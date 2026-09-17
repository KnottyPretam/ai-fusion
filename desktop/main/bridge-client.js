// desktop/main/bridge-client.js — Electron's side of the bridge WebSocket (contract §1; Stage 2).
//
//   ws://127.0.0.1:<PORT>/api/bridge, JSON text frames, ONE client. On open the first frame is
//   `hello{protocol, token, version, sites, capture, analyst}`; nothing else goes out until the
//   backend's `hello_ack` (a `request` that arrives before it is dropped with a warning). Then:
//     request  → onRequest(frame, emit)   (the orchestrator's run; emit carries accepted/rejected/result)
//     cancel   → onCancel(req_id)
//     ping     → pong{ts} (the ping's ts echoed)
//   plus `capture` / `analyst` / `health` frames whenever main's state changes (and the cached
//   health of every view is re-sent right after every hello_ack, so a restarted backend sees it).
//
//   Reconnect: any close that is not fatal schedules a reconnect with backoff 0.5 → 1 → 2 → 4 →
//   8 → 10 s (capped, reset by a hello_ack). Fatal closes stop the client instead of storming:
//   4002 superseded (another client took the bridge), 4003 bad token, 4001 malformed hello —
//   `connect()` must be called again explicitly. A backend that stops pinging (no ping for
//   PING_MISS_FACTOR × ping_s) is treated as gone: the socket is closed and the reconnect
//   schedule starts. Every incoming frame is checked by protocol.js; every outgoing one too (an
//   invalid outgoing frame is logged and NOT sent — a malformed frame would get the socket closed).
//
//   In-flight turns are bound to the socket generation that carried their request: when the
//   socket drops, the turn keeps running locally (the site is already answering; cancelling it
//   would leave the pane in a half state) and every frame it emits afterwards is discarded — the
//   backend has already failed that request `bridge_disconnected` and never re-sends a req_id.
//
//   A `capture` / `analyst` change that lands while the socket is `open` (hello sent, hello_ack
//   pending) cannot go out yet and would be stale in the hello the backend is reading; it is
//   marked dirty and flushed from the live getters right after the ack (after the health replay).
//
//   Frame bodies are never logged (the token travels only inside `hello`).
//   The socket is `globalThis.WebSocket` (Node ≥ 22 / Electron 44); `makeSocket` is injectable
//   so node --test drives the client with a fake. No electron import. `bridgeUrlFor` refuses a
//   backend host that is not loopback unless `allowRemote` (TRIPLEX_ALLOW_REMOTE_BACKEND=1).

import { SLOTS, LOOPBACK_HOSTS } from './sites.js'
import { parseFrame, validateClientFrame, checkHealth } from './protocol.js'

export const PROTOCOL = 1
export const BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 10000])
export const HELLO_ACK_TIMEOUT_MS = 10000
export const PING_MISS_FACTOR = 2.5
export const CLOSE_MALFORMED = 4001
export const CLOSE_SUPERSEDED = 4002
export const CLOSE_BAD_TOKEN = 4003
export const CLOSE_HELLO_TIMEOUT = 4004
/** Closes after which the client stops instead of reconnecting (an explicit connect() restarts it). */
export const FATAL_CLOSE_CODES = Object.freeze([CLOSE_MALFORMED, CLOSE_SUPERSEDED, CLOSE_BAD_TOKEN])
/** Our own close codes (application range; never fatal). */
export const CLOSE_CLIENT_TIMEOUT = 4000
export const WS_OPEN = 1

/**
 * `http://127.0.0.1:8021` (or `.../` / `https:`) → `ws://127.0.0.1:8021/api/bridge`. A host that is
 * not loopback throws unless `allowRemote` — the hello carries the bridge token and every request
 * that follows drives the signed-in site views.
 */
export function bridgeUrlFor(backendUrl, { allowRemote = false } = {}) {
  const u = new URL(String(backendUrl))
  if (!allowRemote && !LOOPBACK_HOSTS.includes(u.hostname.toLowerCase().replace(/\.$/, ''))) {
    throw new Error(`bridge: refusing the non-loopback backend host ${u.hostname} (set TRIPLEX_ALLOW_REMOTE_BACKEND=1 to attach to a remote backend)`)
  }
  const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:'
  return `${proto}//${u.host}/api/bridge`
}

function listen(target, name, fn) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener(name, fn)
    return
  }
  if (typeof target.on === 'function') {
    target.on(name, fn)
    return
  }
  target[`on${name}`] = fn
}

function analystChoice(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return SLOTS.includes(v) ? { slot: v } : null
  if (typeof v === 'object' && SLOTS.includes(v.slot)) return { slot: v.slot }
  return null
}

/**
 * createBridgeClient(deps) → client
 *   url                      the bridge WebSocket URL (see bridgeUrlFor)
 *   token                    the per-launch token (spawned backend) or BRIDGE_TOKEN (attach)
 *   version                  the app version put into hello
 *   sites                    slots to announce (default SLOTS)
 *   getCapture()             {slot: boolean}          getAnalyst() → slot | {slot} | null
 *   getHealth(slot)          the cached Health or null (re-sent after every hello_ack)
 *   onRequest(frame, emit)   → Promise; emit(frame) sends accepted / rejected / result
 *   onCancel(reqId)          the orchestrator's cancel
 *   onState({connected, since?})   `panes:bridge` (called on every transition)
 *   makeSocket(url)          default: new globalThis.WebSocket(url)
 *   setTimeout / clearTimeout / now / log
 *
 * client: connect(), close(), status(), isConnected(), sendCapture(map?), sendAnalyst(choice?),
 *         sendHealth(slot, health), inflight() → number
 */
export function createBridgeClient({
  url,
  token,
  version = '0.0.0',
  sites = SLOTS,
  getCapture = () => ({ claude: false, chatgpt: false, grok: false }),
  getAnalyst = () => null,
  getHealth = () => null,
  onRequest = null,
  onCancel = null,
  onState = null,
  makeSocket = (u) => new globalThis.WebSocket(u),
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  now = Date.now,
  log = console,
} = {}) {
  if (typeof url !== 'string' || url === '') throw new Error('createBridgeClient: url is required')
  if (typeof token !== 'string' || token === '') throw new Error('createBridgeClient: token is required')

  const warn = (m) => log && typeof log.warn === 'function' && log.warn(`[bridge] ${m}`)
  const error = (m) => log && typeof log.error === 'function' && log.error(`[bridge] ${m}`)
  const info = (m) => log && typeof log.log === 'function' && log.log(`[bridge] ${m}`)

  let state = 'idle' // idle | connecting | open | connected | closed | stopped
  let socket = null
  let generation = 0
  let attempts = 0
  let since = null
  let pingS = null
  let stopped = false
  let reconnectTimer = null
  let helloTimer = null
  let pingTimer = null
  let discarded = 0
  let lastClose = null
  let captureDirty = false // a capture change refused while `open` (hello sent, ack pending)
  let analystDirty = false
  const inflight = new Map() // req_id -> {slot, generation, started}

  function emitState() {
    if (typeof onState !== 'function') return
    try {
      onState(state === 'connected' ? { connected: true, since } : { connected: false })
    } catch (e) {
      warn(`onState failed: ${(e && e.message) || e}`)
    }
  }

  function clearTimer(t) {
    if (t !== null) clearT(t)
    return null
  }

  function socketOpen(ws) {
    return !!ws && (ws.readyState === undefined || ws.readyState === WS_OPEN)
  }

  /** Send one already-validated frame on the current socket; false when it could not go out. */
  function sendRaw(frame) {
    if (!socketOpen(socket)) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch (e) {
      warn(`send failed: ${(e && e.message) || e}`)
      return false
    }
  }

  /** Validate an Electron → backend frame and send it (invalid → logged, not sent). */
  function sendFrame(frame) {
    const r = validateClientFrame(frame)
    if (!r.ok) {
      error(`refusing to send an invalid ${frame && frame.type} frame: ${r.error}`)
      return false
    }
    return sendRaw(frame)
  }

  function buildHello() {
    return { type: 'hello', protocol: PROTOCOL, token, version: String(version), sites: [...sites], capture: { ...getCapture() }, analyst: analystChoice(getAnalyst()) }
  }

  function armPingWatch() {
    pingTimer = clearTimer(pingTimer)
    if (!pingS) return
    const g = generation
    pingTimer = setT(() => {
      pingTimer = null
      if (g !== generation || state !== 'connected') return
      warn(`no ping from the backend for ${PING_MISS_FACTOR} × ${pingS} s; reconnecting`)
      closeSocket(CLOSE_CLIENT_TIMEOUT, 'ping timeout')
    }, Math.round(pingS * 1000 * PING_MISS_FACTOR))
    if (pingTimer && typeof pingTimer.unref === 'function') pingTimer.unref()
  }

  function closeSocket(code, reason) {
    const ws = socket
    if (!ws) return
    try {
      ws.close(code, reason)
    } catch (e) {
      warn(`close failed: ${(e && e.message) || e}`)
      onClose(generation, { code, reason })
    }
  }

  function scheduleReconnect() {
    reconnectTimer = clearTimer(reconnectTimer)
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
    attempts += 1
    reconnectTimer = setT(() => {
      reconnectTimer = null
      connect()
    }, delay)
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
    info(`reconnecting in ${delay} ms (attempt ${attempts})`)
  }

  function resendHealth() {
    for (const slot of sites) {
      let h = null
      try {
        h = getHealth(slot)
      } catch (_e) {
        h = null
      }
      if (h) sendHealth(slot, h)
    }
  }

  /** Capture / analyst changes that landed between hello and hello_ack go out now, from the live getters. */
  function flushDirty() {
    if (captureDirty) {
      captureDirty = false
      sendCapture()
    }
    if (analystDirty) {
      analystDirty = false
      sendAnalyst()
    }
  }

  function dispatch(frame) {
    const g = generation
    inflight.set(frame.req_id, { slot: frame.slot, generation: g, started: now() })
    const emit = (out) => {
      if (g !== generation || state !== 'connected') {
        discarded += 1
        info(`req=${frame.req_id} ${out && out.type} discarded: the socket that carried the request is gone`)
        return false
      }
      return sendFrame(out)
    }
    info(`req=${frame.req_id} slot=${frame.slot} view=${frame.view} purpose=${frame.purpose} accepted for dispatch`)
    Promise.resolve()
      .then(() => (typeof onRequest === 'function' ? onRequest(frame, emit) : null))
      .catch((e) => {
        error(`req=${frame.req_id} orchestrator failure: ${(e && e.message) || e}`)
        emit({ type: 'result', req_id: frame.req_id, ok: false, code: 'site_error', message: `orchestrator failure: ${(e && e.message) || e}`, partial: null })
      })
      .then(() => {
        inflight.delete(frame.req_id)
      })
  }

  function handleMessage(g, data) {
    if (g !== generation) return
    const text = typeof data === 'string' ? data : data && typeof data.toString === 'function' && !(data instanceof ArrayBuffer) ? data.toString() : ''
    const r = parseFrame(text, 'server')
    if (!r.ok) {
      warn(`dropped an invalid backend frame: ${r.error}`)
      return
    }
    const f = r.frame
    switch (f.type) {
      case 'hello_ack': {
        if (state !== 'open') {
          warn('hello_ack in the wrong state; ignored')
          return
        }
        helloTimer = clearTimer(helloTimer)
        state = 'connected'
        since = now()
        attempts = 0
        pingS = f.ping_s
        info(`connected (backend ${f.backend_version}, ping every ${pingS} s)`)
        emitState()
        resendHealth()
        flushDirty()
        armPingWatch()
        return
      }
      case 'ping':
        sendRaw({ type: 'pong', ts: f.ts })
        if (state === 'connected') armPingWatch()
        return
      case 'request':
        if (state !== 'connected') {
          warn(`request req=${f.req_id} before hello_ack; dropped`)
          return
        }
        dispatch(f)
        return
      case 'cancel':
        info(`req=${f.req_id} cancel`)
        if (typeof onCancel === 'function') {
          try {
            onCancel(f.req_id)
          } catch (e) {
            warn(`onCancel failed: ${(e && e.message) || e}`)
          }
        }
        return
      default:
        return
    }
  }

  function onClose(g, { code, reason } = {}) {
    if (g !== generation) return
    const wasConnected = state === 'connected'
    socket = null
    helloTimer = clearTimer(helloTimer)
    pingTimer = clearTimer(pingTimer)
    since = null
    pingS = null
    lastClose = { code: Number.isInteger(code) ? code : null, reason: typeof reason === 'string' ? reason : '', at: now() }
    if (inflight.size) info(`${inflight.size} in-flight turn(s) continue locally; their results will be discarded`)
    if (stopped) {
      state = 'stopped'
      if (wasConnected) emitState()
      return
    }
    if (FATAL_CLOSE_CODES.includes(code)) {
      state = 'stopped'
      const why = code === CLOSE_SUPERSEDED ? 'superseded by another bridge client' : code === CLOSE_BAD_TOKEN ? 'the backend refused the token' : 'the backend called our hello malformed'
      error(`closed ${code} (${why}); not reconnecting — connect() restarts the client`)
      if (wasConnected) emitState()
      return
    }
    state = 'closed'
    info(`socket closed (${code === undefined ? 'no code' : code}${reason ? ` ${reason}` : ''})`)
    if (wasConnected) emitState()
    scheduleReconnect()
  }

  function connect() {
    if (state === 'connecting' || state === 'open' || state === 'connected') return false
    stopped = false
    reconnectTimer = clearTimer(reconnectTimer)
    generation += 1
    const g = generation
    state = 'connecting'
    let ws
    try {
      ws = makeSocket(url)
    } catch (e) {
      warn(`cannot open ${url}: ${(e && e.message) || e}`)
      state = 'closed'
      scheduleReconnect()
      return false
    }
    socket = ws
    listen(ws, 'open', () => {
      if (g !== generation) return
      state = 'open'
      captureDirty = false // the hello built now carries the live values
      analystDirty = false
      if (!sendRaw(buildHello())) return
      helloTimer = setT(() => {
        helloTimer = null
        if (g !== generation || state !== 'open') return
        warn(`no hello_ack within ${HELLO_ACK_TIMEOUT_MS} ms; reconnecting`)
        closeSocket(CLOSE_CLIENT_TIMEOUT, 'hello_ack timeout')
      }, HELLO_ACK_TIMEOUT_MS)
      if (helloTimer && typeof helloTimer.unref === 'function') helloTimer.unref()
    })
    listen(ws, 'message', (event) => handleMessage(g, event && 'data' in event ? event.data : event))
    listen(ws, 'error', (event) => {
      if (g !== generation) return
      const msg = event && (event.message || (event.error && event.error.message))
      warn(`socket error${msg ? `: ${msg}` : ''} (a close follows)`)
    })
    listen(ws, 'close', (event) => onClose(g, { code: event && event.code, reason: event && event.reason }))
    return true
  }

  function close() {
    stopped = true
    reconnectTimer = clearTimer(reconnectTimer)
    helloTimer = clearTimer(helloTimer)
    pingTimer = clearTimer(pingTimer)
    if (socket) {
      closeSocket(1000, 'shutdown')
      // onClose flips the state when the socket reports; make it definite now for callers
      if (state !== 'stopped') {
        const wasConnected = state === 'connected'
        state = 'stopped'
        socket = null
        since = null
        if (wasConnected) emitState()
      }
      return
    }
    state = 'stopped'
  }

  function sendCapture(capture) {
    if (state !== 'connected') {
      if (state === 'open') captureDirty = true // the hello already went out with the old value
      return false
    }
    return sendFrame({ type: 'capture', capture: { ...(capture || getCapture()) } })
  }

  function sendAnalyst(choice) {
    if (state !== 'connected') {
      if (state === 'open') analystDirty = true
      return false
    }
    return sendFrame({ type: 'analyst', analyst: analystChoice(choice === undefined ? getAnalyst() : choice) })
  }

  function sendHealth(slot, health) {
    if (state !== 'connected') return false
    if (!SLOTS.includes(slot)) return false
    try {
      checkHealth(health)
    } catch (e) {
      warn(`health for ${slot} not sent: ${(e && e.message) || e}`)
      return false
    }
    return sendFrame({ type: 'health', slot, health })
  }

  function status() {
    return { state, connected: state === 'connected', since, url, attempts, pingS, inflight: inflight.size, discarded, lastClose }
  }

  return {
    connect,
    close,
    status,
    isConnected: () => state === 'connected',
    sendCapture,
    sendAnalyst,
    sendHealth,
    inflight: () => inflight.size,
  }
}
