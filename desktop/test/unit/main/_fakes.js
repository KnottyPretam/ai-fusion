// Shared fakes for desktop/test/unit/main/*.test.js — no Electron, no I/O.
// Not a test file (no `.test.js` suffix), so `node --test 'test/unit/**/*.test.js'` never runs it.

import { EventEmitter } from 'node:events'

let nextId = 100

/** A webContents-like emitter: send() records messages; id is unique; destroy() flips isDestroyed(). */
export function fakeWebContents({ id = nextId++, url = 'https://example.test/' } = {}) {
  const wc = new EventEmitter()
  wc.id = id
  wc.sent = [] // [channel, payload]
  wc.zoom = 1
  wc.focused = 0
  wc.reloads = 0
  wc.loads = []
  wc.devtools = []
  wc._destroyed = false
  wc._url = url
  wc.send = (channel, payload) => {
    wc.sent.push([channel, payload])
  }
  wc.isDestroyed = () => wc._destroyed
  wc.destroy = () => {
    wc._destroyed = true
    wc.emit('destroyed')
  }
  wc.close = () => {
    wc._destroyed = true
  }
  wc.setZoomFactor = (f) => {
    wc.zoom = f
  }
  wc.getZoomFactor = () => wc.zoom
  wc.focus = () => {
    wc.focused += 1
  }
  wc.reload = () => {
    wc.reloads += 1
  }
  wc.loadURL = async (u) => {
    wc.loads.push(u)
    wc._url = u
  }
  wc.getURL = () => wc._url
  wc.openDevTools = (opts) => {
    wc.devtools.push(opts)
  }
  wc.windowOpenHandler = null
  wc.setWindowOpenHandler = (fn) => {
    wc.windowOpenHandler = fn
  }
  /** The last message sent on `triplex:adapter` (or all of them). */
  wc.adapterMessages = () => wc.sent.filter(([c]) => c === 'triplex:adapter').map(([, m]) => m)
  return wc
}

/** ipcMain-like: handle() stores invoke handlers, on() listeners; invoke()/emit() drive them. */
export function fakeIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push(fn)
    },
    removeListener(channel, fn) {
      const list = listeners.get(channel) || []
      const i = list.indexOf(fn)
      if (i !== -1) list.splice(i, 1)
    },
    /** Drive an invoke handler as Electron would: returns a promise. */
    invoke(channel, event, ...args) {
      const fn = handlers.get(channel)
      if (!fn) return Promise.reject(new Error(`no handler for ${channel}`))
      try {
        return Promise.resolve(fn(event, ...args))
      } catch (e) {
        return Promise.reject(e)
      }
    },
    /** Drive a fire-and-forget channel. */
    emit(channel, event, ...args) {
      for (const fn of listeners.get(channel) || []) fn(event, ...args)
    },
  }
}

/** An IPC event from a given webContents' main frame (`senderFrame.parent === null`; `url` = the frame's document when given). */
export function eventFrom(sender, { parent = null, url } = {}) {
  const senderFrame = { parent }
  if (url !== undefined) senderFrame.url = url
  return { sender, senderFrame }
}

/** A will-navigate / will-redirect event object: `prevented` flips on preventDefault(). */
export function navEvent(url, extra = {}) {
  return {
    prevented: false,
    url,
    ...extra,
    preventDefault() {
      this.prevented = true
    },
  }
}

/** What `did-create-window` hands over: a BrowserWindow-like child owning a fresh fakeWebContents. */
export function fakeChildWindow() {
  return { webContents: fakeWebContents({ url: 'about:blank' }) }
}

/** A View-like object recording setBounds / setVisible. */
export function fakeView() {
  return {
    bounds: null,
    visible: true,
    setBounds(b) {
      this.bounds = { ...b }
    },
    getBounds() {
      return this.bounds
    },
    setVisible(v) {
      this.visible = v
    },
    getVisible() {
      return this.visible
    },
  }
}

/** A WebContentsView-like class: records constructor options, owns a fakeWebContents. */
export function makeFakeWebContentsViewClass(instances = []) {
  return class FakeWebContentsView {
    constructor(options) {
      this.options = options
      this.webContents = fakeWebContents({ url: 'about:blank' })
      Object.assign(this, fakeView())
      instances.push(this)
    }
  }
}

/** A session-like object recording the permission handlers. */
export function fakeSession(partition) {
  return {
    partition,
    requestHandler: null,
    checkHandler: null,
    deviceHandler: null,
    setPermissionRequestHandler(fn) {
      this.requestHandler = fn
    },
    setPermissionCheckHandler(fn) {
      this.checkHandler = fn
    },
    setDevicePermissionHandler(fn) {
      this.deviceHandler = fn
    },
  }
}

/** A minimal settings-like object for the view managers (zoom per slot + the Stage 3 analyst keys). */
export function fakeSettings(zoom = { claude: 1, chatgpt: 1, grok: 1 }, { analyst = 'chatgpt', analystVisible = false } = {}) {
  return {
    zoom: { ...zoom },
    saves: 0,
    analyst,
    analystVisible,
    getZoom(slot) {
      return this.zoom[slot]
    },
    setZoom(slot, f) {
      this.zoom[slot] = f
      this.saves += 1
      return f
    },
    getAnalyst() {
      return this.analyst
    },
    setAnalyst(slot) {
      this.analyst = slot
      this.saves += 1
      return this.analyst
    },
    getAnalystVisible() {
      return this.analystVisible === true
    },
    setAnalystVisible(v) {
      this.analystVisible = v === true
      this.saves += 1
      return this.analystVisible
    },
  }
}

/** A controllable fake timer set: `advance(ms)` runs due callbacks in order. */
export function fakeTimers() {
  let now = 0
  let seq = 0
  const timers = new Map()
  const api = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + (Number(ms) || 0), fn, seq: id })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)
        if (!due.length) break
        const t = due[0]
        timers.delete(t.seq)
        now = t.at
        t.fn()
      }
      now = target
    },
  }
  return api
}

/** A logger that records instead of printing. */
export function fakeLog() {
  const log = { lines: [] }
  for (const level of ['log', 'info', 'warn', 'error']) {
    log[level] = (...args) => log.lines.push([level, args.map(String).join(' ')])
  }
  return log
}

/** Site table pointing the three slots at a loopback fake site. */
export function fakeSites(base = 'http://127.0.0.1:5199') {
  const out = {}
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    out[slot] = { url: `${base}/?site=${slot}`, newChatUrl: `${base}/?site=${slot}`, partition: `persist:${slot}`, hosts: ['127.0.0.1', 'localhost'] }
  }
  return out
}

export const tick = () => new Promise((r) => setImmediate(r))
