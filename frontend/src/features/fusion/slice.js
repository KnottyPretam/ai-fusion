// W11: the `fusion` slice. Registered from ./index.jsx; receives every action (registry semantics)
// and reacts to `sse*` actions whose `feature` is 'fusion' plus the conversation lifecycle actions.
//
// Shape (docs/api-contract.md, "Feature slices"):
//   status        'idle' | 'running' | 'done' | 'error'
//                 'done'  = the stream reached a normal end: a persisted FusionTurn (fusion_done,
//                           whatever its exit_reason, including "error") OR one of the two
//                           documented non-crash ends on the auto-run path (see `notice`).
//                 'error' = the stream failed: HTTP failure, an `error{message}` that is not one
//                           of the two notices, an abort, or a stream that ended without fusion_done.
//   analyzing     true between analyze_start and fusion_start on the fusion stream (auto-run prefix)
//   analyzeTurn   the AnalyzeTurn carried by analyze_done on the fusion stream (topics before refetch)
//   notice        null | 'nothing_to_fuse' | 'analyze_degraded'   (normal end states, no fusion turn)
//   turnId, ofAnalyze, maxIterations, standing, rounds, final, exitReason, usage, error
//   rounds        FusionRound-shaped objects built incrementally from round_start / exchange /
//                 round_done, each with an extra `complete` flag (true once round_done arrived or
//                 the round came from a persisted turn).
//   conversationId  id of the conversation the state belongs to (hydration bookkeeping).

export const NOTICE_MESSAGES = ['nothing_to_fuse', 'analyze_degraded']

export function initialFusion() {
  return {
    status: 'idle',
    analyzing: false,
    analyzeTurn: null,
    notice: null,
    turnId: null,
    ofAnalyze: null,
    maxIterations: null,
    standing: [],
    rounds: [],
    final: [],
    exitReason: null,
    usage: null,
    error: null,
    conversationId: null,
  }
}

// Newest fusion turn of a ConversationPublic (last in `turns` with type 'fusion'), or null.
export function newestFusionTurn(conversation) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && turns[i].type === 'fusion') return turns[i]
  return null
}

function roundFromTurn(r) {
  return { ...r, exchanges: [...(r.exchanges || [])], post_round_status: [...(r.post_round_status || [])], complete: true }
}

export function stateFromTurn(turn, conversationId) {
  return {
    ...initialFusion(),
    status: 'done',
    turnId: turn.id,
    ofAnalyze: turn.of_analyze,
    maxIterations: turn.max_iterations,
    standing: [...(turn.standing || [])],
    rounds: (turn.rounds || []).map(roundFromTurn),
    final: [...(turn.final || [])],
    exitReason: turn.exit_reason,
    usage: turn.usage || null,
    conversationId: conversationId ?? null,
  }
}

function upsertRound(rounds, n, update) {
  const idx = rounds.findIndex((r) => r.round === n)
  if (idx === -1) {
    // Defensive: an exchange/round_done for a round we never saw start.
    return [...rounds, update({ round: n, exchanges: [], post_round_status: [], changed: false, complete: false })]
  }
  const out = rounds.slice()
  out[idx] = update(out[idx])
  return out
}

function onEvent(s, ev) {
  switch (ev.type) {
    case 'analyze_start':
      return { ...s, analyzing: true }
    case 'analyze_retry':
      return s
    case 'analyze_done':
      return { ...s, analyzeTurn: ev.turn || s.analyzeTurn }
    case 'analyze_degraded':
      return { ...s, analyzeTurn: ev.turn || s.analyzeTurn }
    case 'fusion_start':
      return {
        ...s,
        status: 'running',
        analyzing: false,
        notice: null,
        error: null,
        turnId: ev.turn_id ?? null,
        ofAnalyze: ev.of_analyze ?? null,
        maxIterations: ev.max_iterations ?? null,
        standing: [...(ev.standing || [])],
        rounds: [],
        final: [],
        exitReason: null,
        usage: null,
      }
    case 'round_start':
      return {
        ...s,
        rounds: s.rounds.some((r) => r.round === ev.round)
          ? s.rounds
          : [...s.rounds, { round: ev.round, exchanges: [], post_round_status: [], changed: false, complete: false }],
      }
    case 'exchange': {
      // eslint-disable-next-line no-unused-vars
      const { type, round, ...exchange } = ev
      return { ...s, rounds: upsertRound(s.rounds, round, (r) => ({ ...r, exchanges: [...r.exchanges, exchange] })) }
    }
    case 'round_done':
      return {
        ...s,
        rounds: upsertRound(s.rounds, ev.round, (r) => ({
          ...r,
          post_round_status: [...(ev.post_round_status || [])],
          changed: !!ev.changed,
          complete: true,
        })),
      }
    case 'fusion_done': {
      const turn = ev.turn || {}
      return {
        ...s,
        status: 'done',
        analyzing: false,
        notice: null,
        error: null,
        turnId: turn.id ?? s.turnId,
        ofAnalyze: turn.of_analyze ?? s.ofAnalyze,
        maxIterations: turn.max_iterations ?? s.maxIterations,
        standing: turn.standing ? [...turn.standing] : s.standing,
        rounds: turn.rounds ? turn.rounds.map(roundFromTurn) : s.rounds.map((r) => ({ ...r, complete: true })),
        final: turn.final ? [...turn.final] : s.final,
        exitReason: ev.exit_reason ?? turn.exit_reason ?? null,
        usage: ev.usage ?? turn.usage ?? null,
      }
    }
    case 'error': {
      const message = ev.message || 'error'
      if (NOTICE_MESSAGES.includes(message)) {
        // Documented non-crash end of the auto-run path (no fusion turn persisted).
        return { ...s, status: 'done', analyzing: false, notice: message, error: null }
      }
      return { ...s, status: 'error', analyzing: false, error: message }
    }
    default:
      return s
  }
}

export function fusionReducer(s = initialFusion(), a) {
  switch (a.type) {
    case 'sse/start':
      if (a.feature !== 'fusion') return s
      return { ...initialFusion(), status: 'running', conversationId: s.conversationId }
    case 'sse':
      if (a.feature !== 'fusion' || !a.event) return s
      return onEvent(s, a.event)
    case 'sse/end': {
      if (a.feature !== 'fusion') return s
      if (s.status !== 'running') return s // a terminal event already settled the state
      if (a.ok) return { ...s, status: 'error', analyzing: false, error: 'stream ended without fusion_done' }
      const code = a.body && a.body.detail && typeof a.body.detail === 'object' && !Array.isArray(a.body.detail) ? a.body.detail.error : undefined
      if (code && NOTICE_MESSAGES.includes(code)) return { ...s, status: 'done', analyzing: false, notice: code, error: null }
      return { ...s, status: 'error', analyzing: false, error: a.error || code || 'stream failed' }
    }
    case 'sse/abort':
      if (a.feature !== 'fusion') return s
      return { ...s, status: 'error', analyzing: false, error: 'aborted' }
    case 'conversation/loaded': {
      const conv = a.conversation
      if (!conv) return initialFusion()
      if (s.status === 'running') return s // never clobber a live timeline
      const sameConv = s.conversationId === conv.id
      // An end state of THIS conversation that persisted no fusion turn (the two notices, an HTTP
      // failure, an abort) is kept until the next run or a conversation switch: the refetch after
      // `error{nothing_to_fuse}` must not wipe the "nothing to fuse" message, even when an older
      // fusion turn exists further up the conversation.
      if (sameConv && s.status !== 'idle' && s.turnId === null) return s
      const turn = newestFusionTurn(conv)
      if (turn) {
        if (sameConv && turn.id === s.turnId) return s
        return stateFromTurn(turn, conv.id)
      }
      return { ...initialFusion(), conversationId: conv.id }
    }
    case 'conversation/cleared':
      return initialFusion()
    case 'conversation/deleted':
      return s.conversationId && s.conversationId === a.id ? initialFusion() : s
    default:
      return s
  }
}
