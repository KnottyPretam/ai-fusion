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

// ---------------------------------------------------------------------------------------------
// Plan (2026-09-27): a PlanTurn made from the fusion turn above (`fullRun().at(-1).turn`, id f1),
// the events of one `POST …/plan` stream in the shapes backend/features/plan.py sends, and a
// loaded conversation carrying send + analyze + fusion + plan turns. Identity-free content: the
// section renders inside the Fusion pane, which the export leak gate scans.
// ---------------------------------------------------------------------------------------------

export const PLAN_USAGE = { calls: [], totals: { prompt_tokens: 2100, completion_tokens: 900, reasoning_tokens: 0, cost_usd: 0.0456, latency_ms: 30000, calls: 1 } }

export const PLAN = {
  objective: 'Configure the BMI088 gyroscope for the 2000 deg/s range over SPI and confirm the setting on the device.',
  prerequisites: ['the BMI088 datasheet, revision 1.9', 'SPI access to the sensor from the host'],
  steps: [
    { number: 1, title: 'Select the interface', action: 'Wire the sensor for SPI.', why: 'SPI is what the rest of the procedure assumes; both interfaces are supported.', inputs: ['host SPI bus'], outputs: ['sensor on SPI'], verify: 'The chip id register reads 0x0F.' },
    { number: 2, title: 'Set the gyroscope range', action: 'Write the range register for 2000 deg/s.', why: 'The range settled on in the comparison.', inputs: ['range register address'], outputs: ['range = 2000 deg/s'], verify: 'Reading the register back returns the 2000 deg/s code.' },
    { number: 3, title: 'Choose the accelerometer bandwidth', action: 'Set the bandwidth per decision d2.', why: '', inputs: [], outputs: [], verify: 'The bandwidth register reads the chosen value.' },
  ],
  decisions: [{ divergence_id: 'd2', topic: 'accelerometer bandwidth', options: ['280 Hz, as one side holds', '145 Hz, as the register map cited by the other side gives'], recommendation: '145 Hz', rationale: 'The only cited evidence is the register map.' }],
  risks: [{ risk: 'The range register code differs between datasheet revisions.', mitigation: 'Read the register back after writing it.' }],
  done_when: ['the gyroscope reports 2000 deg/s full scale', 'the accelerometer bandwidth matches the decision taken'],
}

export function planTurn(id = 'p1', of_fusion = 'f1', { plan = PLAN, status = 'ok', model = 'web:claude', error = null, raw_attempts = [], usage = PLAN_USAGE } = {}) {
  return { type: 'plan', id, ts: '2026-09-07T00:00:04.000Z', slot_config: SLOT_CONFIG, usage, of_fusion, model, plan: status === 'ok' ? plan : null, status, error, raw_attempts }
}

export const planEvents = {
  start: ({ turn_id = 'p1', of_fusion = 'f1', model = 'web:claude' } = {}) => ({ type: 'plan_start', turn_id, of_fusion, model }),
  retry: (error = 'asking the agent for a plan') => ({ type: 'plan_retry', error }),
  done: (turn = planTurn(), cached = false) => ({ type: 'plan_done', turn, cached }),
  degraded: (turn = planTurn('p2', 'f1', { status: 'degraded', error: 'parse_error: no JSON object found', raw_attempts: ['not json', 'still not json'] })) => ({ type: 'plan_degraded', turn }),
  /** start → the narration → done: one whole successful stream. */
  stream: (turn = planTurn(), { cached = false } = {}) => [planEvents.start({ turn_id: turn.id, of_fusion: turn.of_fusion, model: turn.model }), planEvents.retry(), planEvents.done(turn, cached)],
}

/** send + analyze + fusion (f1, max_iterations) + plan (p1 for f1): the whole chain persisted. */
export function plannedConversation({ plan = planTurn(), id = 'c1' } = {}) {
  const fusion = fullRun().at(-1).turn
  return conversation([sendTurn(), analyzeTurn(), fusion, ...(plan ? [plan] : [])], id)
}

/**
 * The desktop `GET /api/models` catalog with `raw.transport` (backend/llm/webmodels.py): the web
 * panes and hidden analyst pages, local Ollama models and — once a key is configured — OpenRouter
 * entries. The shape of features/desktop/fakes.js DESKTOP_CATALOG, copied here because features
 * never import each other's internals, tests included.
 */
export const DESKTOP_CATALOG = [
  { id: 'web:claude', name: 'Claude (web session)', vendor: 'anthropic', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:chatgpt', name: 'ChatGPT (web session)', vendor: 'openai', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:grok', name: 'Grok (web session)', vendor: 'x-ai', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:claude:analyst', name: 'Claude web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:chatgpt:analyst', name: 'ChatGPT web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:grok:analyst', name: 'Grok web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'ollama:hermes3', name: 'hermes3 (local Ollama)', vendor: 'ollama', efforts: ['off'], structured_outputs: false, raw: { transport: 'ollama' } },
  { id: 'ollama:qwen3', name: 'qwen3 (local Ollama)', vendor: 'ollama', efforts: ['off'], structured_outputs: false, raw: { transport: 'ollama' } },
  { id: 'openai/gpt-5', name: 'GPT-5', vendor: 'openai', efforts: ['low', 'medium', 'high'], structured_outputs: true, raw: { transport: 'openrouter' } },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'google', efforts: ['low', 'medium', 'high'], structured_outputs: true, raw: { transport: 'openrouter' } },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', vendor: 'deepseek', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', vendor: 'qwen', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash', vendor: 'xiaomi', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
]

/** The `models` slice loaded with a catalog (the desktop one by default). */
export function modelsState(items = DESKTOP_CATALOG) {
  const byId = {}
  for (const m of items) byId[m.id] = m
  return { items, byId, loaded: true, error: null }
}
