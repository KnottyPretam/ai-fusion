// A fake `electron` module for main-wiring.test.js: enough of app / BrowserWindow /
// WebContentsView / session / shell / ipcMain / screen / Menu / nativeTheme for main/main.js to run its
// preflight and `start()` under plain Node. After `ready` it probes the wiring (IPC handlers,
// layout, zoom, a shortcut, health forwarding, the bridge handshake + one request → result round
// trip over a fake WebSocket, the Stage 2 IPC channels, the renderer's origin guard + foreign-frame
// IPC refusal, child-window / redirect / backstop policy, the Bluetooth chooser, the health + zoom
// + bridge replay, window-bounds persistence, the Stage 3 hidden analyst page) and prints ONE line
// `FAKE_ELECTRON_REPORT <json>`
// before exiting; `app.exit(code)` prints the report and exits with that code at once (the refusal
// paths). Every FakeWebContents emits `web-contents-created` on `app` as Electron does,
// synchronously in its constructor. Order matters for one thing and is recorded for it: every
// `nativeTheme.themeSource = …` lands in `report.themeSourceSets` with the number of windows /
// views / surfaces that existed at the time, so the wiring test can prove the theme is applied
// before any site view is created (the site pages' first paint) — and every window and view
// records the grounds it was given (`background` / `backgrounds`).
//
// Two guards so a wiring run never touches the network: `TRIPLEX_BACKEND_URL` is forced to an
// attach URL (main.js then never spawns a backend) and `globalThis.WebSocket` is replaced by a
// recording fake the probes drive by hand.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSpawnSpec } from '../../../main/backend.js'

if (!process.env.TRIPLEX_BACKEND_URL) process.env.TRIPLEX_BACKEND_URL = 'http://127.0.0.1:1'
if (!process.env.BRIDGE_TOKEN) process.env.BRIDGE_TOKEN = 'wiring'

const report = {
  /** Ordered record of the calls whose SEQUENCE matters (setPath / setName). */
  order: [],
  paths: {},
  dialogSaveCalls: 0,
  switches: [],
  windows: [],
  views: [],
  sessions: [],
  ipcHandles: [],
  ipcOns: [],
  menu: null,
  exit: null,
  quit: false,
  singleInstanceRequested: false,
  sockets: [],
  probes: null,
  /** Every `nativeTheme.themeSource = …`, in order, with how much had been built when it happened. */
  themeSourceSets: [],
}
let nextId = 1
/** Monotonic counter: every BrowserWindow / WebContentsView bumps it in its constructor. */
let surfacesCreated = 0
let finished = false

function finish(code) {
  if (finished) return
  finished = true
  const out = {
    ...report,
    windows: report.windows.map((w) => ({ options: w.options, loads: w.webContents.loads, sent: w.webContents.sent, bounds: w.bounds, menuBarVisible: w.menuBarVisible, background: w.background })),
    views: report.views.map((v) => ({ options: v.options, loads: v.webContents.loads, bounds: v.getBounds(), visible: v.getVisible(), zoom: v.webContents.zoom, id: v.webContents.id, background: v.background, backgrounds: v.backgrounds })),
    menu: report.menu ? { labels: report.menu.template.map((m) => m.label), items: report.menu.template.flatMap((m) => (m.submenu || []).map((i) => i.label).filter(Boolean)), accelerators: report.menu.template.flatMap((m) => (m.submenu || []).map((i) => i.accelerator).filter(Boolean)) } : null,
    sockets: FakeWebSocket.instances.map((s) => ({ url: s.url, sent: s.sent, closed: s.closed })),
  }
  process.stdout.write(`FAKE_ELECTRON_REPORT ${JSON.stringify(out)}\n`)
  process.exit(code)
}

// --- the bridge socket -----------------------------------------------------------------------------
class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closed = null
    this.listeners = {}
    FakeWebSocket.instances.push(this)
  }
  addEventListener(name, fn) {
    ;(this.listeners[name] ||= []).push(fn)
  }
  fire(name, event) {
    for (const fn of this.listeners[name] || []) fn(event)
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('socket not open')
    this.sent.push(JSON.parse(text))
  }
  close(code, reason) {
    if (this.closed) return
    this.closed = { code, reason }
    this.readyState = 3
    this.fire('close', { code, reason })
  }
  open() {
    this.readyState = 1
    this.fire('open', {})
  }
  receive(frame) {
    this.fire('message', { data: JSON.stringify(frame) })
  }
  frames(type) {
    return this.sent.filter((f) => f.type === type)
  }
}
globalThis.WebSocket = FakeWebSocket

class FakeWebContents extends EventEmitter {
  constructor(kind) {
    super()
    this.id = nextId++
    this.kind = kind
    this.loads = []
    this.sent = []
    this.zoom = 1
    this.focused = 0
    this.reloads = 0
    this._destroyed = false
    this.mainFrame = { parent: null }
    app.emit('web-contents-created', {}, this)
  }
  loadURL(u) {
    this.loads.push(u)
    return Promise.resolve()
  }
  send(channel, ...args) {
    this.sent.push([channel, ...args])
  }
  isDestroyed() {
    return this._destroyed
  }
  isLoading() {
    return false
  }
  setWindowOpenHandler(fn) {
    this.windowOpenHandler = fn
  }
  setZoomFactor(f) {
    this.zoom = f
  }
  getZoomFactor() {
    return this.zoom
  }
  focus() {
    this.focused += 1
  }
  reload() {
    this.reloads += 1
  }
  getURL() {
    return this.loads[this.loads.length - 1] || ''
  }
  openDevTools() {}
  close() {
    this._destroyed = true
  }
}

class View {
  constructor() {
    this.bounds = { x: 0, y: 0, width: 0, height: 0 }
    this.visible = true
    this.children = []
    this.background = null
    this.backgrounds = [] // every ground this view was given, in order (creation first)
  }
  setBackgroundColor(color) {
    this.background = color
    this.backgrounds.push(color)
  }
  setBounds(b) {
    this.bounds = { ...b }
  }
  getBounds() {
    return this.bounds
  }
  setVisible(v) {
    this.visible = v
  }
  getVisible() {
    return this.visible
  }
  addChildView(v) {
    this.children.push(v)
  }
  removeChildView(v) {
    const i = this.children.indexOf(v)
    if (i !== -1) this.children.splice(i, 1)
  }
}

export class WebContentsView extends View {
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents('view')
    surfacesCreated += 1
    report.views.push(this)
  }
}

export class BrowserWindow extends EventEmitter {
  static windows = []
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents('window')
    this.contentView = new View()
    this._destroyed = false
    this._maximized = false
    this.menuBarVisible = true
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height }
    this.background = options.backgroundColor ?? null
    surfacesCreated += 1
    BrowserWindow.windows.push(this)
    report.windows.push(this)
  }
  setBackgroundColor(color) {
    this.background = color
  }
  static getAllWindows() {
    return BrowserWindow.windows
  }
  isDestroyed() {
    return this._destroyed
  }
  maximize() {
    this._maximized = true
  }
  unmaximize() {
    this._maximized = false
  }
  isMaximized() {
    return this._maximized
  }
  isMinimized() {
    return false
  }
  restore() {}
  focus() {}
  getBounds() {
    return this.bounds
  }
  getNormalBounds() {
    return this.bounds
  }
  setBounds(b) {
    this.bounds = { ...this.bounds, ...b }
    this.emit('resize')
    this.emit('move')
  }
  setMenuBarVisibility(v) {
    this.menuBarVisible = v
  }
  close() {
    this.emit('close')
    this._destroyed = true
    this.emit('closed')
  }
}

class FakeSession {
  constructor(partition) {
    this.partition = partition
    this.cleared = 0
    report.sessions.push(partition)
  }
  setPermissionRequestHandler(fn) {
    this.requestHandler = fn
  }
  setPermissionCheckHandler(fn) {
    this.checkHandler = fn
  }
  setDevicePermissionHandler(fn) {
    this.deviceHandler = fn
  }
  clearStorageData() {
    this.cleared += 1
    return Promise.resolve()
  }
}
const sessions = new Map()
export const session = {
  defaultSession: new FakeSession('default'),
  fromPartition(p) {
    if (!sessions.has(p)) sessions.set(p, new FakeSession(p))
    return sessions.get(p)
  },
}

export const shell = {
  opened: [],
  openExternal(u) {
    shell.opened.push(u)
    return Promise.resolve()
  },
}

export const ipcMain = {
  handlers: new Map(),
  listeners: new Map(),
  handle(channel, fn) {
    this.handlers.set(channel, fn)
    report.ipcHandles.push(channel)
  },
  removeHandler(channel) {
    this.handlers.delete(channel)
  },
  on(channel, fn) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, [])
    this.listeners.get(channel).push(fn)
    if (!report.ipcOns.includes(channel)) report.ipcOns.push(channel)
  },
  removeListener(channel, fn) {
    const list = this.listeners.get(channel) || []
    const i = list.indexOf(fn)
    if (i !== -1) list.splice(i, 1)
  },
  invoke(channel, event, ...args) {
    const fn = this.handlers.get(channel)
    if (!fn) return Promise.reject(new Error(`no handler for ${channel}`))
    return Promise.resolve().then(() => fn(event, ...args))
  },
  emit(channel, event, ...args) {
    for (const fn of [...(this.listeners.get(channel) || [])]) fn(event, ...args)
  },
}

/**
 * The save dialog main.js hands to export.js. A wiring run must never open a real one and must
 * never write a file, so every call is recorded and answered `canceled: true`; the export probes
 * only prove the channel, its validation and the backend URL it was wired with.
 */
export const dialog = {
  saveCalls: [],
  messageCalls: [],
  async showSaveDialog(...args) {
    dialog.saveCalls.push(args)
    report.dialogSaveCalls = dialog.saveCalls.length
    return { canceled: true }
  },
  async showMessageBox(...args) {
    dialog.messageCalls.push(args)
    return { response: 0 }
  },
}

export const screen = {
  getDisplayMatching() {
    return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  },
}

export const Menu = {
  buildFromTemplate(template) {
    return { template }
  },
  setApplicationMenu(menu) {
    report.menu = menu
  },
}

/**
 * The renderer's palette lives in CSS; the SITE pages follow `themeSource` (main never injects CSS).
 * The setter records WHEN each assignment happened (`views`/`windows` built so far, plus a shared
 * monotonic `surfaces` counter), because the whole point of applying the theme in `start()` before
 * `createWindow()` / `createViewManager()` is that the site pages get the right
 * `prefers-color-scheme` on their FIRST paint: a probe that only reads the last value cannot tell.
 */
export const nativeTheme = {
  _themeSource: 'system',
  get themeSource() {
    return this._themeSource
  },
  set themeSource(next) {
    this._themeSource = next
    report.themeSource = next
    report.themeSourceSets.push({ theme: next, views: report.views.length, windows: report.windows.length, surfaces: surfacesCreated })
  },
  get shouldUseDarkColors() {
    return this._themeSource === 'dark'
  },
}

const paths = { userData: path.join(os.tmpdir(), `triplex-fake-electron-${process.pid}`) }
export const app = new EventEmitter()
app.isPackaged = false
app.commandLine = {
  appendSwitch(name, value) {
    report.switches.push(value === undefined ? [name] : [name, value])
  },
}
app.setPath = (key, value) => {
  paths[key] = value
  report.paths[key] = value
  report.order.push(`setPath:${key}`)
}
app.getPath = (key) => paths[key]
// The product name. Recorded WITH the ordering, because taking the name before the profile is
// pinned is what would move userData and sign the user out of all three sites.
app.setName = (value) => {
  report.appName = value
  report.order.push('setName')
}
app.getName = () => report.appName || 'triplex-desktop'
app.disableHardwareAcceleration = () => {
  report.hwAccelDisabled = true
}
app.requestSingleInstanceLock = () => {
  report.singleInstanceRequested = true
  return true
}
app.whenReady = () => Promise.resolve()
app.exit = (code = 0) => {
  report.exit = code
  finish(code)
}
app.quit = () => {
  report.quit = true
  app.emit('before-quit')
  finish(0)
}

// ---------------------------------------------------------------------------------------------
// Probes: run once main.js's start() has had a chance to complete (ready resolves on the next
// microtask; the timer fires well after). Skipped when a refusal already exited.
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mainFrameEvent = (wc) => ({ sender: wc, senderFrame: { parent: null } })
const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const HELLO_ACK = { type: 'hello_ack', protocol: 1, backend_version: '0.1.0', ping_s: 20 }
const REQUEST = { type: 'request', req_id: '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c', model: 'web:claude', slot: 'claude', view: 'pane', fresh: false, text: 'hi `x`', role: 'claude', purpose: 'chat', conversation_id: CONV, timeout_s: 600 }

async function probe() {
  const probes = {}
  const win = BrowserWindow.windows[0]
  if (!win) {
    report.probes = probes
    return
  }
  const renderer = mainFrameEvent(win.webContents)
  const settle = (p) => p.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String((e && e.message) || e) }))
  const views = report.views

  probes.getInfo = await settle(ipcMain.invoke('panes:getInfo', renderer))
  probes.getInfoFromView = await settle(ipcMain.invoke('panes:getInfo', mainFrameEvent(views[0].webContents)))
  probes.adapterConfigView = await settle(ipcMain.invoke('adapter:config', mainFrameEvent(views[1].webContents)))
  probes.adapterConfigPopup = await settle(ipcMain.invoke('adapter:config', { sender: { id: 987654 }, senderFrame: { parent: null } }))
  probes.badSlot = await settle(ipcMain.invoke('panes:reload', renderer, 'bing'))
  probes.promptSendHandled = ipcMain.handlers.has('prompt:send')
  probes.newChatForeign = await settle(ipcMain.invoke('panes:newChat', mainFrameEvent(views[0].webContents), ['claude']))
  // the three initial loads commit (the fake loadURL fires no events itself): every view's
  // pendingNavigation settles, as it does in Electron once the site page is up
  for (const v of views.slice(0, 3)) v.webContents.emit('did-navigate', {}, v.webContents.getURL(), 200, 'OK')

  ipcMain.emit('panes:layout', renderer, { claude: { x: 0, y: 100.4, width: 500, height: 600 }, chatgpt: null, grok: { x: 500, y: 100, width: 500, height: 600 } })
  probes.layout = views.map((v) => ({ bounds: v.getBounds(), visible: v.getVisible() }))
  ipcMain.emit('panes:active', renderer, { mode: 'tabs', active: 'grok' })
  probes.getInfoAfterActive = await settle(ipcMain.invoke('panes:getInfo', renderer))

  probes.zoom = await settle(ipcMain.invoke('panes:zoom', renderer, 'grok', 'in'))
  probes.zoomApplied = views[2].webContents.zoom
  probes.zoomOthers = [views[0].webContents.zoom, views[1].webContents.zoom]

  const ev = { prevented: false, preventDefault() { this.prevented = true } }
  views[0].webContents.emit('before-input-event', ev, { type: 'keyDown', key: '2', code: 'Digit2', control: true, shift: false, alt: false, meta: false, isAutoRepeat: false })
  probes.shortcut = { prevented: ev.prevented, sent: win.webContents.sent.filter(([c]) => c === 'panes:shortcut') }
  const zoomEv = { prevented: false, preventDefault() { this.prevented = true } }
  win.webContents.emit('before-input-event', zoomEv, { type: 'keyDown', key: '=', code: 'Equal', control: true, shift: false, alt: false, meta: false, isAutoRepeat: false })
  probes.shortcutZoom = { prevented: zoomEv.prevented, activeZoom: views[2].webContents.zoom, sent: win.webContents.sent.filter(([c]) => c === 'panes:zoom') }

  // --- bridge: the socket main opened, the handshake, capture / health frames, one request → result
  const ws = FakeWebSocket.instances[0]
  probes.socket = ws ? { url: ws.url, sentBeforeOpen: ws.sent.length } : null
  const t = globalThis.__triplexTest
  probes.bridgeBeforeAck = t && t.bridge ? t.bridge.status().state : null
  if (ws) {
    ws.open()
    probes.hello = ws.sent[0] || null
    ws.receive(HELLO_ACK)
  }
  probes.bridgeAfterAck = t && t.bridge ? t.bridge.status() : null
  probes.bridgeSentToRenderer = win.webContents.sent.filter(([c]) => c === 'panes:bridge').map(([, s]) => s)

  probes.getCapture = await settle(ipcMain.invoke('panes:getCapture', renderer))
  probes.setCapture = await settle(ipcMain.invoke('panes:setCapture', renderer, 'claude', true))
  probes.setCaptureBad = await settle(ipcMain.invoke('panes:setCapture', renderer, 'claude', 'yes'))
  probes.captureFrames = ws ? ws.frames('capture') : null

  const health = { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: '#x', send: 'b', reply: null, stop: null, error: null }, url: 'u', host: 'h', title: 't', ts: 1 }
  ipcMain.emit('triplex:adapter:health', mainFrameEvent(views[0].webContents), health)
  probes.health = win.webContents.sent.filter(([c]) => c === 'panes:health')
  probes.healthFrames = ws ? ws.frames('health') : null

  // one request → accepted → ready → insertAndSubmit (view focused under the mutex) → result; chat URL recorded
  const v0 = views[0].webContents
  const focusedBefore = win.webContents.focused
  if (ws) ws.receive(REQUEST)
  await sleep(10)
  probes.accepted = ws ? ws.frames('accepted') : null
  const readyMsg = v0.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'ready')
  probes.readyMsg = readyMsg ? readyMsg[1] : null
  if (readyMsg) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v0), { reqId: readyMsg[1].reqId, ok: true, op: 'ready', composerSelector: '#c' })
  await sleep(10)
  const insertMsg = v0.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'insertAndSubmit')
  probes.insertMsg = insertMsg ? insertMsg[1] : null
  probes.viewFocusedDuringInsert = v0.focused
  if (insertMsg) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v0), { reqId: insertMsg[1].reqId, ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: '#c', sendSelector: 'b', assistantCount: 0, confirmedBy: 'composer_cleared', ms: 3, url: 'http://127.0.0.1:5199/?site=claude' })
  await sleep(10)
  const observeMsg = v0.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'observe')
  probes.observeMsg = observeMsg ? observeMsg[1] : null
  if (observeMsg) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v0), { reqId: observeMsg[1].reqId, ok: true, op: 'observe', text: 'Echo: hi `x`', doneBy: 'stop_gone', ms: 40, url: 'http://127.0.0.1:5199/?site=claude' })
  await sleep(10)
  probes.results = ws ? ws.frames('result') : null
  probes.turnEvents = win.webContents.sent.filter(([c]) => c === 'panes:turn').map(([, e]) => e)
  probes.rendererFocusedAfterSend = win.webContents.focused - focusedBefore
  // the fake site pushes /c/<id> after the submit: the orchestrator records it once it matches the override pattern
  v0.emit('did-navigate-in-page', {}, 'http://127.0.0.1:5199/c/1?site=claude', true, 1, 1)
  await sleep(10)
  try {
    probes.chatsFile = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chats.json'), 'utf8'))
  } catch (e) {
    probes.chatsFile = { error: String(e.message) }
  }

  // the cancel path: a request whose ready op is aborted by a bridge cancel
  const cancelReq = { ...REQUEST, req_id: '0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d', slot: 'grok', model: 'web:grok', role: 'grok' }
  const v2 = views[2].webContents
  if (ws) ws.receive(cancelReq)
  await sleep(10)
  if (ws) ws.receive({ type: 'cancel', req_id: cancelReq.req_id })
  await sleep(10)
  const cancelMsg = v2.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'cancel')
  probes.cancelMsg = cancelMsg ? cancelMsg[1] : null
  const grokReady = v2.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'ready')
  if (grokReady) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v2), { reqId: grokReady[1].reqId, ok: false, op: 'ready', code: 'cancelled', message: 'cancelled' })
  await sleep(10)
  probes.cancelResult = ws ? ws.frames('result').find((f) => f.req_id === cancelReq.req_id) || null : null

  // Stage 2 IPC: openChats (recorded link → navigated; no link → kept when already on newChatUrl;
  // null → every pane kept, nothing loaded), signOut, snapshot
  probes.openChats = await settle(ipcMain.invoke('panes:openChats', renderer, CONV))
  probes.openChatsLoads = { claude: v0.loads.slice(-1)[0], chatgpt: views[1].webContents.loads.length, grok: v2.loads.length }
  const loadsBeforeNull = views.slice(0, 3).map((v) => v.webContents.loads.length)
  probes.openChatsNull = await settle(ipcMain.invoke('panes:openChats', renderer, null))
  probes.openChatsNullLoads = views.slice(0, 3).map((v, i) => v.webContents.loads.length - loadsBeforeNull[i])

  // a navigation main started elsewhere (New chat on the chatgpt pane) holds a request's `ready`
  // until that document commits (did-navigate); the bridge still sees `accepted` at once
  const v1 = views[1].webContents
  await settle(ipcMain.invoke('panes:newChat', renderer, ['chatgpt']))
  const pendingReq = { ...REQUEST, req_id: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', slot: 'chatgpt', model: 'web:chatgpt', role: 'chatgpt' }
  if (ws) ws.receive(pendingReq)
  await sleep(30)
  const readyOps = () => v1.sent.filter(([c, m]) => c === 'triplex:adapter' && m && m.op === 'ready')
  const readyBeforeCommit = readyOps().length
  v1.emit('did-navigate', {}, v1.getURL(), 200, 'OK')
  await sleep(10)
  probes.pendingNavigation = { accepted: ws ? ws.frames('accepted').some((f) => f.req_id === pendingReq.req_id) : null, readyBeforeCommit, readyAfterCommit: readyOps().length }
  if (readyOps().length) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v1), { reqId: readyOps().at(-1)[1].reqId, ok: false, op: 'ready', code: 'timeout', message: 'no composer' })
  await sleep(10)

  probes.signOut = await settle(ipcMain.invoke('panes:signOut', renderer, 'grok'))
  probes.signOutCleared = { grok: sessions.get('persist:grok') ? sessions.get('persist:grok').cleared : null, claude: sessions.get('persist:claude') ? sessions.get('persist:claude').cleared : null }
  probes.signOutLoad = v2.loads.slice(-1)[0]
  const snapshotP = ipcMain.invoke('panes:snapshot', renderer, 'chatgpt')
  await sleep(10)
  const snapMsg = v1.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'snapshot')
  if (snapMsg) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v1), { reqId: snapMsg[1].reqId, ok: true, op: 'snapshot', html: '<html><body>…</body></html>' })
  probes.snapshot = await settle(snapshotP)
  try {
    probes.snapshotFile = probes.snapshot.ok ? fs.readFileSync(probes.snapshot.value.path, 'utf8') : null
  } catch (e) {
    probes.snapshotFile = { error: String(e.message) }
  }


  // --- Stage 3: the hidden analyst page --------------------------------------------------------
  // A `web:chatgpt:analyst` request creates the analyst view LAZILY on persist:chatgpt, hidden,
  // and runs the turn on it — never on the chatgpt pane — observing even though capture is off for
  // chatgpt. Then: a challenge health auto-reveals it, the `analyst` rect positions it,
  // panes:setAnalyst switches the partition (old view destroyed, `analyst` frame re-sent, the next
  // spawn's ANALYST_MODEL updated) and a request with no analyst chosen is rejected.
  const ANALYST_REQ = {
    ...REQUEST,
    req_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    model: 'web:chatgpt:analyst',
    slot: 'chatgpt',
    view: 'analyst',
    role: 'analyst',
    purpose: 'extraction',
    fresh: true,
    text: '<<<R1>>> claim',
  }
  const viewsBeforeAnalyst = views.length
  const turnEventsBeforeAnalyst = win.webContents.sent.filter(([c]) => c === 'panes:turn').length
  const paneOpsBeforeAnalyst = views[1].webContents.sent.filter(([c]) => c === 'triplex:adapter').length
  const chatgptHealthBefore = win.webContents.sent.filter(([c, s]) => c === 'panes:health' && s === 'chatgpt').length
  if (ws) ws.receive(ANALYST_REQ)
  await sleep(20)
  probes.analystViewsCreated = views.length - viewsBeforeAnalyst
  const av = views[views.length - 1]
  const awc = av.webContents
  probes.analystView = {
    partition: av.options.webPreferences.partition,
    sitePreload: String(av.options.webPreferences.preload).endsWith(path.join('preload', 'site.cjs')),
    sandbox: av.options.webPreferences.sandbox,
    contextIsolation: av.options.webPreferences.contextIsolation,
    backgroundThrottling: av.options.webPreferences.backgroundThrottling,
    zoom: awc.zoom,
    visible: av.getVisible(),
    loads: awc.loads.slice(),
  }
  probes.analystAccepted = ws ? ws.frames('accepted').find((f) => f.req_id === ANALYST_REQ.req_id) || null : null
  probes.analystAdapterConfig = await settle(ipcMain.invoke('adapter:config', mainFrameEvent(awc)))
  const analystOp = (op) => awc.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === op)
  const aReady = analystOp('ready')
  probes.analystReadyMsg = aReady ? aReady[1] : null
  if (aReady) ipcMain.emit('triplex:adapter:result', mainFrameEvent(awc), { reqId: aReady[1].reqId, ok: true, op: 'ready', composerSelector: '#c' })
  await sleep(10)
  const aInsert = analystOp('insertAndSubmit')
  probes.analystInsertMsg = aInsert ? aInsert[1] : null
  probes.analystFocusedDuringInsert = awc.focused
  if (aInsert) {
    ipcMain.emit('triplex:adapter:result', mainFrameEvent(awc), { reqId: aInsert[1].reqId, ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: '#c', sendSelector: 'b', assistantCount: 1, confirmedBy: 'composer_cleared', ms: 3, url: 'http://127.0.0.1:5199/?site=chatgpt' })
  }
  await sleep(10)
  const aObserve = analystOp('observe')
  probes.analystObserveMsg = aObserve ? aObserve[1] : null
  if (aObserve) {
    ipcMain.emit('triplex:adapter:result', mainFrameEvent(awc), { reqId: aObserve[1].reqId, ok: true, op: 'observe', text: '```json\n{"agreements": []}\n```', doneBy: 'quiet', ms: 12, url: 'http://127.0.0.1:5199/?site=chatgpt' })
  }
  await sleep(10)
  probes.analystResult = ws ? ws.frames('result').find((f) => f.req_id === ANALYST_REQ.req_id) || null : null
  probes.analystPaneUntouched = {
    paneAdapterOps: views[1].webContents.sent.filter(([c]) => c === 'triplex:adapter').length - paneOpsBeforeAnalyst,
    newTurnEvents: win.webContents.sent.filter(([c]) => c === 'panes:turn').length - turnEventsBeforeAnalyst,
  }

  // a challenge on the analyst view reveals it (decision 7) without touching the chatgpt pane chip
  ipcMain.emit('triplex:adapter:health', mainFrameEvent(awc), { ...health, session: 'challenge' })
  await sleep(5)
  probes.analystStates = win.webContents.sent.filter(([c]) => c === 'panes:analyst').map(([, s]) => s)
  probes.analystHealthLeaked = win.webContents.sent.filter(([c, s]) => c === 'panes:health' && s === 'chatgpt').length - chatgptHealthBefore

  // the `analyst` rect drives the revealed view's bounds
  ipcMain.emit('panes:layout', renderer, { claude: { x: 0, y: 100.4, width: 500, height: 600 }, chatgpt: null, grok: { x: 500, y: 100, width: 500, height: 600 }, analyst: { x: 10, y: 700, width: 400, height: 200 } })
  probes.analystLayout = { bounds: av.getBounds(), visible: av.getVisible() }
  await settle(ipcMain.invoke('panes:showAnalyst', renderer, false))
  probes.analystHiddenAgain = av.getVisible()

  // setAnalyst switches the partition: the old view is destroyed, a new hidden one is created, the
  // bridge gets a fresh `analyst` frame and the next spawn would carry the new ANALYST_MODEL
  await settle(ipcMain.invoke('panes:setAnalyst', renderer, 'claude'))
  await sleep(10)
  const newAv = views[views.length - 1]
  probes.setAnalyst = {
    frames: ws ? ws.frames('analyst') : null,
    oldDestroyed: awc.isDestroyed(),
    created: views.length - viewsBeforeAnalyst,
    newPartition: newAv.options.webPreferences.partition,
    newVisible: newAv.getVisible(),
    settingsAnalyst: t && t.settings ? t.settings.get().analyst : null,
    spawnAnalystModel: buildSpawnSpec({ repoDir: '/repo', userData: app.getPath('userData'), token: 'probe', settings: t.settings, env: {} }).env.ANALYST_MODEL,
  }
  probes.setAnalystBad = await settle(ipcMain.invoke('panes:setAnalyst', renderer, 'bing'))

  // no analyst chosen → the request is rejected analyst_not_chosen, nothing is typed anywhere
  await settle(ipcMain.invoke('panes:setAnalyst', renderer, null))
  await sleep(10)
  const NO_ANALYST_REQ = { ...ANALYST_REQ, req_id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60' }
  if (ws) ws.receive(NO_ANALYST_REQ)
  await sleep(10)
  probes.analystNotChosen = ws ? ws.frames('rejected').find((f) => f.req_id === NO_ANALYST_REQ.req_id) || null : null
  probes.analystNullState = { destroyed: newAv.webContents.isDestroyed(), spawnAnalystModel: buildSpawnSpec({ repoDir: '/repo', userData: app.getPath('userData'), token: 'probe', settings: t.settings, env: {} }).env.ANALYST_MODEL }
  // back to the default so settings.json ends the run as it started (nothing is recreated: lazy)
  await settle(ipcMain.invoke('panes:setAnalyst', renderer, 'chatgpt'))
  probes.analystViewsAfterRestore = views.length - viewsBeforeAnalyst

  // --- theme: settings.json is the source, nativeTheme follows, the renderer is told ----------
  probes.themeAtStart = report.themeSource
  probes.themeInGetInfo = (await settle(ipcMain.invoke('panes:getInfo', renderer))).value.theme
  const themeSentBefore = win.webContents.sent.filter(([c]) => c === 'panes:theme').length
  probes.setTheme = await settle(ipcMain.invoke('panes:setTheme', renderer, 'light'))
  probes.themeAfterSet = report.themeSource
  probes.themeSentToRenderer = win.webContents.sent.filter(([c]) => c === 'panes:theme').slice(themeSentBefore).map(([, m]) => m)
  probes.setThemeBad = await settle(ipcMain.invoke('panes:setTheme', renderer, 'chartreuse'))
  probes.setThemeForeign = await settle(ipcMain.invoke('panes:setTheme', mainFrameEvent(views[0].webContents), 'dark'))
  probes.themeAfterBad = report.themeSource
  probes.themeSettings = t && t.settings ? t.settings.get().theme : null

  // --- export: the channel, its validation and the backend URL it was wired with ---------------
  // Only the failing paths run here: the attached backend (127.0.0.1:1) answers nothing, so the
  // fetch fails before any dialog opens and before any print window is created — a wiring run
  // never writes a file and never adds a window (report.windows stays at one).
  probes.exportBadPayload = await settle(ipcMain.invoke('panes:export', renderer, { conversationId: '', turnId: 't', formats: ['md'] }))
  probes.exportBadFormat = await settle(ipcMain.invoke('panes:export', renderer, { conversationId: CONV, turnId: 't1', formats: ['docx'] }))
  probes.exportForeign = await settle(ipcMain.invoke('panes:export', mainFrameEvent(views[0].webContents), { conversationId: CONV, turnId: 't1', formats: ['md'] }))
  probes.exportUnreachable = await settle(ipcMain.invoke('panes:export', renderer, { conversationId: CONV, turnId: 't1', formats: ['md'], title: 'Wiring run', turnType: 'analyze' }))
  probes.exportDialogCalls = dialog.saveCalls.length

  // a socket drop → banner state to the renderer; the client schedules a reconnect (a new socket)
  if (ws) ws.close(1006, '')
  await sleep(10)
  probes.bridgeAfterDrop = t && t.bridge ? t.bridge.status().state : null
  probes.bridgeSentAfterDrop = win.webContents.sent.filter(([c]) => c === 'panes:bridge').map(([, s]) => s)

  // renderer window: pinned to the origin of TRIPLEX_RENDERER_URL; popups external; IPC from a
  // foreign document in the same webContents refused
  const nav = (wc, event, url, extra = []) => {
    const e = { prevented: false, url, preventDefault() { this.prevented = true } }
    wc.emit(event, e, url, ...extra)
    return e.prevented
  }
  let openedFrom = shell.opened.length
  probes.rendererNav = {
    foreign: nav(win.webContents, 'will-navigate', 'https://evil.example/'),
    same: nav(win.webContents, 'will-navigate', 'http://localhost:5184/#/x'),
    redirect: nav(win.webContents, 'will-redirect', 'https://evil.example/r', [false, true]),
    popup: win.webContents.windowOpenHandler({ url: 'https://evil.example/p' }),
    opened: shell.opened.slice(openedFrom),
  }
  probes.foreignFrame = await settle(ipcMain.invoke('panes:getInfo', { sender: win.webContents, senderFrame: { parent: null, url: 'https://evil.example/' } }))
  probes.ownFrame = await settle(ipcMain.invoke('panes:getInfo', { sender: win.webContents, senderFrame: { parent: null, url: 'http://localhost:5184/' } }))

  // site views: will-redirect follows the navigation matrix (main frame only); under E2E the SSO
  // list is empty; an allowed child window is policed like its opener (did-create-window)
  openedFrom = shell.opened.length
  const child = new FakeWebContents('child') // web-contents-created → the backstop, as Electron does first
  const childBackstop = { popup: child.windowOpenHandler ? child.windowOpenHandler({ url: 'http://127.0.0.1:5199/' }) : null, nav: nav(child, 'will-navigate', 'http://127.0.0.1:5199/') }
  views[0].webContents.emit('did-create-window', { webContents: child }, { url: 'http://127.0.0.1:5199/popup' })
  probes.viewPolicy = {
    ssoPopupUnderE2E: views[0].webContents.windowOpenHandler({ url: 'https://accounts.google.com/o/oauth2' }),
    ownPopup: views[0].webContents.windowOpenHandler({ url: 'http://127.0.0.1:5199/share' }).action,
    redirect: nav(views[0].webContents, 'will-redirect', 'https://evil.example/r', [false, true]),
    subframeRedirect: nav(views[0].webContents, 'will-redirect', 'https://evil.example/sub', [false, false]),
    ownNav: nav(views[2].webContents, 'will-navigate', 'http://localhost:5199/?site=grok'),
    childBackstop,
    child: {
      handler: typeof child.windowOpenHandler === 'function',
      evilPopup: child.windowOpenHandler({ url: 'https://evil.example/' }),
      evilNav: nav(child, 'will-navigate', 'https://evil.example/2'),
      ownNav: nav(child, 'will-navigate', 'http://127.0.0.1:5199/cb'),
    },
    opened: shell.opened.slice(openedFrom),
  }

  // backstop: a webContents nobody policed opens nothing and stays put
  const stray = new FakeWebContents('stray')
  probes.backstop = {
    popup: stray.windowOpenHandler ? stray.windowOpenHandler({ url: 'https://evil.example/' }) : null,
    nav: nav(stray, 'will-navigate', 'http://127.0.0.1:5199/'),
    redirect: nav(stray, 'will-redirect', 'http://127.0.0.1:5199/', [false, true]),
  }

  // Bluetooth chooser cancelled on every webContents, exactly one listener each
  const bluetooth = (wc) => {
    const e = { prevented: false, preventDefault() { this.prevented = true } }
    let chosen = null
    wc.emit('select-bluetooth-device', e, [{ deviceId: 'd1', deviceName: 'x' }], (id) => { chosen = id })
    return { prevented: e.prevented, chosen, listeners: wc.listenerCount('select-bluetooth-device') }
  }
  probes.bluetooth = { view: bluetooth(views[0].webContents), window: bluetooth(win.webContents), stray: bluetooth(stray) }

  // cached health + zoom + bridge state replayed on the renderer's did-finish-load and after panes:getInfo
  let sentFrom = win.webContents.sent.length
  win.webContents.emit('did-finish-load')
  probes.replay = win.webContents.sent.slice(sentFrom)
  sentFrom = win.webContents.sent.length
  await ipcMain.invoke('panes:getInfo', renderer)
  probes.replayOnGetInfo = win.webContents.sent.slice(sentFrom)

  // a crash recreates the view (after RECREATE_DELAY_MS) and publishes health view_crashed
  const beforeCrash = views.length
  views[1].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  probes.crashHealth = win.webContents.sent.filter(([c, s]) => c === 'panes:health' && s === 'chatgpt').map(([, , h]) => h.matched.error)
  await sleep(1100)
  probes.recreated = views.length - beforeCrash
  probes.recreatedPartition = views[views.length - 1].options.webPreferences.partition

  // window bounds → settings.json on close (debounce flushed)
  win.setBounds({ x: 10, y: 20, width: 900, height: 700 })
  win.close()
  try {
    probes.settingsFile = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'))
  } catch (e) {
    probes.settingsFile = { error: String(e.message) }
  }
  probes.testGlobal = globalThis.__triplexTest ? Object.keys(globalThis.__triplexTest) : null
  report.probes = probes
}

setTimeout(() => {
  probe()
    .catch((e) => {
      report.probes = { error: String((e && e.stack) || e) }
    })
    .finally(() => finish(0))
}, 50)
