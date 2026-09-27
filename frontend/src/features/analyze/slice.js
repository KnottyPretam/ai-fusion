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

/** "two" … "five" for a council size (the n=3 wording stays byte-identical to the fixed-three days). */
export function countWord(n) {
  const words = { 2: 'two', 3: 'three', 4: 'four', 5: 'five' }
  return words[n] || String(n)
}

/** How many agents a send turn seats (the label prefix its Analyze / Fusion use); 3 when unknown. */
export function councilSize(turn) {
  const n = councilOfTurn(turn).length
  return n >= 2 ? n : DEFAULT_COUNCIL_SIZE
}

/**
 * `councilSize` of the send turn, else — before the first Send lands — of the open conversation's
 * own slot config (a two-agent conversation reads "two" from the start, not "three"); 3 when
 * neither is known.
 */
export function councilSizeFor(turn, slotConfig) {
  if (turn) return councilSize(turn)
  return councilSize(slotConfig && typeof slotConfig === 'object' && slotConfig.slots ? { slot_config: slotConfig } : null)
}

/**
 * Message prefix of the `not_captured` slot error, MIRRORED from
 * features/desktop/slice.js (`NOT_CAPTURED_MESSAGE_PREFIX`, the same constant, minted by
 * backend/llm/bridge.py). Features never import across each other — the codebase duplicates a
 * shared constant instead (SLOT_VENDORS / RANK) — so this is a copy with a pointer, not a second
 * definition: keep the two in step. The persisted SendTurn keeps only the error MESSAGE
 * (backend/schemas.py `errors: dict[SlotId, str]`), never the code, so this prefix is the only
 * persisted signal that a slot replied on screen with capture off (desktop) rather than failing.
 */
export const NOT_CAPTURED_MESSAGE_PREFIX = 'capture is off for '

export function initial() {
  return { status: 'idle', turn: null, cached: false, error: null, ofTurn: null }
}

// Latest send turn = last element of conversation.turns with type === 'send'.
export function latestSendTurn(conversation) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && turns[i].type === 'send') return turns[i]
  return null
}

// Complete when every slot of the turn's OWN council has a non-null response (Analyze button
// rule): a two-agent turn is complete with two replies, a five-agent one needs five.
export function isSendTurnComplete(turn) {
  if (!turn || !turn.responses || typeof turn.responses !== 'object') return false
  const council = councilOfTurn(turn)
  return council.length > 0 && council.every((s) => turn.responses[s] !== null && turn.responses[s] !== undefined)
}

/** The send turn an analyze turn (or an `ofTurn` id) was run on, else the latest send turn. */
export function sendTurnFor(conversation, ofTurn) {
  const turns = (conversation && conversation.turns) || []
  if (ofTurn) for (const t of turns) if (t && t.type === 'send' && t.id === ofTurn) return t
  return latestSendTurn(conversation)
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
