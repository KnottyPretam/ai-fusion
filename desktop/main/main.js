// desktop/main/main.js — Electron main process wiring (Stage 1 electron-main).
//
// Run from desktop/: `npx electron .` (package.json "main"). ESM on purpose ("type":"module").
// This is the ONLY module that imports 'electron'; every other file under main/ takes its
// collaborators as arguments so `node --test` runs them without a binary. Never sets the user
// agent (`setUserAgent` / `app.userAgentFallback`): the stock Electron UA is what passes Google SSO
// and Turnstile.
//
// Before ready:  TRIPLEX_USER_DATA_DIR → app.setPath('userData'); TRIPLEX_CHROMIUM_FLAGS /
//                TRIPLEX_DISABLE_GPU (allow-listed; anything else exits 2); TRIPLEX_SITES_JSON /
//                TRIPLEX_GROK_SURFACE; TRIPLEX_E2E_APP=1 refuses non-loopback site URLs (exit 3);
//                single-instance lock.
// After ready:   settings.json (window bounds clamped to the matching display, zoom), selectors
//                override, the renderer window (preload/renderer.cjs, sandbox), the three site views
//                (views.js), the orchestrator, shortcuts (before-input-event everywhere + hidden
//                menu), every IPC channel (ipc.js); global.__triplexTest under TRIPLEX_E2E_APP=1.

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, WebContentsView, session, shell, ipcMain, screen, Menu } from 'electron'
import { resolveSites, nonLoopbackSiteUrls } from './sites.js'
import { flagsFromEnv, applyFlags, ALLOWED_DESCRIPTION } from './chromium-flags.js'
import { applyPermissionPolicy } from './permissions.js'
import { isExternalUrl } from './policy.js'
import { createSettings } from './settings.js'
import { createSelectorsLoader, timeoutsFor } from './selectors.js'
import { createViewManager, buildWindowOptions, loadWithRetry, LOAD_RETRY_MS } from './views.js'
import { createOrchestrator } from './orchestrator.js'
import { registerIpc } from './ipc.js'
import { createShortcuts } from './shortcuts.js'
import { isMainFrameOf } from './adapter-client.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = require('../package.json')

const RENDERER_PRELOAD = path.join(__dirname, '..', 'preload', 'renderer.cjs')
const SITE_PRELOAD = path.join(__dirname, '..', 'preload', 'site.cjs')
const DEFAULT_BACKEND_PORT = '8021'
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

function rendererUrl() {
  if (env.TRIPLEX_RENDERER_URL) return env.TRIPLEX_RENDERER_URL
  return `http://127.0.0.1:${env.TRIPLEX_BACKEND_PORT || DEFAULT_BACKEND_PORT}/app/`
}

/** @type {Record<string, {url:string,newChatUrl:string,partition:string,hosts:string[]}>|null} */
let sites = null

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
  if (E2E) {
    const bad = nonLoopbackSiteUrls(sites)
    if (bad.length) return fail(3, `TRIPLEX_E2E_APP=1 refuses the non-loopback site URL ${bad[0].slot}.${bad[0].key}=${bad[0].url}`)
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** @type {BrowserWindow|null} */
let win = null
let settings = null
let selectors = null
let views = null
let orchestrator = null
let shortcuts = null
let ipc = null
/** {mode, active} as last reported by the renderer over 'panes:active' (shared with shortcuts). */
const layoutState = { mode: null, active: null }

function windowAlive() {
  return !!(win && !win.isDestroyed() && !win.webContents.isDestroyed())
}

function isRenderer(event) {
  return windowAlive() && isMainFrameOf(event, win.webContents)
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

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

function createWindow() {
  const bounds = settings.windowBoundsForLaunch()
  win = new BrowserWindow(buildWindowOptions({ preload: RENDERER_PRELOAD, bounds, title: 'Triplex' }))
  if (bounds.maximized) win.maximize()

  // The renderer never opens windows itself; links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
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

function start() {
  const userData = app.getPath('userData')
  applyPermissionPolicy(session.defaultSession) // the renderer's own session

  settings = createSettings({ dir: userData, screen })
  settings.load()

  selectors = createSelectorsLoader({ filePath: env.TRIPLEX_SELECTORS_FILE || path.join(userData, SELECTORS_FILE) })
  selectors.load()

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
    onHealth: (slot, health) => sendToRenderer('panes:health', slot, health),
    dev: DEV,
  })

  orchestrator = createOrchestrator({
    adapterFor: (slot) => views.adapterFor(slot),
    focusView: (slot) => views.focus(slot),
    restoreRendererFocus: focusRenderer,
    timeoutsFor: (slot) => timeoutsFor(selectors.current(), slot),
  })

  shortcuts = createShortcuts({
    getActive: () => layoutState.active || DEFAULT_ACTIVE,
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
  views.createAll()
  try {
    // The hidden menu is the accelerator fallback; before-input-event is the primary path, so a
    // menu problem must never take the app down.
    Menu.setApplicationMenu(Menu.buildFromTemplate(shortcuts.menuTemplate()))
  } catch (e) {
    console.warn(`[triplex] application menu not installed: ${(e && e.message) || e}`)
  }

  ipc = registerIpc({
    ipcMain,
    isRenderer,
    views,
    layoutState,
    orchestrator,
    selectors,
    sites,
    version: PKG.version,
    dev: DEV,
    openExternal,
    sendToRenderer,
  })

  if (E2E) {
    globalThis.__triplexTest = { views, orchestrator, settings, selectors, layoutState, ipc }
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

app.on('before-quit', () => {
  if (settings) settings.flushWindowBounds()
})

app.on('window-all-closed', () => {
  app.quit()
})
