// desktop/main/orchestrator.js — one unified prompt into N site views (Stage 1 `prompt:send`).
//
//   submitAll({targets, text}) → {results: {[slot]: {ok, code?, message?, ms, url?, composerSelector?, sendSelector?}}}
//
// Per target, in parallel:  ready (composer present, session ok, nothing in flight)
//                           → mutex ⟨ focus the view → insertAndSubmit ⟩ release
// The `ready` phases overlap; the insert phases never do (decision 13: a focus race would leave the
// text in one pane only). One target's failure never fails another. The renderer's focus is
// restored exactly once, after the last insert phase has finished. Nothing is read back.
// Runs themselves are serialized too (`submitAll` queues behind the previous run): the renderer's
// `sending` lock is the main path, but after a renderer crash-reload a second run could otherwise
// restore the renderer's focus while the first is still inside a view.
// Pure module: `adapterFor`, `focusView`, `restoreRendererFocus` and `timeoutsFor` are injected.

import { SLOTS } from './sites.js'
import { AdapterRequestError } from './adapter-client.js'
import { INSERT_SETTLE_MS } from './selectors.js'

export { INSERT_SETTLE_MS }

/** Grace added to the preload's own budget so main's timeout fires after the adapter's, not before. */
export const TIMEOUT_GRACE_MS = 3000

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

/** A promise-chain mutex: `lock()` resolves with the release function once the lock is yours. */
export function createMutex() {
  let tail = Promise.resolve()
  let holders = 0
  return {
    lock() {
      let release
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
        holders += 1
        return release
      })
      tail = ticket.then(() => gate)
      return ticket
    },
    locked: () => holders > 0,
  }
}

function errorResult(e, ms) {
  if (e instanceof AdapterRequestError) return { ok: false, code: e.code, message: e.message, ms }
  const code = e && typeof e.code === 'string' && e.code !== '' ? e.code : 'site_error'
  return { ok: false, code, message: String((e && e.message) || e), ms }
}

/**
 * createOrchestrator({adapterFor, focusView, restoreRendererFocus, timeoutsFor, mutex, now, log}) → {submitAll}
 *   adapterFor(slot)          the view's adapter client (null → `view_crashed`)
 *   focusView(slot)           `webContents.focus()` on the view (may be async)
 *   restoreRendererFocus()    called once after every insert phase has finished
 *   timeoutsFor(slot)         {composerWaitMs, sendWaitMs, submitVerifyMs} from the merged selectors
 */
export function createOrchestrator({ adapterFor, focusView, restoreRendererFocus, timeoutsFor, mutex = createMutex(), now = Date.now, log = console, insertSettleMs = INSERT_SETTLE_MS } = {}) {
  if (typeof adapterFor !== 'function') throw new Error('createOrchestrator: adapterFor is required')
  const settle = Number.isFinite(insertSettleMs) && insertSettleMs >= 0 ? insertSettleMs : INSERT_SETTLE_MS

  const budgets = (slot) => {
    const t = (typeof timeoutsFor === 'function' && timeoutsFor(slot)) || {}
    const composer = Number.isFinite(t.composerWaitMs) ? t.composerWaitMs : 15000
    const send = Number.isFinite(t.sendWaitMs) ? t.sendWaitMs : 18000
    const verify = Number.isFinite(t.submitVerifyMs) ? t.submitVerifyMs : 5000
    return { readyMs: composer, submitMs: insertAndSubmitBudgetMs({ composerWaitMs: composer, sendWaitMs: send, submitVerifyMs: verify, insertSettleMs: settle }) }
  }

  async function submitOne(slot, text) {
    const started = now()
    const elapsed = () => Math.max(0, Math.round(now() - started))
    try {
      const client = adapterFor(slot)
      if (!client) throw new AdapterRequestError('view_crashed', `${slot}: no live view`)
      const { readyMs, submitMs } = budgets(slot)
      await client.request('ready', { timeoutMs: readyMs }, { timeoutMs: readyMs + TIMEOUT_GRACE_MS })
      const release = await mutex.lock()
      let res
      try {
        if (typeof focusView === 'function') await focusView(slot)
        res = await client.request('insertAndSubmit', { text }, { timeoutMs: submitMs + TIMEOUT_GRACE_MS })
      } finally {
        release()
      }
      const out = { ok: true, ms: elapsed() }
      if (typeof res.url === 'string') out.url = res.url
      if (typeof res.composerSelector === 'string') out.composerSelector = res.composerSelector
      if (typeof res.sendSelector === 'string') out.sendSelector = res.sendSelector
      return out
    } catch (e) {
      const r = errorResult(e, elapsed())
      if (log && typeof log.warn === 'function') log.warn(`[orchestrator] ${slot}: ${r.code} — ${r.message}`)
      return r
    }
  }

  async function runAll({ targets, text } = {}) {
    const wanted = new Set(Array.isArray(targets) ? targets : [])
    const slots = SLOTS.filter((s) => wanted.has(s))
    const prompt = typeof text === 'string' ? text : ''
    const settled = await Promise.all(slots.map((slot) => submitOne(slot, prompt)))
    try {
      if (typeof restoreRendererFocus === 'function') await restoreRendererFocus()
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[orchestrator] restoreRendererFocus: ${(e && e.message) || e}`)
    }
    const results = {}
    slots.forEach((slot, i) => {
      results[slot] = settled[i]
    })
    return { results }
  }

  let tail = Promise.resolve()

  /**
   * targets: slot[] (already validated by ipc.js; de-duplicated here in SLOTS order); text: string.
   * Never rejects: every slot gets a result object. Runs are queued: a call made while another run
   * is in flight starts after that run has restored the renderer's focus.
   */
  function submitAll(req = {}) {
    const run = tail.then(() => runAll(req))
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return { submitAll, mutex }
}
