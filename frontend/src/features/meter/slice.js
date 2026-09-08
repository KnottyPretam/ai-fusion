// Meter slice (W12). Per feature: the LAST invocation (PLAN §7: "tokens / $ / latency for the last
// invocation, broken out by feature") plus a cumulative row for the CURRENT conversation, and a
// cumulative total. Fusion's multiplier = last Fusion cost / cost of the Send turn it fused, so it
// never shrinks as the conversation grows.
//
// Sources (docs/api-contract.md):
//   turn_start{turn_id}                     -> last.send reset (send AND continue streams both run
//                                              under the runStream feature key 'send')
//   slot_done{usage: Usage, truncated}      -> send + last.send; +1 call each
//   turn_done{turn_id, usage: FeatureUsage} -> send + last.send latency only (totals.latency_ms is
//                                              the feature wall clock; per-slot latencies overlap);
//                                              sendCostByTurn[turn_id] = last.send.cost_usd
//   analyze_start{turn_id, of_turn}         -> last.analyze reset; analyzeOfTurn[turn_id] = of_turn
//   analyze_done{turn, cached}              -> analyze + last.analyze from turn.usage.totals; cached
//                                              hits are ignored (docs/semantics.md cache rule), so
//                                              a cached last invocation reads as zero cost
//   analyze_degraded{turn}                  -> analyze + last.analyze (the persisted turn still paid
//                                              for both attempts; keeps live == reload)
//   fusion_start{of_analyze}                -> last.fusion reset; fusedSendCost = cost of the Send
//                                              turn behind of_analyze (analyzeOfTurn -> sendCostByTurn)
//   fusion_done{turn, usage}                -> fusion + last.fusion from usage.totals (fusion calls
//                                              only; an auto-run AnalyzeTurn carries its own usage);
//                                              an unknown fused Send falls back to the last Send
//   conversation/loaded{conversation}       -> everything recomputed from the persisted turns so a
//                                              reload (or the post-stream refetch) shows the same
//   any event carrying code cost_cap_exceeded -> costCapExceeded, a persistent warning flag
//                                              (the backend cap is per session, so it is never
//                                              cleared by switching conversations)
export const ROW_KEYS = ['prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cost_usd', 'latency_ms', 'calls', 'truncated']
export const FEATURE_ROWS = ['send', 'analyze', 'fusion']
export const COST_CAP_CODE = 'cost_cap_exceeded'

export function emptyRow() {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: 0, calls: 0, truncated: 0 }
}

function emptyRows() {
  return { send: emptyRow(), analyze: emptyRow(), fusion: emptyRow() }
}

export function initialMeter() {
  return {
    ...emptyRows(), // cumulative for the current conversation
    total: emptyRow(),
    last: emptyRows(), // the most recent invocation of each feature
    sendCostByTurn: {}, // send/continue turn id -> that turn's cost
    analyzeOfTurn: {}, // analyze turn id -> the send turn it analyzed
    fusedSendCost: 0, // cost of the Send behind the last Fusion (the multiplier's denominator)
    costCapExceeded: false,
    conversationId: null,
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const round8 = (v) => Math.round(v * 1e8) / 1e8

function addRow(row, delta) {
  const out = { ...row }
  for (const k of ROW_KEYS) out[k] = num(out[k]) + num(delta[k])
  out.cost_usd = round8(out.cost_usd)
  return out
}

// A delta normalised to a row (ROW_KEYS only, numbers only).
const asRow = (delta) => addRow(emptyRow(), delta)

function sumRows(rows) {
  let t = emptyRow()
  for (const r of rows) t = addRow(t, r)
  return t
}

function totalsOf(turn) {
  return (turn && turn.usage && turn.usage.totals) || {}
}

// A persisted turn -> {row, delta}.
function turnDelta(turn) {
  const t = totalsOf(turn)
  switch (turn && turn.type) {
    case 'send':
      return { row: 'send', delta: { ...t, truncated: Object.values(turn.truncated || {}).filter(Boolean).length } }
    case 'continue':
      return { row: 'send', delta: { ...t, truncated: turn.truncated ? 1 : 0 } }
    case 'analyze':
      return { row: 'analyze', delta: { ...t, truncated: 0 } }
    case 'fusion':
      return { row: 'fusion', delta: { ...t, truncated: 0 } }
    default:
      return null
  }
}

// Cost of the Send turn an analyze turn looked at, or 0 when either side is unknown.
function sendCostOfAnalyze(s, analyzeId) {
  const sendId = analyzeId ? s.analyzeOfTurn[analyzeId] : undefined
  return sendId ? num(s.sendCostByTurn[sendId]) : 0
}

// Everything the meter derives from a persisted conversation: cumulative rows, the last row per
// feature (newest turn of that kind; send|continue both count as Send), the turn maps and the
// fused-Send cost of the newest fusion turn.
export function meterFromConversation(conversation) {
  const rows = emptyRows()
  const last = emptyRows()
  const sendCostByTurn = {}
  const analyzeOfTurn = {}
  let newestFusion = null
  for (const turn of (conversation && conversation.turns) || []) {
    const d = turnDelta(turn)
    if (!d) continue
    rows[d.row] = addRow(rows[d.row], d.delta)
    last[d.row] = asRow(d.delta)
    if (!turn.id) continue
    if (d.row === 'send') sendCostByTurn[turn.id] = num(totalsOf(turn).cost_usd)
    else if (d.row === 'analyze') analyzeOfTurn[turn.id] = turn.of_turn
    else newestFusion = turn
  }
  const out = { ...rows, last, sendCostByTurn, analyzeOfTurn, fusedSendCost: 0 }
  if (newestFusion) out.fusedSendCost = sendCostOfAnalyze(out, newestFusion.of_analyze) || last.send.cost_usd
  return out
}

export function rowsFromConversation(conversation) {
  const { send, analyze, fusion } = meterFromConversation(conversation)
  return { send, analyze, fusion }
}

function withTotal(s, patch) {
  const next = { ...s, ...patch }
  next.total = sumRows(FEATURE_ROWS.map((k) => next[k]))
  return next
}

// Add a delta to a feature's cumulative row AND its last-invocation row.
function book(s, row, delta) {
  return withTotal(s, { [row]: addRow(s[row], delta), last: { ...s.last, [row]: addRow(s.last[row], delta) } })
}

// Add a delta to a feature's cumulative row and make it the last-invocation row (one-shot features).
function bookAsLast(s, row, delta) {
  return withTotal(s, { [row]: addRow(s[row], delta), last: { ...s.last, [row]: asRow(delta) } })
}

function resetLast(s, row, extra) {
  return { ...s, ...extra, last: { ...s.last, [row]: emptyRow() } }
}

function mentionsCostCap(v) {
  return typeof v === 'string' && v.includes(COST_CAP_CODE)
}

// True when an SSE event carries the cost-cap code: slot_error{code}, error{message},
// analyze_retry{error}, exchange{error}, analyze_degraded{turn.error}.
export function carriesCostCap(ev) {
  if (!ev || typeof ev !== 'object') return false
  if (ev.code === COST_CAP_CODE) return true
  return mentionsCostCap(ev.error) || mentionsCostCap(ev.message) || mentionsCostCap(ev.turn && ev.turn.error)
}

function reduceEvent(s, feature, ev) {
  if (!ev) return s
  if (carriesCostCap(ev) && !s.costCapExceeded) s = { ...s, costCapExceeded: true }
  switch (ev.type) {
    case 'turn_start':
      return feature === 'send' ? resetLast(s, 'send') : s
    case 'slot_done': {
      if (feature !== 'send') return s
      const u = ev.usage || {}
      return book(s, 'send', { ...u, latency_ms: 0, calls: 1, truncated: ev.truncated ? 1 : 0 })
    }
    case 'turn_done': {
      if (feature !== 'send') return s
      const wall = num(totalsOf(ev).latency_ms)
      const next = wall ? book(s, 'send', { latency_ms: wall }) : s
      if (!ev.turn_id) return next
      return { ...next, sendCostByTurn: { ...next.sendCostByTurn, [ev.turn_id]: next.last.send.cost_usd } }
    }
    case 'analyze_start': {
      const analyzeOfTurn = ev.turn_id && ev.of_turn ? { ...s.analyzeOfTurn, [ev.turn_id]: ev.of_turn } : s.analyzeOfTurn
      return resetLast(s, 'analyze', { analyzeOfTurn })
    }
    case 'analyze_done':
      if (ev.cached) return s
      return bookAsLast(s, 'analyze', { ...totalsOf(ev.turn), truncated: 0 })
    case 'analyze_degraded':
      return bookAsLast(s, 'analyze', { ...totalsOf(ev.turn), truncated: 0 })
    case 'fusion_start':
      return resetLast(s, 'fusion', { fusedSendCost: sendCostOfAnalyze(s, ev.of_analyze) })
    case 'fusion_done': {
      const t = (ev.usage && ev.usage.totals) || totalsOf(ev.turn)
      const next = bookAsLast(s, 'fusion', { ...t, truncated: 0 })
      // No fusion_start (or an unknown analyze/send chain): the fused Send is the newest one.
      const fused = next.fusedSendCost || sendCostOfAnalyze(next, ev.turn && ev.turn.of_analyze) || next.last.send.cost_usd
      return fused === next.fusedSendCost ? next : { ...next, fusedSendCost: fused }
    }
    default:
      return s
  }
}

export function meterReducer(s = initialMeter(), a) {
  switch (a.type) {
    case 'sse':
      return reduceEvent(s, a.feature, a.event)
    case 'conversation/loaded': {
      const conv = a.conversation
      return withTotal({ ...s, conversationId: conv ? conv.id : null }, meterFromConversation(conv))
    }
    case 'conversation/cleared':
      return withTotal({ ...s, conversationId: null }, meterFromConversation(null))
    case 'conversation/deleted':
      return s.conversationId && s.conversationId === a.id ? withTotal({ ...s, conversationId: null }, meterFromConversation(null)) : s
    default:
      return s
  }
}
