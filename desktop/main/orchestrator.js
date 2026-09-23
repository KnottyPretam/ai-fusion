// desktop/main/orchestrator.js — one bridge `request` → one turn in a site view (Stage 2 electron-bridge).
//
//   run(request, emit) → Promise<finalFrame>   emit(frame) carries accepted / rejected / result to the backend
//   cancel(reqId) → boolean                    aborts the adapter op in flight for that request
//   inflight(slot) → {reqId, view} | null
//
// Per request (contract §1, decisions 12 / 13):
//   1. reject from the HEALTH CACHE before any DOM write: unknown slot → unknown_site; no live
//      view → view_crashed; a turn already in flight on that view, or health.stop === true (the
//      site is still answering a manual prompt) → view_busy; health.session logged_out |
//      challenge | blocked → that code; matched.error 'view_crashed' → view_crashed;
//      view 'analyst' with no analyst chosen (or a slot that is not the chosen one) →
//      analyst_not_chosen. A lingering `stop` in the cache is re-read from the page first, and the
//      view is RESERVED across that read, so two requests arriving inside that window cannot both
//      be accepted onto one view (the loser is `view_busy`).
//   2. `accepted{req_id, view, slot}`.
//   3. navigation: link = chats.get(conversation_id, slot); a link that exists and differs from
//      the view's URL → loadUrl(link) (a failed load → result `navigation`); no link → adopt
//      whatever chat the pane shows (no navigation); `fresh:true` → newChatUrl first. Then a
//      navigation main started elsewhere (panes:openChats, New chat, Sign out, the initial load
//      — `pendingNavigation(slot)`) must commit before anything is asked of the page: the OLD
//      document would answer `ready` for the new one. Bounded by NAVIGATION_WAIT_MS; a cancel
//      ends the wait.
//   4. `ready` (composer present, session ok, no stop button) with the composer budget.
//   5. mutex ⟨ focus the view → insertAndSubmit ⟩: the insert phases of parallel requests never
//      overlap; the renderer's focus is restored once the last queued insert has finished.
//   6. chat-URL wait, in the background: the view's URL right after the submit, else the first
//      did-navigate / did-navigate-in-page matching the site's chatUrlPattern within
//      CHAT_URL_WAIT_MS → chats.set(conversation_id, slot, url). Only matching URLs are ever
//      recorded, so a matching link is never overwritten by a non-matching URL.
//   7. capture[slot] on → `observe{baselineCount: assistantCount, quietMs, settleMs, timeoutMs,
//      firstTokenMs}` (plus `expect:'json'` for a structured purpose, S10, and `incompleteGraceMs`
//      on the analyst view, S11) →
//      `result ok:true captured:true {text, url, ms, done_by}`; off → `captured:false {url, ms}`.
//      A submit result without a usable assistantCount omits baselineCount: the adapter then
//      samples the count itself (at least "now", never "nothing" — baseline 0 on a thread with
//      replies would capture the previous one).
//   Failures after `accepted` are `result ok:false`: the adapter's code when it is a §1 result
//   code, else `site_error` with "<code>: <message>"; `partial` when the adapter reported one.
//   `panes:turn` phases: typing → submitted → replying (capture on) → done | error{code}.
//   A bridge `cancel` aborts the adapter op in flight (AbortSignal → adapter `cancel` → the op
//   answers `cancelled`). A socket drop is the caller's business: the turn completes locally and
//   bridge-client.js discards its frames. `ms` is an integer since the request was taken up.
//
// Stage 3, `view: 'analyst'` (analyst-views.js): the request runs on the HIDDEN analyst view of
// that site instead of its pane — a different `WebContentsView` on the same partition, so an
// analyst turn and a pane turn on the same slot are independent, while two analyst turns are
// serialized against each other (the second is `view_busy`). Differences from a pane turn:
// `fresh:true` opens `newChatUrl` on the analyst view and `fresh:false` continues in place (a
// recorded chat link belongs to the pane and is never consulted or written for the analyst); the
// analyst ALWAYS observes — the per-pane capture switches do not apply to a view the user never
// reads — and no `panes:turn` phase is emitted, because that event is keyed by slot alone (§2)
// and would label the slot's PANE as typing.
// "In place" is bound to the CONVERSATION, though: the hidden analyst view is one per app while the
// backend's busy guard is per conversation, so between conversation A's first analyst attempt and
// its correction another conversation can take the view and open its own chat. A `fresh:false`
// analyst request therefore returns to the analyst chat its own conversation last used
// (`analystView.chatFor`), or opens a NEW one when it has none and the view sits in a chat that
// belongs to a different conversation (`analystView.chatOwner`) — a correction is never typed into
// another conversation's chat. Each finished analyst turn records its chat (`analystView.noteChat`,
// only URLs matching the site's chatUrlPattern), which is main's memory, not chats.json.
//
// Settled re-read (S11; `settledReread`, entered from `turn`'s one failure funnel): when an ANALYST
// capture on a STRUCTURED purpose fails with `timeout` or `reply_not_found`, the chat is reloaded and
// read again with the same reader — the pre-submit baseline, `expect:'json'`, SETTLED_REREAD_MS — and
// a re-read that succeeds is returned exactly as a normal capture. The plan's C1 ("re-read on a parse
// failure") landed at S10 as an in-adapter re-sample of the same live DOM; three read-only probes
// then (2026-09-20, -21 and -22) showed the complete answer sitting in the chat after EVERY failure,
// so the reply was there each time and only the capture that followed the live render had missed it.
// A reloaded page renders the finished turn once — no placeholder, no remount, no reasoning gap — and
// the selectors that pick it on a live page pick it there (on a reloaded page every container is in
// the adapter's `known` set, so the count rule from the pre-submit baseline is what finds it). Before
// the reload the failing DOM is saved, scrubbed (`saveFailureSnapshot`, never fatal), so the NEXT
// failure can be read rather than re-measured; and when main's own timer was what fired, the cancel it
// sent is acknowledged first (`error.cancelResult`) — the preload holds one op in flight per view and
// would answer `busy`. Never for a pane, never for `chat`, never when the view's URL is not a chat
// (chatgpt's `/c/WEB:<uuid>` placeholder 404s), never without a pre-submit baseline (a re-read would
// count the settled answer as an earlier turn), and never past what is left of the backend's grant.
// ANY failure inside the recovery reports the ORIGINAL failure, code, message and partial intact. The
// view stays reserved throughout: it is the same turn.
// Pure module: every collaborator is injected (see createOrchestrator) so node --test drives it.

import { SLOTS } from './sites.js'
import { AdapterRequestError } from './adapter-client.js'
import { INSERT_SETTLE_MS } from './selectors.js'
import { RESULT_CODES } from './protocol.js'

export { INSERT_SETTLE_MS }

/** Grace added to the preload's own budget so main's timeout fires after the adapter's, not before. */
export const TIMEOUT_GRACE_MS = 3000
/** Decision 12: a chat link is recorded only from a matching navigation within this window after the submit. */
export const CHAT_URL_WAIT_MS = 15000
/** How long a request waits for a navigation main started elsewhere to commit before `ready`. */
export const NAVIGATION_WAIT_MS = 15000
export const TURN_PHASES = Object.freeze(['idle', 'typing', 'submitted', 'replying', 'done', 'error'])

const RESULT_CODE_SET = new Set(RESULT_CODES)

/**
 * The preload's worst case for one insertAndSubmit (site.cjs): requireSessionOk waits up to
 * composerWaitMs, insertText settles INSERT_SETTLE_MS after each of its two attempts, submit polls
 * the send button up to sendWaitMs, confirms the click within submitVerifyMs and, when that fails,
 * confirms the Enter fallback within submitVerifyMs again. Main budgets exactly that (+ grace), so
 * a `not_submitted` from the adapter is never reported as main's own `timeout` (with a cancel).
 */
export function insertAndSubmitBudgetMs({ composerWaitMs, sendWaitMs, submitVerifyMs, insertSettleMs = INSERT_SETTLE_MS }) {
  return composerWaitMs + sendWaitMs + 2 * submitVerifyMs + 2 * insertSettleMs
}

/** The adapter's worst case for one observe: the first container within firstTokenMs, then the capture cap. */
export function observeBudgetMs({ firstTokenMs, captureTimeoutMs }) {
  return firstTokenMs + captureTimeoutMs
}

/**
 * How much more patient a turn on the hidden ANALYST view is than a pane turn (S10).
 *
 * `budgets()` used to be keyed on the slot alone, so the analyst page was given the timings tuned for a
 * chat answer someone is watching — while it holds the longest and most structured reply in the system:
 * three whole replies quoted into one prompt, answered as a JSON document. On 2026-09-20 that ended two
 * analyst captures mid-document (13 and 6 characters, both reported as `ok`) and Analyze degraded twice.
 * `ANALYST_PATIENCE` multiplies the two STILLNESS windows and the first-token deadline — how long a lull
 * has to last before the reply counts as finished, and how long the page may show nothing at all.
 * `ANALYST_CAPTURE_PATIENCE` multiplies the OVERALL budget separately, and by more, because those are
 * different quantities: a lull is a pause between rendered chunks, while the budget has to cover the
 * model THINKING before the first chunk exists. Measured 2026-09-20: with a reasoning mode switched on
 * inside chatgpt.com a condense call showed an empty reply container for 570 s straight (the whole grant
 * a 600 s bridge deadline allows) and its answer landed in that chat shortly after the capture gave up.
 * Both are still capped by `captureCeilingMs`, so the ADAPTER always reports before the bridge does.
 */
/** The purposes whose reply is a JSON document, and so must be captured whole (S10). */
export const STRUCTURED_PURPOSES = Object.freeze(['extraction', 'defense', 'convergence'])

/** Headroom kept under the backend's request deadline so the ADAPTER's timeout is the one that
 *  reports — with its partial and its reason — rather than the bridge failing the request blind. */
export const CAPTURE_CEILING_MARGIN_MS = 30000

export const ANALYST_PATIENCE = 3

/**
 * The adapter's own default for `incompleteGraceMs` (site.cjs: how long an answer that never takes the
 * expected shape is waited on after the site says it is done). Sent scaled by ANALYST_PATIENCE for the
 * analyst view ONLY, so a pane's observe payload is byte-identical to what it was (S11).
 */
export const INCOMPLETE_GRACE_MS = 20000
/** The budget of a settled re-read (S11): the answer is already on the reloaded page, so this covers one page render and one settle window, not a model thinking. */
export const SETTLED_REREAD_MS = 60000
/** The failure codes a settled re-read may follow: the two that say "the capture did not read it", never one that says the site refused. */
export const REREAD_CODES = Object.freeze(['timeout', 'reply_not_found'])

/**
 * What the settled re-read needs of the grant, worst case: the reload wait, `ready`, the re-read
 * observe, and main's own grace on each request. `budgets()` RESERVES this much of the ceiling for an
 * analyst turn (review 2026-09-22: a capture sized to eat the ceiling left exactly the 30 s margin,
 * and the recovery the release is about never ran on a full-budget timeout under a 900 s grant), and
 * `settledReread` checks the same sum, so the two can never disagree.
 */
export function rereadReserveMs(readyMs) {
  return NAVIGATION_WAIT_MS + readyMs + TIMEOUT_GRACE_MS + SETTLED_REREAD_MS + TIMEOUT_GRACE_MS
}

/** A diag line saying the site's stop control was up at the last sample: the model is still working. */
export const STILL_WORKING_RE = /\bstopNow=true\b/

/** The analyst's multiplier for the OVERALL capture budget (thinking time, not lull length). */
export const ANALYST_CAPTURE_PATIENCE = 4

/** A promise-chain mutex: `lock()` resolves with the release function once the lock is yours. */
export function createMutex() {
  let tail = Promise.resolve()
  let holders = 0
  let waiters = 0
  return {
    lock() {
      let release
      waiters += 1
      const gate = new Promise((resolve) => {
        let released = false
        release = () => {
          if (released) return
          released = true
          holders -= 1
          resolve()
        }
      })
      const ticket = tail.then(() => {
        waiters -= 1
        holders += 1
        return release
      })
      tail = ticket.then(() => gate)
      return ticket
    },
    locked: () => holders > 0,
    waiting: () => waiters,
  }
}

/** How long a fresh `health` read may take before the cached value is used instead. */
export const FRESH_HEALTH_TIMEOUT_MS = 3000

/** The §1 reject code the health cache dictates for a slot, or null when the view may proceed. */
export function rejectFromHealth(health, { inflight = false } = {}) {
  if (inflight) return { code: 'view_busy', message: 'a turn is already in flight on this view' }
  if (!health || typeof health !== 'object') return null
  const matched = health.matched && typeof health.matched === 'object' ? health.matched : {}
  if (matched.error === 'view_crashed') return { code: 'view_crashed', message: 'the site view crashed and is being recreated' }
  if (health.session === 'logged_out') return { code: 'logged_out', message: 'the site is signed out; sign in from the pane' }
  if (health.session === 'challenge') return { code: 'challenge', message: 'the site is showing a verification challenge' }
  if (health.session === 'blocked') return { code: 'blocked', message: 'the site reported unusual activity' }
  if (health.stop === true) return { code: 'view_busy', message: 'the site is still answering a prompt (stop button visible)' }
  return null
}

/** Compile a chatUrlPattern source; null when empty or invalid (then nothing is ever recorded). */
export function compileChatUrlPattern(source) {
  if (typeof source !== 'string' || source === '') return null
  try {
    return new RegExp(source)
  } catch (_e) {
    return null
  }
}

function adapterFailure(e) {
  if (e instanceof AdapterRequestError) return { code: e.code, message: e.message, partial: typeof e.partial === 'string' ? e.partial : null }
  const code = e && typeof e.code === 'string' && e.code !== '' ? e.code : 'site_error'
  return { code, message: String((e && e.message) || e), partial: null }
}

/**
 * createOrchestrator(deps) → {run, cancel, inflight, mutex}
 *   adapterFor(slot)               the view's adapter client (null → view_crashed)
 *   analystAdapterFor?(slot)       Stage 3: the hidden analyst view's client for `slot` (absent, or
 *                                  null → `analyst_not_chosen`: no analyst is chosen, or not that one)
 *   analystView?                   Stage 3, the rest of the analyst view's seam (analyst-views.js):
 *                                  {currentUrl(), loadUrl(url), newChatUrl(), pendingNavigation(),
 *                                   focus(), getHealth(), setHealth(h), chatFor(convId),
 *                                   chatOwner(url), noteChat(convId, url)} — every entry optional
 *   focusView(slot)                `webContents.focus()` on the view (may be async)
 *   restoreRendererFocus()         called once the last queued insert phase has finished
 *   timeoutsFor(slot)              {composerWaitMs, sendWaitMs, submitVerifyMs} from the merged selectors
 *   captureTimeoutsFor?(slot)      {quietMs, settleMs, firstTokenMs, captureTimeoutMs} (v2; defaults when absent)
 *   chatUrlPatternFor?(slot)       the site's chatUrlPattern source (nothing recorded when absent)
 *   getHealth?(slot)               the cached Health object (null → proceed)
 *   setHealth?(slot, h)            store a fresh Health read back into the cache (renderer replay uses it)
 *   getCapture?()                  {slot: boolean} (absent → capture off everywhere)
 *   chats?                         {get(convId, slot), set(convId, slot, url)}
 *   currentUrl?(slot)              the view's URL now
 *   loadUrl?(slot, url)            navigate the view (rejects on a failed load)
 *   pendingNavigation?(slot)       a promise for a navigation main started elsewhere (views.js), or null
 *   onNavigate?(slot, cb)          cb(url) on did-navigate / did-navigate-in-page; returns unsubscribe
 *   newChatUrl?(slot)              the site's newChatUrl (for `fresh:true`)
 *   onTurn?(slot, phase, code?)    `panes:turn` for the renderer
 *   saveFailureSnapshot?(view, slot) → Promise<string|null>   S11: write that view's scrubbed DOM under
 *                                  snapshots/ (ipc.js saveDomSnapshot) and resolve with the path; called
 *                                  BEFORE a settled re-read reloads the page; a rejection is logged, never fatal
 *   mutex, now, log, insertSettleMs, setTimeout, clearTimeout
 */
export function createOrchestrator({
  adapterFor,
  analystAdapterFor = null,
  analystView = null,
  focusView,
  restoreRendererFocus,
  timeoutsFor,
  captureTimeoutsFor = null,
  chatUrlPatternFor = null,
  getHealth = null,
  setHealth = null,
  getCapture = null,
  chats = null,
  currentUrl = null,
  loadUrl = null,
  pendingNavigation = null,
  onNavigate = null,
  newChatUrl = null,
  onTurn = null,
  saveFailureSnapshot = null,
  mutex = createMutex(),
  now = Date.now,
  log = console,
  insertSettleMs = INSERT_SETTLE_MS,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
} = {}) {
  if (typeof adapterFor !== 'function') throw new Error('createOrchestrator: adapterFor is required')
  const settle = Number.isFinite(insertSettleMs) && insertSettleMs >= 0 ? insertSettleMs : INSERT_SETTLE_MS
  const warn = (m) => log && typeof log.warn === 'function' && log.warn(`[orchestrator] ${m}`)
  const info = (m) => log && typeof log.log === 'function' && log.log(`[orchestrator] ${m}`)

  /** slot → {reqId, view, controller, started} while a turn is in flight on that view. */
  const active = new Map()
  let insertsQueued = 0

  /**
   * The capture can never usefully outlast the backend's own deadline for the request: past that
   * the bridge has already failed it with `timeout` and nothing the adapter returns is read. The
   * request frame carries `timeout_s`, so the ceiling comes from what was actually granted rather
   * than from a copy of BRIDGE_TIMEOUT_S here that could drift out of step with it.
   */
  const captureCeilingMs = (timeoutS) => {
    const granted = Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : 600000
    // The margin, unless the grant is too short to give one — then half of it, so a small deadline
    // still leaves the adapter a usable window AND still reports before the bridge does.
    return Math.max(Math.floor(granted / 2), granted - CAPTURE_CEILING_MARGIN_MS)
  }

  const budgets = (slot, view, timeoutS) => {
    const t = (typeof timeoutsFor === 'function' && timeoutsFor(slot)) || {}
    const composer = Number.isFinite(t.composerWaitMs) ? t.composerWaitMs : 15000
    const send = Number.isFinite(t.sendWaitMs) ? t.sendWaitMs : 18000
    const verify = Number.isFinite(t.submitVerifyMs) ? t.submitVerifyMs : 5000
    const c = (typeof captureTimeoutsFor === 'function' && captureTimeoutsFor(slot)) || {}
    // Every capture window is scaled for the analyst view (S10): the two stillness windows, the
    // first-token deadline and the overall budget. A config that predates `settleMs` gets the
    // contract default, never the per-site value of whichever site happens to be the analyst.
    const patience = view === 'analyst' ? ANALYST_PATIENCE : 1
    const quietMs = (Number.isFinite(c.quietMs) ? c.quietMs : 2500) * patience
    const settleMs = (Number.isFinite(c.settleMs) ? c.settleMs : 400) * patience
    const firstTokenMs = (Number.isFinite(c.firstTokenMs) ? c.firstTokenMs : 90000) * patience
    // The analyst page needs a LONGER run, not just longer lulls. Measured 2026-09-20: a condense
    // call with a reasoning mode switched on inside ChatGPT rendered no readable text for the whole
    // 300 s a pane is given, so the capture timed out at `chars=0` while the answer — a correct
    // 5,847-character claims object — landed in that chat shortly afterwards. A pane's budget is
    // sized for someone watching a reply arrive; the analyst's is sized for a model thinking.
    const capturePatience = view === 'analyst' ? ANALYST_CAPTURE_PATIENCE : 1
    const wanted = (Number.isFinite(c.captureTimeoutMs) ? c.captureTimeoutMs : 300000) * capturePatience
    const submitMs = insertAndSubmitBudgetMs({ composerWaitMs: composer, sendWaitMs: send, submitVerifyMs: verify, insertSettleMs: settle })
    // The grant covers the WHOLE request, so the ceiling has to leave room for main's own pre-capture
    // work on this turn too — waiting for the composer, inserting, submitting — and not just for the
    // bridge margin. A capture sized against the grant alone outlives it by however long the submit
    // took. The floor keeps a short grant usable: half of what the margin left.
    // An analyst turn keeps room under the ceiling for the settled re-read (S11) — the recovery is
    // worthless if the capture it recovers from has already eaten the time it needs.
    const reserve = view === 'analyst' ? rereadReserveMs(composer) : 0
    const ceiling = Math.max(Math.floor(captureCeilingMs(timeoutS) / 2), captureCeilingMs(timeoutS) - reserve)
    const captureTimeoutMs = Math.min(wanted, Math.max(Math.floor(ceiling / 2), ceiling - composer - submitMs))
    return {
      readyMs: composer,
      submitMs,
      quietMs,
      settleMs,
      firstTokenMs,
      captureTimeoutMs,
      observeMs: observeBudgetMs({ firstTokenMs, captureTimeoutMs }),
      // Only the analyst is sent one (S11): the adapter's default stands for a pane, and its payload
      // stays byte-identical. Scaled with the lull windows, not the thinking budget — it is a lull.
      incompleteGraceMs: view === 'analyst' ? INCOMPLETE_GRACE_MS * patience : null,
    }
  }

  /** Whether a failed capture may be followed by a settled re-read (S11): the analyst view, a structured purpose, one of the two "did not read it" codes. */
  const rereadable = (request, entry, code) =>
    entry.view === 'analyst' && STRUCTURED_PURPOSES.includes(request && request.purpose) && REREAD_CODES.includes(code)

  /** What the backend granted for the whole request, in ms (the same reading captureCeilingMs takes). */
  const grantMs = (timeoutS) => (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : 600000)

  const phase = (slot, p, code) => {
    if (typeof onTurn !== 'function') return
    try {
      onTurn(slot, p, code)
    } catch (e) {
      warn(`onTurn failed: ${(e && e.message) || e}`)
    }
  }

  const url = (slot) => {
    if (typeof currentUrl !== 'function') return ''
    try {
      return String(currentUrl(slot) || '')
    } catch (_e) {
      return ''
    }
  }

  const captureOn = (slot) => {
    if (typeof getCapture !== 'function') return false
    try {
      const c = getCapture()
      return !!(c && c[slot] === true)
    } catch (_e) {
      return false
    }
  }

  /** One entry of the optional `analystView` seam (analyst-views.js), bound; null when not wired. */
  const analystFn = (name) => (analystView && typeof analystView[name] === 'function' ? analystView[name].bind(analystView) : null)

  /**
   * The collaborators one turn uses, chosen by `view`: a pane turn drives the slot's site view, its
   * chat links and its capture switch; an analyst turn drives the hidden analyst view, never touches
   * chats.json, always observes and emits no `panes:turn` phase (§2 keys both by slot alone).
   */
  function seamFor(view, slot) {
    if (view !== 'analyst') {
      return {
        client: typeof adapterFor === 'function' ? adapterFor(slot) : null,
        url: () => url(slot),
        loadUrl: typeof loadUrl === 'function' ? (u) => loadUrl(slot, u) : null,
        newChatUrl: typeof newChatUrl === 'function' ? () => newChatUrl(slot) : null,
        pendingNavigation: typeof pendingNavigation === 'function' ? () => pendingNavigation(slot) : null,
        focus: typeof focusView === 'function' ? () => focusView(slot) : null,
        getHealth: typeof getHealth === 'function' ? () => getHealth(slot) : null,
        setHealth: typeof setHealth === 'function' ? (h) => setHealth(slot, h) : null,
        observes: () => captureOn(slot),
        recordsChat: true,
        phases: true,
      }
    }
    const analystUrl = analystFn('currentUrl')
    return {
      client: typeof analystAdapterFor === 'function' ? analystAdapterFor(slot) : null,
      url: () => {
        if (!analystUrl) return ''
        try {
          return String(analystUrl() || '')
        } catch (_e) {
          return ''
        }
      },
      loadUrl: analystFn('loadUrl'),
      newChatUrl: analystFn('newChatUrl'),
      pendingNavigation: analystFn('pendingNavigation'),
      focus: analystFn('focus'),
      getHealth: analystFn('getHealth'),
      setHealth: analystFn('setHealth'),
      observes: () => true, // the analyst page is read back whatever the pane capture switches say
      recordsChat: false,
      // main's per-conversation memory of the hidden view's chats (never chats.json, which is the pane's)
      chatFor: analystFn('chatFor'),
      chatOwner: analystFn('chatOwner'),
      noteChat: analystFn('noteChat'),
      phases: false,
    }
  }

  /**
   * Record the chat this turn landed in: the view's URL now when it matches, else the first
   * matching navigation within CHAT_URL_WAIT_MS. Returns `{url(), stop()}`; `url()` is the
   * recorded URL or null. Nothing is recorded without a conversation id or a usable pattern.
   */
  function watchChatUrl(slot, convId) {
    const pattern = compileChatUrlPattern(typeof chatUrlPatternFor === 'function' ? chatUrlPatternFor(slot) : '')
    let recorded = null
    let stopped = false
    let unsubscribe = () => {}
    let timer = null
    const stop = () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      if (timer !== null) clearT(timer)
    }
    const record = (u) => {
      recorded = u
      stop()
      if (chats && typeof chats.set === 'function' && typeof convId === 'string' && convId !== '') {
        try {
          const known = typeof chats.get === 'function' ? chats.get(convId, slot) : null
          if (known !== u) {
            chats.set(convId, slot, u)
            info(`${slot}: chat link recorded for ${convId}`)
          }
        } catch (e) {
          warn(`${slot}: chats.set failed: ${(e && e.message) || e}`)
        }
      }
    }
    if (!pattern) return { url: () => null, stop }
    const matches = (u) => typeof u === 'string' && pattern.test(u)
    const current = url(slot)
    if (matches(current)) {
      record(current)
    } else if (typeof onNavigate === 'function') {
      unsubscribe = onNavigate(slot, (u) => {
        if (!stopped && matches(u)) record(u)
      }) || (() => {})
      timer = setT(stop, CHAT_URL_WAIT_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
    return { url: () => recorded, stop }
  }

  /**
   * Where a `fresh:false` analyst request must continue. The hidden analyst view is ONE per app
   * while the backend's busy guard is per conversation, so "in place" can be ANOTHER conversation's
   * chat (A's correction attempt after B took the view between A's two attempts). Returns the URL
   * to open first, or null to stay where the view is:
   *   • this conversation's own recorded analyst chat, when the view has moved away from it;
   *   • a brand-new chat, when this conversation has no recorded chat and the view sits in one that
   *     belongs to a different conversation (never type a correction into a foreign chat);
   *   • null when the view is already in this conversation's chat, or in nobody's.
   */
  function analystContinuation(seam, convId) {
    if (typeof seam.chatFor !== 'function') return null
    const here = seam.url()
    let mine = null
    let owner = null
    try {
      mine = convId === '' ? null : seam.chatFor(convId) || null
      owner = typeof seam.chatOwner === 'function' ? seam.chatOwner(here) || null : null
    } catch (e) {
      warn(`analyst chat lookup failed: ${(e && e.message) || e}`)
      return null
    }
    if (typeof mine === 'string' && mine !== '') return mine === here ? null : mine
    if (owner === null || owner === convId) return null
    info('analyst page: the chat it is in belongs to another conversation; opening a new one')
    return typeof seam.newChatUrl === 'function' ? seam.newChatUrl() || null : null
  }

  /**
   * Remember which analyst chat this conversation is in, so its next `fresh:false` continuation
   * comes back here. Only URLs matching the site's chatUrlPattern are recorded (the same rule as
   * the pane's chats.json), so the site root is never mistaken for a chat.
   */
  function noteAnalystChat(seam, slot, convId, u) {
    if (typeof seam.noteChat !== 'function' || convId === '' || typeof u !== 'string' || u === '') return
    const pattern = compileChatUrlPattern(typeof chatUrlPatternFor === 'function' ? chatUrlPatternFor(slot) : '')
    if (!pattern || !pattern.test(u)) return
    try {
      seam.noteChat(convId, u)
    } catch (e) {
      warn(`analyst chat could not be recorded: ${(e && e.message) || e}`)
    }
  }

  /**
   * Wait for a navigation main started elsewhere on `slot` (openChats / New chat / Sign out / the
   * initial load) to commit, so `ready` is never answered by the document about to be replaced.
   * Bounded by NAVIGATION_WAIT_MS; the turn's abort signal ends the wait at once. Never throws.
   */
  async function awaitPendingNavigation(seam, label, signal) {
    if (typeof seam.pendingNavigation !== 'function') return
    let pending = null
    try {
      pending = seam.pendingNavigation()
    } catch (_e) {
      pending = null
    }
    if (!pending || typeof pending.then !== 'function') return
    info(`${label}: a navigation is pending; waiting for it to commit before ready`)
    let timer = null
    let onAbort = null
    try {
      await Promise.race([
        pending.then(
          () => {},
          () => {},
        ),
        new Promise((resolve) => {
          timer = setT(resolve, NAVIGATION_WAIT_MS)
        }),
        new Promise((resolve) => {
          onAbort = resolve
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (timer !== null) clearT(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  async function underMutex(fn) {
    insertsQueued += 1
    const release = await mutex.lock()
    try {
      return await fn()
    } finally {
      release()
      insertsQueued -= 1
      if (insertsQueued === 0 && typeof restoreRendererFocus === 'function') {
        try {
          await restoreRendererFocus()
        } catch (e) {
          warn(`restoreRendererFocus: ${(e && e.message) || e}`)
        }
      }
    }
  }

  /** The turn proper, after `accepted`. Resolves with the result frame (never rejects). */
  async function turn(request, entry) {
    const { slot } = request
    const { seam, label } = entry
    const reqId = request.req_id
    const started = entry.started
    const elapsed = () => Math.max(0, Math.round(now() - started))
    const signal = entry.controller.signal
    const client = seam.client
    const b = budgets(slot, entry.view, request && request.timeout_s)
    const { readyMs, submitMs, quietMs, settleMs, firstTokenMs, captureTimeoutMs, observeMs, incompleteGraceMs } = b
    const emitPhase = (p, code) => {
      if (seam.phases) phase(slot, p, code)
    }
    let chatWatch = null
    let submitted = null // the insertAndSubmit result once there is one: the settled re-read needs its baseline
    let observing = false // the capture was asked for: only a failure from there on may be followed by a re-read
    const cancelled = () => {
      if (signal.aborted) throw new AdapterRequestError('cancelled', 'cancelled by the backend')
    }
    try {
      if (!client) throw new AdapterRequestError('view_crashed', `${label}: no live view`)
      // 3. navigation (decision 12; the analyst view never consults or records a PANE chat link)
      const convId = typeof request.conversation_id === 'string' ? request.conversation_id : ''
      const link = seam.recordsChat && chats && typeof chats.get === 'function' && convId !== '' ? chats.get(convId, slot) : null
      let target = null
      if (request.fresh === true && typeof seam.newChatUrl === 'function') target = seam.newChatUrl() || null
      else if (link && link !== seam.url()) target = link
      // an analyst continuation belongs to its conversation, never to whoever used the view last
      else if (!seam.recordsChat) target = analystContinuation(seam, convId)
      if (target) {
        if (typeof seam.loadUrl !== 'function') throw new AdapterRequestError('navigation', `${label}: cannot navigate (no loader)`)
        info(`${label}: opening ${link && target === link ? 'the recorded chat' : 'a new chat'}`)
        try {
          await seam.loadUrl(target)
        } catch (e) {
          throw new AdapterRequestError('navigation', `could not open ${link && target === link ? 'the recorded chat' : 'a new chat'}: ${(e && e.message) || e}`)
        }
        cancelled()
      }
      // 3b. a navigation main started elsewhere must commit first (the old document would answer)
      await awaitPendingNavigation(seam, label, signal)
      cancelled()
      // 4. ready
      await client.request('ready', { timeoutMs: readyMs }, { timeoutMs: readyMs + TIMEOUT_GRACE_MS, signal })
      cancelled()
      // 5. insert under the mutex (a hidden analyst view takes focus too — the Stage 0 spike)
      submitted = await underMutex(async () => {
        cancelled()
        emitPhase('typing')
        if (typeof seam.focus === 'function') await seam.focus()
        return client.request('insertAndSubmit', { text: request.text }, { timeoutMs: submitMs + TIMEOUT_GRACE_MS, signal })
      })
      emitPhase('submitted')
      // ONE line per submit (S11): which confirmation the adapter saw and which send button it pressed
      // (or the Enter fallback), so a capture that then reads nothing can be told apart from a prompt
      // that was never really sent — without reading the page again.
      info(`${label}: submitted by ${submitted.confirmedBy} (send: ${submitted.sendSelector || 'enter-fallback'})`)
      // 6. chat-URL wait, in the background (never delays the result)
      chatWatch = seam.recordsChat ? watchChatUrl(slot, convId) : { url: () => null, stop: () => {} }
      const resultUrl = () => chatWatch.url() || (typeof submitted.url === 'string' && submitted.url) || seam.url()
      // 7. observe when capture is on (always, for the analyst view)
      if (!seam.observes()) {
        const only = resultUrl()
        noteAnalystChat(seam, slot, convId, only)
        return { type: 'result', req_id: reqId, ok: true, captured: false, url: only, ms: elapsed() }
      }
      cancelled()
      emitPhase('replying')
      // every budget the adapter honours is sent, so the site's own `settleMs` / `firstTokenMs` are
      // never silently the adapter's fallbacks, and the analyst's multiplied windows actually arrive
      const observePayload = { quietMs, settleMs, timeoutMs: captureTimeoutMs, firstTokenMs }
      // Every turn Triplex asks for in a STRUCTURED shape answers with a JSON document, so a capture
      // of half a document ends nothing (S10): the adapter keeps sampling until the braces balance.
      // Gated on the PURPOSE, not the view: `chat` is the user's own prose in a pane and must never
      // wait for braces, while `extraction` (the analyst), `defense` and `convergence` (Fusion,
      // which runs on the PANES, not the analyst page) are all JSON and were all exposed to the same
      // mid-document truncation. Anything unrecognised is left ungated.
      if (STRUCTURED_PURPOSES.includes(request && request.purpose)) observePayload.expect = 'json'
      if (Number.isFinite(incompleteGraceMs)) observePayload.incompleteGraceMs = incompleteGraceMs
      if (Number.isInteger(submitted.assistantCount) && submitted.assistantCount >= 0) observePayload.baselineCount = submitted.assistantCount
      else warn(`${label}: the submit result carried no usable assistantCount; the adapter samples the baseline itself`)
      observing = true
      const observed = await client.request('observe', observePayload, { timeoutMs: observeMs + TIMEOUT_GRACE_MS, signal })
      const text = typeof observed.text === 'string' ? observed.text : ''
      const doneBy = ['done_selector', 'stop_gone', 'quiet'].includes(observed.doneBy) ? observed.doneBy : 'quiet'
      // ONE line per captured turn (S10). `doneBy` used to be computed here and thrown away, which is
      // why the 13-character analyst capture of 2026-09-20 could only be diagnosed by counting
      // characters in the persisted conversation: nothing on the way through said how a capture ended.
      // The length, never the text — the reply does not go in the log.
      info(`${label}: captured ${text.length} chars by ${doneBy} in ${Number.isFinite(observed.ms) ? Math.round(observed.ms) : elapsed()} ms`)
      const finalUrl = (typeof observed.url === 'string' && observed.url) || resultUrl()
      noteAnalystChat(seam, slot, convId, finalUrl)
      return { type: 'result', req_id: reqId, ok: true, captured: true, text, url: finalUrl, ms: elapsed(), done_by: doneBy }
    } catch (e) {
      const f = adapterFailure(e)
      const code = RESULT_CODE_SET.has(f.code) ? f.code : 'site_error'
      const message = code === f.code ? f.message : `${f.code}: ${f.message}`
      warn(`${label}: ${code} — ${message}`)
      const failure = { type: 'result', req_id: reqId, ok: false, code, message, partial: f.partial }
      if (!observing || !rereadable(request, entry, code)) return failure
      // S11: the answer is usually in the chat by now (see the header). Never throws; null = the
      // original failure stands.
      const recovered = await settledReread(request, entry, e, submitted, b, elapsed)
      return recovered || failure
    }
  }

  /**
   * Read the answer back from the SETTLED page (S11, header): acknowledge main's own cancel if one
   * was sent, save the failing DOM, then reload the chat the view is in and observe it from the
   * pre-submit baseline under SETTLED_REREAD_MS. Resolves with the OK result frame, or null when the
   * re-read was not attempted or failed — the caller then reports the original failure. Never rejects.
   */
  async function settledReread(request, entry, error, submitted, b, elapsed) {
    // Structural, not incidental (review 2026-09-22): this runs inside turn()'s single catch, so a throw
    // anywhere in it would replace the ORIGINAL failure with a generic site_error and lose the partial.
    try {
      return await settledRereadUnguarded(request, entry, error, submitted, b, elapsed)
    } catch (e) {
      warn(`${entry.label}: settled re-read threw (${(e && e.message) || e}); reporting the original failure`)
      return null
    }
  }

  async function settledRereadUnguarded(request, entry, error, submitted, b, elapsed) {
    const { slot } = request
    const { seam, label } = entry
    const reqId = request.req_id
    const client = seam.client
    const signal = entry.controller.signal
    const convId = typeof request.conversation_id === 'string' ? request.conversation_id : ''
    // (1) main's timer fired and sent a cancel: the preload frees its one in-flight slot only once it
    // has answered that cancel, and would answer `busy` to a snapshot or a ready before then.
    const ack = error && error.cancelResult
    if (ack && typeof ack.then === 'function') {
      info(`${label}: waiting for the adapter to answer the cancel before reading the page again`)
      try {
        await ack
      } catch (_e) {
        /* never rejects by contract; nothing to do if it did */
      }
    }
    // (2) the DOM exactly as the failure left it, BEFORE the reload replaces it; a snapshot that fails
    // is a line in the log, never a reason to skip the re-read.
    if (typeof saveFailureSnapshot === 'function') {
      try {
        const file = await saveFailureSnapshot(entry.view, slot)
        if (file) info(`${label}: DOM snapshot of the failed capture saved to ${file}`)
      } catch (e) {
        warn(`${label}: DOM snapshot of the failed capture failed: ${(e && e.message) || e}`)
      }
    }
    // (2b) a capture that ended with the site's stop control UP is the S10 reasoning shape: the model is
    // still writing and the answer is provably not on the page yet (measured 570 s of it). Reloading
    // now would destroy the in-progress turn. The diag line says so; the snapshot above is still worth
    // having. (Review 2026-09-22.)
    if (error && STILL_WORKING_RE.test(String(error.message || ''))) {
      warn(`${label}: no settled re-read — the site was still working at the last sample (stopNow=true); a reload would abandon the reply in progress`)
      return null
    }
    // (3) only a chat can be reloaded and read: the site root holds nothing, and chatgpt's `/c/WEB:<uuid>`
    // placeholder 404s (the segment-end chatUrlPattern rejects it, as it does for chats.json).
    const here = seam.url()
    const pattern = compileChatUrlPattern(typeof chatUrlPatternFor === 'function' ? chatUrlPatternFor(slot) : '')
    if (!pattern || !pattern.test(here)) {
      warn(`${label}: no settled re-read — the view's URL is not a chat (${here || 'unknown'})`)
      return null
    }
    const baseline = submitted && Number.isInteger(submitted.assistantCount) && submitted.assistantCount >= 0 ? submitted.assistantCount : null
    if (baseline === null) {
      warn(`${label}: no settled re-read — the submit carried no baseline, so a reloaded page could not tell this turn's reply from the earlier ones`)
      return null
    }
    if (typeof seam.loadUrl !== 'function') {
      warn(`${label}: no settled re-read — the view cannot be reloaded (no loader)`)
      return null
    }
    // The re-read has to finish inside the grant too, or the bridge fails the request while the view
    // is still reserved and the backend's correction attempt lands on a `view_busy`.
    const left = grantMs(request && request.timeout_s) - elapsed()
    const needed = rereadReserveMs(b.readyMs) // the same sum budgets() reserved, so this is normally true
    if (left < needed) {
      warn(`${label}: no settled re-read — ${left} ms of the grant left, the re-read needs ${needed} ms`)
      return null
    }
    try {
      if (signal.aborted) throw new AdapterRequestError('cancelled', 'cancelled by the backend')
      info(`${label}: settled re-read — reloading the chat and reading it again from baseline ${baseline}`)
      // A loader that resolves on load is bounded like every other wait here; the navigation wait
      // below is what actually confirms the page.
      await Promise.race([Promise.resolve(seam.loadUrl(here)), new Promise((r) => setT(r, NAVIGATION_WAIT_MS))])
      await awaitPendingNavigation(seam, label, signal)
      if (signal.aborted) throw new AdapterRequestError('cancelled', 'cancelled by the backend')
      await client.request('ready', { timeoutMs: b.readyMs }, { timeoutMs: b.readyMs + TIMEOUT_GRACE_MS, signal })
      // The re-read gets a grace sized to ITS budget, not the analyst's 60 s (which would not fit in a
      // 60 s observe): a settled page has nothing left to render, so half the budget is generous.
      const rereadGrace = Math.min(Number.isFinite(b.incompleteGraceMs) ? b.incompleteGraceMs : INCOMPLETE_GRACE_MS, Math.floor(SETTLED_REREAD_MS / 2))
      const payload = { baselineCount: baseline, expect: 'json', quietMs: b.quietMs, settleMs: b.settleMs, firstTokenMs: b.firstTokenMs, timeoutMs: SETTLED_REREAD_MS, incompleteGraceMs: rereadGrace }
      const observed = await client.request('observe', payload, { timeoutMs: SETTLED_REREAD_MS + TIMEOUT_GRACE_MS, signal })
      const text = typeof observed.text === 'string' ? observed.text : ''
      const doneBy = ['done_selector', 'stop_gone', 'quiet'].includes(observed.doneBy) ? observed.doneBy : 'quiet'
      info(`${label}: recovered by settled re-read, ${text.length} chars`)
      const finalUrl = (typeof observed.url === 'string' && observed.url) || seam.url()
      noteAnalystChat(seam, slot, convId, finalUrl)
      return { type: 'result', req_id: reqId, ok: true, captured: true, text, url: finalUrl, ms: elapsed(), done_by: doneBy }
    } catch (e) {
      const g = adapterFailure(e)
      warn(`${label}: settled re-read failed (${g.code}: ${g.message}); reporting the original failure`)
      return null
    }
  }

  /**
   * run(request, emit): `request` is a validated §1 request frame; `emit(frame)` sends the
   * accepted/rejected frame first and the result last. Resolves with the final frame; never
   * rejects (an emit() failure is logged).
   */
  async function run(request, emit) {
    const send = (frame) => {
      try {
        if (typeof emit === 'function') emit(frame)
      } catch (e) {
        warn(`emit failed: ${(e && e.message) || e}`)
      }
      return frame
    }
    const reqId = request && typeof request.req_id === 'string' && request.req_id !== '' ? request.req_id : ''
    const slot = request && request.slot
    const view = request && request.view === 'analyst' ? 'analyst' : 'pane'
    const reject = (code, message) => send({ type: 'rejected', req_id: reqId, code, message })

    // 1. reject from the health cache, before any DOM write
    if (!SLOTS.includes(slot)) return reject('unknown_site', `no view for slot ${String(slot)}`)
    if (view === 'analyst' && typeof analystAdapterFor !== 'function') return reject('analyst_not_chosen', 'no analyst page is available')
    // The analyst view is one per app, not one per slot: its own key serializes analyst turns
    // against each other while leaving that site's PANE (a different view) free to run its own.
    const key = view === 'analyst' ? `analyst:${slot}` : slot
    const label = view === 'analyst' ? `analyst page (${slot})` : slot
    const seam = seamFor(view, slot)
    if (!seam.client) {
      if (view === 'analyst') return reject('analyst_not_chosen', `no analyst page is chosen for ${slot}; choose one in Settings`)
      return reject('view_crashed', `${slot}: no live view`)
    }
    const entry = { reqId, view, slot, seam, label, controller: new AbortController(), started: now() }
    let health = typeof seam.getHealth === 'function' ? seam.getHealth() : null
    const busy = active.has(key)
    if (health && health.stop === true && !busy) {
      // The cache is fed by the adapter's change/poll publishes (1.5 s) — a stop button that showed
      // for a short reply can linger in it. Re-read before rejecting so a finished reply never
      // turns a send into view_busy; a site that is really still answering stays rejected.
      // The view is RESERVED across that await (`busy` was read before it): two requests that
      // arrive inside the 3 s window would otherwise both find the map empty and both be accepted.
      active.set(key, entry)
      try {
        const fresh = await seam.client.request('health', {}, { timeoutMs: FRESH_HEALTH_TIMEOUT_MS })
        if (fresh && fresh.ok !== false && fresh.health && typeof fresh.health === 'object') {
          health = fresh.health
          if (typeof seam.setHealth === 'function') seam.setHealth(fresh.health)
        }
      } catch (_e) {
        /* keep the cached value */
      }
    }
    const bad = rejectFromHealth(health, { inflight: busy })
    if (bad) {
      if (active.get(key) === entry) active.delete(key) // give the reservation back
      return reject(bad.code, `${label}: ${bad.message}`)
    }

    // 2. accepted
    active.set(key, entry)
    send({ type: 'accepted', req_id: reqId, view, slot })
    try {
      const result = await turn(request, entry)
      if (seam.phases) phase(slot, result.ok ? 'done' : 'error', result.ok ? undefined : result.code)
      return send(result)
    } finally {
      if (active.get(key) === entry) active.delete(key)
    }
  }

  /** Abort the in-flight op of `reqId` (adapter cancel); false when no such turn is running. */
  function cancel(reqId) {
    for (const entry of active.values()) {
      if (entry.reqId === reqId) {
        if (!entry.controller.signal.aborted) entry.controller.abort()
        return true
      }
    }
    return false
  }

  function inflight(slot) {
    const e = active.get(slot)
    return e ? { reqId: e.reqId, view: e.view } : null
  }

  return { run, cancel, inflight, mutex }
}
