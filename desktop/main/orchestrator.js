// desktop/main/orchestrator.js — one bridge `request` → one turn in a site view (Stage 2 electron-bridge).
//
//   run(request, emit) → Promise<finalFrame>   emit(frame) carries accepted / rejected / result to the backend
//   cancel(reqId) → boolean                    aborts the adapter op in flight for that request
//   inflight(slot) → {reqId, view} | null
//
// Per request (contract §1, decisions 12 / 13):
//   1. reject from the HEALTH CACHE before any DOM write: unknown slot → unknown_site; no live
//      view → view_crashed; a turn already in flight on that slot, or health.stop === true (the
//      site is still answering a manual prompt) → view_busy; health.session logged_out |
//      challenge | blocked → that code; matched.error 'view_crashed' → view_crashed;
//      view 'analyst' → analyst_not_chosen until Stage 3 injects `analystAdapterFor`.
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
//   7. capture[slot] on → `observe{baselineCount: assistantCount, quietMs, timeoutMs}` →
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
 *   analystAdapterFor?(slot)       Stage 3: the hidden analyst view's client (absent → analyst_not_chosen)
 *   focusView(slot)                `webContents.focus()` on the view (may be async)
 *   restoreRendererFocus()         called once the last queued insert phase has finished
 *   timeoutsFor(slot)              {composerWaitMs, sendWaitMs, submitVerifyMs} from the merged selectors
 *   captureTimeoutsFor?(slot)      {quietMs, firstTokenMs, captureTimeoutMs} (v2; defaults when absent)
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
 *   mutex, now, log, insertSettleMs, setTimeout, clearTimeout
 */
export function createOrchestrator({
  adapterFor,
  analystAdapterFor = null,
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

  const budgets = (slot) => {
    const t = (typeof timeoutsFor === 'function' && timeoutsFor(slot)) || {}
    const composer = Number.isFinite(t.composerWaitMs) ? t.composerWaitMs : 15000
    const send = Number.isFinite(t.sendWaitMs) ? t.sendWaitMs : 18000
    const verify = Number.isFinite(t.submitVerifyMs) ? t.submitVerifyMs : 5000
    const c = (typeof captureTimeoutsFor === 'function' && captureTimeoutsFor(slot)) || {}
    const quietMs = Number.isFinite(c.quietMs) ? c.quietMs : 2500
    const firstTokenMs = Number.isFinite(c.firstTokenMs) ? c.firstTokenMs : 90000
    const captureTimeoutMs = Number.isFinite(c.captureTimeoutMs) ? c.captureTimeoutMs : 300000
    return {
      readyMs: composer,
      submitMs: insertAndSubmitBudgetMs({ composerWaitMs: composer, sendWaitMs: send, submitVerifyMs: verify, insertSettleMs: settle }),
      quietMs,
      captureTimeoutMs,
      observeMs: observeBudgetMs({ firstTokenMs, captureTimeoutMs }),
    }
  }

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
   * Wait for a navigation main started elsewhere on `slot` (openChats / New chat / Sign out / the
   * initial load) to commit, so `ready` is never answered by the document about to be replaced.
   * Bounded by NAVIGATION_WAIT_MS; the turn's abort signal ends the wait at once. Never throws.
   */
  async function awaitPendingNavigation(slot, signal) {
    if (typeof pendingNavigation !== 'function') return
    let pending = null
    try {
      pending = pendingNavigation(slot)
    } catch (_e) {
      pending = null
    }
    if (!pending || typeof pending.then !== 'function') return
    info(`${slot}: a navigation is pending; waiting for it to commit before ready`)
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
    const { slot, view } = request
    const reqId = request.req_id
    const started = entry.started
    const elapsed = () => Math.max(0, Math.round(now() - started))
    const signal = entry.controller.signal
    const client = view === 'analyst' ? analystAdapterFor(slot) : adapterFor(slot)
    const { readyMs, submitMs, quietMs, captureTimeoutMs, observeMs } = budgets(slot)
    let chatWatch = null
    const cancelled = () => {
      if (signal.aborted) throw new AdapterRequestError('cancelled', 'cancelled by the backend')
    }
    try {
      if (!client) throw new AdapterRequestError('view_crashed', `${slot}: no live view`)
      // 3. navigation (decision 12)
      const link = chats && typeof chats.get === 'function' && typeof request.conversation_id === 'string' ? chats.get(request.conversation_id, slot) : null
      let target = null
      if (request.fresh === true && typeof newChatUrl === 'function') target = newChatUrl(slot) || null
      else if (link && link !== url(slot)) target = link
      if (target) {
        if (typeof loadUrl !== 'function') throw new AdapterRequestError('navigation', `${slot}: cannot navigate (no loader)`)
        info(`${slot}: opening ${link && target === link ? 'the recorded chat' : 'a new chat'}`)
        try {
          await loadUrl(slot, target)
        } catch (e) {
          throw new AdapterRequestError('navigation', `could not open the recorded chat: ${(e && e.message) || e}`)
        }
        cancelled()
      }
      // 3b. a navigation main started elsewhere must commit first (the old document would answer)
      await awaitPendingNavigation(slot, signal)
      cancelled()
      // 4. ready
      await client.request('ready', { timeoutMs: readyMs }, { timeoutMs: readyMs + TIMEOUT_GRACE_MS, signal })
      cancelled()
      // 5. insert under the mutex
      const submitted = await underMutex(async () => {
        cancelled()
        phase(slot, 'typing')
        if (typeof focusView === 'function') await focusView(slot)
        return client.request('insertAndSubmit', { text: request.text }, { timeoutMs: submitMs + TIMEOUT_GRACE_MS, signal })
      })
      phase(slot, 'submitted')
      // 6. chat-URL wait, in the background (never delays the result)
      chatWatch = watchChatUrl(slot, request.conversation_id)
      const resultUrl = () => chatWatch.url() || (typeof submitted.url === 'string' && submitted.url) || url(slot)
      // 7. observe when capture is on
      if (!captureOn(slot)) {
        return { type: 'result', req_id: reqId, ok: true, captured: false, url: resultUrl(), ms: elapsed() }
      }
      cancelled()
      phase(slot, 'replying')
      const observePayload = { quietMs, timeoutMs: captureTimeoutMs }
      if (Number.isInteger(submitted.assistantCount) && submitted.assistantCount >= 0) observePayload.baselineCount = submitted.assistantCount
      else warn(`${slot}: the submit result carried no usable assistantCount; the adapter samples the baseline itself`)
      const observed = await client.request('observe', observePayload, { timeoutMs: observeMs + TIMEOUT_GRACE_MS, signal })
      const text = typeof observed.text === 'string' ? observed.text : ''
      const doneBy = ['done_selector', 'stop_gone', 'quiet'].includes(observed.doneBy) ? observed.doneBy : 'quiet'
      return { type: 'result', req_id: reqId, ok: true, captured: true, text, url: (typeof observed.url === 'string' && observed.url) || resultUrl(), ms: elapsed(), done_by: doneBy }
    } catch (e) {
      const f = adapterFailure(e)
      const code = RESULT_CODE_SET.has(f.code) ? f.code : 'site_error'
      const message = code === f.code ? f.message : `${f.code}: ${f.message}`
      warn(`${slot}: ${code} — ${message}`)
      return { type: 'result', req_id: reqId, ok: false, code, message, partial: f.partial }
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
    if (view === 'analyst' && typeof analystAdapterFor !== 'function') return reject('analyst_not_chosen', 'no analyst view is available (Stage 3)')
    const key = view === 'analyst' ? `analyst:${slot}` : slot
    const client = view === 'analyst' ? analystAdapterFor(slot) : adapterFor(slot)
    if (!client) return reject('view_crashed', `${slot}: no live view`)
    let health = typeof getHealth === 'function' ? getHealth(slot) : null
    if (view !== 'analyst' && health && health.stop === true && !active.has(key)) {
      // The cache is fed by the adapter's change/poll publishes (1.5 s) — a stop button that showed
      // for a short reply can linger in it. Re-read before rejecting so a finished reply never
      // turns a send into view_busy; a site that is really still answering stays rejected.
      try {
        const fresh = await client.request('health', {}, { timeoutMs: FRESH_HEALTH_TIMEOUT_MS })
        if (fresh && fresh.ok !== false && fresh.health && typeof fresh.health === 'object') {
          health = fresh.health
          if (typeof setHealth === 'function') setHealth(slot, fresh.health)
        }
      } catch (_e) {
        /* keep the cached value */
      }
    }
    const bad = rejectFromHealth(view === 'analyst' ? null : health, { inflight: active.has(key) })
    if (bad) return reject(bad.code, `${slot}: ${bad.message}`)

    // 2. accepted
    const entry = { reqId, view, slot, controller: new AbortController(), started: now() }
    active.set(key, entry)
    send({ type: 'accepted', req_id: reqId, view, slot })
    try {
      const result = await turn(request, entry)
      if (result.ok) phase(slot, 'done')
      else phase(slot, 'error', result.code)
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
