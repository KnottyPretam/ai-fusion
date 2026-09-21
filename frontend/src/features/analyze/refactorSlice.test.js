// The refactor slice (S11). Mirrors the analyze slice's tests, plus the one thing that differs: a
// `refactor_retry` is PROGRESS (the map call, then one per label), not a failed attempt.
import { describe, expect, test } from 'vitest'
import { edgeRows, initial, latestSendTurn, newestOkRefactorTurn, reducer } from './refactorSlice.js'

const sse = (event, feature = 'refactor') => ({ type: 'sse', feature, event })
const okTurn = (ofTurn = 't1') => ({
  id: 'r1',
  type: 'refactor',
  of_turn: ofTurn,
  status: 'ok',
  refactoring: { graph: { nodes: [], edges: [] }, question: 'tight', replies: [] },
})

describe('refactor slice', () => {
  test('starts idle and empty', () => {
    expect(initial()).toEqual({ status: 'idle', turn: null, cached: false, notice: null, error: null, ofTurn: null })
  })

  test('refactor_start is the only idle -> running transition and remembers the send turn', () => {
    const s = reducer(initial(), sse({ type: 'refactor_start', turn_id: 'r1', of_turn: 't1' }))
    expect(s).toMatchObject({ status: 'running', ofTurn: 't1', turn: null })
  })

  test('refactor_retry is progress, carried as a notice and never as an error', () => {
    let s = reducer(initial(), sse({ type: 'refactor_start', of_turn: 't1' }))
    s = reducer(s, sse({ type: 'refactor_retry', error: 'mapping the question' }))
    expect(s.status).toBe('working')
    expect(s.notice).toBe('mapping the question')
    expect(s.error).toBeNull()
    s = reducer(s, sse({ type: 'refactor_retry', error: "refactoring R2's reply (3,000 characters)" }))
    expect(s.notice).toContain('R2')
  })

  test('refactor_done carries the turn and clears the notice', () => {
    let s = reducer(initial(), sse({ type: 'refactor_start', of_turn: 't1' }))
    s = reducer(s, sse({ type: 'refactor_retry', error: 'mapping' }))
    s = reducer(s, sse({ type: 'refactor_done', turn: okTurn(), cached: true }))
    expect(s).toMatchObject({ status: 'done', cached: true, notice: null, error: null, ofTurn: 't1' })
    expect(s.turn.id).toBe('r1')
  })

  test('refactor_degraded keeps the turn and surfaces its error', () => {
    const turn = { id: 'r2', type: 'refactor', of_turn: 't1', status: 'degraded', error: 'parse_error', refactoring: null }
    const s = reducer(initial(), sse({ type: 'refactor_degraded', turn }))
    expect(s).toMatchObject({ status: 'degraded', error: 'parse_error', ofTurn: 't1' })
  })

  test('a terminal error counts on the refactor stream, or on any stream while a run is in flight', () => {
    const running = reducer(initial(), sse({ type: 'refactor_start', of_turn: 't1' }))
    expect(reducer(running, sse({ type: 'error', message: 'boom' }, 'send')).status).toBe('error')
    expect(reducer(initial(), sse({ type: 'error', message: 'boom' }, 'send')).status).toBe('idle')
    expect(reducer(initial(), sse({ type: 'error', message: 'boom' }, 'refactor')).status).toBe('error')
  })

  test('a pre-stream failure arrives as sse/end and is an error', () => {
    const s = reducer(initial(), { type: 'sse/end', feature: 'refactor', ok: false, error: 'busy' })
    expect(s).toMatchObject({ status: 'error', error: 'busy' })
  })

  test('an abort mid-run resets; an abort at rest changes nothing', () => {
    const running = reducer(initial(), sse({ type: 'refactor_start', of_turn: 't1' }))
    expect(reducer(running, { type: 'sse/abort' })).toEqual(initial())
    const at_rest = reducer(initial(), sse({ type: 'refactor_done', turn: okTurn() }))
    expect(reducer(at_rest, { type: 'sse/abort' })).toBe(at_rest)
  })

  test('conversation/loaded hydrates from the newest ok refactor turn of the latest send turn', () => {
    const conversation = { turns: [{ id: 't1', type: 'send' }, okTurn('t1')] }
    const s = reducer(initial(), { type: 'conversation/loaded', conversation })
    expect(s).toMatchObject({ status: 'done', ofTurn: 't1' })
    expect(s.turn.id).toBe('r1')
  })

  test('conversation/loaded never clobbers a result that belongs to the displayed send turn', () => {
    const done = reducer(initial(), sse({ type: 'refactor_done', turn: okTurn('t1') }))
    const conversation = { turns: [{ id: 't1', type: 'send' }] }
    expect(reducer(done, { type: 'conversation/loaded', conversation })).toBe(done)
  })

  test('conversation/cleared resets, and is identity when already initial', () => {
    const done = reducer(initial(), sse({ type: 'refactor_done', turn: okTurn() }))
    expect(reducer(done, { type: 'conversation/cleared' })).toEqual(initial())
    const fresh = initial()
    expect(reducer(fresh, { type: 'conversation/cleared' })).toBe(fresh)
  })
})

describe('refactor slice: pure helpers', () => {
  test('latestSendTurn takes the LAST send turn', () => {
    const conversation = { turns: [{ id: 'a', type: 'send' }, { id: 'r', type: 'refactor' }, { id: 'b', type: 'send' }] }
    expect(latestSendTurn(conversation).id).toBe('b')
    expect(latestSendTurn(null)).toBeNull()
    expect(latestSendTurn({ turns: [] })).toBeNull()
  })

  test('newestOkRefactorTurn ignores degraded turns and turns for another send', () => {
    const turns = [
      { id: 'r1', type: 'refactor', of_turn: 't1', status: 'ok' },
      { id: 'r2', type: 'refactor', of_turn: 't1', status: 'degraded' },
      { id: 'r3', type: 'refactor', of_turn: 't2', status: 'ok' },
    ]
    expect(newestOkRefactorTurn({ turns }, 't1').id).toBe('r1')
    expect(newestOkRefactorTurn({ turns }, 't3')).toBeNull()
  })

  test('edgeRows resolves node ids to labels and leaves an unknown id as it is', () => {
    const graph = {
      nodes: [{ id: 'n1', label: 'Hyprland' }, { id: 'n2', label: 'note app' }],
      edges: [{ source: 'n1', target: 'n2', relation: 'hosts' }, { source: 'n9', target: 'n1', relation: 'unknown' }],
    }
    expect(edgeRows(graph)).toEqual([
      { from: 'Hyprland', relation: 'hosts', to: 'note app' },
      { from: 'n9', relation: 'unknown', to: 'Hyprland' },
    ])
    expect(edgeRows(null)).toEqual([])
  })
})
