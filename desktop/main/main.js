// desktop/main/main.js — Electron main process wiring (Stage 1 electron-main → Stage 2
// electron-bridge → Stage 3 analyst-view).
//
// Run from desktop/: `npx electron .` (package.json "main"). ESM on purpose ("type":"module").
// This is the ONLY module that imports 'electron'; every other file under main/ takes its
// collaborators as arguments so `node --test` runs them without a binary. Never sets the user
// agent (`setUserAgent` / `app.userAgentFallback`): the stock Electron UA is what passes Google SSO
// and Turnstile.
//
// Before ready:  TRIPLEX_USER_DATA_DIR → app.setPath('userData'); TRIPLEX_CHROMIUM_FLAGS /
//                TRIPLEX_DISABLE_GPU (allow-listed; anything else exits 2); TRIPLEX_SITES_JSON /
//                TRIPLEX_GROK_SURFACE; TRIPLEX_BACKEND_URL (a non-loopback host exits 2 unless
//                TRIPLEX_ALLOW_REMOTE_BACKEND=1); TRIPLEX_E2E_APP=1 refuses non-loopback site URLs
//                and trusted hosts (exit 3) and treats SSO_HOSTS as empty; single-instance lock;
//                `web-contents-created` backstop (any webContents nobody policed opens nothing
//                and stays put; the Bluetooth chooser is cancelled everywhere).
// After ready:   settings.json (window bounds clamped to the matching display, zoom, capture),
//                chats.json (links off the site's hosts dropped), the selectors override (+ fs.watch
//                hot reload → {op:'config'} to every view), the backend — attached
//                (`TRIPLEX_BACKEND_URL` + `BRIDGE_TOKEN`) or spawned (`.venv/bin/python -m
//                backend.main` on TRIPLEX_BACKEND_PORT with a per-launch random token, logs in
//                <userData>/logs/backend.log, restart ≤3/min, SIGTERM then SIGKILL on quit — the
//                quit is held until the child is gone; a port that already answers is refused and
//                reported in the bridge banner as `panes:bridge {connected:false, error}`)
//                — the renderer window (preload/renderer.cjs, sandbox, pinned to the renderer URL's
//                origin), the three site views (views.js), the orchestrator (one bridge request →
//                one turn), the bridge client (hello{token} → hello_ack → request/result, capture /
//                health frames, backoff, `panes:bridge`), shortcuts + the application menu
//                (menu.js), every IPC channel (ipc.js), the cached health + zoom + bridge state +
//                analyst state replayed to the renderer on every did-finish-load; global.__triplexTest
//                under TRIPLEX_E2E_APP=1.
// Stage 3:       the hidden analyst view (analyst-views.js) on persist:<settings.analyst> —
//                created lazily, never shown unless the renderer asks — its `panes:analyst` state
//                pushed to the renderer, the bridge `analyst` frame re-sent from the settings
//                subscription on every change, and `ANALYST_MODEL` picked up by the NEXT backend
//                spawn (buildSpawnSpec reads settings.getAnalyst() at spawn time).

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, WebContentsView, session, shell, ipcMain, screen, Menu, nativeTheme } from 'electron'
import { resolveSites, nonLoopbackSiteUrls, SSO_HOSTS } from './sites.js'
import { flagsFromEnv, applyFlags, ALLOWED_DESCRIPTION } from './chromium-flags.js'
import { applyPermissionPolicy, attachDeviceChooserPolicy } from './permissions.js'
import { isExternalUrl, originOf, frameOriginMatches, attachOriginPolicy, attachDefaultDenyPolicy } from './policy.js'
import { createSettings } from './settings.js'
import { createSelectorsLoader, timeoutsFor, captureTimeoutsFor, chatUrlPatternFor } from './selectors.js'
import { createViewManager, buildWindowOptions, loadWithRetry, LOAD_RETRY_MS } from './views.js'
import { createAnalystViews } from './analyst-views.js'
import { createOrchestrator } from './orchestrator.js'
import { registerIpc, saveDomSnapshot } from './ipc.js'
import { createShortcuts } from './shortcuts.js'
import { buildMenuTemplate } from './menu.js'
import { isMainFrameOf } from './adapter-client.js'
import { createChats } from './chats.js'
import { createBridgeClient, bridgeUrlFor } from './bridge-client.js'
import { buildSpawnSpec, attachSpec, createBackend, randomToken, DEFAULT_PORT, STOP_GRACE_MS } from './backend.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = require('../package.json')

const REPO_DIR = path.resolve(__dirname, '..', '..')
const RENDERER_PRELOAD = path.join(__dirname, '..', 'preload', 'renderer.cjs')
const SITE_PRELOAD = path.join(__dirname, '..', 'preload', 'site.cjs')
const SELECTORS_FILE = 'selectors.json'
const DEFAULT_ACTIVE = 'chatgpt' // the renderer slice's initial active pane

const env = process.env
const E2E = env.TRIPLEX_E2E_APP === '1'
const DEV = !app.isPackaged

// ---------------------------------------------------------------------------------------------
// Before ready
// ---------------------------------------------------------------------------------------------

function fail(code, message) {
  console.error(`[triplex] ${message}`)
  app.exit(code)
  return false
}

if (env.TRIPLEX_USER_DATA_DIR) app.setPath('userData', path.resolve(env.TRIPLEX_USER_DATA_DIR))

/** {port, url} of the backend this launch talks to (attached or spawned); set in start(). */
let backendInfo = null

function backendPort() {
  const n = Number(env.TRIPLEX_BACKEND_PORT || DEFAULT_PORT)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT
}

function rendererUrl() {
  if (env.TRIPLEX_RENDERER_URL) return env.TRIPLEX_RENDERER_URL
  const base = backendInfo ? backendInfo.url : `http://127.0.0.1:${backendPort()}`
  return `${base}/app/`
}

/** The only origin the renderer window may show and accept IPC from (null when the URL does not parse). */
function rendererOrigin() {
  return originOf(rendererUrl())
}

/** @type {Record<string, {url:string,newChatUrl:string,partition:string,hosts:string[]}>|null} */
let sites = null
/** The attach spec from TRIPLEX_BACKEND_URL (decided in preflight; null = spawn). */
let attached = null

/** Everything that must be decided before `ready`. Returns false after scheduling app.exit(). */
function preflight() {
  const flags = flagsFromEnv(env)
  if (!flags.ok) return fail(2, `TRIPLEX_CHROMIUM_FLAGS: "${flags.rejected}" is not allow-listed (allowed: ${ALLOWED_DESCRIPTION})`)
  applyFlags(app.commandLine, flags.flags)
  try {
    sites = resolveSites(env)
  } catch (e) {
    return fail(2, e.message)
  }
  try {
    attached = attachSpec(env, { log: console }) // a non-loopback TRIPLEX_BACKEND_URL is a config error
  } catch (e) {
    return fail(2, e.message)
  }
  if (E2E) {
    // URLs first, then the hosts policy.js would trust for in-view navigation and child windows.
    const bad = nonLoopbackSiteUrls(sites)
    if (bad.length) {
      const what = bad[0].key === 'hosts' ? 'trusted host' : 'site URL'
      return fail(3, `TRIPLEX_E2E_APP=1 refuses the non-loopback ${what} ${bad[0].slot}.${bad[0].key}=${bad[0].url}`)
    }
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** @type {BrowserWindow|null} */
let win = null
let settings = null
let chats = null
let selectors = null
let stopSelectorsWatch = null
let views = null
let analystViews = null
let orchestrator = null
let shortcuts = null
let ipc = null
let bridge = null
let backend = null
let bridgeState = { connected: false }
/** {mode, active} as last reported by the renderer over 'panes:active' (shared with shortcuts). */
const layoutState = { mode: null, active: null }

function windowAlive() {
  return !!(win && !win.isDestroyed() && !win.webContents.isDestroyed())
}

function isRenderer(event) {
  if (!windowAlive() || !isMainFrameOf(event, win.webContents)) return false
  try {
    // Belt and braces under the will-navigate guard: a foreign document that somehow ended up in
    // the renderer webContents (the preload re-runs for every document) never gets window.triplex.
    return frameOriginMatches(event, rendererOrigin())
  } catch (_e) {
    return false
  }
}

function sendToRenderer(channel, ...args) {
  if (windowAlive()) win.webContents.send(channel, ...args)
}

function focusRenderer() {
  if (!windowAlive()) return
  try {
    win.webContents.focus()
  } catch (_e) {
    /* the window is going away */
  }
}

function openExternal(url) {
  if (!isExternalUrl(url)) return Promise.resolve()
  return shell.openExternal(String(url)).catch((e) => console.warn(`[triplex] openExternal failed: ${(e && e.message) || e}`))
}

function activeSlot() {
  return layoutState.active || DEFAULT_ACTIVE
}

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

function createWindow() {
  const bounds = settings.windowBoundsForLaunch()
  win = new BrowserWindow(buildWindowOptions({ preload: RENDERER_PRELOAD, bounds, title: 'Triplex' }))
  if (bounds.maximized) win.maximize()

  // The renderer never opens windows itself and never leaves its own origin: window.open, a
  // navigation or a server-side redirect elsewhere goes to the system browser (window.triplex,
  // which drives three logged-in sessions, must never follow the window to a foreign page).
  attachOriginPolicy(win.webContents, rendererOrigin(), { openExternal, log: console })
  attachDeviceChooserPolicy(win.webContents)
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details && details.reason === 'clean-exit') return
    console.error(`[renderer] render process gone (${details && details.reason}); reloading`)
    setTimeout(() => {
      if (windowAlive()) win.webContents.reload()
    }, LOAD_RETRY_MS)
  })

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return
    settings.queueWindowBounds(win.getNormalBounds(), win.isMaximized())
  }
  for (const evt of ['resize', 'move', 'maximize', 'unmaximize']) win.on(evt, persistBounds)
  win.on('close', () => {
    persistBounds()
    settings.flushWindowBounds()
  })
  win.on('closed', () => {
    win = null
  })
  loadWithRetry(win.webContents, rendererUrl(), { tag: 'renderer' })
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/**
 * Re-send what the renderer may have missed: the cached health of every view, the persisted
 * zoom factors and the bridge state. `webContents.send` to a page that is still loading (launch,
 * the reload after a renderer crash) is lost, and `panes:getInfo` carries neither. Wired to the
 * renderer's did-finish-load here; ipc.js also replays right after `panes:getInfo`, when the
 * renderer's listeners are known to exist. Stage 3 adds the analyst state, which drives the
 * fourth tab.
 */
function replayToRenderer() {
  if (!views || !windowAlive()) return
  for (const slot of views.slots()) {
    const h = views.getHealth(slot)
    if (h) sendToRenderer('panes:health', slot, h)
    sendToRenderer('panes:zoom', { slot, factor: views.zoomFactor(slot) })
  }
  sendToRenderer('panes:bridge', bridgeState)
  if (analystViews) sendToRenderer('panes:analyst', analystViews.state())
}

/** Decide where the backend is: attach to TRIPLEX_BACKEND_URL (decided in preflight), else prepare a spawn on TRIPLEX_BACKEND_PORT. */
function resolveBackend(userData) {
  if (attached) {
    backendInfo = { port: attached.port, url: attached.url }
    console.log(`[backend] attaching to ${attached.url} (TRIPLEX_BACKEND_URL)`)
    return { token: attached.token, backend: null }
  }
  const token = randomToken()
  const spec = buildSpawnSpec({ repoDir: REPO_DIR, userData, port: backendPort(), token, settings, env })
  backendInfo = { port: spec.port, url: spec.url }
  return { token, backend: createBackend({ spec, logDir: path.join(userData, 'logs'), log: console }) }
}

/**
 * The three site pages are never styled by Triplex (no CSS injection into pages we do not own):
 * they are told what the system prefers, and chatgpt.com / claude.ai / grok.com apply their OWN
 * dark themes through `prefers-color-scheme`. A site pinned to light in its own settings stays
 * light, which is correct — that is the user's choice on that site.
 */
function applyTheme(theme) {
  const next = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark'
  try {
    nativeTheme.themeSource = next
  } catch (err) {
    console.error(`[theme] could not set themeSource: ${(err && err.message) || err}`)
  }
  return next
}

function start() {
  applyTheme(process.env.TRIPLEX_THEME)
  const userData = app.getPath('userData')
  try {
    fs.mkdirSync(userData, { recursive: true })
  } catch (e) {
    console.warn(`[triplex] cannot create ${userData}: ${(e && e.message) || e}`)
  }
  applyPermissionPolicy(session.defaultSession) // the renderer's own session

  settings = createSettings({ dir: userData, screen })
  settings.load()

  chats = createChats({ dir: userData, sites })
  chats.load()

  selectors = createSelectorsLoader({ filePath: env.TRIPLEX_SELECTORS_FILE || path.join(userData, SELECTORS_FILE) })
  selectors.load()

  const resolved = resolveBackend(userData)
  backend = resolved.backend

  createWindow()

  views = createViewManager({
    WebContentsView,
    sessionFromPartition: (partition) => session.fromPartition(partition),
    contentView: win.contentView,
    sites,
    preload: SITE_PRELOAD,
    settings,
    ipcMain,
    openExternal,
    onHealth: (slot, health) => {
      sendToRenderer('panes:health', slot, health)
      if (bridge) bridge.sendHealth(slot, health)
    },
    dev: DEV,
    ssoHosts: E2E ? [] : SSO_HOSTS, // an E2E run must never open a real SSO host, even as a popup
  })
  win.webContents.on('did-finish-load', replayToRenderer)

  // The hidden analyst page: nothing is created until an analyst request, `showAnalyst(true)` or an
  // `analyst` rect asks for it (contract §5 `settings.analyst`, default 'chatgpt').
  analystViews = createAnalystViews({
    WebContentsView,
    sessionFromPartition: (partition) => session.fromPartition(partition),
    contentView: win.contentView,
    sites,
    preload: SITE_PRELOAD,
    settings,
    ipcMain,
    openExternal,
    onState: (state) => sendToRenderer('panes:analyst', state),
    dev: DEV,
    ssoHosts: E2E ? [] : SSO_HOSTS,
  })

  orchestrator = createOrchestrator({
    adapterFor: (slot) => views.adapterFor(slot),
    analystAdapterFor: (slot) => analystViews.adapterFor(slot),
    analystView: {
      currentUrl: () => analystViews.currentUrl(),
      loadUrl: (url) => analystViews.loadUrl(url),
      newChatUrl: () => analystViews.newChatUrl(),
      pendingNavigation: () => analystViews.pendingNavigation(),
      focus: () => analystViews.focus(),
      getHealth: () => analystViews.getHealth(),
      setHealth: (h) => analystViews.setHealth(h),
      // a `fresh:false` analyst continuation belongs to its conversation, not to whoever used the
      // one hidden view last (the backend's busy guard is per conversation)
      chatFor: (convId) => analystViews.chatFor(convId),
      chatOwner: (url) => analystViews.chatOwner(url),
      noteChat: (convId, url) => analystViews.noteChat(convId, url),
    },
    focusView: (slot) => views.focus(slot),
    restoreRendererFocus: focusRenderer,
    timeoutsFor: (slot) => timeoutsFor(selectors.current(), slot),
    captureTimeoutsFor: (slot) => captureTimeoutsFor(selectors.current(), slot),
    chatUrlPatternFor: (slot) => chatUrlPatternFor(selectors.current(), slot),
    getHealth: (slot) => views.getHealth(slot),
    setHealth: (slot, h) => views.setHealth(slot, h),
    getCapture: () => settings.getCapture(),
    chats,
    currentUrl: (slot) => views.currentUrl(slot),
    loadUrl: (slot, url) => views.loadUrl(slot, url),
    pendingNavigation: (slot) => views.pendingNavigation(slot),
    onNavigate: (slot, cb) => views.onNavigate(slot, cb),
    newChatUrl: (slot) => sites[slot].newChatUrl,
    onTurn: (slot, phase, code) => sendToRenderer('panes:turn', code === undefined ? { slot, phase } : { slot, phase, code }),
  })

  const reloadSelectors = () => {
    selectors.reload()
    views.pushConfig(selectors.current())
    analystViews.pushConfig(selectors.current())
  }

  shortcuts = createShortcuts({
    getActive: activeSlot,
    zoom: (slot, direction) => views.zoom(slot, direction),
    reload: (slot) => {
      selectors.reload()
      views.reload(slot)
    },
    inspect: (slot) => views.inspect(slot),
    focusRenderer,
    sendToRenderer,
    dev: DEV,
  })
  shortcuts.attach(win.webContents)
  views.onCreated((_slot, wc) => shortcuts.attach(wc)) // before createAll: initial and recreated views alike
  analystViews.onCreated((_slot, wc) => shortcuts.attach(wc)) // it holds the keyboard focus during an insert
  views.createAll()

  const snapshotsDir = path.join(userData, 'snapshots')
  try {
    // The hidden menu is the accelerator fallback; before-input-event is the primary path, so a
    // menu problem must never take the app down.
    const template = buildMenuTemplate({
      shortcuts,
      dev: DEV,
      getActive: activeSlot,
      actions: {
        reloadSelectors,
        saveSnapshot: (slot) => saveDomSnapshot({ views, snapshotsDir }, slot),
        showAnalyst: () => analystViews.setVisible(true),
        signOut: (slot) => views.signOut(slot),
      },
      log: console,
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  } catch (e) {
    console.warn(`[triplex] application menu not installed: ${(e && e.message) || e}`)
  }

  // Bridge client: hello carries the capture switches and the analyst choice (§1); every later
  // change re-sends the matching `capture` / `analyst` frame from the settings subscription below.
  bridge = createBridgeClient({
    url: bridgeUrlFor(backendInfo.url, { allowRemote: env.TRIPLEX_ALLOW_REMOTE_BACKEND === '1' }),
    token: resolved.token,
    version: PKG.version,
    getCapture: () => settings.getCapture(),
    getAnalyst: () => settings.getAnalyst(),
    getHealth: (slot) => views.getHealth(slot),
    setHealth: (slot, h) => views.setHealth(slot, h),
    onRequest: (frame, emit) => orchestrator.run(frame, emit),
    onCancel: (reqId) => orchestrator.cancel(reqId),
    onState: (state) => {
      bridgeState = state
      sendToRenderer('panes:bridge', state)
    },
    log: console,
  })
  settings.subscribe(({ key }) => {
    if (key === 'capture') bridge.sendCapture(settings.getCapture())
    // A new analyst takes effect for the backend in two steps: the frame tells the running backend
    // which page answers now, and the next spawn's ANALYST_MODEL (buildSpawnSpec) makes it durable.
    if (key === 'analyst') bridge.sendAnalyst(settings.getAnalyst())
  })

  ipc = registerIpc({
    ipcMain,
    isRenderer,
    views,
    analystViews,
    layoutState,
    orchestrator,
    selectors,
    settings,
    chats,
    sites,
    version: PKG.version,
    dev: DEV,
    getBackend: () => backendInfo,
    getBridgeState: () => bridgeState,
    snapshotsDir,
    onHealth: (slot, health) => bridge.sendHealth(slot, health),
    openExternal,
    sendToRenderer,
  })

  stopSelectorsWatch = selectors.watch({
    onChange: ({ changed, error }) => {
      if (!changed) return
      const n = views.pushConfig(selectors.current()) + analystViews.pushConfig(selectors.current())
      console.log(`[selectors] override ${error ? 'invalid (last good kept)' : 'reloaded'}; config pushed to ${n} view(s)`)
    },
  })

  if (backend) {
    backend
      .start()
      .then(() => bridge.connect())
      .catch((e) => {
        const message = String((e && e.message) || e)
        // The banner shows why there is no bridge; a later hello_ack (onState) replaces it.
        bridgeState = { connected: false, error: message }
        sendToRenderer('panes:bridge', bridgeState)
        if (e && e.code === 'port_in_use') {
          console.error(`[backend] ${message}; not connecting to a backend that is not ours`)
          return
        }
        console.error(`[backend] ${message}; the bridge keeps retrying`)
        bridge.connect()
      })
  } else {
    bridge.connect()
  }

  if (E2E) {
    globalThis.__triplexTest = { views, analystViews, orchestrator, settings, selectors, layoutState, ipc, bridge, chats, backend: backend || { info: () => backendInfo, attached: true } }
  }
}

if (preflight()) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
    app.whenReady().then(start)
  }
}

// Backstop for every webContents in the process (site views, the renderer, allowed SSO popups,
// devtools, anything else): fires synchronously on construction, before views.js / createWindow()
// attach their own policy, and stays inert for the contents they police; whatever nobody polices
// opens no windows and does not navigate. Bluetooth device requests are cancelled everywhere.
app.on('web-contents-created', (_event, contents) => {
  try {
    attachDefaultDenyPolicy(contents, { log: console })
    attachDeviceChooserPolicy(contents)
  } catch (e) {
    console.warn(`[triplex] web-contents-created backstop failed: ${(e && e.message) || e}`)
  }
})

let quitting = false
app.on('before-quit', (event) => {
  if (settings) settings.flushWindowBounds()
  if (stopSelectorsWatch) {
    stopSelectorsWatch()
    stopSelectorsWatch = null
  }
  if (bridge) bridge.close()
  if (backend && !quitting) {
    // stop() sends SIGTERM now and SIGKILL after STOP_GRACE_MS; hold the quit until the child is
    // gone (bounded), otherwise the SIGKILL timer dies with this process and a backend that
    // ignores SIGTERM outlives the app and squats on the port for the next launch.
    quitting = true
    event.preventDefault()
    const stopped = backend.stop().catch(() => {})
    const bound = new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 1000))
    Promise.race([stopped, bound]).then(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
