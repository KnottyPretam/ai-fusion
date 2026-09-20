// desktop/main/views.js — the three site views (contract §2/§5; plan Stage 1 electron-main).
//
// Every view: `WebContentsView` on `persist:<slot>` with `preload/site.cjs`, `sandbox:true`,
// `contextIsolation:true`, `nodeIntegration:false`, `backgroundThrottling:false` (hidden views
// keep running: tabs mode hides two of them and the Stage 3 analyst view is never shown);
// popups + will-navigate / will-redirect (+ allowed child windows, recursively) through policy.js;
// permissions per partition through permissions.js, the Bluetooth chooser cancelled per view;
// zoom kept per view (`webContents.setZoomFactor`, re-applied on every navigation so a cross-host
// hop inside one view never inherits Chromium's per-origin level; persisted in settings.json);
// `render-process-gone` → the view is recreated and the renderer gets a health object whose
// `matched.error` is `view_crashed`. Every navigation main starts itself (the initial load, New
// chat, Sign out, Reload, a recorded chat link) is tracked per view until the main frame commits
// (`did-navigate`), the load fails, or NAVIGATION_WAIT_MS elapse: `pendingNavigation(slot)` hands
// that promise to the orchestrator so a bridge request never answers `ready` on the OLD document.
// `loadUrl` accepts only the site's own pages (policy.isSiteUrl — `loadURL` never fires
// `will-navigate`). Every view is also given the resolved theme's ground (`backgroundFor` →
// `View.setBackgroundColor`) so a dark page mounting over a fresh view never flashes white.
// No electron import: `WebContentsView`, the session lookup and the window's
// `contentView` are injected, so node --test drives the manager with fakes.

import { SLOTS, SSO_HOSTS } from './sites.js'
import { attachPolicy, isSiteUrl } from './policy.js'
import { applyPermissionPolicy, attachDeviceChooserPolicy } from './permissions.js'
import { applyLayout as applyLayoutToViews, normalizeLayout } from './layout.js'
import { stepZoom, clampZoom, asTheme, DEFAULT_THEME } from './settings.js'
import { createAdapterClient, isMainFrameOf, REQUEST_CHANNEL } from './adapter-client.js'
import { APP_TITLE } from './branding.js'

export const LOAD_RETRY_MS = 1000
export const LOAD_RETRY_MAX = 30
export const RECREATE_DELAY_MS = 1000
export const CRASH_WINDOW_MS = 60000
export const CRASH_LIMIT = 5
/** A navigation main started stays "pending" (pendingNavigation) at most this long without a commit. */
export const NAVIGATION_WAIT_MS = 15000

/**
 * The ground painted before any page has painted: the `--bg` tokens of frontend/src/index.css
 * (light `#ffffff`, dark `#0d1117`). Electron's own default is white, so a dark-theme launch shows
 * a full white window (and a white rect per site view) until the first paint lands — and
 * `loadWithRetry` can keep that up for seconds against a backend that is still starting.
 */
export const BACKGROUND_LIGHT = '#ffffff'
export const BACKGROUND_DARK = '#0d1117'

/**
 * The ground for a theme choice. Pure on purpose: `'system'` is resolved by the caller
 * (main passes `nativeTheme.shouldUseDarkColors`) because views.js imports no electron.
 */
export function backgroundFor(theme, { prefersDark = false } = {}) {
  const resolved = asTheme(theme, DEFAULT_THEME)
  const dark = resolved === 'dark' || (resolved === 'system' && prefersDark === true)
  return dark ? BACKGROUND_DARK : BACKGROUND_LIGHT
}

/**
 * Paint a view's own ground (`View.setBackgroundColor`) so a dark page mounting over a fresh view
 * does not flash white. Never throws: a fake (or an Electron that drops the method) just skips it.
 */
export function paintBackground(view, color, { log = console } = {}) {
  if (!view || typeof view.setBackgroundColor !== 'function') return false
  if (typeof color !== 'string' || color === '') return false
  try {
    view.setBackgroundColor(color)
    return true
  } catch (e) {
    if (log && typeof log.warn === 'function') log.warn(`[view] setBackgroundColor(${color}) failed: ${(e && e.message) || e}`)
    return false
  }
}

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

/**
 * webPreferences for the renderer window (same hardening; preload/renderer.cjs) plus the ground
 * Electron paints before the renderer's first paint (`backgroundColor`, default light) and the
 * window/taskbar icon (`icon`, a PNG path; omitted when not given, as the tests do).
 */
export function buildWindowOptions({ preload, bounds = {}, title = APP_TITLE, backgroundColor = BACKGROUND_LIGHT, icon = null } = {}) {
  if (typeof preload !== 'string' || preload === '') throw new Error('buildWindowOptions: preload is required')
  const out = {
    width: bounds.width,
    height: bounds.height,
    title,
    autoHideMenuBar: true,
    show: true,
    backgroundColor: typeof backgroundColor === 'string' && backgroundColor !== '' ? backgroundColor : BACKGROUND_LIGHT,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
    },
  }
  if (typeof icon === 'string' && icon !== '') out.icon = icon
  if (typeof bounds.x === 'number') out.x = bounds.x
  if (typeof bounds.y === 'number') out.y = bounds.y
  return out
}

/** `scheme://host` of a URL for a log line (never the path). */
function describeUrl(url) {
  try {
    const u = new URL(String(url))
    return `${u.protocol}//${u.host}`
  } catch (_e) {
    return 'unparseable URL'
  }
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
 * loadURL, retried until the page actually loads (1 s × 30 by default). Returns a `cancel()`.
 *
 * Two things make this less obvious than it looks, both found by a packaged build coming up as a
 * black window (2026-09-20) while its backend was still binding its port:
 *
 *   1. A failed navigation ALSO emits `did-finish-load`, for Chromium's error page. Treating that
 *      as success removed the listeners after the first failure, so nothing retried again.
 *   2. `loadURL` REJECTS on the same failure. That rejection is not a `did-fail-load`, and
 *      swallowing it (`.catch(() => {})`) hid the only remaining signal that the loop was dead.
 *
 * So an attempt is over only when `did-finish-load` arrives with no failure recorded for it, and
 * BOTH signals — the event and the rejection — schedule the next attempt, whichever comes first.
 * `ERR_ABORTED` (-3) is not a failure: a newer load superseded this one.
 */
export function loadWithRetry(wc, url, { tag = 'view', log = console, setTimeout: setT = globalThis.setTimeout, retryMs = LOAD_RETRY_MS, maxRetries = LOAD_RETRY_MAX } = {}) {
  let tries = 0
  let cancelled = false
  let done = false
  // Which attempt is in flight, and whether it has already been judged. Both the event and the
  // rejection can report the same attempt; only the first of them schedules the next one.
  let attempt = 0
  let settled = -1

  const destroyed = () => typeof wc.isDestroyed === 'function' && wc.isDestroyed()
  const cleanup = () => {
    done = true
    if (typeof wc.removeListener === 'function') {
      wc.removeListener('did-fail-load', onFail)
      wc.removeListener('did-finish-load', onDone)
    }
  }

  function fail(reason, code) {
    if (cancelled || done) return
    if (settled === attempt) return // this attempt already scheduled its successor
    settled = attempt
    tries += 1
    if (tries > maxRetries) {
      if (log && typeof log.error === 'function') log.error(`[${tag}] giving up on ${url} after ${maxRetries} retries (${reason})`)
      cleanup()
      return
    }
    if (log && typeof log.warn === 'function') log.warn(`[${tag}] load failed (${reason}); retry ${tries}/${maxRetries} in ${retryMs} ms`)
    setT(() => {
      if (cancelled || done || destroyed()) return
      go()
    }, retryMs)
  }

  const onFail = (_event, code, description, _failedUrl, isMainFrame) => {
    if (isMainFrame === false || code === -3) return
    fail(`${code} ${description}`, code)
  }
  // Success ONLY when this attempt has not already failed; otherwise it is the error page finishing.
  const onDone = () => {
    if (cancelled || done) return
    if (settled === attempt) return
    cleanup()
  }

  function go() {
    attempt += 1
    Promise.resolve()
      .then(() => wc.loadURL(url))
      .catch((e) => fail((e && e.message) || String(e)))
  }

  if (typeof wc.on === 'function') {
    wc.on('did-fail-load', onFail)
    wc.on('did-finish-load', onDone)
  }
  go()
  return () => {
    cancelled = true
    cleanup()
  }
}

/**
 * createViewManager(deps) → manager
 *   deps: WebContentsView (class), sessionFromPartition(partition), contentView {addChildView, removeChildView},
 *         sites, preload, settings, ipcMain, openExternal(url), onHealth(slot, health), dev, log,
 *         setTimeout, clearTimeout, now, applyPermissions?, makeAdapterClient?, childWindowOptions?,
 *         ssoHosts? (SSO_HOSTS; main passes [] under TRIPLEX_E2E_APP=1)
 *   manager.get(slot) → WebContentsView | null      manager.webContents(slot) → WebContents | null
 *   manager.adapterFor(slot) → adapter client | null (destroyed / recreating → null)
 *   manager.slotOfSender(event) → slot | null         (main-frame sender id; popups → null)
 *   manager.applyLayout(normalized) / manager.layout()  bounds + visibility (remembered for recreated views)
 *   manager.focus / reload / newChat / currentUrl / inspect / zoom(slot, direction) → factor / zoomFactor
 *   manager.setHealth(slot, h) / getHealth(slot)      the health cache the renderer also receives
 *   manager.onCreated(cb) → unsubscribe               cb(slot, webContents) for every (re)created view
 *   manager.setBackgroundColor(color) → repainted     the ground under the pages (theme change; see backgroundFor)
 *   manager.createAll() / destroyAll()
 *   Stage 2:
 *   manager.loadUrl(slot, url) → Promise             a recorded chat link (rejects `navigation` on a failed load
 *                                                     or a URL off the site's hosts — never even loaded)
 *   manager.pendingNavigation(slot) → Promise|null   a navigation main started that has not committed yet
 *   manager.onNavigate(slot, cb) → unsubscribe        cb(url, {inPage}) on did-navigate / did-navigate-in-page (main frame)
 *   manager.pushConfig(selectors) → count             {op:'config', selectors} to every live view (hot reload)
 *   manager.signOut(slot) → Promise<boolean>          clearStorageData on THAT partition only, then newChatUrl
 *   manager.partitionOf(slot) → string
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
  ssoHosts = SSO_HOSTS,
  backgroundColor = BACKGROUND_LIGHT,
} = {}) {
  if (typeof WebContentsView !== 'function') throw new Error('createViewManager: WebContentsView is required')
  if (!contentView || typeof contentView.addChildView !== 'function') throw new Error('createViewManager: contentView is required')
  if (!sites || !settings || !ipcMain) throw new Error('createViewManager: sites, settings and ipcMain are required')

  const entries = {} // slot -> {view, wc, client, cancelLoad, pending, disposed, crashes: number[]}
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

  /** The current ground: a function is re-read per view, so a view created after a theme change is right. */
  let background = backgroundColor
  const groundColor = () => {
    if (typeof background !== 'function') return background
    try {
      return background()
    } catch (e) {
      warn(`[view] backgroundColor() failed: ${(e && e.message) || e}`)
      return BACKGROUND_LIGHT
    }
  }

  /**
   * Track a navigation main just started on `entry`: `tracker.promise` resolves (never rejects)
   * once the main frame commits (`did-navigate`), the load fails (`did-fail-load`, main frame,
   * not ERR_ABORTED — a superseding navigation commits on its own), the view is disposed, or
   * NAVIGATION_WAIT_MS elapse; `tracker.settle()` ends it early (loadUrl once loadURL resolved).
   * A newer navigation on the same view settles the older tracker: only the latest is pending.
   */
  function trackNavigation(entry, url) {
    if (entry.pending) entry.pending.settle()
    const wc = entry.wc
    const tracker = { url, promise: null, settle: null }
    let done = false
    let resolveFn = () => {}
    let timer = null
    tracker.promise = new Promise((resolve) => {
      resolveFn = resolve
    })
    const onNavigate = () => tracker.settle()
    const onFail = (_event, code, _description, _failedUrl, isMainFrame) => {
      if (isMainFrame === false || code === -3) return
      tracker.settle()
    }
    tracker.settle = () => {
      if (done) return
      done = true
      if (timer !== null) clearT(timer)
      timer = null
      if (typeof wc.removeListener === 'function') {
        wc.removeListener('did-navigate', onNavigate)
        wc.removeListener('did-fail-load', onFail)
      }
      if (entry.pending === tracker) entry.pending = null
      resolveFn()
    }
    if (typeof wc.on === 'function') {
      wc.on('did-navigate', onNavigate)
      wc.on('did-fail-load', onFail)
    }
    timer = setT(() => {
      timer = null
      tracker.settle()
    }, NAVIGATION_WAIT_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
    entry.pending = tracker
    return tracker
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
    // The view's own ground, before the site's first paint: a dark page over a white view flashes too.
    paintBackground(view, groundColor(), { log })
    const wc = view.webContents
    const tag = `view ${slot}`
    const entry = { slot, view, wc, client: null, cancelLoad: null, pending: null, disposed: false, crashes: entries[slot] ? entries[slot].crashes : [] }
    entries[slot] = entry

    attachPolicy(wc, site, { openExternal, childWindowOptions, log, ssoHosts })
    attachDeviceChooserPolicy(wc)
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
    trackNavigation(entry, site.url)
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
    if (entry.pending) entry.pending.settle()
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
      } catch (_err) {
        return false
      }
      trackNavigation(e, manager.currentUrl(slot))
      return true
    },
    newChat(slot) {
      const e = live(requireSlot(slot))
      if (!e) return false
      if (e.cancelLoad) e.cancelLoad()
      e.cancelLoad = loadWithRetry(e.wc, sites[slot].newChatUrl, { tag: `view ${slot}`, log, setTimeout: setT })
      trackNavigation(e, sites[slot].newChatUrl)
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
    async loadUrl(slot, url) {
      const e = live(requireSlot(slot))
      if (!e) {
        const err = new Error(`${slot}: no live view`)
        err.code = 'view_crashed'
        throw err
      }
      if (typeof url !== 'string' || url === '') throw new Error('loadUrl: url is required')
      const site = sites[slot]
      if (url !== site.url && url !== site.newChatUrl && !isSiteUrl(url, site)) {
        // loadURL bypasses will-navigate: a link off the site's hosts (a tampered chats.json) is
        // refused here, before anything is loaded into the logged-in partition.
        const out = new Error(`${slot}: refusing to open a URL off the site's hosts (${describeUrl(url)})`)
        out.code = 'navigation'
        throw out
      }
      if (e.cancelLoad) e.cancelLoad()
      e.cancelLoad = null
      const tracker = trackNavigation(e, url)
      try {
        await e.wc.loadURL(url)
      } catch (err) {
        // ERR_ABORTED (-3): a newer navigation superseded this one (the site's own redirect); the
        // adapter's `ready` decides what the page ended up as — the tracker stays pending until
        // that navigation commits. Anything else is a failed load.
        if (err && (err.errno === -3 || err.code === 'ERR_ABORTED')) return true
        tracker.settle()
        const out = new Error(`${slot}: could not open ${url} (${(err && err.message) || err})`)
        out.code = 'navigation'
        throw out
      }
      tracker.settle()
      return true
    },
    pendingNavigation(slot) {
      const e = live(requireSlot(slot))
      return e && e.pending ? e.pending.promise : null
    },
    onNavigate(slot, cb) {
      const e = live(requireSlot(slot))
      if (!e || typeof cb !== 'function' || typeof e.wc.on !== 'function') return () => {}
      const onFull = (_event, url) => cb(String(url || ''), { inPage: false })
      const onInPage = (_event, url, isMainFrame) => {
        if (isMainFrame === false) return
        cb(String(url || ''), { inPage: true })
      }
      e.wc.on('did-navigate', onFull)
      e.wc.on('did-navigate-in-page', onInPage)
      return () => {
        if (typeof e.wc.removeListener !== 'function') return
        e.wc.removeListener('did-navigate', onFull)
        e.wc.removeListener('did-navigate-in-page', onInPage)
      }
    },
    pushConfig(selectors) {
      let count = 0
      for (const slot of SLOTS) {
        const e = live(slot)
        if (!e) continue
        try {
          e.wc.send(REQUEST_CHANNEL, { op: 'config', selectors })
          count += 1
        } catch (err) {
          warn(`[view ${slot}] config push failed: ${(err && err.message) || err}`)
        }
      }
      return count
    },
    partitionOf(slot) {
      return sites[requireSlot(slot)].partition
    },
    async signOut(slot) {
      requireSlot(slot)
      const ses = sessionFromPartition(sites[slot].partition)
      if (!ses || typeof ses.clearStorageData !== 'function') throw new Error(`${slot}: session has no clearStorageData`)
      await ses.clearStorageData()
      info(`[view ${slot}] storage cleared for ${sites[slot].partition}`)
      return manager.newChat(slot)
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
    /** New ground for every live view (a theme change) and for every view created from here on. */
    setBackgroundColor(color) {
      if (typeof color !== 'string' || color === '') return 0
      background = color
      let count = 0
      for (const slot of SLOTS) {
        const e = live(slot)
        if (e && paintBackground(e.view, color, { log })) count += 1
      }
      return count
    },
  }
  return manager
}
