// Test fixtures for the refactor feature (vitest only). No slot or vendor names anywhere, so the
// "labels only" test can scan the rendered text.
import { SLOT_CONFIG, sendTurn } from '../analyze/fixtures.js'

export { SLOT_CONFIG, sendTurn }

const USAGE = { calls: [], totals: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: 0, calls: 0 } }

export const REFACTORING = {
  graph: {
    nodes: [
      { id: 'n1', label: 'inertial sensor', kind: 'subject' },
      { id: 'n2', label: 'gyroscope range', kind: 'quantity' },
    ],
    edges: [{ source: 'n1', target: 'n2', relation: 'has property' }],
  },
  question: 'What is the selectable gyroscope full-scale range?',
  replies: [
    { model: 'R1', summary: 'Reads the range from the range table.', claims: ['The upper range is 2000 dps', 'Cites table 3'] },
    { model: 'R2', summary: 'States a lower maximum.', claims: ['The gyroscope tops out at 1000 dps'] },
    { model: 'R3', summary: 'Gives the whole span.', claims: ['Ranges run from 125 dps to 2000 dps'] },
  ],
}

export function refactorTurn(overrides = {}) {
  return {
    type: 'refactor',
    id: 'r1',
    ts: '2026-09-20T00:00:00.000Z',
    of_turn: 's1',
    slot_config: SLOT_CONFIG,
    usage: USAGE,
    status: 'ok',
    error: null,
    refactoring: REFACTORING,
    raw_attempts: ['{"graph": {}, "question": "…"}'],
    ...overrides,
  }
}

export function degradedTurn(overrides = {}) {
  return refactorTurn({
    id: 'r2',
    status: 'degraded',
    refactoring: null,
    error: 'parse_error: no JSON object found in the response',
    raw_attempts: ['Sure! Here you go:', ''],
    ...overrides,
  })
}

export function conversation(turns = [], overrides = {}) {
  return {
    id: 'c1',
    title: 'IMU ranges',
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    slot_config: SLOT_CONFIG,
    threads: { claude: [], chatgpt: [], grok: [] },
    turns,
    ...overrides,
  }
}

export const events = {
  loaded: (conv) => ({ type: 'conversation/loaded', conversation: conv }),
  start: (ofTurn = 's1') => ({ type: 'sse', feature: 'refactor', event: { type: 'refactor_start', turn_id: 'r1', of_turn: ofTurn } }),
  notice: (text) => ({ type: 'sse', feature: 'refactor', event: { type: 'refactor_retry', error: text } }),
  done: (turn, cached = false) => ({ type: 'sse', feature: 'refactor', event: { type: 'refactor_done', turn, cached } }),
  degraded: (turn) => ({ type: 'sse', feature: 'refactor', event: { type: 'refactor_degraded', turn } }),
  error: (message) => ({ type: 'sse', feature: 'refactor', event: { type: 'error', message } }),
}
