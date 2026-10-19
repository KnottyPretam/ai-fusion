// autoReread.js (2026-10-18) — the pure half of the automatic Read again (./useAutoReread.js is the
// React half). Nothing here touches the store or the window.
//
// Measured that day: a ChatGPT reply thought for longer than the pane grant (the capture gave up at
// ~525 s with the site's stop control still up, `stopNow=true`), the answer landed in the pane minutes
// later, and the prompt bar went on saying "still answering" until the user clicked Read again on the
// Analyze tab — which they had no reason to look for. So the renderer now does that click itself:
//   * a slot of the open conversation's latest Send whose persisted error says the site was STILL
//     ANSWERING (`isStillAnswering`, the capture diag's `stopNow=true`) and that can be read again at
//     all (`rereadableSlots`: a `web:<slot>` pane, nothing but an Analyze / Refactor after the Send);
//   * once that site's pane reports its stop control GONE (`health.stop === false`, signed in), held
//     for AUTO_REREAD_SETTLE_MS — a stop button that re-renders between two phases of a reply must not
//     start the read early (a re-read started too early still waits for the reply, and while its
//     `reread` stream runs everything a stream locks is locked: the composer, New chat, the sidebar,
//     each pane's Reload / New chat / Capture);
//   * only while the pane SHOWS this conversation's chat: main stamps every health sample with
//     `chatOf`, the conversation ids whose recorded chat link for that slot is the page on screen
//     (an older main sends no field — then never). The automatic read therefore never navigates a
//     pane: a pane showing another page just skips the slot (`attempted` untouched), and the read
//     fires when the user comes back to that chat;
//   * with that site's capture switch on (a re-read with capture off reads nothing) and the bridge
//     to Electron connected;
//   * never while any stream runs or a send is in flight;
//   * ONCE per conversation + turn + slot per app session (`attempted`), with ONE more try after a
//     TRANSIENT failure (TRANSIENT_REREAD_CODES: the bridge or the view was momentarily unavailable,
//     the request never reached the page) — a reply that was not found stays failed. A failure is
//     shown on the prompt-bar line and the Read again button stays the manual path: never a loop.
// It runs only while the conversation is OPEN (the panes show its chats); one left with a slot still
// answering is read the next time it is opened.
//
// Imports features/analyze/slice.js (the Read again rules) — features/desktop already imports
// features/analyze (Drawer) and features/send (PromptBar), so the rules are shared, not mirrored.
import { isStillAnswering, latestSendTurn, plainError, rereadableSlots } from '../analyze/slice.js'
import { SITES } from './slice.js'
import { anyStreaming } from './stepper.js'

/** How long a pane's stop control must stay gone before the automatic read starts (a debounce). */
export const AUTO_REREAD_SETTLE_MS = 3000

/**
 * The failures worth ONE more automatic try (`isTransientRereadFailure`): the bridge, the view or the
 * conversation was momentarily unavailable, or the request never got an answer — nothing says the reply
 * is not there. `reply_not_found`, `timeout`, `empty_reply`, `not_captured` and anything else are final.
 */
export const TRANSIENT_REREAD_CODES = Object.freeze(['bridge_unavailable', 'bridge_disconnected', 'bridge_no_ack', 'busy', 'view_busy', 'adapter_gone', 'navigation', 'cancelled'])

/** A failure the hook may retry once: a transient code, or a thrown network / POST error (`thrown`). */
export function isTransientRereadFailure(code, { thrown = false } = {}) {
  return TRANSIENT_REREAD_CODES.includes(code) || (thrown && !code)
}

/** One automatic try per (conversation, turn, slot) per session. */
export function autoRereadKey(convId, turnId, slot) {
  return `${convId}:${turnId}:${slot}`
}

/**
 * The slot to read again now, as `{turnId, slot, message}` (`message`: the persisted still-answering
 * error, which names the prompt-bar line this read may complete), or null. The rules are the header's,
 * in order; the first slot (catalog order, as `rereadableSlots` returns them) that passes them all wins.
 */
export function autoRereadTarget({ conversation, panes, streams, attempted } = {}) {
  if (!conversation || typeof conversation !== 'object') return null
  if (anyStreaming(streams)) return null
  if (panes && panes.sending) return null
  if (!(panes && panes.bridge && panes.bridge.connected === true)) return null
  const send = latestSendTurn(conversation)
  if (!send) return null
  const errors = send.errors && typeof send.errors === 'object' ? send.errors : {}
  const health = (panes && panes.health) || {}
  const capture = (panes && panes.capture) || {}
  for (const slot of rereadableSlots(conversation, send)) {
    if (!isStillAnswering(errors[slot])) continue
    if (!SITES.includes(slot)) continue
    if (attempted && typeof attempted.has === 'function' && attempted.has(autoRereadKey(conversation.id, send.id, slot))) continue
    const h = health[slot]
    if (!h || typeof h !== 'object' || h.stop !== false || h.session !== 'ok') continue
    if (!Array.isArray(h.chatOf) || !h.chatOf.includes(conversation.id)) continue // another page: skip, never navigate
    if (capture[slot] !== true) continue
    return { turnId: send.id, slot, message: errors[slot] }
  }
  return null
}

/**
 * A prompt-bar result (`panes.lastSend[slot]`) that says "still answering": the same predicate as
 * PromptBar's `stillAnswering`. The automatic read's FIRST write needs such a line carrying the very
 * message of the error it is completing (the line belongs to THIS Send); every later write needs the
 * line to still be the object the read last wrote — any other line belongs to something newer.
 */
export function isStillAnsweringResult(r) {
  return !!r && typeof r === 'object' && !r.ok && !r.reread && isStillAnswering(r.message)
}

/** The prompt-bar result objects of the automatic read (formatted by PromptBar's formatResult / resultTitle). */
export const rereadRunning = () => ({ ok: false, reread: 'running' })
export const rereadDone = (ms) => ({ ok: true, reread: 'done', ms: Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0 })
export const rereadFailed = (code, message) => ({ ok: false, reread: 'failed', code: code || 'error', message: plainError(message) || String(code || 'error') })
