import { describe, expect, test } from 'vitest'
import './index.jsx' // registers the 'analyze' slice
import { applyEvents } from '../../state/testing.jsx'
import { initial, isSendTurnComplete, latestSendTurn, newestOkAnalyzeTurn, reducer } from './slice.js'
import { analyzeTurn, conversation, degradedTurn, events, sendTurn } from './fixtures.js'

describe('analyze slice: SSE events', () => {
  test('initial shape', () => {
    expect(initial()).toEqual({ status: 'idle', turn: null, cached: false, error: null, ofTurn: null })
    expect(applyEvents('analyze', []).analyze).toEqual(initial())
  })

  test('analyze_start -> running, analyze_retry -> retrying, analyze_done -> done with the turn', () => {
    let s = applyEvents('analyze', [events.start('a1', 's1')])
    expect(s.analyze).toEqual({ status: 'running', turn: null, cached: false, error: null, ofTurn: 's1' })
    s = applyEvents('analyze', [events.retry('bad json')], { state: s })
    expect(s.analyze).toMatchObject({ status: 'retrying', error: 'bad json', ofTurn: 's1' })
    const turn = analyzeTurn()
    s = applyEvents('analyze', [events.done(turn, false)], { state: s })
    expect(s.analyze).toEqual({ status: 'done', turn, cached: false, error: null, ofTurn: 's1' })
    expect(s.analyze.turn.extraction.divergences).toHaveLength(3)
  })

  test('analyze_done with cached:true sets the cached flag', () => {
    const s = applyEvents('analyze', [events.start(), events.done(analyzeTurn(), true)])
    expect(s.analyze.cached).toBe(true)
    expect(s.analyze.status).toBe('done')
  })

  test('analyze_degraded -> degraded with the raw attempts and turn.error', () => {
    const turn = degradedTurn()
    const s = applyEvents('analyze', [events.start('a2'), events.retry(), events.degraded(turn)])
    expect(s.analyze).toEqual({ status: 'degraded', turn, cached: false, error: turn.error, ofTurn: 's1' })
    expect(s.analyze.turn.raw_attempts).toHaveLength(2)
  })

  test("analyze_* events arriving under feature 'fusion' (auto-run) still update the slice", () => {
    let s = applyEvents('fusion', [events.start('a1', 's1')])
    expect(s.analyze.status).toBe('running')
    s = applyEvents('fusion', [events.retry('x')], { state: s })
    expect(s.analyze.status).toBe('retrying')
    s = applyEvents('fusion', [events.done(analyzeTurn(), false), { type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] }], { state: s })
    expect(s.analyze.status).toBe('done')
    expect(s.analyze.turn.id).toBe('a1')
    // the analyze stream slice is untouched by a fusion-tagged stream
    expect(s.streams.analyze.status).toBe('idle')
  })

  test("a degraded auto-run under 'fusion' lands as degraded", () => {
    const s = applyEvents('fusion', [events.start('a2'), events.degraded(degradedTurn()), events.error('analyze_degraded')])
    // analyze_degraded is the analyze result; the fusion stream's trailing error does not
    // overwrite it (the analyze run was no longer in flight).
    expect(s.analyze.status).toBe('degraded')
    expect(s.analyze.turn.status).toBe('degraded')
  })

  test("terminal error on feature 'analyze' -> error with the message", () => {
    const s = applyEvents('analyze', [events.start(), events.error('analyst unavailable')])
    expect(s.analyze).toMatchObject({ status: 'error', error: 'analyst unavailable', ofTurn: 's1' })
  })

  test("terminal error on feature 'fusion' after analyze_done leaves the analyze result alone", () => {
    const s = applyEvents('fusion', [events.start(), events.done(analyzeTurn()), events.error('nothing_to_fuse')])
    expect(s.analyze.status).toBe('done')
    expect(s.analyze.error).toBeNull()
  })

  test("terminal error on feature 'fusion' while analyze is still in flight -> error", () => {
    const s = applyEvents('fusion', [events.start(), events.error('boom')])
    expect(s.analyze).toMatchObject({ status: 'error', error: 'boom' })
  })

  test('pre-stream failure (sse/end ok:false on analyze) -> error; a prior report is kept', () => {
    let s = applyEvents('analyze', [events.start(), events.done(analyzeTurn())])
    s = applyEvents('analyze', [{ type: 'sse/start', feature: 'analyze' }, { type: 'sse/end', feature: 'analyze', ok: false, error: 'busy', status: 409 }], { state: s })
    expect(s.analyze).toMatchObject({ status: 'error', error: 'busy' })
    expect(s.analyze.turn.id).toBe('a1')
    // an ok end on another feature never touches it
    const t = applyEvents('send', [{ type: 'sse/end', feature: 'send', ok: false, error: 'x' }], { state: s })
    expect(t.analyze).toBe(s.analyze)
  })

  test('sse/abort while in flight resets; otherwise untouched', () => {
    let s = applyEvents('analyze', [events.start()])
    s = applyEvents('analyze', [{ type: 'sse/abort', feature: 'analyze' }], { state: s })
    expect(s.analyze).toEqual(initial())
    const done = applyEvents('analyze', [events.start(), events.done(analyzeTurn())])
    const after = applyEvents('analyze', [{ type: 'sse/abort', feature: 'analyze' }], { state: done })
    expect(after.analyze).toBe(done.analyze)
  })

  test('unrelated actions and slot events keep slice identity', () => {
    const s = applyEvents('analyze', [events.start(), events.done(analyzeTurn())])
    const t = applyEvents('send', [{ type: 'slot_delta', slot: 'claude', text: 'x' }, { type: 'models/loaded', items: [] }], { state: s })
    expect(t.analyze).toBe(s.analyze)
    expect(reducer(s.analyze, { type: '@@slice/registered' })).toBe(s.analyze)
  })
})

describe('analyze slice: conversation lifecycle', () => {
  test('conversation/loaded hydrates from the newest ok analyze turn of the latest send turn', () => {
    const older = analyzeTurn({ id: 'a-old', of_turn: 's1' })
    const newer = analyzeTurn({ id: 'a-new', of_turn: 's1' })
    const conv = conversation([sendTurn({ id: 's1' }), older, degradedTurn({ id: 'a-bad', of_turn: 's1' }), newer, degradedTurn({ id: 'a-last', of_turn: 's1' })])
    const s = applyEvents('analyze', [events.loaded(conv)])
    expect(s.analyze).toEqual({ status: 'done', turn: newer, cached: false, error: null, ofTurn: 's1' })
  })

  test('conversation/loaded ignores analyze turns of an earlier send turn', () => {
    const conv = conversation([sendTurn({ id: 's1' }), analyzeTurn({ id: 'a1', of_turn: 's1' }), sendTurn({ id: 's2' })])
    const s = applyEvents('analyze', [events.loaded(conv)])
    expect(s.analyze).toEqual(initial())
  })

  test('conversation/loaded with only a degraded turn for the latest send resets to idle', () => {
    const conv = conversation([sendTurn({ id: 's1' }), degradedTurn({ id: 'a2', of_turn: 's1' })])
    const s = applyEvents('analyze', [events.loaded(conv)])
    expect(s.analyze.status).toBe('idle')
  })

  test('conversation/loaded after a new send turn replaces an old report', () => {
    let s = applyEvents('analyze', [events.loaded(conversation([sendTurn({ id: 's1' }), analyzeTurn({ of_turn: 's1' })]))])
    expect(s.analyze.status).toBe('done')
    s = applyEvents('analyze', [events.loaded(conversation([sendTurn({ id: 's1' }), analyzeTurn({ of_turn: 's1' }), sendTurn({ id: 's2' })]))], { state: s })
    expect(s.analyze).toEqual(initial())
  })

  test('the refetch right after a degraded / cached / errored run keeps that result', () => {
    const conv = conversation([sendTurn({ id: 's1' }), analyzeTurn({ id: 'a1', of_turn: 's1' })])
    // degraded run on the same send turn: the conversation now also holds the degraded turn
    let s = applyEvents('analyze', [events.start('a2', 's1'), events.degraded(degradedTurn({ id: 'a2' }))])
    const convAfter = conversation([...conv.turns, degradedTurn({ id: 'a2' })])
    let t = applyEvents('analyze', [events.loaded(convAfter)], { state: s })
    expect(t.analyze).toBe(s.analyze)
    expect(t.analyze.status).toBe('degraded')
    // cached hit
    s = applyEvents('analyze', [events.start('a1', 's1'), events.done(analyzeTurn({ id: 'a1' }), true)])
    t = applyEvents('analyze', [events.loaded(conv)], { state: s })
    expect(t.analyze.cached).toBe(true)
    // terminal error after analyze_start
    s = applyEvents('analyze', [events.start('a3', 's1'), events.error('analyst unavailable')])
    t = applyEvents('analyze', [events.loaded(conv)], { state: s })
    expect(t.analyze.status).toBe('error')
  })

  test('conversation/loaded for a different conversation re-hydrates', () => {
    let s = applyEvents('analyze', [events.start('a1', 's1'), events.degraded(degradedTurn())])
    const other = conversation([sendTurn({ id: 's9' }), analyzeTurn({ id: 'a9', of_turn: 's9' })], { id: 'c2' })
    s = applyEvents('analyze', [events.loaded(other)], { state: s })
    expect(s.analyze).toMatchObject({ status: 'done', ofTurn: 's9' })
    expect(s.analyze.turn.id).toBe('a9')
  })

  test('conversation/loaded with no send turn and conversation/cleared reset', () => {
    let s = applyEvents('analyze', [events.start(), events.done(analyzeTurn())])
    s = applyEvents('analyze', [events.loaded(conversation([]))], { state: s })
    expect(s.analyze).toEqual(initial())
    s = applyEvents('analyze', [events.start(), events.done(analyzeTurn())])
    s = applyEvents('analyze', [{ type: 'conversation/cleared' }], { state: s })
    expect(s.analyze).toEqual(initial())
    // idempotent: an already-initial slice keeps identity
    const again = applyEvents('analyze', [{ type: 'conversation/cleared' }], { state: s })
    expect(again.analyze).toBe(s.analyze)
  })
})

describe('analyze helpers', () => {
  test('latestSendTurn / isSendTurnComplete / newestOkAnalyzeTurn', () => {
    expect(latestSendTurn(null)).toBeNull()
    expect(latestSendTurn(conversation([]))).toBeNull()
    const s1 = sendTurn({ id: 's1' })
    const s2 = sendTurn({ id: 's2', responses: { claude: 'a', chatgpt: null, grok: 'c' } })
    const conv = conversation([s1, analyzeTurn({ of_turn: 's1' }), { type: 'continue', id: 'k1', slot: 'grok', prompt: 'p', response: 'r' }, s2])
    expect(latestSendTurn(conv)).toBe(s2)
    expect(isSendTurnComplete(s1)).toBe(true)
    expect(isSendTurnComplete(s2)).toBe(false)
    expect(isSendTurnComplete(null)).toBe(false)
    expect(isSendTurnComplete({ responses: {} })).toBe(false)
    expect(newestOkAnalyzeTurn(conv, 's1').id).toBe('a1')
    expect(newestOkAnalyzeTurn(conv, 's2')).toBeNull()
  })
})
