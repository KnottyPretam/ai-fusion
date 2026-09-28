// Council (2026-09-27): the Fusion gate judges a send turn against its OWN council (a two-agent
// turn used to be "incomplete" for ever against a fixed three — the one functional bug), and the
// final report shows every label that holds a position, R4 / R5 included.
import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import FusionPane from './index.jsx'
import { LABELS, councilOfTurn, councilSize, fusionGate, isSendComplete, labelsFor, labelsWithPosition } from './derive.js'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import { EXTRACTION, SLOT_CONFIG, USAGE, analyzeTurn, conversation, exchange, fusionStart, fusionTurnFromEvents, roundDone, sendTurn } from './fixtures.js'

const idle = { send: { status: 'idle' }, analyze: { status: 'idle' }, fusion: { status: 'idle' } }
const CFG2 = { ...SLOT_CONFIG, slots: { chatgpt: SLOT_CONFIG.slots.chatgpt, qwen: { model: 'vendor-q/model-q', effort: 'off' } } }
const CFG5 = { ...SLOT_CONFIG, slots: { ...SLOT_CONFIG.slots, gemini: { model: 'd', effort: 'off' }, mimo: { model: 'e', effort: 'off' } } }

describe('derive.js over a council', () => {
  test('LABELS / labelsFor / councilSize', () => {
    expect(LABELS).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(labelsFor(2)).toEqual(['R1', 'R2'])
    expect(labelsFor(5)).toEqual(LABELS)
    expect(councilSize({ ...sendTurn(), slot_config: CFG5 })).toBe(5)
    expect(councilOfTurn({ ...sendTurn('s1', { qwen: 'y', chatgpt: 'x' }), slot_config: CFG2 })).toEqual(['chatgpt', 'qwen'])
  })

  test("isSendComplete: a two-council turn with two replies IS complete; a five-council needs all five", () => {
    const two = { ...sendTurn('s1', { chatgpt: 'x', qwen: 'y' }), slot_config: CFG2 }
    expect(isSendComplete(two)).toBe(true)
    expect(isSendComplete({ ...two, responses: { chatgpt: 'x', qwen: null } })).toBe(false)
    const five = { ...sendTurn('s1', { claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', mimo: 'e' }), slot_config: CFG5 }
    expect(isSendComplete(five)).toBe(true)
    expect(isSendComplete({ ...five, responses: { ...five.responses, mimo: undefined } })).toBe(false)
    // the classic three, unchanged
    expect(isSendComplete(sendTurn())).toBe(true)
    expect(isSendComplete(sendTurn('s1', { claude: 'a', chatgpt: null, grok: 'c' }))).toBe(false)
  })

  test('fusionGate enables on a complete two-council turn (auto-Analyze) and a five-council with an ok Analyze', () => {
    const two = { ...sendTurn('s1', { chatgpt: 'x', qwen: 'y' }), slot_config: CFG2 }
    const conv2 = { ...conversation([two]), slot_config: CFG2, threads: { chatgpt: [], qwen: [] } }
    expect(fusionGate({ conversation: conv2, slotConfig: CFG2, streams: idle })).toMatchObject({ enabled: true, autoAnalyze: true })
    const five = { ...sendTurn('s1', { claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', mimo: 'e' }), slot_config: CFG5 }
    const conv5 = { ...conversation([five, analyzeTurn()]), slot_config: CFG5 }
    expect(fusionGate({ conversation: conv5, slotConfig: CFG5, streams: idle })).toMatchObject({ enabled: true, autoAnalyze: false, standing: ['d1', 'd2'] })
    const short = { ...five, responses: { ...five.responses, gemini: null } }
    expect(fusionGate({ conversation: { ...conv5, turns: [short] }, slotConfig: CFG5, streams: idle })).toMatchObject({ enabled: false, reason: 'latest send turn is incomplete' })
  })
})

describe('FusionPane over a five-council', () => {
  test('a standing divergence shows every label with a position, R4 and R5 included, and the export stays R-labelled', () => {
    const five = { ...sendTurn('s1', { claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', mimo: 'e' }), slot_config: CFG5 }
    const extraction = {
      ...EXTRACTION,
      divergences: [{ ...EXTRACTION.divergences[0], positions: [...EXTRACTION.divergences[0].positions, { model: 'R4', claim: 'Selectable to 250.', evidence_cited: null }, { model: 'R5', claim: 'Not selectable.', evidence_cited: 'the box' }] }],
    }
    const conv = { ...conversation([five, analyzeTurn('a1', 's1', extraction)]), slot_config: CFG5 }
    const div = extraction.divergences[0]
    expect(labelsWithPosition(div)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    const body = [fusionStart({ standing: ['d1'], max_iterations: 1 }), { type: 'round_start', round: 1 }, ...['R1', 'R2', 'R3', 'R4', 'R5'].map((l) => exchange(1, 'd1', l, 'defend')), roundDone(1, { d1: 'standing' }, false)]
    const turn = { ...fusionTurnFromEvents(body, { max_iterations: 1, exit_reason: 'stalemate' }), slot_config: CFG5 }
    const run = [...body, { type: 'fusion_done', turn, exit_reason: 'stalemate', usage: USAGE }]
    const state = applyEvents('fusion', [{ type: 'conversation/loaded', conversation: conv }, ...run])
    renderWithStore(<FusionPane />, { preloaded: state })
    for (const l of ['R1', 'R2', 'R3', 'R4', 'R5']) {
      expect(screen.getByTestId(`fusion-exchange-d1-1-${l}`)).toHaveAttribute('data-stance', 'defend')
      expect(screen.getByTestId(`fusion-side-d1-${l}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('fusion-side-d1-R5')).toHaveTextContent('Not selectable.')
    expect(screen.getByTestId('fusion-trace-d1')).toHaveTextContent('R1 defends → R2 defends → R3 defends → R4 defends → R5 defends → standing, round 1')
    // Plan (2026-09-27): the section under the report carries the ONE control that names agents by
    // design — the picker of who writes the plan (and the "made by" echo of that pick), like the
    // Send columns and the analyst picker; it cannot say which R-label is which. Everything else
    // in the pane stays label-free.
    const root = screen.getByTestId('fusion-root').cloneNode(true)
    for (const n of root.querySelectorAll('[data-testid="plan-model"], [data-testid="plan-model-used"]')) n.remove()
    expect(root.textContent).not.toMatch(/\b(claude|chatgpt|grok|gemini|mimo|xiaomi)\b/i)
  })
})
