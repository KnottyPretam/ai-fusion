import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import CostMeter from './index.jsx' // registers the 'meter' slice at module scope
import { carriesCostCap, initialMeter, meterReducer, rowsFromConversation } from './slice.js'
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

const SEND_EVENTS = [
  sample.turnStart('t1'),
  sample.slotStart('claude'),
  sample.slotStart('chatgpt'),
  sample.slotStart('grok'),
  sample.slotDelta('claude', 'hi'),
  sample.slotDone('claude'),
  sample.slotDone('chatgpt'),
  { ...sample.slotDone('grok', { reasoning_tokens: 7 }), finish_reason: 'length', truncated: true },
  sample.turnDone('t1'),
]

describe('meter slice: streams', () => {
  test('initial state has the four rows and no warning', () => {
    const s = applyEvents('send', [])
    expect(s.meter).toEqual(initialMeter())
  })

  test('slot_done events aggregate into the Send row; turn_done supplies the wall-clock latency', () => {
    const s = applyEvents('send', SEND_EVENTS)
    expect(s.meter.send).toEqual({ prompt_tokens: 30, completion_tokens: 60, reasoning_tokens: 7, cost_usd: 0.003, latency_ms: 800, calls: 3, truncated: 1 })
    expect(s.meter.analyze).toEqual(initialMeter().analyze)
    expect(s.meter.total).toEqual(s.meter.send)
    expect(s.meter.costCapExceeded).toBe(false)
  })

  test('a continue stream (feature send, one slot) books under the Send row too', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('send', [{ ...sample.turnStart('t2'), feature: 'continue', slots: ['grok'] }, sample.slotStart('grok'), sample.slotDone('grok'), sample.turnDone('t2')], { state: s })
    expect(s.meter.send).toMatchObject({ prompt_tokens: 40, completion_tokens: 80, cost_usd: 0.004, latency_ms: 1600, calls: 4, truncated: 1 })
  })

  test('slot_error adds nothing (no usage) and slot_done under another feature is ignored', () => {
    let s = applyEvents('send', [sample.turnStart(), sample.slotError('grok')])
    expect(s.meter.send.calls).toBe(0)
    s = applyEvents('fusion', [sample.slotDone('claude')], { state: s })
    expect(s.meter.send.calls).toBe(0)
  })

  test('analyze_done adds turn.usage.totals; a cached hit is ignored', () => {
    let s = applyEvents('analyze', [{ type: 'analyze_start', turn_id: 'a1', of_turn: 't1' }, { type: 'analyze_done', turn: ANALYZE_TURN, cached: true }])
    expect(s.meter.analyze).toEqual(initialMeter().analyze)
    s = applyEvents('analyze', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }], { state: s })
    expect(s.meter.analyze).toEqual({ prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 5, cost_usd: 0.0005, latency_ms: 1200, calls: 1, truncated: 0 })
    expect(s.meter.total.cost_usd).toBe(0.0005)
  })

  test('analyze_done routed through a fusion stream (auto-run) still books under Analyze', () => {
    const s = applyEvents('fusion', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }])
    expect(s.meter.analyze.calls).toBe(1)
    expect(s.meter.fusion.calls).toBe(0)
  })

  test('analyze_degraded books the persisted (paid-for) attempts', () => {
    const degraded = { ...ANALYZE_TURN, status: 'degraded', error: 'boom', usage: featureUsage({ cost_usd: 0.001, calls: 2 }) }
    const s = applyEvents('analyze', [{ type: 'analyze_degraded', turn: degraded }])
    expect(s.meter.analyze).toMatchObject({ cost_usd: 0.001, calls: 2 })
  })

  test('fusion_done adds usage.totals to the Fusion row and the total sums all rows', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('analyze', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }], { state: s })
    s = applyEvents('fusion', [{ type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] }, { type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    expect(s.meter.fusion).toEqual({ prompt_tokens: 900, completion_tokens: 300, reasoning_tokens: 40, cost_usd: 0.012, latency_ms: 9000, calls: 7, truncated: 0 })
    expect(s.meter.total).toEqual({ prompt_tokens: 1030, completion_tokens: 410, reasoning_tokens: 52, cost_usd: 0.0155, latency_ms: 11000, calls: 11, truncated: 1 })
  })

  test('fusion_done without a top-level usage falls back to turn.usage', () => {
    const s = applyEvents('fusion', [{ type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'error' }])
    expect(s.meter.fusion.calls).toBe(7)
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
      {
        id: 't1',
        type: 'send',
        prompt: 'q',
        responses: { claude: 'a', chatgpt: 'b', grok: 'c' },
        truncated: { claude: false, chatgpt: true, grok: false },
        slot_config: CFG,
        usage: featureUsage({ prompt_tokens: 30, completion_tokens: 60, cost_usd: 0.003, latency_ms: 800, calls: 3 }),
      },
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

  test('conversation/loaded recomputes every row from the persisted turns', () => {
    const s = applyEvents('send', SEND_EVENTS.concat([{ type: 'conversation/loaded', conversation: CONV }]))
    expect(s.meter.conversationId).toBe('c1')
    expect(s.meter.send).toEqual({ prompt_tokens: 40, completion_tokens: 80, reasoning_tokens: 0, cost_usd: 0.004, latency_ms: 1500, calls: 4, truncated: 2 })
    expect(s.meter.analyze).toMatchObject({ prompt_tokens: 100, cost_usd: 0.0005, calls: 1 })
    expect(s.meter.fusion).toMatchObject({ prompt_tokens: 900, cost_usd: 0.012, calls: 7 })
    expect(s.meter.total).toMatchObject({ cost_usd: 0.0165, calls: 12, truncated: 2 })
    expect(rowsFromConversation(CONV).send.calls).toBe(4)
  })

  test('cleared / deleted current conversation resets the rows; deleting another does not', () => {
    let s = applyEvents('send', [{ type: 'conversation/loaded', conversation: CONV }])
    const before = s.meter
    s = applyEvents('send', [{ type: 'conversation/deleted', id: 'other' }], { state: s })
    expect(s.meter).toBe(before)
    s = applyEvents('send', [{ type: 'conversation/deleted', id: 'c1' }], { state: s })
    expect(s.meter.total.calls).toBe(0)
    expect(s.meter.conversationId).toBeNull()
    s = applyEvents('send', [{ type: 'conversation/loaded', conversation: CONV }, { type: 'conversation/cleared' }], { state: s })
    expect(s.meter.send).toEqual(initialMeter().send)
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
  test('renders one row per feature plus total, the fusion multiplier, truncation count', () => {
    let s = applyEvents('send', SEND_EVENTS)
    s = applyEvents('analyze', [{ type: 'analyze_done', turn: ANALYZE_TURN, cached: false }], { state: s })
    s = applyEvents('fusion', [{ type: 'fusion_done', turn: FUSION_TURN, exit_reason: 'converged', usage: FUSION_USAGE }], { state: s })
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-row-send')).toHaveTextContent('Send')
    expect(screen.getByTestId('meter-send-tokens')).toHaveTextContent('30 / 60')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0.00300')
    expect(screen.getByTestId('meter-send-latency')).toHaveTextContent('800 ms')
    expect(screen.getByTestId('meter-send-calls')).toHaveTextContent('3')
    expect(screen.getByTestId('meter-analyze-calls')).toHaveTextContent('1')
    expect(screen.getByTestId('meter-fusion-calls')).toHaveTextContent('7')
    expect(screen.getByTestId('meter-fusion-latency')).toHaveTextContent('9.0 s')
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveTextContent('×4.0 vs Send')
    expect(screen.getByTestId('meter-total-cost')).toHaveTextContent('$0.0155')
    expect(screen.getByTestId('meter-total-calls')).toHaveTextContent('11')
    expect(screen.getByTestId('meter-truncated')).toHaveTextContent('truncated replies: 1')
    expect(screen.queryByTestId('meter-cost-cap')).toBeNull()
  })

  test('renders zeros with no multiplier when idle', () => {
    renderWithStore(<CostMeter />)
    expect(screen.getByTestId('meter-row-total')).toHaveTextContent('$0')
    expect(screen.queryByTestId('meter-fusion-multiplier')).toBeNull()
    expect(screen.getByTestId('meter-truncated')).toHaveTextContent('truncated replies: 0')
  })

  test('shows the persistent cost-cap warning', () => {
    const s = applyEvents('send', [{ ...sample.slotError('claude'), code: 'cost_cap_exceeded' }])
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    expect(screen.getByTestId('meter-cost-cap')).toHaveTextContent(/cost cap exceeded/i)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
