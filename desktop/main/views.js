// desktop/main/views.js — the three site views (contract §2/§5; plan Stage 1 electron-main).
//
// Every view: `WebContentsView` on `persist:<slot>` with `preload/site.cjs`, `sandbox:true`,
// `contextIsolation:true`, `nodeIntegration:false`, `backgroundThrottling:false` (hidden views
// keep running: tabs mode hides two of them and the Stage 3 analyst view is never shown);
// popups + will-navigate through policy.js; permissions per partition through permissions.js;
// zoom kept per view (`webContents.setZoomFactor`, re-applied on every navigation so a cross-host
// hop inside one view never inherits Chromium's per-origin level; persisted in settings.json);
// `render-process-gone` → the view is recreated and the renderer gets a health object whose
// `matched.error` is `view_crashed`. No electron import: `WebContentsView`, the session lookup and
// the window's `contentView` are injected, so node --test drives the manager with fakes.

import { SLOTS } from './sites.js'
import { attachPolicy } from './policy.js'
import { applyPermissionPolicy } from './permissions.js'
import { applyLayout as applyLayoutToViews, normalizeLayout } from './layout.js'
import { stepZoom, clampZoom } from './settings.js'
import { createAdapterClient, isMainFrameOf } from './adapter-client.js'

export const LOAD_RETRY_MS = 1000
export const LOAD_RETRY_MAX = 30
export const RECREATE_DELAY_MS = 1000
export const CRASH_WINDOW_MS = 60000
export const CRASH_LIMIT = 5

/** webPreferences for one site view (the pure option-builder the views test asserts on). */
export function buildViewOptions(site, { preload, zoomFactor = 1 } = {}) {
  if (!site || typeof site.partition !== 'string') throw new Error('buildViewOptions: site.partition is required')
  if (typeof preload !== 'string' || preload === '') throw new Error('buildViewOptions: preload is required')
  return {
    webPreferences: {
      partition: site.partition,
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      backgroundThrottling: false,
      zoomFactor: clampZoom(zoomFactor),
    },
  }
}

/** webPreferences for the renderer window (same hardening; preload/renderer.cjs). */
export function buildWindowOptions({ preload, bounds = {}, title = 'Triplex' } = {}) {
  if (typeof preload !== 'string' || preload === '') throw new Error('buildWindowOptions: preload is required')
  const out = {
    width: bounds.width,
    height: bounds.height,
    title,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
    },
  }
  if (typeof bounds.x === 'number') out.x = bounds.x
  if (typeof bounds.y === 'number') out.y = bounds.y
  return out
}

/** The Health object main publishes for a crashed view (§1 shape; `matched.error = 'view_crashed'`). */
export function crashedHealth(slot, { url = '', now = Date.now } = {}) {
  let host = ''
  try {
    host = url ? new URL(url).hostname : ''
  } catch (_e) {
    host = ''
  }
  return {
    composer: false,
    send: false,
    reply: null,
    stop: null,
    session: 'unknown',
    matched: { composer: null, send: null, reply: null, stop: null, error: 'view_crashed' },
    url: String(url || ''),
    host,
    title: '',
    ts: Math.round(Number(now()) || 0),
  }
}

/**
 * loadURL with a retry on every main-frame `did-fail-load` (1 s × 30 by default; ERR_ABORTED = a
 * newer load superseded this one and is not a failure). Returns a `cancel()` that stops retrying.
 */
export function loadWithRetry(wc, url, { tag = 'view', log = console, setTimeout: setT = globalThis.setTimeout, retryMs = LOAD_RETRY_MS, maxRetries = LOAD_RETRY_MAX } = {}) {
  let tries = 0
  let cancelled = false
  const destroyed = () => typeof wc.isDestroyed === 'function' && wc.isDestroyed()
  const cleanup = () => {
    if (typeof wc.removeListener === 'function') {
      wc.removeListener('did-fail-load', onFail)
      wc.removeListener('did-finish-load', onDone)
    }
  }
  const onDone = () => cleanup()
  const onFail = (_event, code, description, _failedUrl, isMainFrame) => {
    if (cancelled || isMainFrame === false || code === -3) return
    tries += 1
    if (tries > maxRetries) {
      if (log && typeof log.error === 'function') log.error(`[${tag}] giving up on ${url} after ${maxRetries} retries (${code} ${description})`)
      cleanup()
      return
    }
    if (log && typeof log.warn === 'function') log.warn(`[${tag}] load failed (${code} ${description}); retry ${tries}/${maxRetries} in ${retryMs} ms`)
    setT(() => {
      if (cancelled || destroyed()) return
      Promise.resolve()
        .then(() => wc.loadURL(url))
        .catch(() => {})
    }, retryMs)
  }
  if (typeof wc.on === 'function') {
    wc.on('did-fail-load', onFail)
    wc.on('did-finish-load', onDone)
  }
  Promise.resolve()
    .then(() => wc.loadURL(url))
    .catch(() => {})
  return () => {
    cancelled = true
    cleanup()
  }
}

/**
 * createViewManager(deps) → manager
 *   deps: WebContentsView (class), sessionFromPartition(partition), contentView {addChildView, removeChildView},
 *         sites, preload, settings, ipcMain, openExternal(url), onHealth(slot, health), dev, log,
 *         setTimeout, clearTimeout, now, applyPermissions?, makeAdapterClient?, childWindowOptions?
 *   manager.get(slot) → WebContentsView | null      manager.webContents(slot) → WebContents | null
 *   manager.adapterFor(slot) → adapter client | null (destroyed / recreating → null)
 *   manager.slotOfSender(event) → slot | null         (main-frame sender id; popups → null)
 *   manager.applyLayout(normalized) / manager.layout()  bounds + visibility (remembered for recreated views)
 *   manager.focus / reload / newChat / currentUrl / inspect / zoom(slot, direction) → factor / zoomFactor
 *   manager.setHealth(slot, h) / getHealth(slot)      the health cache the renderer also receives
 *   manager.onCreated(cb) → unsubscribe               cb(slot, webContents) for every (re)created view
 *   manager.createAll() / destroyAll()
 */
export function createViewManager({
  WebContentsView,
  sessionFromPartition,
  contentView,
  sites,
  preload,
  settings,
  ipcMain,
  openExternal,
  onHealth = () => {},
  dev = false,
  log = console,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  now = Date.now,
  applyPermissions = applyPermissionPolicy,
  makeAdapterClient = createAdapterClient,
  childWindowOptions = { autoHideMenuBar: true },
} = {}) {
  if (typeof WebContentsView !== 'function') throw new Error('createViewManager: WebContentsView is required')
  if (!contentView || typeof contentView.addChildView !== 'function') throw new Error('createViewManager: contentView is required')
  if (!sites || !settings || !ipcMain) throw new Error('createViewManager: sites, settings and ipcMain are required')

  const entries = {} // slot -> {view, wc, client, cancelLoad, disposed, crashes: number[]}
  const health = {}
  const created = new Set()
  const partitionsDone = new Set()
  let lastLayout = normalizeLayout(null)

  const live = (slot) => {
    const e = entries[slot]
    if (!e || e.disposed) return null
    try {
      if (typeof e.wc.isDestroyed === 'function' && e.wc.isDestroyed()) return null
    } catch (_e) {
      return null
    }
    return e
  }

  const warn = (m) => log && typeof log.warn === 'function' && log.warn(m)
  const error = (m) => log && typeof log.error === 'function' && log.error(m)
  const info = (m) => log && typeof log.log === 'function' && log.log(m)

  function applyZoom(entry, factor) {
    try {
      entry.wc.setZoomFactor(factor)
    } catch (e) {
      warn(`[view ${entry.slot}] setZoomFactor(${factor}) failed: ${(e && e.message) || e}`)
    }
  }

  function create(slot) {
    const site = sites[slot]
    if (!site) throw new Error(`createViewManager: no site for ${slot}`)
    if (!partitionsDone.has(site.partition)) {
      applyPermissions(sessionFromPartition(site.partition))
      partitionsDone.add(site.partition)
    }
    const zoom = settings.getZoom(slot)
    const view = new WebContentsView(buildViewOptions(site, { preload, zoomFactor: zoom }))
    const wc = view.webContents
    const tag = `view ${slot}`
    const entry = { slot, view, wc, client: null, cancelLoad: null, disposed: false, crashes: entries[slot] ? entries[slot].crashes : [] }
    entries[slot] = entry

    attachPolicy(wc, site, { openExternal, childWindowOptions, log })
    wc.on('did-navigate', () => applyZoom(entry, settings.getZoom(slot)))
    wc.on('did-finish-load', () => {
      applyZoom(entry, settings.getZoom(slot))
      let url = ''
      try {
        url = wc.getURL()
      } catch (_e) {
        url = ''
      }
      info(`[${tag}] loaded ${url}`)
    })
    contentView.addChildView(view)
    // The client's own listeners go first so a crash fails its pending requests `view_crashed`
    // before the manager disposes it (which would report `adapter_gone`).
    entry.client = makeAdapterClient(wc, slot, { ipcMain, setTimeout: setT, clearTimeout: clearT, now, log })
    wc.on('render-process-gone', (_event, details) => handleCrash(entry, details))
    applyZoom(entry, zoom)
    applyLayoutToViews({ [slot]: view }, lastLayout)
    entry.cancelLoad = loadWithRetry(wc, site.url, { tag, log, setTimeout: setT })
    for (const cb of created) {
      try {
        cb(slot, wc)
      } catch (e) {
        warn(`[${tag}] onCreated listener failed: ${(e && e.message) || e}`)
      }
    }
    return view
  }

  function dispose(entry) {
    if (entry.disposed) return
    entry.disposed = true
    if (entry.cancelLoad) entry.cancelLoad()
    if (entry.client) entry.client.dispose()
    try {
      if (typeof contentView.removeChildView === 'function') contentView.removeChildView(entry.view)
    } catch (_e) {
      /* already detached */
    }
    try {
      if (typeof entry.wc.close === 'function' && !(typeof entry.wc.isDestroyed === 'function' && entry.wc.isDestroyed())) entry.wc.close()
    } catch (_e) {
      /* already gone */
    }
  }

  function handleCrash(entry, details) {
    const reason = details && details.reason
    if (entry.disposed || reason === 'clean-exit') return
    if (entries[entry.slot] !== entry) return
    const slot = entry.slot
    let url = ''
    try {
      url = entry.wc.getURL()
    } catch (_e) {
      url = ''
    }
    error(`[view ${slot}] render process gone (${reason || 'unknown'}, exit ${details && details.exitCode})`)
    const t = now()
    entry.crashes = entry.crashes.filter((ts) => t - ts < CRASH_WINDOW_MS)
    entry.crashes.push(t)
    const h = crashedHealth(slot, { url, now })
    setHealth(slot, h)
    dispose(entry)
    if (entry.crashes.length > CRASH_LIMIT) {
      error(`[view ${slot}] crashed ${entry.crashes.length} times in ${CRASH_WINDOW_MS / 1000} s; not recreating (Reload the pane to retry)`)
      return
    }
    setT(() => {
      if (entries[slot] !== entry) return // already recreated / destroyed
      try {
        create(slot)
      } catch (e) {
        error(`[view ${slot}] recreate failed: ${(e && e.message) || e}`)
      }
    }, RECREATE_DELAY_MS)
  }

  function setHealth(slot, h) {
    health[slot] = h
    try {
      onHealth(slot, h)
    } catch (e) {
      warn(`[view ${slot}] onHealth failed: ${(e && e.message) || e}`)
    }
  }

  function requireSlot(slot) {
    if (!SLOTS.includes(slot)) throw new Error(`views: unknown slot ${String(slot)}`)
    return slot
  }

  const manager = {
    createAll() {
      for (const slot of SLOTS) if (!entries[slot]) create(slot)
      return manager
    },
    destroyAll() {
      for (const slot of Object.keys(entries)) {
        dispose(entries[slot])
        delete entries[slot]
      }
    },
    slots: () => SLOTS.slice(),
    get(slot) {
      const e = live(requireSlot(slot))
      return e ? e.view : null
    },
    webContents(slot) {
      const e = live(requireSlot(slot))
      return e ? e.wc : null
    },
    adapterFor(slot) {
      const e = live(requireSlot(slot))
      return e ? e.client : null
    },
    slotOfSender(event) {
      for (const slot of SLOTS) {
        const e = live(slot)
        if (e && isMainFrameOf(event, e.wc)) return slot
      }
      return null
    },
    applyLayout(normalized) {
      lastLayout = normalized && typeof normalized === 'object' ? normalized : normalizeLayout(null)
      const map = {}
      for (const slot of SLOTS) {
        const e = live(slot)
        if (e) map[slot] = e.view
      }
      return applyLayoutToViews(map, lastLayout)
    },
    layout: () => lastLayout,
    focus(slot) {
      const e = live(requireSlot(slot))
      if (!e) return false
      try {
        e.wc.focus()
        return true
      } catch (_err) {
        return false
      }
    },
    reload(slot) {
      const e = live(requireSlot(slot))
      if (!e) {
        // a view that gave up after a crash loop comes back on an explicit Reload
        const stale = entries[slot]
        if (stale) stale.crashes = []
        create(slot)
        return true
      }
      try {
        e.wc.reload()
        return true
      } catch (_err) {
        return false
      }
    },
    newChat(slot) {
      const e = live(requireSlot(slot))
      if (!e) return false
      if (e.cancelLoad) e.cancelLoad()
      e.cancelLoad = loadWithRetry(e.wc, sites[slot].newChatUrl, { tag: `view ${slot}`, log, setTimeout: setT })
      return true
    },
    currentUrl(slot) {
      const e = live(requireSlot(slot))
      if (!e) return ''
      try {
        return String(e.wc.getURL() || '')
      } catch (_err) {
        return ''
      }
    },
    inspect(slot) {
      const e = live(requireSlot(slot))
      if (!e || !dev) return false
      try {
        e.wc.openDevTools({ mode: 'detach' })
        return true
      } catch (_err) {
        return false
      }
    },
    zoom(slot, direction) {
      requireSlot(slot)
      const next = stepZoom(settings.getZoom(slot), direction)
      settings.setZoom(slot, next)
      const e = live(slot)
      if (e) applyZoom(e, next)
      return next
    },
    zoomFactor(slot) {
      return settings.getZoom(requireSlot(slot))
    },
    setHealth(slot, h) {
      requireSlot(slot)
      health[slot] = h
    },
    getHealth(slot) {
      return health[requireSlot(slot)] || null
    },
    onCreated(cb) {
      if (typeof cb !== 'function') return () => {}
      created.add(cb)
      return () => created.delete(cb)
    },
  }
  return manager
}
