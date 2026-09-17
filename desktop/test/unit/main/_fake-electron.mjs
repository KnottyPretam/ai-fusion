// A fake `electron` module for main-wiring.test.js: enough of app / BrowserWindow /
// WebContentsView / session / shell / ipcMain / screen / Menu for main/main.js to run its
// preflight and `start()` under plain Node. After `ready` it probes the wiring (IPC handlers,
// layout, zoom, a shortcut, health forwarding, a full prompt:send round trip, the renderer's
// origin guard + foreign-frame IPC refusal, child-window / redirect / backstop policy, the
// Bluetooth chooser, the health + zoom replay, window-bounds persistence) and prints ONE line
// `FAKE_ELECTRON_REPORT <json>` before exiting; `app.exit(code)` prints the report and exits with
// that code at once (the refusal paths). Every FakeWebContents emits `web-contents-created` on
// `app` as Electron does, synchronously in its constructor.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const report = {
  paths: {},
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
  probes: null,
}
let nextId = 1
let finished = false

function finish(code) {
  if (finished) return
  finished = true
  const out = {
    ...report,
    windows: report.windows.map((w) => ({ options: w.options, loads: w.webContents.loads, sent: w.webContents.sent, bounds: w.bounds, menuBarVisible: w.menuBarVisible })),
    views: report.views.map((v) => ({ options: v.options, loads: v.webContents.loads, bounds: v.getBounds(), visible: v.getVisible(), zoom: v.webContents.zoom, id: v.webContents.id })),
    menu: report.menu ? { labels: report.menu.template.map((m) => m.label), accelerators: report.menu.template.flatMap((m) => (m.submenu || []).map((i) => i.accelerator).filter(Boolean)) } : null,
  }
  process.stdout.write(`FAKE_ELECTRON_REPORT ${JSON.stringify(out)}\n`)
  process.exit(code)
}

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
    BrowserWindow.windows.push(this)
    report.windows.push(this)
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
}
app.getPath = (key) => paths[key]
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
  probes.oversize = await settle(ipcMain.invoke('prompt:send', renderer, { targets: ['claude'], text: 'x'.repeat(32769) }))

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

  const health = { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: '#x', send: 'b', reply: null, stop: null, error: null }, url: 'u', host: 'h', title: 't', ts: 1 }
  ipcMain.emit('triplex:adapter:health', mainFrameEvent(views[0].webContents), health)
  probes.health = win.webContents.sent.filter(([c]) => c === 'panes:health')

  // full prompt:send round trip through the orchestrator and the adapter client
  const v0 = views[0].webContents
  const focusedBefore = win.webContents.focused
  const sendP = ipcMain.invoke('prompt:send', renderer, { targets: ['claude'], text: 'hi `x`' })
  await sleep(10)
  const readyMsg = v0.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'ready')
  probes.readyMsg = readyMsg ? readyMsg[1] : null
  if (readyMsg) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v0), { reqId: readyMsg[1].reqId, ok: true, op: 'ready', composerSelector: '#c' })
  await sleep(10)
  const insertMsg = v0.sent.find(([c, m]) => c === 'triplex:adapter' && m && m.op === 'insertAndSubmit')
  probes.insertMsg = insertMsg ? insertMsg[1] : null
  probes.viewFocusedDuringInsert = v0.focused
  if (insertMsg) ipcMain.emit('triplex:adapter:result', mainFrameEvent(v0), { reqId: insertMsg[1].reqId, ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: '#c', sendSelector: 'b', assistantCount: 0, confirmedBy: 'composer_cleared', ms: 3, url: 'http://127.0.0.1:5199/c/1' })
  probes.promptSend = await settle(sendP)
  probes.rendererFocusedAfterSend = win.webContents.focused - focusedBefore

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

  // cached health + zoom replayed on the renderer's did-finish-load and after panes:getInfo
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
