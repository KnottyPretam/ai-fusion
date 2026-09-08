// Test fixtures for the analyze feature (vitest only). Claims deliberately contain no slot or
// vendor names so the "labels only" test can scan the rendered text.
export const SLOT_CONFIG = {
  slots: {
    claude: { model: 'vendor-a/model-a', effort: 'medium' },
    chatgpt: { model: 'vendor-b/model-b', effort: 'medium' },
    grok: { model: 'vendor-c/model-c', effort: 'medium' },
  },
  analyst_model: 'vendor-b/analyst',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

const USAGE = { calls: [], totals: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: 0, calls: 0 } }

export function sendTurn(overrides = {}) {
  return {
    type: 'send',
    id: 's1',
    ts: '2026-09-07T00:00:00.000Z',
    slot_config: SLOT_CONFIG,
    usage: USAGE,
    prompt: 'What is the maximum gyroscope full-scale range of the IMU?',
    responses: { claude: 'up to 2000 deg/s', chatgpt: '1000 deg/s', grok: '125 to 2000 deg/s' },
    errors: {},
    partial: {},
    reasoning: {},
    citations: {},
    truncated: {},
    effort_applied: {},
    ...overrides,
  }
}

export const EXTRACTION = {
  agreements: [
    { topic: 'range selectability', statement: 'The full-scale range is selectable.', models: ['R1', 'R3'] },
    { topic: 'units', statement: 'Angular rate is expressed in deg/s.', models: ['R1', 'R2', 'R3'] },
  ],
  divergences: [
    {
      id: 'd1',
      topic: 'maximum range',
      positions: [
        { model: 'R1', claim: 'Selectable up to 2000 deg/s.', evidence_cited: 'datasheet table 3' },
        { model: 'R2', claim: 'Tops out at 1000 deg/s.', evidence_cited: null },
        { model: 'R3', claim: 'Ranges from 125 up to 2000 deg/s.', evidence_cited: null },
      ],
      materiality: 'high',
    },
    {
      id: 'd2',
      topic: 'lowest range setting',
      positions: [
        { model: 'R1', claim: 'Lowest setting is 125 deg/s.', evidence_cited: null },
        { model: 'R3', claim: 'Lowest setting is 250 deg/s.', evidence_cited: 'register map' },
      ],
      materiality: 'low',
    },
    {
      id: 'd3',
      topic: 'output data rate',
      positions: [
        { model: 'R2', claim: 'Up to 2 kHz.', evidence_cited: null },
        { model: 'R3', claim: 'Up to 1 kHz.', evidence_cited: null },
      ],
      materiality: 'medium',
    },
  ],
}

export function analyzeTurn(overrides = {}) {
  return {
    type: 'analyze',
    id: 'a1',
    ts: '2026-09-07T00:00:01.000Z',
    slot_config: SLOT_CONFIG,
    usage: USAGE,
    of_turn: 's1',
    extraction: EXTRACTION,
    status: 'ok',
    error: null,
    raw_attempts: [JSON.stringify(EXTRACTION)],
    ...overrides,
  }
}

export function degradedTurn(overrides = {}) {
  return analyzeTurn({
    id: 'a2',
    extraction: null,
    status: 'degraded',
    error: '1 validation error for Extraction\ndivergences\n  Field required',
    raw_attempts: ['```json\n{"agreements": [', '{"agreements": []}'],
    ...overrides,
  })
}

export function conversation(turns = [], overrides = {}) {
  return {
    schema_version: 1,
    id: 'c1',
    title: 'Test conversation',
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    slot_config: SLOT_CONFIG,
    threads: { claude: [], chatgpt: [], grok: [] },
    turns,
    ...overrides,
  }
}

export const events = {
  start: (turn_id = 'a1', of_turn = 's1') => ({ type: 'analyze_start', turn_id, of_turn }),
  retry: (error = 'Extraction.divergences: Field required') => ({ type: 'analyze_retry', error }),
  done: (turn = analyzeTurn(), cached = false) => ({ type: 'analyze_done', turn, cached }),
  degraded: (turn = degradedTurn()) => ({ type: 'analyze_degraded', turn }),
  error: (message = 'analyst unavailable') => ({ type: 'error', message }),
  loaded: (conv) => ({ type: 'conversation/loaded', conversation: conv }),
}
