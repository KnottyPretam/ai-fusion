// The preparse slice (2026-09-23): every transition of a pre-parse stream, read only on its own
// feature key; `seq` counts results and only ever goes up; nothing conversation-bound.
import { describe, expect, test } from 'vitest'
import './index.jsx' // registers the `preparse` slice beside `panes`
import { hasSlice, initialState } from '../../state/registry.js'
import { FEATURE, initial, reducer } from './preparseSlice.js'

const sse = (event, feature = FEATURE) => ({ type: 'sse', feature, event })
const USAGE = { calls: [], totals: { prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0, cost_usd: 0, latency_ms: 10, calls: 1 } }
const DONE = { type: 'preparse_done', prompt: 'Q?\n\nAnswer format', original: 'q?', question: 'Q?', usage: USAGE }
const running = () => reducer(initial(), sse({ type: 'preparse_start' }))

describe('preparse slice', () => {
  test('is registered beside panes (index.jsx) and starts idle and empty', () => {
    expect(hasSlice('preparse')).toBe(true)
    expect(FEATURE).toBe('preparse')
    expect(initialState().preparse).toEqual(initial())
    expect(initial()).toEqual({ status: 'idle', notice: null, prompt: null, original: null, question: null, error: null, rawAttempts: [], seq: 0 })
  })

  test('preparse_start → running (fields reset, seq kept); preparse_retry → working with the notice', () => {
    const stale = { ...initial(), status: 'degraded', error: 'old', original: 'x', rawAttempts: ['x'], seq: 2 }
    const s = reducer(stale, sse({ type: 'preparse_start' }))
    expect(s).toEqual({ ...initial(), status: 'running', seq: 2 })
    const w = reducer(s, sse({ type: 'preparse_retry', error: 'restating the question concisely' }))
    expect(w).toMatchObject({ status: 'working', notice: 'restating the question concisely', error: null, seq: 2 })
    expect(reducer(w, sse({ type: 'preparse_retry' })).notice).toBeNull()
  })

  test('preparse_done → done with the composed prompt, the original and the question, and seq + 1', () => {
    const s = reducer(reducer(running(), sse({ type: 'preparse_retry', error: 'n' })), sse(DONE))
    expect(s).toEqual({ status: 'done', notice: null, prompt: 'Q?\n\nAnswer format', original: 'q?', question: 'Q?', error: null, rawAttempts: [], seq: 1 })
    // a done straight from idle (no start seen) still counts
    expect(reducer(initial(), sse(DONE)).seq).toBe(1)
  })

  test('a preparse_done with a missing, non-string or empty prompt is an error, never an empty composer; seq unchanged', () => {
    for (const prompt of [undefined, '', 42, null]) {
      const s = reducer(running(), sse({ ...DONE, prompt }))
      expect(s).toMatchObject({ status: 'error', error: 'malformed preparse_done', seq: 0, prompt: null })
    }
  })

  test('preparse_degraded keeps the original and the raw attempts and surfaces the reason', () => {
    const s = reducer(running(), sse({ type: 'preparse_degraded', error: 'the analyst returned an empty restatement', original: 'q?', raw_attempts: ['{"question": "  "}'], usage: USAGE }))
    expect(s).toEqual({ status: 'degraded', notice: null, prompt: null, original: 'q?', question: null, error: 'the analyst returned an empty restatement', rawAttempts: ['{"question": "  "}'], seq: 0 })
    expect(reducer(running(), sse({ type: 'preparse_degraded' }))).toMatchObject({ status: 'degraded', error: 'degraded', rawAttempts: [] })
  })

  test('a terminal error event is an error with its message', () => {
    expect(reducer(running(), sse({ type: 'error', message: 'boom' }))).toMatchObject({ status: 'error', error: 'boom', notice: null })
    expect(reducer(running(), sse({ type: 'error' }))).toMatchObject({ status: 'error', error: 'error' })
  })

  test('a pre-stream failure lands as sse/end{ok:false} with its code; sse/end{ok:true} keeps identity', () => {
    const s = reducer(initial(), { type: 'sse/end', feature: FEATURE, ok: false, error: 'busy', status: 409 })
    expect(s).toMatchObject({ status: 'error', error: 'busy', seq: 0 })
    expect(reducer(initial(), { type: 'sse/end', feature: FEATURE, ok: false })).toMatchObject({ status: 'error', error: 'stream failed' })
    const done = reducer(initial(), sse(DONE))
    expect(reducer(done, { type: 'sse/end', feature: FEATURE, ok: true })).toBe(done)
    // review 2026-09-23: the result is already in the composer — a transport failure after the final frame says nothing new
    expect(reducer(done, { type: 'sse/end', feature: FEATURE, ok: false, error: 'stream failed' })).toBe(done)
  })

  test('sse/abort (Cancel) resets to idle keeping seq; at rest it keeps identity', () => {
    const w = reducer(reducer(initial(), sse(DONE)), sse({ type: 'preparse_start' }))
    expect(w.seq).toBe(1)
    const s = reducer(w, { type: 'sse/abort', feature: FEATURE })
    expect(s).toEqual({ ...initial(), seq: 1 })
    expect(reducer(s, { type: 'sse/abort', feature: FEATURE })).toBe(s)
    const fresh = initial()
    expect(reducer(fresh, { type: 'sse/abort', feature: FEATURE })).toBe(fresh)
  })

  test('preparse/clear resets to idle keeping seq; at rest it keeps identity', () => {
    const done = reducer(initial(), sse(DONE))
    const s = reducer(done, { type: 'preparse/clear' })
    expect(s).toEqual({ ...initial(), seq: 1 })
    expect(reducer(s, { type: 'preparse/clear' })).toBe(s)
    const failed = reducer(initial(), { type: 'sse/end', feature: FEATURE, ok: false, error: 'busy' })
    expect(reducer(failed, { type: 'preparse/clear' })).toEqual(initial())
  })

  test('seq is monotonic: results across a clear and an abort count up, nothing counts down', () => {
    let s = reducer(initial(), sse(DONE))
    s = reducer(s, { type: 'preparse/clear' })
    s = reducer(s, sse({ type: 'preparse_start' }))
    s = reducer(s, { type: 'sse/abort', feature: FEATURE })
    s = reducer(s, sse({ type: 'preparse_start' }))
    s = reducer(s, sse({ ...DONE, prompt: 'second' }))
    expect(s).toMatchObject({ status: 'done', prompt: 'second', seq: 2 })
    s = reducer(s, sse({ type: 'preparse_degraded', error: 'x' }))
    expect(s.seq).toBe(2)
  })

  test('events of another feature keep identity, whatever their type (only feature preparse is read)', () => {
    const w = running()
    for (const feature of ['send', 'analyze', 'fusion', 'refactor']) {
      expect(reducer(w, sse({ type: 'preparse_start' }, feature))).toBe(w)
      expect(reducer(w, sse(DONE, feature))).toBe(w)
      expect(reducer(w, sse({ type: 'error', message: 'boom' }, feature))).toBe(w)
      expect(reducer(w, { type: 'sse/end', feature, ok: false, error: 'busy' })).toBe(w)
      expect(reducer(w, { type: 'sse/abort', feature })).toBe(w)
      expect(reducer(w, { type: 'sse/start', feature })).toBe(w)
    }
  })

  test('conversation/loaded and conversation/cleared are ignored: the draft is not conversation-bound', () => {
    const w = reducer(running(), sse({ type: 'preparse_retry', error: 'n' }))
    expect(reducer(w, { type: 'conversation/loaded', conversation: { id: 'c1', turns: [] } })).toBe(w)
    expect(reducer(w, { type: 'conversation/cleared' })).toBe(w)
    const done = reducer(initial(), sse(DONE))
    expect(reducer(done, { type: 'conversation/loaded', conversation: { id: 'c2', turns: [] } })).toBe(done)
  })

  test('unknown actions and malformed events keep identity', () => {
    const w = running()
    expect(reducer(w, { type: 'panes/mode', mode: 'tabs' })).toBe(w)
    expect(reducer(w, sse(null))).toBe(w)
    expect(reducer(w, sse({ type: 7 }))).toBe(w)
    expect(reducer(w, sse({ type: 'slot_delta', slot: 'claude', text: 'x' }))).toBe(w)
    expect(reducer(undefined, { type: '@@init' })).toEqual(initial())
  })
})
