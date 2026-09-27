// Council (2026-09-27): labels follow the analyzed send turn's council size (R1..Rn), a turn is
// complete against its OWN council, and the prose reads the count. The three-slot cases stay in
// slice.test.js / AnalyzePane.test.jsx; this file adds the 2- and 5-member ones.
import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import AnalyzePane from './index.jsx'
import { repliesHeading } from './RefactorView.jsx'
import { LABELS as REFACTOR_LABELS, councilSize as refactorCouncilSize, labelsFor as refactorLabelsFor } from './refactorSlice.js'
import { LABELS, councilOfTurn, councilSize, councilSizeFor, countWord, isSendTurnComplete, labelsFor, sendTurnFor } from './slice.js'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import { EXTRACTION, analyzeTurn, conversation, events, sendTurn } from './fixtures.js'

const CFG2 = { slots: { chatgpt: { model: 'vendor-b/model-b', effort: 'medium' }, qwen: { model: 'vendor-q/model-q', effort: 'off' } }, analyst_model: 'vendor-b/analyst', max_iterations: 2, materiality_min: 'medium', grounded: false }
const CFG5 = {
  slots: { claude: { model: 'a', effort: 'off' }, chatgpt: { model: 'b', effort: 'off' }, grok: { model: 'c', effort: 'off' }, gemini: { model: 'd', effort: 'off' }, deepseek: { model: 'e', effort: 'off' } },
  analyst_model: 'vendor-b/analyst',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}
const send2 = (responses = { chatgpt: 'x', qwen: 'y' }) => sendTurn({ slot_config: CFG2, responses })
const send5 = (responses = { claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', deepseek: 'e' }) => sendTurn({ slot_config: CFG5, responses })

describe('label and council helpers', () => {
  test('LABELS is R1..R5 in both slices; labelsFor clamps to 2..5 and reads unknown as three', () => {
    expect(LABELS).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(REFACTOR_LABELS).toEqual(LABELS)
    expect(labelsFor(2)).toEqual(['R1', 'R2'])
    expect(labelsFor(3)).toEqual(['R1', 'R2', 'R3'])
    expect(labelsFor(5)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(labelsFor(6)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(labelsFor(1)).toEqual(['R1', 'R2', 'R3'])
    expect(labelsFor(undefined)).toEqual(['R1', 'R2', 'R3'])
    expect(refactorLabelsFor(2)).toEqual(['R1', 'R2'])
    expect(countWord(2)).toBe('two')
    expect(countWord(5)).toBe('five')
    expect(countWord(9)).toBe('9')
  })

  test("councilOfTurn / councilSize read the turn's slot_config in catalog order, else its responses; 3 when unknown", () => {
    expect(councilOfTurn(send5())).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'deepseek'])
    expect(councilOfTurn(send2())).toEqual(['chatgpt', 'qwen'])
    expect(councilOfTurn({ responses: { qwen: null, grok: 'x' } })).toEqual(['grok', 'qwen'])
    expect(councilOfTurn(null)).toEqual([])
    expect(councilSize(send5())).toBe(5)
    expect(councilSize(send2())).toBe(2)
    expect(councilSize(sendTurn())).toBe(3)
    expect(councilSize(null)).toBe(3)
    expect(councilSize({ responses: { grok: 'x' } })).toBe(3) // one reply is no council: the default
    // before the first Send the open conversation's own config is the council
    expect(councilSizeFor(send5(), CFG2)).toBe(5)
    expect(councilSizeFor(null, CFG2)).toBe(2)
    expect(councilSizeFor(null, CFG5)).toBe(5)
    expect(councilSizeFor(null, null)).toBe(3)
    expect(councilSizeFor(null, { slots: null })).toBe(3)
    expect(refactorCouncilSize(send2())).toBe(2)
  })

  test("isSendTurnComplete judges the turn's OWN council: two replies complete a two-council, a five-council needs five", () => {
    expect(isSendTurnComplete(send2())).toBe(true)
    expect(isSendTurnComplete(send2({ chatgpt: 'x', qwen: null }))).toBe(false)
    expect(isSendTurnComplete(send2({ chatgpt: 'x' }))).toBe(false) // the council says qwen; no reply at all
    expect(isSendTurnComplete(send5())).toBe(true)
    expect(isSendTurnComplete(send5({ claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', deepseek: null }))).toBe(false)
    // a stray extra reply outside the council does not count either way
    expect(isSendTurnComplete(send2({ chatgpt: 'x', qwen: 'y', grok: null }))).toBe(true)
  })

  test('sendTurnFor finds the send turn an analyze turn names, else the latest send turn', () => {
    const conv = conversation([send5(), sendTurn({ id: 's2' })])
    expect(sendTurnFor(conv, 's1').slot_config).toBe(CFG5)
    expect(sendTurnFor(conv, 'nope').id).toBe('s2')
    expect(sendTurnFor(conv, null).id).toBe('s2')
    expect(sendTurnFor(null, 's1')).toBeNull()
  })

  test('repliesHeading reads the count in words (three stays as it was)', () => {
    expect(repliesHeading(3)).toBe('The three responses, reduced')
    expect(repliesHeading(2)).toBe('The two responses, reduced')
    expect(repliesHeading(5)).toBe('The five responses, reduced')
  })
})

describe('AnalyzePane over a council', () => {
  test('a two-council report has two Differs columns; the hint and the Refactor titles read "two"', () => {
    const extraction = {
      agreements: [{ topic: 'units', statement: 'deg/s', models: ['R1', 'R2'] }],
      divergences: [{ id: 'd1', topic: 'maximum range', positions: [{ model: 'R1', claim: 'Up to 2000.', evidence_cited: null }, { model: 'R2', claim: 'Up to 1000.', evidence_cited: null }], materiality: 'high' }],
    }
    const conv = conversation([send2()], { slot_config: CFG2, threads: { chatgpt: [], qwen: [] } })
    const state = applyEvents('analyze', [events.loaded(conv), events.done(analyzeTurn({ extraction, slot_config: CFG2 }))])
    renderWithStore(<AnalyzePane />, { preloaded: state })
    const heads = [...screen.getByTestId('analyze-divergences').querySelectorAll('thead th')].map((th) => th.textContent)
    expect(heads).toEqual(['topic', 'R1', 'R2', 'materiality'])
    expect(screen.getByTestId('analyze-cell-d1-R2')).toHaveTextContent('Up to 1000.')
    expect(screen.queryByTestId('analyze-cell-d1-R3')).toBeNull()
    expect(screen.getByTestId('refactor-run')).toHaveAttribute('title', 'Map the question into a knowledge graph, restate it concisely, and reduce all two answers to their claims. Analyze then compares that instead of the whole answers.')
    expect(screen.getByTestId('analyze-run')).toBeEnabled() // two replies complete the two-council
  })

  test('a two-council with no send turn yet reads "two" from its own slot config, not the fixed three', () => {
    const conv = conversation([], { slot_config: CFG2, threads: { chatgpt: [], qwen: [] } })
    renderWithStore(<AnalyzePane />, { preloaded: applyEvents('analyze', [events.loaded(conv)]) })
    expect(screen.getByTestId('refactor-run')).toHaveAttribute('title', 'Map the question into a knowledge graph, restate it concisely, and reduce all two answers to their claims. Analyze then compares that instead of the whole answers.')
    expect(screen.getByTestId('refactor-run')).toBeDisabled()
  })

  test('a five-council report has five Differs columns and the incomplete hint says "all five responses"', () => {
    const extraction = { ...EXTRACTION, divergences: [{ ...EXTRACTION.divergences[0], positions: [...EXTRACTION.divergences[0].positions, { model: 'R5', claim: 'Up to 4000.', evidence_cited: null }] }] }
    const conv = conversation([send5()], { slot_config: CFG5 })
    const state = applyEvents('analyze', [events.loaded(conv), events.done(analyzeTurn({ extraction, slot_config: CFG5 }))])
    const { unmount } = renderWithStore(<AnalyzePane />, { preloaded: state })
    const heads = [...screen.getByTestId('analyze-divergences').querySelectorAll('thead th')].map((th) => th.textContent)
    expect(heads).toEqual(['topic', 'R1', 'R2', 'R3', 'R4', 'R5', 'materiality'])
    expect(screen.getByTestId('analyze-cell-d1-R5')).toHaveTextContent('Up to 4000.')
    expect(screen.getByTestId('analyze-cell-d1-R4')).toHaveTextContent('—')
    unmount()
    const incomplete = conversation([send5({ claude: 'a', chatgpt: 'b', grok: 'c', gemini: 'd', deepseek: null })], { slot_config: CFG5 })
    renderWithStore(<AnalyzePane />, { preloaded: applyEvents('analyze', [events.loaded(incomplete)]) })
    expect(screen.getByTestId('analyze-hint')).toHaveTextContent('waiting for all five responses')
    expect(screen.getByTestId('analyze-run')).toBeDisabled()
  })
})
