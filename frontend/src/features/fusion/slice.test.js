import { describe, expect, test } from 'vitest'
import './index.jsx' // registers the fusion slice
import { applyEvents } from '../../state/testing.jsx'
import { initialState, rootReducer } from '../../state/registry.js'
import { fusionReducer, initialFusion, stateFromTurn } from './slice.js'
import { ANALYZE_PREFIX, ROUND1, ROUND2, USAGE, analyzeTurn, conversation, exchange, fullRun, fusionStart, fusionTurnFromEvents, sendTurn } from './fixtures.js'

const start = { type: 'sse/start', feature: 'fusion' }
const endOk = { type: 'sse/end', feature: 'fusion', ok: true }

describe('fusion slice: live stream', () => {
  test('initial shape', () => {
    const s = initialState()
    expect(s.fusion).toMatchObject({ status: 'idle', analyzing: false, notice: null, turnId: null, rounds: [], final: [], exitReason: null, usage: null, error: null })
  })

  test('sse/start resets to running; fusion_start seeds the run', () => {
    const s = applyEvents('fusion', [start, fusionStart()])
    expect(s.fusion).toMatchObject({ status: 'running', analyzing: false, turnId: 'f1', ofAnalyze: 'a1', maxIterations: 2, standing: ['d1', 'd2'], rounds: [], final: [] })
  })

  test('rounds are built incrementally from round_start / exchange / round_done', () => {
    let s = applyEvents('fusion', [start, fusionStart(), ROUND1[0]])
    expect(s.fusion.rounds).toEqual([{ round: 1, exchanges: [], post_round_status: [], changed: false, complete: false }])
    s = applyEvents('fusion', [ROUND1[1], ROUND1[2]], { state: s })
    expect(s.fusion.rounds[0].exchanges).toHaveLength(2)
    // `type` and `round` are stripped; the rest of the Exchange is kept verbatim
    expect(s.fusion.rounds[0].exchanges[1]).toMatchObject({ divergence_id: 'd1', model: 'R2', stance: 'revise', flagged_unjustified: false })
    expect(s.fusion.rounds[0].exchanges[1]).not.toHaveProperty('type')
    expect(s.fusion.rounds[0].exchanges[1]).not.toHaveProperty('round')
    expect(s.fusion.rounds[0].complete).toBe(false)
    s = applyEvents('fusion', [...ROUND1.slice(3)], { state: s })
    expect(s.fusion.rounds[0]).toMatchObject({ complete: true, changed: true, post_round_status: [{ divergence_id: 'd1', status: 'resolved' }, { divergence_id: 'd2', status: 'standing' }] })
    expect(s.fusion.status).toBe('running')
    s = applyEvents('fusion', ROUND2, { state: s })
    expect(s.fusion.rounds.map((r) => r.round)).toEqual([1, 2])
    expect(s.fusion.rounds[1].exchanges.map((e) => e.stance)).toEqual(['defend', 'unavailable'])
  })

  test('fusion_done settles status/final/exitReason/usage from the persisted turn', () => {
    const events = fullRun({ exit_reason: 'max_iterations' })
    const s = applyEvents('fusion', [start, ...events, endOk])
    expect(s.fusion.status).toBe('done')
    expect(s.fusion.exitReason).toBe('max_iterations')
    expect(s.fusion.usage).toEqual(USAGE)
    expect(s.fusion.final).toEqual([{ divergence_id: 'd1', status: 'resolved' }, { divergence_id: 'd2', status: 'standing' }])
    expect(s.fusion.rounds.every((r) => r.complete)).toBe(true)
    expect(s.fusion.rounds).toHaveLength(2)
    expect(s.fusion.error).toBeNull()
    expect(s.fusion.notice).toBeNull()
  })

  test('fusion_done with exit_reason error is still a done state (a turn was persisted)', () => {
    const body = [fusionStart({ max_iterations: 1 }), { type: 'round_start', round: 1 }, exchange(1, 'd1', 'R1', 'unavailable'), exchange(1, 'd1', 'R2', 'unavailable'), exchange(1, 'd1', 'R3', 'unavailable'), exchange(1, 'd2', 'R1', 'unavailable'), exchange(1, 'd2', 'R3', 'unavailable'), { type: 'round_done', round: 1, post_round_status: [{ divergence_id: 'd1', status: 'standing' }, { divergence_id: 'd2', status: 'standing' }], changed: false }]
    const turn = fusionTurnFromEvents(body, { max_iterations: 1, exit_reason: 'error' })
    const s = applyEvents('fusion', [start, ...body, { type: 'fusion_done', turn, exit_reason: 'error', usage: USAGE }, endOk])
    expect(s.fusion).toMatchObject({ status: 'done', exitReason: 'error', error: null })
  })

  test('analyze_* prefix then error{nothing_to_fuse} is a normal end, not a crash', () => {
    let s = applyEvents('fusion', [start, ANALYZE_PREFIX[0]])
    expect(s.fusion).toMatchObject({ status: 'running', analyzing: true })
    s = applyEvents('fusion', [ANALYZE_PREFIX[1]], { state: s })
    expect(s.fusion.analyzeTurn.id).toBe('a9')
    s = applyEvents('fusion', [{ type: 'error', message: 'nothing_to_fuse' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'nothing_to_fuse' }], { state: s })
    expect(s.fusion).toMatchObject({ status: 'done', notice: 'nothing_to_fuse', error: null, analyzing: false, turnId: null, rounds: [] })
    // the frozen streams slice still records the terminal error; that is its contract, not ours
    expect(s.streams.fusion.status).toBe('error')
  })

  test('analyze_degraded then error{analyze_degraded} is a normal end too', () => {
    const degraded = analyzeTurn('a9', 's1', null, 'degraded')
    const s = applyEvents('fusion', [start, { type: 'analyze_start', turn_id: 'a9', of_turn: 's1' }, { type: 'analyze_retry', error: 'bad json' }, { type: 'analyze_degraded', turn: degraded }, { type: 'error', message: 'analyze_degraded' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'analyze_degraded' }])
    expect(s.fusion).toMatchObject({ status: 'done', notice: 'analyze_degraded', error: null, analyzing: false })
  })

  test('any other terminal error is an error state', () => {
    const s = applyEvents('fusion', [start, fusionStart(), ...ROUND1, { type: 'error', message: 'boom' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'boom' }])
    expect(s.fusion).toMatchObject({ status: 'error', error: 'boom', notice: null })
    expect(s.fusion.rounds).toHaveLength(1) // partial timeline kept
  })

  test('HTTP failure (sse/end with a status) is an error, except the two notice codes', () => {
    let s = applyEvents('fusion', [start, { type: 'sse/end', feature: 'fusion', ok: false, error: 'busy', status: 409, body: { detail: { error: 'busy' } } }])
    expect(s.fusion).toMatchObject({ status: 'error', error: 'busy' })
    s = applyEvents('fusion', [start, { type: 'sse/end', feature: 'fusion', ok: false, error: 'nothing_to_fuse', status: 409, body: { detail: { error: 'nothing_to_fuse' } } }])
    expect(s.fusion).toMatchObject({ status: 'done', notice: 'nothing_to_fuse', error: null })
    s = applyEvents('fusion', [start, { type: 'sse/end', feature: 'fusion', ok: false, error: 'max_iterations: Input should be less than or equal to 5', status: 422, body: { detail: [{ loc: ['body', 'max_iterations'], msg: 'x' }] } }])
    expect(s.fusion.status).toBe('error')
  })

  test('a stream that ends ok without fusion_done and an abort are error states', () => {
    let s = applyEvents('fusion', [start, fusionStart(), endOk])
    expect(s.fusion).toMatchObject({ status: 'error', error: 'stream ended without fusion_done' })
    s = applyEvents('fusion', [start, fusionStart(), { type: 'sse/abort', feature: 'fusion' }])
    expect(s.fusion).toMatchObject({ status: 'error', error: 'aborted' })
  })

  test('events of other features never touch the slice (identity preserved)', () => {
    const s0 = initialState()
    const s1 = applyEvents('send', [{ type: 'sse/start', feature: 'send' }, { type: 'turn_start', turn_id: 't', feature: 'send', slots: [] }, { type: 'error', message: 'nothing_to_fuse' }], { state: s0 })
    expect(s1.fusion).toBe(s0.fusion)
    const s2 = applyEvents('analyze', [{ type: 'sse/start', feature: 'analyze' }, { type: 'analyze_start', turn_id: 'a', of_turn: 's' }], { state: s1 })
    expect(s2.fusion).toBe(s0.fusion)
    expect(s2.fusion.analyzing).toBe(false)
  })
})

describe('fusion slice: conversation lifecycle', () => {
  const doneEvents = fullRun()
  const fusionTurn = doneEvents[doneEvents.length - 1].turn

  test('conversation/loaded hydrates from the newest fusion turn', () => {
    const older = fusionTurnFromEvents([fusionStart({ turn_id: 'f0', standing: ['d1'] })], { id: 'f0', exit_reason: 'stalemate' })
    const conv = conversation([sendTurn(), analyzeTurn(), older, fusionTurn])
    const s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conv })
    expect(s.fusion).toMatchObject({ status: 'done', turnId: 'f1', ofAnalyze: 'a1', maxIterations: 2, standing: ['d1', 'd2'], exitReason: 'max_iterations', conversationId: 'c1' })
    expect(s.fusion.rounds).toHaveLength(2)
    expect(s.fusion.rounds.every((r) => r.complete)).toBe(true)
    expect(s.fusion.final).toEqual(fusionTurn.final)
    expect(s.fusion.usage).toEqual(USAGE)
    expect(stateFromTurn(fusionTurn, 'c1').rounds[0].exchanges).toEqual(fusionTurn.rounds[0].exchanges)
  })

  test('conversation without a fusion turn resets to idle; cleared resets', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn()], 'c2') })
    expect(s.fusion).toEqual({ ...initialFusion(), conversationId: 'c2' })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    expect(s.fusion.status).toBe('done')
    s = rootReducer(s, { type: 'conversation/cleared' })
    expect(s.fusion).toEqual(initialFusion())
  })

  test('a refetch never clobbers a live timeline', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() })
    s = applyEvents('fusion', [start, fusionStart(), ...ROUND1], { state: s })
    const live = s.fusion
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    expect(s.fusion).toBe(live)
  })

  test('the refetch after error{nothing_to_fuse} keeps the notice, even with an older fusion turn present', () => {
    const conv = conversation([sendTurn(), analyzeTurn(), fusionTurn, sendTurn('s2')])
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conv })
    s = applyEvents('fusion', [start, ...ANALYZE_PREFIX, { type: 'error', message: 'nothing_to_fuse' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'nothing_to_fuse' }], { state: s })
    expect(s.fusion.notice).toBe('nothing_to_fuse')
    const refetched = conversation([...conv.turns, analyzeTurn('a9', 's2', { agreements: [], divergences: [] })])
    s = rootReducer(s, { type: 'conversation/loaded', conversation: refetched })
    expect(s.fusion).toMatchObject({ status: 'done', notice: 'nothing_to_fuse', turnId: null })
    // switching conversation drops it
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn()], 'c2') })
    expect(s.fusion).toMatchObject({ status: 'idle', notice: null, conversationId: 'c2' })
  })

  test('the refetch after fusion_done is a no-op for the same turn; a newer turn re-hydrates', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() })
    s = applyEvents('fusion', [start, ...doneEvents, endOk], { state: s })
    const done = s.fusion
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    expect(s.fusion).toBe(done)
    const newer = { ...fusionTurn, id: 'f2', exit_reason: 'converged' }
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn, newer]) })
    expect(s.fusion).toMatchObject({ turnId: 'f2', exitReason: 'converged' })
  })

  test('a refetch after a run that failed after fusion_start keeps the failure and the partial timeline', () => {
    const failed = [start, fusionStart(), ...ROUND1, { type: 'error', message: 'boom' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'boom' }]
    // (1) no fusion turn on the server (the contract persists none on error{message})
    let s = applyEvents('fusion', failed, { state: rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() }) })
    const failure = s.fusion
    expect(failure).toMatchObject({ status: 'error', error: 'boom', turnId: 'f1', conversationId: 'c1' })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation() })
    expect(s.fusion).toBe(failure)
    expect(s.fusion.rounds).toHaveLength(1)
    // (2) an OLDER fusion turn further up the conversation must not silently replace the failure
    const older = fusionTurnFromEvents([fusionStart({ turn_id: 'f0', standing: ['d1'] })], { id: 'f0', exit_reason: 'stalemate' })
    const withOlder = conversation([sendTurn(), analyzeTurn(), older, sendTurn('s2'), analyzeTurn('a9', 's2')])
    s = applyEvents('fusion', failed, { state: rootReducer(initialState(), { type: 'conversation/loaded', conversation: withOlder }) })
    expect(s.fusion.turnId).toBe('f1')
    const kept = s.fusion
    s = rootReducer(s, { type: 'conversation/loaded', conversation: withOlder })
    expect(s.fusion).toBe(kept)
    expect(s.fusion).toMatchObject({ status: 'error', error: 'boom', turnId: 'f1' })
    expect(s.fusion.rounds).toHaveLength(1)
    // (3) a conversation switch drops it
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn()], 'c2') })
    expect(s.fusion).toMatchObject({ status: 'idle', error: null, turnId: null, rounds: [], conversationId: 'c2' })
    // (4) the abort variant is kept the same way
    s = applyEvents('fusion', [start, fusionStart(), { type: 'sse/abort', feature: 'fusion' }], { state: rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() }) })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation() })
    expect(s.fusion).toMatchObject({ status: 'error', error: 'aborted', turnId: 'f1' })
    // (5) the next run's sse/start clears it
    s = applyEvents('fusion', [start], { state: s })
    expect(s.fusion).toMatchObject({ status: 'running', error: null, turnId: null, conversationId: 'c1' })
  })

  test('a run lost client-side that the producer completed anyway is superseded by its persisted turn', () => {
    // run-to-completion rule: after a disconnect/abort the backend still persists the FusionTurn whose
    // id fusion_start announced; once the refetch holds that very turn its record replaces the failure
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() })
    s = applyEvents('fusion', [start, fusionStart(), ...ROUND1, { type: 'sse/abort', feature: 'fusion' }], { state: s })
    expect(s.fusion).toMatchObject({ status: 'error', error: 'aborted', turnId: 'f1' })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    expect(s.fusion).toMatchObject({ status: 'done', error: null, turnId: 'f1', exitReason: 'max_iterations' })
    expect(s.fusion.rounds).toHaveLength(2)
    expect(s.fusion.final).toEqual(fusionTurn.final)
  })

  test('a refetch after an HTTP failure re-hydrates the persisted report and keeps the failure visible', () => {
    const conv = conversation([sendTurn(), analyzeTurn(), fusionTurn])
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conv })
    s = applyEvents('fusion', [start, { type: 'sse/end', feature: 'fusion', ok: false, error: 'busy', status: 409, body: { detail: { error: 'busy' } } }], { state: s })
    expect(s.fusion).toMatchObject({ status: 'error', error: 'busy', turnId: null })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conv })
    expect(s.fusion).toMatchObject({ status: 'done', turnId: 'f1', error: 'busy', exitReason: 'max_iterations', conversationId: 'c1' })
    expect(s.fusion.final).toEqual(fusionTurn.final)
    expect(s.fusion.rounds).toHaveLength(2)
    // a later refetch of the same turn is a no-op (identity kept, the failure stays visible)
    const hydrated = s.fusion
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([...conv.turns, sendTurn('s2')]) })
    expect(s.fusion).toBe(hydrated)
    // the turn persisted by the still-running producer lands on the next refetch and clears the error
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([...conv.turns, { ...fusionTurn, id: 'f2' }]) })
    expect(s.fusion).toMatchObject({ status: 'done', turnId: 'f2', error: null })
  })

  test('a pre-stream failure with nothing persisted stays visible; the next sse/start clears it', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() })
    s = applyEvents('fusion', [start, { type: 'sse/end', feature: 'fusion', ok: false, error: 'Failed to fetch' }], { state: s })
    const failure = s.fusion
    expect(failure).toMatchObject({ status: 'error', error: 'Failed to fetch', turnId: null })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation() })
    expect(s.fusion).toBe(failure)
    s = applyEvents('fusion', [start], { state: s })
    expect(s.fusion).toMatchObject({ status: 'running', error: null })
  })

  test('a conversation switch mid-stream never clobbers the live timeline', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation() })
    s = applyEvents('fusion', [start, fusionStart(), ...ROUND1], { state: s })
    const live = s.fusion
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn], 'c2') })
    expect(s.fusion).toBe(live)
    expect(s.fusion).toMatchObject({ status: 'running', conversationId: 'c1' })
    // the run's own refetch (of c1) after fusion_done then settles on that turn
    s = applyEvents('fusion', [...ROUND2, doneEvents[doneEvents.length - 1], endOk], { state: s })
    s = rootReducer(s, { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    expect(s.fusion).toMatchObject({ status: 'done', turnId: 'f1', conversationId: 'c1' })
  })

  test('conversation/deleted for the tracked conversation resets', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), fusionTurn]) })
    s = rootReducer(s, { type: 'conversation/deleted', id: 'other' })
    expect(s.fusion.status).toBe('done')
    s = rootReducer(s, { type: 'conversation/deleted', id: 'c1' })
    expect(s.fusion).toEqual(initialFusion())
  })

  test('reducer tolerates undefined state and unknown actions', () => {
    const s = fusionReducer(undefined, { type: 'nope' })
    expect(s).toEqual(initialFusion())
    expect(fusionReducer(s, { type: 'sse', feature: 'fusion' })).toBe(s)
  })
})
