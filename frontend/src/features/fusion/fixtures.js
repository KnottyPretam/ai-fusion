// W11 test fixtures: a synthetic conversation with a complete send turn, an ok analyze turn with
// two standing divergences (d1 high, d2 medium) and one below threshold (d3 low), plus the SSE
// event sequences the backend contract documents (docs/api-contract.md, docs/semantics.md).

export const SLOT_CONFIG = {
  slots: { claude: { model: 'anthropic/claude-opus-5', effort: 'medium' }, chatgpt: { model: 'openai/gpt-5.6-sol', effort: 'medium' }, grok: { model: 'x-ai/grok-4.6', effort: 'medium' } },
  analyst_model: 'openai/gpt-5.6-luna',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

export const USAGE = { calls: [], totals: { prompt_tokens: 1200, completion_tokens: 340, reasoning_tokens: 0, cost_usd: 0.0123, latency_ms: 4200, calls: 7 } }

export const EXTRACTION = {
  agreements: [{ topic: 'interface', statement: 'SPI and I2C are both supported', models: ['R1', 'R2', 'R3'] }],
  divergences: [
    {
      id: 'd1',
      topic: 'gyroscope full-scale range',
      materiality: 'high',
      positions: [
        { model: 'R1', claim: '2000 deg/s', evidence_cited: 'datasheet table 3' },
        { model: 'R2', claim: '1000 deg/s', evidence_cited: null },
        { model: 'R3', claim: '125 to 2000 deg/s', evidence_cited: null },
      ],
    },
    {
      id: 'd2',
      topic: 'accelerometer bandwidth',
      materiality: 'medium',
      positions: [
        { model: 'R1', claim: '280 Hz', evidence_cited: null },
        { model: 'R3', claim: '145 Hz', evidence_cited: 'register map' },
      ],
    },
    {
      id: 'd3',
      topic: 'package marking',
      materiality: 'low',
      positions: [
        { model: 'R2', claim: 'BMI088 printed', evidence_cited: null },
        { model: 'R3', claim: 'coded marking', evidence_cited: null },
      ],
    },
  ],
}

export function sendTurn(id = 's1', responses = { claude: 'a', chatgpt: 'b', grok: 'c' }) {
  return { type: 'send', id, ts: '2026-09-07T00:00:00.000Z', slot_config: SLOT_CONFIG, usage: USAGE, prompt: 'What is the BMI088 gyro range?', responses, errors: {}, partial: {}, reasoning: {}, citations: {}, truncated: {}, effort_applied: {} }
}

export function analyzeTurn(id = 'a1', of_turn = 's1', extraction = EXTRACTION, status = 'ok') {
  return { type: 'analyze', id, ts: '2026-09-07T00:00:01.000Z', slot_config: SLOT_CONFIG, usage: USAGE, of_turn, extraction: status === 'ok' ? extraction : null, status, error: null, raw_attempts: [] }
}

export function conversation(turns = [sendTurn(), analyzeTurn()], id = 'c1') {
  return { schema_version: 1, id, title: 'Test', created_at: '2026-09-07T00:00:00.000Z', updated_at: '2026-09-07T00:00:02.000Z', slot_config: SLOT_CONFIG, threads: { claude: [], chatgpt: [], grok: [] }, turns }
}

export function exchange(round, divergence_id, model, stance, extra = {}) {
  const base = { type: 'exchange', round, divergence_id, model, stance, justification: '', revised_claim: null, confidence: null, persuaded_by: null, flagged_unjustified: false, error: null }
  if (stance === 'defend') Object.assign(base, { justification: `${model} defends ${divergence_id} in round ${round} with datasheet specifics.`, confidence: 0.8 })
  if (stance === 'revise') Object.assign(base, { justification: `${model} is persuaded by the datasheet gyroscope table cited by a peer and revises ${divergence_id} accordingly, round ${round}.`, revised_claim: `revised claim of ${model} on ${divergence_id} (r${round})`, confidence: 0.7, persuaded_by: 'the datasheet gyroscope full-scale table' })
  if (stance === 'unavailable') Object.assign(base, { error: 'Provider disconnected' })
  return { ...base, ...extra }
}

export function roundDone(round, statuses, changed) {
  return { type: 'round_done', round, post_round_status: Object.entries(statuses).map(([divergence_id, status]) => ({ divergence_id, status })), changed }
}

// Round 1: d1 R2 revises (justified), R1/R3 defend -> resolved. d2: R1/R3 defend -> standing.
// Round 2: d1 not re-challenged; d2: R1 defends, R3 unavailable -> standing. exit max_iterations.
export const ROUND1 = [
  { type: 'round_start', round: 1 },
  exchange(1, 'd1', 'R1', 'defend'),
  exchange(1, 'd1', 'R2', 'revise'),
  exchange(1, 'd1', 'R3', 'defend'),
  exchange(1, 'd2', 'R1', 'defend'),
  exchange(1, 'd2', 'R3', 'defend'),
  roundDone(1, { d1: 'resolved', d2: 'standing' }, true),
]
export const ROUND2 = [
  { type: 'round_start', round: 2 },
  exchange(2, 'd2', 'R1', 'defend'),
  exchange(2, 'd2', 'R3', 'unavailable'),
  roundDone(2, { d1: 'resolved', d2: 'standing' }, false),
]

export function fusionTurnFromEvents(events, { id = 'f1', of_analyze = 'a1', max_iterations = 2, exit_reason = 'max_iterations' } = {}) {
  const rounds = []
  let standing = []
  for (const ev of events) {
    if (ev.type === 'fusion_start') standing = ev.standing
    if (ev.type === 'round_start') rounds.push({ round: ev.round, exchanges: [], post_round_status: [], changed: false })
    if (ev.type === 'exchange') {
      // eslint-disable-next-line no-unused-vars
      const { type, round, ...ex } = ev
      rounds.find((r) => r.round === round).exchanges.push(ex)
    }
    if (ev.type === 'round_done') Object.assign(rounds.find((r) => r.round === ev.round), { post_round_status: ev.post_round_status, changed: ev.changed })
  }
  const final = rounds.length ? rounds[rounds.length - 1].post_round_status : standing.map((d) => ({ divergence_id: d, status: 'standing' }))
  return { type: 'fusion', id, ts: '2026-09-07T00:00:03.000Z', slot_config: SLOT_CONFIG, usage: USAGE, of_analyze, max_iterations, standing, rounds, final, exit_reason }
}

export function fusionStart({ turn_id = 'f1', of_analyze = 'a1', max_iterations = 2, standing = ['d1', 'd2'] } = {}) {
  return { type: 'fusion_start', turn_id, of_analyze, max_iterations, standing }
}

export function fullRun({ max_iterations = 2, exit_reason = 'max_iterations' } = {}) {
  const body = [fusionStart({ max_iterations }), ...ROUND1, ...ROUND2]
  const turn = fusionTurnFromEvents(body, { max_iterations, exit_reason })
  return [...body, { type: 'fusion_done', turn, exit_reason, usage: USAGE }]
}

export const ANALYZE_PREFIX = [
  { type: 'analyze_start', turn_id: 'a9', of_turn: 's1' },
  { type: 'analyze_done', turn: analyzeTurn('a9', 's1', { agreements: [], divergences: [] }), cached: false },
]

export function sseText(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

// A minimal Response-like object that satisfies both runStream (SSE reader) and http.request (json).
export function fakeResponse(text, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder()
  const chunks = [enc.encode(text)]
  let i = 0
  return {
    ok,
    status,
    json: async () => JSON.parse(text),
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }), releaseLock() {}, cancel: async () => {} }) },
  }
}
