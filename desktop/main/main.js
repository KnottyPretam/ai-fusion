// desktop/main/main.js — Electron main process (Stage 0 stub; Stage 1 splits this into
// views/layout/policy/permissions/chromium-flags/ipc/... per the plan's ownership table).
//
// Run from desktop/: `npx electron .` (package.json "main"). ESM on purpose ("type":"module").
// Never sets the user agent (`setUserAgent` / `app.userAgentFallback`): the stock Electron UA is
// what passes Google SSO and Turnstile.

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, WebContentsView, session, shell, ipcMain } from 'electron'
import { SLOTS, SSO_HOSTS, hostInList, resolveSites } from './sites.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = require('../package.json')
// site.cjs boots only inside a page, so requiring it here just yields its pure exports.
const { DEFAULT_SELECTORS } = require('../preload/site.cjs')

const RENDERER_PRELOAD = path.join(__dirname, '..', 'preload', 'renderer.cjs')
const SITE_PRELOAD = path.join(__dirname, '..', 'preload', 'site.cjs')
const DEFAULT_RENDERER_URL = 'http://127.0.0.1:8021/app/'
const LOAD_RETRY_MS = 1000
const LOAD_RETRY_MAX = 30
const SHELL_STRIP_PX = 120 // Stage-0 placeholder shell height (see layoutViews)
const MAX_PROMPT_CHARS = 32768
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])
const CHROMIUM_FLAG_ALLOW = /^--(ignore-gpu-blocklist|disable-gpu|disable-gpu-compositing)$|^--(use-gl|enable-features|disable-features)=.+$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const E2E = process.env.TRIPLEX_E2E_APP === '1'
const DEV = !app.isPackaged

const env = process.env

// ---------------------------------------------------------------------------------------------
// Before ready: paths, flags, single instance, site table
// ---------------------------------------------------------------------------------------------

function fail(code, message) {
  console.error(`[triplex] ${message}`)
  app.exit(code)
  return false
}

if (env.TRIPLEX_USER_DATA_DIR) app.setPath('userData', path.resolve(env.TRIPLEX_USER_DATA_DIR))

/** Allow-listed Chromium switches from TRIPLEX_CHROMIUM_FLAGS (whitespace separated). */
function parseChromiumFlags(raw) {
  const flags = String(raw || '')
    .split(/\s+/)
    .filter(Boolean)
  const out = []
  for (const flag of flags) {
    if (!CHROMIUM_FLAG_ALLOW.test(flag)) return { ok: false, rejected: flag, flags: out }
    const eq = flag.indexOf('=')
    const name = (eq === -1 ? flag : flag.slice(0, eq)).replace(/^--/, '')
    const value = eq === -1 ? undefined : flag.slice(eq + 1)
    out.push({ name, value })
  }
  return { ok: true, flags: out }
}

/** @type {Record<string, {url:string,newChatUrl:string,partition:string,hosts:string[]}>|null} */
let sites = null

/** Everything that must be decided before `ready`. Returns false after scheduling app.exit(). */
function preflight() {
  const parsed = parseChromiumFlags(env.TRIPLEX_CHROMIUM_FLAGS)
  if (!parsed.ok) {
    return fail(2, `TRIPLEX_CHROMIUM_FLAGS: "${parsed.rejected}" is not allow-listed (allowed: --ignore-gpu-blocklist --disable-gpu --disable-gpu-compositing --use-gl=* --enable-features=* --disable-features=*)`)
  }
  for (const { name, value } of parsed.flags) {
    if (value === undefined) app.commandLine.appendSwitch(name)
    else app.commandLine.appendSwitch(name, value)
  }
  if (env.TRIPLEX_DISABLE_GPU === '1') app.disableHardwareAcceleration()

  try {
    sites = resolveSites(env)
  } catch (e) {
    return fail(2, e.message)
  }

  if (E2E) {
    for (const slot of SLOTS) {
      for (const key of ['url', 'newChatUrl']) {
        let host = null
        try {
          host = new URL(sites[slot][key]).hostname
        } catch (_e) {
          /* reported below */
        }
        if (!LOOPBACK_HOSTS.has(host)) return fail(3, `TRIPLEX_E2E_APP=1 refuses the non-loopback site URL ${slot}.${key}=${sites[slot][key]}`)
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** loadURL with a retry on did-fail-load every LOAD_RETRY_MS, up to LOAD_RETRY_MAX times. */
function loadWithRetry(wc, url, tag) {
  let tries = 0
  const onFail = (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded by a newer load */) return
    tries += 1
    if (tries > LOAD_RETRY_MAX) {
      console.error(`[${tag}] giving up on ${url} after ${LOAD_RETRY_MAX} retries (${code} ${description})`)
      wc.removeListener('did-fail-load', onFail)
      return
    }
    console.warn(`[${tag}] load failed (${code} ${description}); retry ${tries}/${LOAD_RETRY_MAX} in ${LOAD_RETRY_MS} ms`)
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {})
    }, LOAD_RETRY_MS)
  }
  wc.on('did-fail-load', onFail)
  wc.once('did-finish-load', () => wc.removeListener('did-fail-load', onFail))
  wc.loadURL(url).catch(() => {})
}

function parseUrl(url) {
  try {
    return new URL(String(url))
  } catch (_e) {
    return null
  }
}

function openExternally(url) {
  const u = parseUrl(url)
  if (!u) return
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') shell.openExternal(u.href).catch(() => {})
}

/** Popup policy (contract §5): allow SSO/site hosts as child windows, deny javascript:/data:, else external. */
function popupDecision(url, site) {
  const u = parseUrl(url)
  if (!u) return 'deny'
  if (u.protocol === 'javascript:' || u.protocol === 'data:') return 'deny'
  if ((u.protocol === 'http:' || u.protocol === 'https:') && (hostInList(u.hostname, SSO_HOSTS) || hostInList(u.hostname, site.hosts))) return 'allow'
  return 'external'
}

function isAllowedNavigation(url, site) {
  const u = parseUrl(url)
  if (!u) return false
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return hostInList(u.hostname, site.hosts) || hostInList(u.hostname, SSO_HOSTS)
}

function applyPermissionPolicy(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  ses.setDevicePermissionHandler(() => false)
}

// ---------------------------------------------------------------------------------------------
// Window + views
// ---------------------------------------------------------------------------------------------

/** @type {BrowserWindow|null} */
let win = null
/** @type {Record<string, WebContentsView>} */
const views = {}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'Triplex',
    autoHideMenuBar: true,
    webPreferences: {
      preload: RENDERER_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.on('closed', () => {
    win = null
  })
  // The renderer never opens windows itself; links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] render process gone (${details.reason}); reloading`)
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reload()
    }, LOAD_RETRY_MS)
  })
  loadWithRetry(win.webContents, env.TRIPLEX_RENDERER_URL || DEFAULT_RENDERER_URL, 'renderer')
}

function createView(slot) {
  const site = sites[slot]
  const ses = session.fromPartition(site.partition)
  applyPermissionPolicy(ses)

  const view = new WebContentsView({
    webPreferences: {
      partition: site.partition,
      preload: SITE_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const wc = view.webContents
  const tag = `view ${slot}`

  wc.setWindowOpenHandler(({ url }) => {
    const decision = popupDecision(url, site)
    if (decision === 'allow') {
      // A child window created this way shares the opener's partition (and preload, which stays
      // inert there because adapter:config resolves its sender to null).
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
    }
    if (decision === 'external') openExternally(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, site)) {
      event.preventDefault()
      openExternally(url)
    }
  })
  wc.on('did-finish-load', () => {
    console.log(`[${tag}] loaded ${wc.getURL()}`)
  })
  wc.on('render-process-gone', (_event, details) => {
    console.error(`[${tag}] render process gone (${details.reason}); reloading`)
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.reload()
    }, LOAD_RETRY_MS)
  })

  win.contentView.addChildView(view)
  views[slot] = view
  loadWithRetry(wc, site.url, tag)
  return view
}

/**
 * Stage-0 layout: the renderer's placeholder shell owns the top SHELL_STRIP_PX px, the three
 * views split the rest into equal thirds. Stage 1 replaces this with the rects the renderer
 * reports over 'panes:layout' (`triplex.setLayout`).
 */
function layoutViews() {
  if (!win || win.isDestroyed()) return
  const { width, height } = win.getContentBounds()
  const top = Math.min(SHELL_STRIP_PX, Math.max(0, height - 1))
  const avail = Math.max(1, height - top)
  const third = Math.floor(width / 3)
  SLOTS.forEach((slot, i) => {
    const view = views[slot]
    if (!view) return
    const x = i * third
    const w = i === SLOTS.length - 1 ? width - x : third
    view.setBounds({ x, y: top, width: Math.max(1, w), height: avail })
  })
}

// ---------------------------------------------------------------------------------------------
// IPC (contract §2) — Stage 0 stubs with full sender/payload validation
// ---------------------------------------------------------------------------------------------

function badRequest() {
  return new Error('bad_request')
}

function isRendererSender(event) {
  return !!(win && !win.isDestroyed() && event && event.sender === win.webContents)
}

function slotOfSender(event) {
  if (!event || !event.sender) return null
  for (const slot of SLOTS) {
    const view = views[slot]
    if (view && !view.webContents.isDestroyed() && view.webContents.id === event.sender.id) return slot
  }
  return null
}

function requireRenderer(event) {
  if (!isRendererSender(event)) throw badRequest()
}

function requireSlot(slot) {
  if (typeof slot !== 'string' || !SLOTS.includes(slot)) throw badRequest()
  return slot
}

/** targets ⊆ SLOTS; de-duplicated and returned in SLOTS order. */
function requireTargets(targets) {
  if (!Array.isArray(targets)) throw badRequest()
  const seen = new Set()
  for (const t of targets) seen.add(requireSlot(t))
  return SLOTS.filter((s) => seen.has(s))
}

function publicSites() {
  const out = {}
  for (const slot of SLOTS) {
    const { url, newChatUrl, partition } = sites[slot]
    out[slot] = { url, newChatUrl, partition }
  }
  return out
}

function registerIpc() {
  // --- renderer → main -----------------------------------------------------------------------
  ipcMain.handle('panes:getInfo', (event) => {
    requireRenderer(event)
    return { version: PKG.version, dev: DEV, sites: publicSites(), backend: null, layout: null }
  })
  ipcMain.on('panes:layout', (event, layout) => {
    if (!isRendererSender(event)) return
    if (layout === null || typeof layout !== 'object') return
    // Stage 0: rects are validated but not applied (layoutViews owns the bounds until Stage 1).
  })
  ipcMain.on('panes:active', (event, state) => {
    if (!isRendererSender(event)) return
    if (state === null || typeof state !== 'object') return
    // Stage 0: no tabs mode yet.
  })
  ipcMain.handle('panes:newChat', (event, targets) => {
    requireRenderer(event)
    requireTargets(targets)
    // Stage 0 stub: no navigation.
  })
  for (const channel of ['panes:reload', 'panes:openExternal', 'panes:inspect', 'panes:focus']) {
    ipcMain.handle(channel, (event, slot) => {
      requireRenderer(event)
      requireSlot(slot)
      // Stage 0 stub: harmless no-op.
    })
  }
  ipcMain.handle('panes:zoom', (event, slot, direction) => {
    requireRenderer(event)
    requireSlot(slot)
    if (direction !== 'in' && direction !== 'out' && direction !== 'reset') throw badRequest()
    const view = views[slot]
    const factor = view && !view.webContents.isDestroyed() ? view.webContents.getZoomFactor() : 1
    // Stage 0 stub: reports the current factor without changing it.
    return { factor }
  })
  ipcMain.handle('prompt:send', (event, req) => {
    requireRenderer(event)
    if (req === null || typeof req !== 'object') throw badRequest()
    const targets = requireTargets(req.targets)
    if (typeof req.text !== 'string' || req.text.length > MAX_PROMPT_CHARS) throw badRequest()
    const results = {}
    for (const slot of targets) results[slot] = { ok: false, code: 'composer_not_found', message: 'stage 0 stub', ms: 0 }
    return { results }
  })

  // --- site preload → main -------------------------------------------------------------------
  ipcMain.handle('adapter:config', (event) => {
    // Resolved by sender id; an SSO popup or unknown page gets site:null and stays inert.
    const site = slotOfSender(event)
    return { site, selectors: DEFAULT_SELECTORS, dev: DEV }
  })
  ipcMain.on('triplex:adapter:result', (event, res) => {
    const slot = slotOfSender(event)
    if (slot === null || res === null || typeof res !== 'object') return
    // Stage 0: no request is ever in flight; results are dropped.
  })
  ipcMain.on('triplex:adapter:health', (event, health) => {
    const slot = slotOfSender(event)
    if (slot === null || health === null || typeof health !== 'object') return
    if (win && !win.isDestroyed()) win.webContents.send('panes:health', slot, health)
  })
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

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
    app.whenReady().then(() => {
      applyPermissionPolicy(session.defaultSession)
      registerIpc()
      createWindow()
      for (const slot of SLOTS) createView(slot)
      layoutViews()
      win.on('resize', layoutViews)
      if (E2E) globalThis.__triplexTest = { views, settings: {} }
    })
  }
}

app.on('window-all-closed', () => {
  app.quit()
})
