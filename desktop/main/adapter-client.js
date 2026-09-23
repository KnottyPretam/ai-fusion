// desktop/main/adapter-client.js — main's side of the site-preload protocol (contract §2).
//
//   main → preload   webContents.send('triplex:adapter', {reqId, op, ...payload})
//   preload → main   ipcRenderer.send('triplex:adapter:result', {reqId, ok, op, ...})
//
// One client per site view. `request(op, payload, {timeoutMs})` resolves with the ok:true result
// object and rejects with an `AdapterRequestError {code, message, partial?}` for an ok:false
// result, a timeout (`timeout`, a `cancel` is sent for the request and its answer is awaitable as
// `error.cancelResult` — the preload holds ONE op in flight per view and only frees it once it has
// answered that cancel, so a caller that wants to ask anything else of the page must wait for it or
// be told `busy`; S11), a main-frame navigation
// (`did-navigate` → every pending request fails `adapter_gone`; the preload re-boots), a crashed
// or destroyed renderer (`view_crashed`) or a disposed client. Results are matched by `reqId` and
// accepted only from this view's own webContents (sender id + main frame): a result from another
// view, an SSO popup or a sub-frame is ignored.
// Pure module: `ipcMain`, the timers and the id generator are injected for node --test.

import { randomUUID } from 'node:crypto'

export const RESULT_CHANNEL = 'triplex:adapter:result'
export const REQUEST_CHANNEL = 'triplex:adapter'
export const DEFAULT_TIMEOUT_MS = 45000
/**
 * After an abort (`request(..., {signal})`) main sends `cancel{target}` and lets the adapter answer
 * `cancelled` itself (contract §2); when no answer comes within this grace the request is failed
 * locally with `cancelled` so a bridge `cancel` always terminates the turn.
 */
export const CANCEL_GRACE_MS = 2000

export class AdapterRequestError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'AdapterRequestError'
    this.code = code
    if (extra && extra.partial !== undefined) this.partial = extra.partial
    if (extra && extra.op !== undefined) this.op = extra.op
    // `timeout` only: a promise for the adapter's answer to the cancel main sent — `{cancelled}`, or
    // null when none came within CANCEL_GRACE_MS (or the view was gone). Never rejects.
    if (extra && extra.cancelResult !== undefined) this.cancelResult = extra.cancelResult
  }
}

/** True when an IPC event comes from `webContents`' main frame (sub-frames and other views are refused). */
export function isMainFrameOf(event, webContents) {
  if (!event || !event.sender || !webContents) return false
  const sender = event.sender
  const sameSender = sender === webContents || (typeof sender.id === 'number' && sender.id === webContents.id)
  if (!sameSender) return false
  let frame = null
  try {
    frame = event.senderFrame
  } catch (_e) {
    return false // the frame was disposed between send and receive
  }
  if (frame === undefined) return true // fakes and older events carry no frame
  if (frame === null) return false
  return !frame.parent
}

/**
 * createAdapterClient(webContents, slot, {ipcMain, setTimeout, clearTimeout, now, makeId, log}) → client
 *   client.request(op, payload = {}, {timeoutMs} = {}) → Promise<result>
 *   client.pending()   number of in-flight requests
 *   client.dispose()   detach every listener; pending requests reject `adapter_gone`
 *   client.slot / client.webContents
 */
export function createAdapterClient(
  webContents,
  slot,
  { ipcMain, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout, now = Date.now, makeId = randomUUID, log = console } = {},
) {
  if (!webContents || typeof webContents.send !== 'function') throw new Error('createAdapterClient: webContents is required')
  if (!ipcMain || typeof ipcMain.on !== 'function') throw new Error('createAdapterClient: ipcMain is required')

  const pending = new Map() // reqId -> {op, resolve, reject, timer}
  const cancels = new Map() // cancel reqId -> {resolve, timer}: the tracked cancels of timed-out requests (never counted as pending)
  let disposed = false

  const destroyed = () => {
    try {
      return typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()
    } catch (_e) {
      return true
    }
  }

  function settle(reqId, entry) {
    pending.delete(reqId)
    if (entry.timer !== null) clearT(entry.timer)
    if (entry.cancelTimer !== null) clearT(entry.cancelTimer)
    if (entry.detachAbort) entry.detachAbort()
  }

  function failAll(code, message) {
    for (const [reqId, entry] of Array.from(pending.entries())) {
      settle(reqId, entry)
      entry.reject(new AdapterRequestError(code, message, { op: entry.op }))
    }
    // a page that navigated or died has no op in flight any more: every tracked cancel is answered
    for (const [cancelId, c] of Array.from(cancels.entries())) settleCancel(cancelId, c, null)
  }

  function settleCancel(cancelId, c, value) {
    cancels.delete(cancelId)
    if (c.timer !== null) clearT(c.timer)
    c.resolve(value)
  }

  /**
   * Send `cancel{target}` for a request main gave up on and resolve with the adapter's answer
   * (`{cancelled}`), or null when none came within CANCEL_GRACE_MS or the view is gone. Never
   * rejects: the cancel is a courtesy to the page, and a missing answer is a fact about the page,
   * not a failure of the request that sent it. Tracked apart from `pending` — it is not a request
   * the caller is waiting on, so `pending()` and `failAll` treat it as what it is.
   */
  function sendCancel(target) {
    return new Promise((resolve) => {
      const cancelId = String(makeId())
      const c = { resolve, timer: null }
      c.timer = setT(() => {
        if (cancels.get(cancelId) === c) settleCancel(cancelId, c, null)
      }, CANCEL_GRACE_MS)
      if (c.timer && typeof c.timer.unref === 'function') c.timer.unref()
      cancels.set(cancelId, c)
      try {
        send({ reqId: cancelId, op: 'cancel', target })
      } catch (_e) {
        settleCancel(cancelId, c, null) // the view is gone; nothing to cancel
      }
    })
  }

  function send(msg) {
    if (destroyed()) throw new AdapterRequestError('view_crashed', `${slot}: view is gone`, { op: msg.op })
    webContents.send(REQUEST_CHANNEL, msg)
  }

  const onResult = (event, res) => {
    if (disposed || !isMainFrameOf(event, webContents)) return
    if (!res || typeof res !== 'object' || typeof res.reqId !== 'string') return
    const c = cancels.get(res.reqId)
    if (c) {
      settleCancel(res.reqId, c, { cancelled: res.ok === true && res.cancelled === true })
      return
    }
    const entry = pending.get(res.reqId)
    if (!entry) return // an abort's cancel ack, a late reply after timeout, or a reply we never asked for
    settle(res.reqId, entry)
    if (res.ok === true) {
      entry.resolve(res)
      return
    }
    const code = typeof res.code === 'string' && res.code !== '' ? res.code : 'site_error'
    entry.reject(new AdapterRequestError(code, typeof res.message === 'string' ? res.message : code, { partial: res.partial, op: entry.op }))
  }

  const onNavigate = () => failAll('adapter_gone', `${slot}: the page navigated while a request was in flight`)
  const onGone = () => failAll('view_crashed', `${slot}: the site renderer is gone`)

  ipcMain.on(RESULT_CHANNEL, onResult)
  if (typeof webContents.on === 'function') {
    webContents.on('did-navigate', onNavigate)
    webContents.on('render-process-gone', onGone)
    webContents.on('destroyed', onGone)
  }

  /**
   * request(op, payload, {timeoutMs, signal}): `signal` (an AbortSignal) cancels the in-flight op —
   * main sends `cancel{target: reqId}`, the adapter aborts the op and answers `cancelled` (that
   * result settles the promise); CANCEL_GRACE_MS without an answer → rejected `cancelled` locally.
   */
  function request(op, payload = {}, { timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new AdapterRequestError('adapter_gone', `${slot}: adapter client disposed`, { op }))
        return
      }
      if (typeof op !== 'string' || op === '') {
        reject(new AdapterRequestError('site_error', 'request: op must be a non-empty string', { op }))
        return
      }
      const reqId = String(makeId())
      const budget = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
      const msg = { ...(payload && typeof payload === 'object' ? payload : {}), reqId, op }
      const entry = { op, resolve, reject, timer: null, cancelTimer: null, detachAbort: null, started: now() }
      if (signal && typeof signal === 'object' && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          if (!pending.has(reqId)) return
          try {
            send({ reqId: String(makeId()), op: 'cancel', target: reqId })
          } catch (_e) {
            settle(reqId, entry)
            reject(new AdapterRequestError('cancelled', `${slot}: ${op} cancelled (view gone)`, { op }))
            return
          }
          entry.cancelTimer = setT(() => {
            if (!pending.has(reqId)) return
            settle(reqId, entry)
            reject(new AdapterRequestError('cancelled', `${slot}: ${op} cancelled (no answer from the adapter)`, { op }))
          }, CANCEL_GRACE_MS)
          if (entry.cancelTimer && typeof entry.cancelTimer.unref === 'function') entry.cancelTimer.unref()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.detachAbort = () => signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          reject(new AdapterRequestError('cancelled', `${slot}: ${op} cancelled before it was sent`, { op }))
          entry.detachAbort()
          return
        }
      }
      entry.timer = setT(() => {
        if (!pending.has(reqId)) return
        settle(reqId, entry)
        // The cancel is TRACKED (S11): its answer is the moment the adapter has freed its one
        // in-flight slot, and the settled re-read that may follow a timed-out analyst capture must
        // not ask anything of the page before then. Fire-and-forget left that moment unknowable.
        const cancelResult = sendCancel(reqId)
        reject(new AdapterRequestError('timeout', `${slot}: ${op} timed out after ${budget} ms`, { op, cancelResult }))
      }, budget)
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref()
      pending.set(reqId, entry)
      try {
        send(msg)
      } catch (e) {
        settle(reqId, entry)
        reject(e instanceof AdapterRequestError ? e : new AdapterRequestError('view_crashed', String((e && e.message) || e), { op }))
      }
    })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (typeof ipcMain.removeListener === 'function') ipcMain.removeListener(RESULT_CHANNEL, onResult)
    if (typeof webContents.removeListener === 'function') {
      webContents.removeListener('did-navigate', onNavigate)
      webContents.removeListener('render-process-gone', onGone)
      webContents.removeListener('destroyed', onGone)
    }
    failAll('adapter_gone', `${slot}: adapter client disposed`)
  }

  return {
    slot,
    webContents,
    request,
    pending: () => pending.size,
    dispose,
    isDisposed: () => disposed,
  }
}
