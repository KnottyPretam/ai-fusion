// Analyze slice (W10). Registered under key 'analyze' from ./index.jsx.
//
// Shape: { status: 'idle'|'running'|'retrying'|'done'|'degraded'|'error',
//          turn:   AnalyzeTurn exactly as analyze_done / analyze_degraded sent it (or null),
//          cached: analyze_done.cached,
//          error:  analyze_retry.error while retrying, the terminal message on 'error',
//                  turn.error on 'degraded',
//          ofTurn: the send turn id this state belongs to }
//
// Every `analyze_*` SSE event updates this slice REGARDLESS of a.feature: Fusion auto-runs
// Analyze inside its own stream, so those events arrive tagged feature: 'fusion'. Terminal
// `error` events count when they arrive on the analyze stream, or on any stream while an
// analyze run is still in flight (running / retrying).

// docs/api-contract.md: RANK is duplicated locally (state/* is frozen).
export const RANK = { low: 0, medium: 1, high: 2 }
export const LABELS = ['R1', 'R2', 'R3']

export function initial() {
  return { status: 'idle', turn: null, cached: false, error: null, ofTurn: null }
}

// Latest send turn = last element of conversation.turns with type === 'send'.
export function latestSendTurn(conversation) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && turns[i].type === 'send') return turns[i]
  return null
}

// Complete when every slot in `responses` is non-null (Analyze button rule).
export function isSendTurnComplete(turn) {
  if (!turn || !turn.responses || typeof turn.responses !== 'object') return false
  const values = Object.values(turn.responses)
  return values.length > 0 && values.every((v) => v !== null && v !== undefined)
}

// Newest analyze turn with status 'ok' for the given send turn id.
export function newestOkAnalyzeTurn(conversation, ofTurn) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t && t.type === 'analyze' && t.of_turn === ofTurn && t.status === 'ok') return t
  }
  return null
}

function inFlight(s) {
  return s.status === 'running' || s.status === 'retrying'
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
        case 'analyze_start':
          return { status: 'running', turn: null, cached: false, error: null, ofTurn: ev.of_turn ?? null }
        case 'analyze_retry':
          return { ...s, status: 'retrying', error: ev.error ?? null }
        case 'analyze_done': {
          const turn = ev.turn ?? null
          return { status: 'done', turn, cached: !!ev.cached, error: null, ofTurn: (turn && turn.of_turn) ?? s.ofTurn }
        }
        case 'analyze_degraded': {
          const turn = ev.turn ?? null
          return { status: 'degraded', turn, cached: false, error: (turn && turn.error) ?? null, ofTurn: (turn && turn.of_turn) ?? s.ofTurn }
        }
        case 'error':
          if (a.feature === 'analyze' || inFlight(s)) return { ...s, status: 'error', error: ev.message || 'error' }
          return s
        default:
          return s
      }
    }
    case 'sse/end':
      // Pre-stream failures (409 busy / incomplete_send_turn, 404) never emit an analyze_* event:
      // runStream reports them as sse/end{ok:false, error:<code>}. A stream that dies while an
      // analyze run is in flight (whichever feature opened it) also ends here.
      if (!a.ok && (a.feature === 'analyze' || inFlight(s))) return { ...s, status: 'error', error: a.error || 'stream failed' }
      return s
    case 'sse/abort':
      return inFlight(s) ? initial() : s
    case 'conversation/loaded': {
      const send = latestSendTurn(a.conversation)
      if (!send) return isInitial(s) ? s : initial()
      // The pane refetches the conversation right after its own stream ends; a result that
      // belongs to this send turn (done, cached, degraded, retrying under Fusion, error) stays.
      if (s.ofTurn === send.id && s.status !== 'idle') return s
      const ok = newestOkAnalyzeTurn(a.conversation, send.id)
      if (ok) return { status: 'done', turn: ok, cached: false, error: null, ofTurn: send.id }
      return isInitial(s) ? s : initial()
    }
    case 'conversation/cleared':
      return isInitial(s) ? s : initial()
    default:
      return s
  }
}
