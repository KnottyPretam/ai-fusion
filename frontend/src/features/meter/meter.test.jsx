import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import CostMeter from './index.jsx' // registers the 'meter' slice at module scope
import { carriesCostCap, emptyRow, initialMeter, meterFromConversation, meterReducer, rowsFromConversation } from './slice.js'
import { applyEvents, renderWithStore, sample } from '../../state/testing.jsx'

const CFG = {
  slots: { claude: { model: 'a', effort: 'medium' }, chatgpt: { model: 'b', effort: 'medium' }, grok: { model: 'c', effort: 'medium' } },
  analyst_model: 'x',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

function featureUsage(totals) {
  return { calls: [], totals: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: 0, calls: 0, ...totals } }
}

const ANALYZE_TURN = {
  id: 'a1',
  type: 'analyze',
  of_turn: 't1',
  status: 'ok',
  slot_config: CFG,
  extraction: { agreements: [], divergences: [] },
  usage: featureUsage({ prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 5, cost_usd: 0.0005, latency_ms: 1200, calls: 1 }),
}

const FUSION_USAGE = featureUsage({ prompt_tokens: 900, completion_tokens: 300, reasoning_tokens: 40, cost_usd: 0.012, latency_ms: 9000, calls: 7 })
const FUSION_TURN = {
  id: 'f1',
  type: 'fusion',
  of_analyze: 'a1',
  max_iterations: 2,
  standing: ['d1'],
  rounds: [],
  final: [{ divergence_id: 'd1', status: 'resolved' }],
  exit_reason: 'converged',
  slot_config: CFG,
  usage: FUSION_USAGE,
}

// One full three-slot send stream for `turnId` ($0.003, 3 calls, 800 ms wall clock, grok truncated).
function sendEvents(turnId = 't1') {
  return [
    sample.turnStart(turnId),
    sample.slotStart('claude'),
    sample.slotStart('chatgpt'),
    sample.slotStart('grok'),
    sample.slotDelta('claude', 'hi'),
    sample.slotDone('claude'),
    sample.slotDone('chatgpt'),
    { ...sample.slotDone('grok', { reasoning_tokens: 7 }), finish_reason: 'length', truncated: true },
    sample.turnDone(turnId),
  ]
}
const SEND_EVENTS = sendEvents('t1')
const SEND_ROW = { prompt_tokens: 30, completion_tokens: 60, reasoning_tokens: 7, cost_usd: 0.003, latency_ms: 800, calls: 3, truncated: 1 }
const ANALYZE_ROW = { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 5, cost_usd: 0.0005, latency_ms: 1200, calls: 1, truncated: 0 }
const FUSION_ROW = { prompt_tokens: 900, completion_tokens: 300, reasoning_tokens: 40, cost_usd: 0.012, latency_ms: 9000, calls: 7, truncated: 0 }

const sendTurn = (id, cost_usd, extra = {}) => ({
  id,
  type: 'send',
  prompt: 'q',
  responses: { claude: 'a', chatgpt: 'b', grok: 'c' },
  truncated: { claude: false, chatgpt: false, grok: false },
  slot_config: CFG,
  usage: featureUsage({ prompt_tokens: 30, completion_tokens: 60, cost_usd, latency_ms: 800, calls: 3 }),
  ...extra,
})

describe('meter slice: streams', () => {
  test('initial state has the four rows, empty last rows and no warning', () => {
    const s = applyEvents('send', [])
    expect(s.meter).toEqual(initialMeter())
    expect(s.meter.last).toEqual({ send: emptyRow(), analyze: emptyRow(), fusion: emptyRow() })
  })

  test('slot_done events aggregate into the Send row and the last Send; turn_done supplies the wall-clock latency and books the turn cost', () => {
    const s = applyEvents('send', SEND_EVENTS)
    expect(s.meter.send).toEqual(SEND_ROW)
    expect(s.meter.last.send).toEqual(SEND_ROW)
    expect(s.meter.sendCostByTurn).toEqual({ t1: 0.003 })
    expect(s.meter.analyze).toEqual(initialMeter().analyze)
    expect(s.meter.total).toEqual(s.meter.send)
    expect(s.meter.costCapExceeded).toBe(false)
  })

  test('a second send accumulates in the conversation row while the last Send is that turn only', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('send', sendEvents('t2'), { state: s })
    expect(s.meter.send).toMatchObject({ cost_usd: 0.006, calls: 6, latency_ms: 1600, truncated: 2 })
    expect(s.meter.last.send).toEqual(SEND_ROW)
    expect(s.meter.sendCostByTurn).toEqual({ t1: 0.003, t2: 0.003 })
  })

  test('a continue stream (feature send, one slot) books under the Send row too and becomes the last Send', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('send', [{ ...sample.turnStart('t2'), feature: 'continue', slots: ['grok'] }, sample.slotStart('grok'), sample.slotDone('grok'), sample.turnDone('t2')], { state: s })
    expect(s.meter.send).toMatchObject({ prompt_tokens: 40, completion_tokens: 80, cost_usd: 0.004, latency_ms: 1600, calls: 4, truncated: 1 })
    expect(s.meter.last.send).toEqual({ prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0, cost_usd: 0.001, latency_ms: 800, calls: 1, truncated: 0 })
    expect(s.meter.sendCostByTurn.t2).toBe(0.001)
  })

  test('slot_error adds nothing (no usage) and slot_done under another feature is ignored', () => {
    let s = applyEvents('send', [sample.turnStart(), sample.slotError('grok')])
    expect(s.meter.send.calls).toBe(0)
    s = applyEvents('fusion', [sample.slotDone('claude')], { state: s })
    expect(s.meter.send.calls).toBe(0)
    expect(s.meter.last.send.calls).toBe(0)
  })

  test('analyze_done adds turn.usage.totals; a cached hit is ignored and reads as a zero-cost last invocation', () => {
    let s = applyEvents('analyze', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }])
    expect(s.meter.analyze).toEqual(ANALYZE_ROW)
    expect(s.meter.last.analyze).toEqual(ANALYZE_ROW)
    expect(s.meter.total.cost_usd).toBe(0.0005)
    s = applyEvents('analyze', [{ type: 'analyze_start', turn_id: 'a1', of_turn: 't1' }, { type: 'analyze_done', turn: ANALYZE_TURN, cached: true }], { state: s })
    expect(s.meter.analyze).toEqual(ANALYZE_ROW)
    expect(s.meter.last.analyze).toEqual(emptyRow())
    expect(s.meter.analyzeOfTurn).toEqual({ a1: 't1' })
  })

  test('analyze_done routed through a fusion stream (auto-run) still books under Analyze', () => {
    const s = applyEvents('fusion', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }])
    expect(s.meter.analyze.calls).toBe(1)
    expect(s.meter.last.analyze.calls).toBe(1)
    expect(s.meter.fusion.calls).toBe(0)
  })

  test('analyze_degraded books the persisted (paid-for) attempts', () => {
    const degraded = { ...ANALYZE_TURN, status: 'degraded', error: 'boom', usage: featureUsage({ cost_usd: 0.001, calls: 2 }) }
    const s = applyEvents('analyze', [{ type: 'analyze_degraded', turn: degraded }])
    expect(s.meter.analyze).toMatchObject({ cost_usd: 0.001, calls: 2 })
    expect(s.meter.last.analyze).toMatchObject({ cost_usd: 0.001, calls: 2 })
  })

  test('fusion_done adds usage.totals to the Fusion row and the total sums all rows', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('analyze', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }], { state: s })
    s = applyEvents('fusion', [{ type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] }, { type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    expect(s.meter.fusion).toEqual(FUSION_ROW)
    expect(s.meter.last.fusion).toEqual(FUSION_ROW)
    expect(s.meter.total).toEqual({ prompt_tokens: 1030, completion_tokens: 410, reasoning_tokens: 52, cost_usd: 0.0155, latency_ms: 11000, calls: 11, truncated: 1 })
  })

  test('the multiplier denominator is the Send the fused Analyze looked at, not the cumulative Send', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('send', sendEvents('t2'), { state: s })
    expect(s.meter.send.cost_usd).toBe(0.006)
    s = applyEvents('analyze', [{ type: 'analyze_start', turn_id: 'a1', of_turn: 't1' }, { type: 'analyze_done', turn: ANALYZE_TURN, cached: false }], { state: s })
    s = applyEvents('fusion', [{ type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] }, { type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    expect(s.meter.fusedSendCost).toBe(0.003)
    expect(s.meter.last.send).toEqual(SEND_ROW) // t2 only
    expect(s.meter.last.fusion.cost_usd).toBe(0.012)
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveTextContent('×4.0 vs Send') // 0.012 / 0.003, not 0.012 / 0.006
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveAttribute('title', expect.stringContaining("this Fusion's cost divided by the fused Send's cost"))
    expect(screen.getByTestId('meter-send-conv-cost')).toHaveTextContent('$0.00600')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0.00300')
  })

  test('a second Fusion resets the last Fusion row and re-resolves its fused Send', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('fusion', [{ type: 'analyze_start', turn_id: 'a1', of_turn: 't1' }, { type: 'analyze_done', turn: ANALYZE_TURN, cached: false }, { type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] }, { type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    s = applyEvents('send', sendEvents('t2').map((ev) => (ev.type === 'slot_done' ? { ...ev, usage: { ...ev.usage, cost_usd: 0.002 } } : ev)), { state: s })
    const cheap = featureUsage({ cost_usd: 0.003, calls: 3 })
    s = applyEvents('fusion', [{ type: 'analyze_start', turn_id: 'a2', of_turn: 't2' }, { type: 'analyze_done', turn: { ...ANALYZE_TURN, id: 'a2', of_turn: 't2' }, cached: false }, { type: 'fusion_start', turn_id: 'f2', of_analyze: 'a2', max_iterations: 1, standing: ['d1'] }], { state: s })
    expect(s.meter.last.fusion).toEqual(emptyRow())
    expect(s.meter.fusedSendCost).toBe(0.006)
    s = applyEvents('fusion', [{ type: 'fusion_done', turn: { ...FUSION_TURN, id: 'f2', of_analyze: 'a2', usage: cheap }, exit_reason: 'stalemate', usage: cheap }], { state: s })
    expect(s.meter.last.fusion).toMatchObject({ cost_usd: 0.003, calls: 3 })
    expect(s.meter.fusion).toMatchObject({ cost_usd: 0.015, calls: 10 })
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveTextContent('×0.5 vs Send')
  })

  test('fusion_done without a top-level usage falls back to turn.usage; without fusion_start the fused Send is the last Send', () => {
    let s = applyEvents('fusion', [{ type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'error' }])
    expect(s.meter.fusion.calls).toBe(7)
    expect(s.meter.fusedSendCost).toBe(0) // no Send at all: no multiplier
    s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('fusion', [{ type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    expect(s.meter.fusedSendCost).toBe(0.003)
  })

  test('untouched actions keep slice identity', () => {
    const s0 = applyEvents('send', [])
    const s1 = meterReducer(s0.meter, { type: 'sse', feature: 'send', event: sample.slotDelta('claude', 'x') })
    expect(s1).toBe(s0.meter)
    expect(meterReducer(s0.meter, { type: 'noop' })).toBe(s0.meter)
  })
})

describe('meter slice: conversation lifecycle', () => {
  const CONV = {
    id: 'c1',
    title: 'T',
    slot_config: CFG,
    threads: { claude: [], chatgpt: [], grok: [] },
    turns: [
      sendTurn('t1', 0.003, { truncated: { claude: false, chatgpt: true, grok: false } }),
      {
        id: 't2',
        type: 'continue',
        slot: 'grok',
        prompt: 'more',
        response: 'r',
        truncated: true,
        slot_config: CFG,
        usage: featureUsage({ prompt_tokens: 10, completion_tokens: 20, cost_usd: 0.001, latency_ms: 700, calls: 1 }),
      },
      ANALYZE_TURN,
      FUSION_TURN,
    ],
  }

  test('conversation/loaded recomputes every row, the last rows and the turn maps from the persisted turns', () => {
    const s = applyEvents('send', SEND_EVENTS.concat([{ type: 'conversation/loaded', conversation: CONV }]))
    expect(s.meter.conversationId).toBe('c1')
    expect(s.meter.send).toEqual({ prompt_tokens: 40, completion_tokens: 80, reasoning_tokens: 0, cost_usd: 0.004, latency_ms: 1500, calls: 4, truncated: 2 })
    expect(s.meter.analyze).toMatchObject({ prompt_tokens: 100, cost_usd: 0.0005, calls: 1 })
    expect(s.meter.fusion).toMatchObject({ prompt_tokens: 900, cost_usd: 0.012, calls: 7 })
    expect(s.meter.total).toMatchObject({ cost_usd: 0.0165, calls: 12, truncated: 2 })
    // last Send = the newest send|continue turn (the continue), not the sum
    expect(s.meter.last.send).toEqual({ prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0, cost_usd: 0.001, latency_ms: 700, calls: 1, truncated: 1 })
    expect(s.meter.last.analyze).toEqual(ANALYZE_ROW)
    expect(s.meter.last.fusion).toEqual(FUSION_ROW)
    expect(s.meter.sendCostByTurn).toEqual({ t1: 0.003, t2: 0.001 })
    expect(s.meter.analyzeOfTurn).toEqual({ a1: 't1' })
    expect(s.meter.fusedSendCost).toBe(0.003) // f1 -> a1 -> t1
    expect(rowsFromConversation(CONV).send.calls).toBe(4)
    expect(meterFromConversation(null)).toMatchObject({ send: emptyRow(), last: { send: emptyRow() }, sendCostByTurn: {}, fusedSendCost: 0 })
  })

  test('a reloaded conversation with two sends shows the multiplier against the fused Send and the newest Send as last', () => {
    const conv = { ...CONV, turns: [sendTurn('t1', 0.003), sendTurn('t2', 0.002, { usage: featureUsage({ prompt_tokens: 20, completion_tokens: 40, cost_usd: 0.002, latency_ms: 600, calls: 3 }) }), ANALYZE_TURN, FUSION_TURN] }
    const s = applyEvents('send', [{ type: 'conversation/loaded', conversation: conv }])
    expect(s.meter.send.cost_usd).toBe(0.005)
    expect(s.meter.last.send).toEqual({ prompt_tokens: 20, completion_tokens: 40, reasoning_tokens: 0, cost_usd: 0.002, latency_ms: 600, calls: 3, truncated: 0 })
    expect(s.meter.fusedSendCost).toBe(0.003)
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveTextContent('×4.0 vs Send') // 0.012 / 0.003
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0.00200')
    expect(screen.getByTestId('meter-send-conv-cost')).toHaveTextContent('$0.00500')
  })

  test('a fusion turn whose analyze chain is unknown falls back to the newest Send', () => {
    const conv = { ...CONV, turns: [sendTurn('t1', 0.003), { ...FUSION_TURN, of_analyze: 'missing' }] }
    expect(meterFromConversation(conv).fusedSendCost).toBe(0.003)
  })

  test('cleared / deleted current conversation resets the rows; deleting another does not', () => {
    let s = applyEvents('send', [{ type: 'conversation/loaded', conversation: CONV }])
    const before = s.meter
    s = applyEvents('send', [{ type: 'conversation/deleted', id: 'other' }], { state: s })
    expect(s.meter).toBe(before)
    s = applyEvents('send', [{ type: 'conversation/deleted', id: 'c1' }], { state: s })
    expect(s.meter.total.calls).toBe(0)
    expect(s.meter.conversationId).toBeNull()
    expect(s.meter).toEqual(initialMeter())
    s = applyEvents('send', [{ type: 'conversation/loaded', conversation: CONV }, { type: 'conversation/cleared' }], { state: s })
    expect(s.meter.send).toEqual(initialMeter().send)
    expect(s.meter.last.fusion).toEqual(emptyRow())
    expect(s.meter.fusedSendCost).toBe(0)
    expect(s.meter.sendCostByTurn).toEqual({})
  })

  test('a conversation/loaded mid-stream is transient: the post-stream reload matches the persisted turns', () => {
    const persisted = { ...CONV, turns: [sendTurn('t1', 0.003), sendTurn('t2', 0.003, { truncated: { claude: false, chatgpt: false, grok: true }, usage: featureUsage({ prompt_tokens: 30, completion_tokens: 60, reasoning_tokens: 7, cost_usd: 0.003, latency_ms: 800, calls: 3 }) })] }
    const events = sendEvents('t2')
    const half = events.slice(0, 6) // turn_start .. first slot_done
    let s = applyEvents('send', [{ type: 'conversation/loaded', conversation: { ...CONV, turns: [sendTurn('t1', 0.003)] } }].concat(half))
    s = applyEvents('send', [{ type: 'conversation/loaded', conversation: { ...CONV, turns: [sendTurn('t1', 0.003)] } }].concat(events.slice(6)), { state: s })
    expect(s.meter.send.calls).toBe(5) // one live slot_done was dropped by the mid-stream reload
    s = applyEvents('send', [{ type: 'conversation/loaded', conversation: persisted }], { state: s })
    expect(s.meter.send).toEqual(rowsFromConversation(persisted).send)
    expect(s.meter.last.send).toEqual(meterFromConversation(persisted).last.send)
  })

  test('the cost-cap flag survives a reload', () => {
    let s = applyEvents('send', [{ ...sample.slotError('grok'), code: 'cost_cap_exceeded', error_type: 'triplex' }])
    expect(s.meter.costCapExceeded).toBe(true)
    s = applyEvents('send', [{ type: 'conversation/loaded', conversation: CONV }], { state: s })
    expect(s.meter.costCapExceeded).toBe(true)
  })
})

describe('cost-cap detection', () => {
  test('a plain slot_error does not set the flag; the cost_cap_exceeded code does, from any event shape', () => {
    expect(applyEvents('send', [sample.slotError('grok')]).meter.costCapExceeded).toBe(false)
    expect(carriesCostCap({ type: 'slot_error', slot: 'grok', code: 'cost_cap_exceeded' })).toBe(true)
    expect(carriesCostCap({ type: 'error', message: 'cost_cap_exceeded' })).toBe(true)
    expect(carriesCostCap({ type: 'analyze_retry', error: 'cost_cap_exceeded: session total 10.2 > 10' })).toBe(true)
    expect(carriesCostCap({ type: 'exchange', round: 1, divergence_id: 'd1', model: 'R3', stance: 'unavailable', error: 'cost_cap_exceeded' })).toBe(true)
    expect(carriesCostCap({ type: 'analyze_degraded', turn: { ...ANALYZE_TURN, status: 'degraded', error: 'cost_cap_exceeded' } })).toBe(true)
    expect(carriesCostCap({ type: 'slot_error', code: 502, message: 'Provider disconnected' })).toBe(false)
  })
})

describe('CostMeter pane', () => {
  test('renders last-invocation and conversation groups per feature, a total, the fusion multiplier, truncation count', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('send', sendEvents('t2'), { state: s })
    s = applyEvents('analyze', [{ type: 'analyze_start', turn_id: 'a1', of_turn: 't2' }, { type: 'analyze_done', turn: { ...ANALYZE_TURN, of_turn: 't2' }, cached: false }], { state: s })
    s = applyEvents('fusion', [{ type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] }, { type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-group-last')).toHaveTextContent('last invocation')
    expect(screen.getByTestId('meter-group-conv')).toHaveTextContent('this conversation')
    expect(screen.getByTestId('meter-row-send')).toHaveTextContent('Send')
    // last invocation (the second send)
    expect(screen.getByTestId('meter-send-tokens')).toHaveTextContent('30 / 60')
    expect(screen.getByTestId('meter-send-tokens')).toHaveTextContent('+7 reasoning')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0.00300')
    expect(screen.getByTestId('meter-send-latency')).toHaveTextContent('800 ms')
    expect(screen.getByTestId('meter-send-calls')).toHaveTextContent('3')
    // this conversation (both sends)
    expect(screen.getByTestId('meter-send-conv-tokens')).toHaveTextContent('60 / 120')
    expect(screen.getByTestId('meter-send-conv-cost')).toHaveTextContent('$0.00600')
    expect(screen.getByTestId('meter-send-conv-latency')).toHaveTextContent('1.6 s')
    expect(screen.getByTestId('meter-send-conv-calls')).toHaveTextContent('6')
    expect(screen.getByTestId('meter-analyze-calls')).toHaveTextContent('1')
    expect(screen.getByTestId('meter-fusion-calls')).toHaveTextContent('7')
    expect(screen.getByTestId('meter-fusion-latency')).toHaveTextContent('9.0 s')
    expect(screen.getByTestId('meter-fusion-cost')).toHaveTextContent('$0.0120')
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveTextContent('×4.0 vs Send')
    expect(screen.getByTestId('meter-fusion-conv-cost')).not.toHaveTextContent('vs Send')
    expect(screen.getByTestId('meter-total-conv-cost')).toHaveTextContent('$0.0185')
    expect(screen.getByTestId('meter-total-conv-calls')).toHaveTextContent('14')
    expect(screen.getByTestId('meter-truncated')).toHaveTextContent('truncated replies: 2')
    expect(screen.queryByTestId('meter-cost-cap')).toBeNull()
  })

  test('renders zeros with no multiplier when idle', () => {
    renderWithStore(<CostMeter />)
    expect(screen.getByTestId('meter-row-total')).toHaveTextContent('$0')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0')
    expect(screen.queryByTestId('meter-fusion-multiplier')).toBeNull()
    expect(screen.getByTestId('meter-truncated')).toHaveTextContent('truncated replies: 0')
  })

  test('tolerates a pre-fix meter shape without last rows', () => {
    const { last, sendCostByTurn, analyzeOfTurn, fusedSendCost, ...legacy } = applyEvents('send', SEND_EVENTS).meter
    renderWithStore(<CostMeter />, { preloaded: { meter: legacy } })
    expect(screen.getByTestId('meter-send-conv-cost')).toHaveTextContent('$0.00300')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0')
    expect(screen.queryByTestId('meter-fusion-multiplier')).toBeNull()
  })

  test('shows the persistent cost-cap warning', () => {
    const s = applyEvents('send', [{ ...sample.slotError('claude'), code: 'cost_cap_exceeded' }])
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-cost-cap')).toHaveTextContent(/cost cap exceeded/i)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
