// W11: pure derivations for the Fusion pane (no React). Rules duplicated from
// docs/api-contract.md "Derived rules for panes" and docs/semantics.md "Fusion".

export const SLOT_IDS = ['claude', 'chatgpt', 'grok']
export const LABELS = ['R1', 'R2', 'R3']
// Duplicated locally on purpose (state/* is frozen).
export const RANK = { low: 0, medium: 1, high: 2 }
export const MIN_ITERATIONS = 1
export const MAX_ITERATIONS = 5
export const RESOLVED_STATUSES = ['resolved', 'resolved_unjustified']

export function clampIterations(n) {
  const v = Number.isFinite(Number(n)) ? Math.round(Number(n)) : MIN_ITERATIONS
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, v))
}

// Latest send turn = last element of conversation.turns with type 'send'.
export function latestSendTurn(conversation) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && turns[i].type === 'send') return turns[i]
  return null
}

// Complete when every slot in `responses` is non-null.
export function isSendComplete(turn) {
  if (!turn || !turn.responses) return false
  return SLOT_IDS.every((s) => turn.responses[s] !== null && turn.responses[s] !== undefined)
}

// Newest analyze turn with status ok for `sendTurnId` (what the backend defaults `of_analyze` to).
export function newestOkAnalyze(conversation, sendTurnId) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t && t.type === 'analyze' && t.status === 'ok' && t.of_turn === sendTurnId) return t
  }
  return null
}

export function analyzeTurnById(conversation, id) {
  if (!id) return null
  const turns = (conversation && conversation.turns) || []
  return turns.find((t) => t && t.type === 'analyze' && t.id === id) || null
}

// Divergence ids with MATERIALITY_RANK[materiality] >= rank[materiality_min], in extraction order.
export function standingIds(extraction, materialityMin) {
  const min = RANK[materialityMin] ?? RANK.medium
  return ((extraction && extraction.divergences) || []).filter((d) => (RANK[d.materiality] ?? -1) >= min).map((d) => d.id)
}

export function anyStreaming(streams) {
  return Object.values(streams || {}).some((s) => s && s.status === 'streaming')
}

// The Fusion button rule. Returns {enabled, reason, autoAnalyze, standing}; `reason` explains a
// disabled button, `autoAnalyze` says the run will have to auto-run Analyze first, `standing` is
// the id set the next run would fuse (null when no ok Analyze result exists yet).
export function fusionGate({ conversation, slotConfig, streams }) {
  if (!conversation) return { enabled: false, reason: 'no conversation', autoAnalyze: false, standing: null }
  const send = latestSendTurn(conversation)
  if (!send) return { enabled: false, reason: 'no send turn yet', autoAnalyze: false, standing: null }
  if (!isSendComplete(send)) return { enabled: false, reason: 'latest send turn is incomplete', autoAnalyze: false, standing: null }
  const analyze = newestOkAnalyze(conversation, send.id)
  const autoAnalyze = !analyze
  let standing = null
  if (analyze) {
    const min = (slotConfig && slotConfig.materiality_min) || (conversation.slot_config && conversation.slot_config.materiality_min) || 'medium'
    standing = standingIds(analyze.extraction, min)
    if (standing.length === 0) {
      return { enabled: false, reason: `nothing to fuse: no divergence at or above materiality "${min}"`, autoAnalyze: false, standing }
    }
  }
  if (anyStreaming(streams)) return { enabled: false, reason: 'a stream is running', autoAnalyze, standing }
  return { enabled: true, reason: null, autoAnalyze, standing }
}

// ---------------------------------------------------------------- timeline derivation

export function divergenceMap(analyzeTurn) {
  const out = {}
  const divs = (analyzeTurn && analyzeTurn.extraction && analyzeTurn.extraction.divergences) || []
  for (const d of divs) out[d.id] = d
  return out
}

export function labelsWithPosition(divergence) {
  const seen = []
  for (const p of (divergence && divergence.positions) || []) if (!seen.includes(p.model)) seen.push(p.model)
  return seen
}

function exchangesOf(rounds, divergenceId, label) {
  const out = []
  for (const r of rounds || []) for (const e of r.exchanges || []) if (e.divergence_id === divergenceId && (!label || e.model === label)) out.push({ ...e, round: r.round })
  return out
}

// revised_claim of the label's most recent revise exchange, else the extraction position's claim.
export function latestClaim(rounds, divergence, label) {
  const revises = exchangesOf(rounds, divergence && divergence.id, label).filter((e) => e.stance === 'revise' && e.revised_claim != null)
  if (revises.length) return revises[revises.length - 1].revised_claim
  const pos = ((divergence && divergence.positions) || []).find((p) => p.model === label)
  return pos ? pos.claim : null
}

// justification of the label's most recent defend/revise exchange, else evidence_cited or "(none given)".
export function latestJustification(rounds, divergence, label) {
  const spoken = exchangesOf(rounds, divergence && divergence.id, label).filter((e) => e.stance !== 'unavailable' && e.justification)
  if (spoken.length) return spoken[spoken.length - 1].justification
  const pos = ((divergence && divergence.positions) || []).find((p) => p.model === label)
  return (pos && pos.evidence_cited) || '(none given)'
}

export function statusAfterRound(round, divergenceId) {
  const st = (round && round.post_round_status) || []
  const hit = st.find((s) => s.divergence_id === divergenceId)
  return hit ? hit.status : null
}

// One row per standing divergence; one cell per round. A cell is
//   {round, exchanges, status, complete, skipped}
// where `skipped` means the divergence was already resolved before this round (not re-challenged)
// and `status` is the post-round status (null while the round is still in progress).
export function buildTimeline(standing, rounds) {
  return (standing || []).map((id) => {
    let resolvedRound = null
    let finalStatus = null
    const cells = (rounds || []).map((r) => {
      const skipped = resolvedRound !== null
      const exchanges = (r.exchanges || []).filter((e) => e.divergence_id === id)
      let status = r.complete ? statusAfterRound(r, id) || (skipped ? finalStatus : 'standing') : null
      if (skipped && status === null) status = finalStatus
      if (status) finalStatus = status
      if (status && RESOLVED_STATUSES.includes(status) && resolvedRound === null) resolvedRound = r.round
      return { round: r.round, exchanges, status, complete: !!r.complete, skipped }
    })
    return { id, cells, finalStatus, resolvedRound }
  })
}

export const STANCE_VERB = { defend: 'defends', revise: 'revises', unavailable: 'unavailable' }

// "R1 defends → R3 revises → resolved, round 2"
export function traceText(row) {
  const parts = []
  for (const c of row.cells) {
    if (c.skipped) continue
    for (const e of c.exchanges) {
      let s = `${e.model} ${STANCE_VERB[e.stance] || e.stance}`
      if (e.stance === 'revise' && e.flagged_unjustified) s += ' (unjustified)'
      parts.push(s)
    }
  }
  const last = row.cells[row.cells.length - 1]
  if (row.resolvedRound !== null) parts.push(`${row.finalStatus}, round ${row.resolvedRound}`)
  else if (last && last.complete && row.finalStatus) parts.push(`${row.finalStatus}, round ${last.round}`)
  else parts.push('…')
  return parts.join(' → ')
}

export function fmtUsd(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '$0'
  return n < 0.01 && n > 0 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`
}

export function usageSummary(usage) {
  const t = (usage && usage.totals) || {}
  const tokens = (t.prompt_tokens || 0) + (t.completion_tokens || 0)
  const parts = [`${tokens} tokens (${t.prompt_tokens || 0} in / ${t.completion_tokens || 0} out`]
  if (t.reasoning_tokens) parts[0] += ` / ${t.reasoning_tokens} reasoning`
  parts[0] += ')'
  parts.push(fmtUsd(t.cost_usd || 0))
  parts.push(`${t.latency_ms || 0} ms`)
  parts.push(`${t.calls || 0} calls`)
  return parts.join(' · ')
}
