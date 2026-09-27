// Refactor slice (S11). Registered under key 'refactor' from ./index.jsx.
//
// Shape: { status: 'idle'|'running'|'working'|'done'|'degraded'|'error',
//          turn:   RefactorTurn exactly as refactor_done / refactor_degraded sent it (or null),
//          cached: refactor_done.cached,
//          notice: the latest refactor_retry{error} narration while working (the map call, then one
//                  per label) — it is progress, not a failure, which is why it is not `error`,
//          error:  the terminal message on 'error', turn.error on 'degraded',
//          ofTurn: the send turn id this state belongs to }
//
// Deliberately the same shape as the analyze slice, minus one thing: nothing else auto-runs
// Refactor, so — unlike `analyze_*` — a `refactor_*` event only ever arrives on the refactor stream.

export const LABELS = ['R1', 'R2', 'R3', 'R4', 'R5']

// Council (2026-09-27): a conversation seats 2..5 of the 7-vendor catalog and uses the label prefix
// of its size (R1..Rn). Mirrored per feature (features never import each other): the same three
// helpers live in analyze/refactorSlice.js and fusion/derive.js.
export const SLOT_IDS = ['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'qwen', 'mimo']
export const DEFAULT_COUNCIL_SIZE = 3

/** R1..Rn for a council of n (clamped to the five labels; below 2 reads as the classic three). */
export function labelsFor(n) {
  const size = Number.isInteger(n) && n >= 2 ? Math.min(n, LABELS.length) : DEFAULT_COUNCIL_SIZE
  return LABELS.slice(0, size)
}

/** The council a persisted turn was run for, in catalog order (its `slot_config.slots` keys, else its `responses` keys); [] for anything else. */
export function councilOfTurn(turn) {
  const cfg = turn && turn.slot_config && turn.slot_config.slots
  const source = cfg && typeof cfg === 'object' ? cfg : turn && turn.responses && typeof turn.responses === 'object' ? turn.responses : null
  return source ? SLOT_IDS.filter((s) => s in source) : []
}

/** How many agents a send turn seats (the label prefix its Analyze / Fusion use); 3 when unknown. */
export function councilSize(turn) {
  const n = councilOfTurn(turn).length
  return n >= 2 ? n : DEFAULT_COUNCIL_SIZE
}

export function initial() {
  return { status: 'idle', turn: null, cached: false, notice: null, error: null, ofTurn: null }
}

/** Latest send turn = last element of conversation.turns with type === 'send'. */
export function latestSendTurn(conversation) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && turns[i].type === 'send') return turns[i]
  return null
}

/** Newest refactor turn with status 'ok' for the given send turn id. */
export function newestOkRefactorTurn(conversation, ofTurn) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t && t.type === 'refactor' && t.of_turn === ofTurn && t.status === 'ok') return t
  }
  return null
}

/** The rows of the graph's edge table, with node ids resolved to their labels where they are known. */
export function edgeRows(graph) {
  const nodes = (graph && graph.nodes) || []
  const byId = new Map(nodes.map((n) => [n.id, n.label]))
  return ((graph && graph.edges) || []).map((e) => ({
    from: byId.get(e.source) || e.source,
    relation: e.relation,
    to: byId.get(e.target) || e.target,
  }))
}

function inFlight(s) {
  return s.status === 'running' || s.status === 'working'
}

function isInitial(s) {
  return s.status === 'idle' && s.turn === null && s.error === null && s.ofTurn === null && s.cached === false
}

export function reducer(s = initial(), a) {
  switch (a.type) {
    case 'sse': {
      const ev = a.event
      if (!ev || typeof ev.type !== 'string') return s
      switch (ev.type) {
        case 'refactor_start':
          return { status: 'running', turn: null, cached: false, notice: null, error: null, ofTurn: ev.of_turn ?? null }
        case 'refactor_retry':
          // Progress, not a failure: the map call, then one call per label, each announced.
          return { ...s, status: 'working', notice: ev.error ?? null }
        case 'refactor_done': {
          const turn = ev.turn ?? null
          return { status: 'done', turn, cached: !!ev.cached, notice: null, error: null, ofTurn: (turn && turn.of_turn) ?? s.ofTurn }
        }
        case 'refactor_degraded': {
          const turn = ev.turn ?? null
          return { status: 'degraded', turn, cached: false, notice: null, error: (turn && turn.error) ?? null, ofTurn: (turn && turn.of_turn) ?? s.ofTurn }
        }
        case 'error':
          if (a.feature === 'refactor' || inFlight(s)) return { ...s, status: 'error', notice: null, error: ev.message || 'error' }
          return s
        default:
          return s
      }
    }
    case 'sse/end':
      // Pre-stream failures (409 busy / incomplete_send_turn, 404) emit no refactor_* event at all:
      // runStream reports them as sse/end{ok:false, error:<code>}.
      if (!a.ok && (a.feature === 'refactor' || inFlight(s))) return { ...s, status: 'error', notice: null, error: a.error || 'stream failed' }
      return s
    case 'sse/abort':
      return inFlight(s) ? initial() : s
    case 'conversation/loaded': {
      const send = latestSendTurn(a.conversation)
      if (!send) return isInitial(s) ? s : initial()
      if (s.ofTurn === send.id && s.status !== 'idle') return s
      const ok = newestOkRefactorTurn(a.conversation, send.id)
      if (ok) return { status: 'done', turn: ok, cached: false, notice: null, error: null, ofTurn: send.id }
      return isInitial(s) ? s : initial()
    }
    case 'conversation/cleared':
      return isInitial(s) ? s : initial()
    default:
      return s
  }
}
