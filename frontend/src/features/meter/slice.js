// Meter slice (W12). One cumulative row per feature for the CURRENT conversation, plus a total.
//
// Sources (docs/api-contract.md):
//   slot_done{usage: Usage, truncated}      -> Send row (send AND continue streams both run under
//                                              the runStream feature key 'send'); +1 call each
//   turn_done{usage: FeatureUsage}          -> Send row latency only (totals.latency_ms is the
//                                              feature wall clock; per-slot latencies overlap)
//   analyze_done{turn, cached}              -> Analyze row from turn.usage.totals; cached hits
//                                              are ignored (docs/semantics.md cache rule)
//   analyze_degraded{turn}                  -> Analyze row (the persisted turn still paid for
//                                              both attempts; keeps live == reload)
//   fusion_done{turn, usage}                -> Fusion row from usage.totals (fusion calls only;
//                                              an auto-run AnalyzeTurn carries its own usage)
//   conversation/loaded{conversation}       -> rows recomputed from the persisted turns so a
//                                              reload (or the post-stream refetch) shows totals
//   any event carrying code cost_cap_exceeded -> costCapExceeded, a persistent warning flag
//                                              (the backend cap is per session, so it is never
//                                              cleared by switching conversations)
export const ROW_KEYS = ['prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cost_usd', 'latency_ms', 'calls', 'truncated']
export const FEATURE_ROWS = ['send', 'analyze', 'fusion']
export const COST_CAP_CODE = 'cost_cap_exceeded'

export function emptyRow() {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: 0, calls: 0, truncated: 0 }
}

export function initialMeter() {
  return { send: emptyRow(), analyze: emptyRow(), fusion: emptyRow(), total: emptyRow(), costCapExceeded: false, conversationId: null }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const round8 = (v) => Math.round(v * 1e8) / 1e8

function addRow(row, delta) {
  const out = { ...row }
  for (const k of ROW_KEYS) out[k] = num(out[k]) + num(delta[k])
  out.cost_usd = round8(out.cost_usd)
  return out
}

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

export function rowsFromConversation(conversation) {
  const rows = { send: emptyRow(), analyze: emptyRow(), fusion: emptyRow() }
  for (const turn of (conversation && conversation.turns) || []) {
    const d = turnDelta(turn)
    if (d) rows[d.row] = addRow(rows[d.row], d.delta)
  }
  return rows
}

function withTotal(s, rows) {
  const next = { ...s, ...rows }
  next.total = sumRows(FEATURE_ROWS.map((k) => next[k]))
  return next
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
    case 'slot_done': {
      if (feature !== 'send') return s
      const u = ev.usage || {}
      return withTotal(s, { send: addRow(s.send, { ...u, latency_ms: 0, calls: 1, truncated: ev.truncated ? 1 : 0 }) })
    }
    case 'turn_done': {
      if (feature !== 'send') return s
      const wall = num(totalsOf(ev).latency_ms)
      return wall ? withTotal(s, { send: addRow(s.send, { latency_ms: wall }) }) : s
    }
    case 'analyze_done':
      if (ev.cached) return s
      return withTotal(s, { analyze: addRow(s.analyze, { ...totalsOf(ev.turn), truncated: 0 }) })
    case 'analyze_degraded':
      return withTotal(s, { analyze: addRow(s.analyze, { ...totalsOf(ev.turn), truncated: 0 }) })
    case 'fusion_done': {
      const t = (ev.usage && ev.usage.totals) || totalsOf(ev.turn)
      return withTotal(s, { fusion: addRow(s.fusion, { ...t, truncated: 0 }) })
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
      return withTotal({ ...s, conversationId: conv ? conv.id : null }, rowsFromConversation(conv))
    }
    case 'conversation/cleared':
      return withTotal({ ...s, conversationId: null }, rowsFromConversation(null))
    case 'conversation/deleted':
      return s.conversationId && s.conversationId === a.id ? withTotal({ ...s, conversationId: null }, rowsFromConversation(null)) : s
    default:
      return s
  }
}
