// desktop/main/analyst-views.js — the hidden analyst page (Stage 3 analyst-view; contract §1/§2/§5).
//
// ONE extra `WebContentsView`, on `persist:<settings.analyst>` — the same logged-in session as that
// slot's pane, a different view — created LAZILY (nothing exists until an analyst request, an
// explicit `showAnalyst(true)` or an `analyst` rect in `panes:layout` asks for it) and attached with
// `addChildView` + `setVisible(false)`: `backgroundThrottling:false` keeps it running while hidden,
// zoom is always 1 (it is never read by a human unless it is revealed), and it carries the same
// site preload, policy, permissions and device-chooser rules as a pane view. Insertion into a
// hidden view works per the Stage 0 spike (`webContents.focus()` + the adapter's `execCommand`
// path), so the analyst never has to be shown to answer.
//
//   slot()                 settings.analyst (null = no analyst chosen)
//   visible()              settings.analystVisible (the renderer's fourth tab mirrors it)
//   state()                the `panes:analyst` payload {slot, visible, health}
//   adapterFor(slot)       the adapter client, creating the view on demand; null when `slot` is not
//                          the chosen analyst (the orchestrator answers `analyst_not_chosen`)
//   setAnalyst(slot|null)  persists settings.analyst; a partition change destroys the old view and
//                          recreates it (hidden) when one existed, else stays lazy
//   setVisible(bool)       persists settings.analystVisible; false hides the view at once, and true is
//                          refused while no analyst is chosen (nothing would be behind the tab)
//   applyLayout(norm)      the `analyst` rect of a normalized layout drives bounds + visibility
//   setHealth(h)/getHealth()   the health cache behind `panes:analyst`; `challenge` / `logged_out`
//                          AUTO-REVEALS the view (decision 7: the affected view is shown so the
//                          user can sign in or solve the challenge by hand)
//   currentUrl()/loadUrl(url)/newChatUrl()/pendingNavigation()/focus()/slotOfSender(event)
//   chatFor(convId)/chatOwner(url)/noteChat(convId, url)   which analyst chat each conversation is
//                          in: the view is one per app while the backend's busy guard is per
//                          conversation, so the orchestrator binds a `fresh:false` continuation to
//                          the chat its own conversation used instead of typing into a foreign one
//   pushConfig(selectors)  the §4 selector hot reload reaches the analyst view as well
//
// Readings taken where the contract is silent (documented in the final report):
//   • a request whose slot is not `settings.analyst` is `analyst_not_chosen`, not `unknown_site`:
//     the backend's ANALYST_MODEL is only refreshed on the next spawn, so a mid-session change
//     leaves stale `web:<old>:analyst` requests in flight and "the analyst you asked for is not the
//     one that is chosen" is exactly that state.
//   • the analyst view never records a chat link in chats.json and never emits `panes:turn`: both
//     are keyed by slot alone (§2) and would mislabel that slot's PANE. Its chats are remembered
//     in memory per conversation instead (`noteChat`), which never leaves main.
//   • the analyst view's Health is never sent over the bridge `health` frame (also slot-keyed) —
//     it reaches the renderer as `panes:analyst.health` only.
//
// No electron import: `WebContentsView`, the session lookup and the window's `contentView` are
// injected, exactly as in views.js, so `node --test` drives this with fakes.

import { SLOTS, SSO_HOSTS } from './sites.js'
import { attachPolicy, isSiteUrl } from './policy.js'
import { applyPermissionPolicy, attachDeviceChooserPolicy } from './permissions.js'
import { applyLayout as applyLayoutToViews, normalizeLayout } from './layout.js'
import { createAdapterClient, REQUEST_CHANNEL } from './adapter-client.js'
import { buildViewOptions, loadWithRetry, crashedHealth, paintBackground, BACKGROUND_LIGHT, NAVIGATION_WAIT_MS, RECREATE_DELAY_MS, CRASH_WINDOW_MS, CRASH_LIMIT } from './views.js'

/** The layout key the renderer reports the analyst rect under (contract §2). */
export const ANALYST_LAYOUT_KEY = 'analyst'
/** Session states that reveal the analyst view without being asked (decision 7). */
export const REVEAL_SESSIONS = Object.freeze(['logged_out', 'challenge'])
/** How many conversations' analyst chats main remembers (newest kept; the map never grows forever). */
export const ANALYST_CHAT_MEMORY = 50

/**
 * createAnalystViews(deps) → manager (see the header for the surface).
 *   WebContentsView, sessionFromPartition, contentView, sites, preload, settings, ipcMain
 *   openExternal(url), onState(state), dev, log, setTimeout, clearTimeout, now,
 *   applyPermissions?, makeAdapterClient?, childWindowOptions?, ssoHosts?
 */
export function createAnalystViews({
  WebContentsView,
  sessionFromPartition,
  contentView,
  sites,
  preload,
  settings,
  ipcMain,
  openExternal,
  onState = () => {},
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
  if (typeof WebContentsView !== 'function') throw new Error('createAnalystViews: WebContentsView is required')
  if (!contentView || typeof contentView.addChildView !== 'function') throw new Error('createAnalystViews: contentView is required')
  if (!sites || !settings || !ipcMain) throw new Error('createAnalystViews: sites, settings and ipcMain are required')

  /** {slot, view, wc, client, cancelLoad, pending, disposed} while a view exists; null when lazy. */
  let entry = null
  let health = null
  let lastLayout = normalizeLayout(null)
  let crashes = []
  /** conversation id → the analyst chat URL that conversation last used (insertion-ordered, capped). */
  const chats = new Map()
  const partitionsDone = new Set()
  const created = new Set()

  const warn = (m) => log && typeof log.warn === 'function' && log.warn(`[analyst] ${m}`)
  const error = (m) => log && typeof log.error === 'function' && log.error(`[analyst] ${m}`)
  const info = (m) => log && typeof log.log === 'function' && log.log(`[analyst] ${m}`)

  /** The current ground (see views.backgroundFor); a function is re-read per created view. */
  let background = backgroundColor
  const groundColor = () => {
    if (typeof background !== 'function') return background
    try {
      return background()
    } catch (e) {
      warn(`backgroundColor() failed: ${(e && e.message) || e}`)
      return BACKGROUND_LIGHT
    }
  }

  const chosen = () => {
    const slot = typeof settings.getAnalyst === 'function' ? settings.getAnalyst() : null
    return SLOTS.includes(slot) ? slot : null
  }

  const wanted = () => (typeof settings.getAnalystVisible === 'function' ? settings.getAnalystVisible() === true : false)

  function live() {
    if (!entry || entry.disposed) return null
    try {
      if (typeof entry.wc.isDestroyed === 'function' && entry.wc.isDestroyed()) return null
    } catch (_e) {
      return null
    }
    return entry
  }

  function state() {
    return { slot: chosen(), visible: wanted(), health }
  }

  function publish() {
    try {
      onState(state())
    } catch (e) {
      warn(`onState failed: ${(e && e.message) || e}`)
    }
  }

  /**
   * Track a navigation this module started until the main frame commits, the load fails or
   * NAVIGATION_WAIT_MS elapse — the orchestrator awaits it before `ready`, so the OLD document
   * never answers for the new one (views.js does the same per pane).
   */
  function trackNavigation(e, url) {
    if (e.pending) e.pending.settle()
    const wc = e.wc
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
      if (e.pending === tracker) e.pending = null
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
    e.pending = tracker
    return tracker
  }

  function applyZoom(e) {
    try {
      e.wc.setZoomFactor(1) // the analyst page is machine-read: always 1, never the pane's zoom
    } catch (err) {
      warn(`setZoomFactor(1) failed: ${(err && err.message) || err}`)
    }
  }

  function create() {
    const slot = chosen()
    if (slot === null) return null
    const site = sites[slot]
    if (!site) {
      warn(`no site for ${slot}; the analyst view is not created`)
      return null
    }
    if (!partitionsDone.has(site.partition)) {
      applyPermissions(sessionFromPartition(site.partition))
      partitionsDone.add(site.partition)
    }
    const view = new WebContentsView(buildViewOptions(site, { preload, zoomFactor: 1 }))
    // The ground under the page: revealed on a challenge, it must not flash white in a dark shell.
    paintBackground(view, groundColor(), { log })
    const wc = view.webContents
    const e = { slot, view, wc, client: null, cancelLoad: null, pending: null, disposed: false }
    entry = e
    health = null

    attachPolicy(wc, site, { openExternal, childWindowOptions, log, ssoHosts })
    attachDeviceChooserPolicy(wc)
    wc.on('did-navigate', () => applyZoom(e))
    wc.on('did-finish-load', () => applyZoom(e))
    contentView.addChildView(view)
    // Hidden from the moment it is attached: the renderer decides when (and where) it is shown.
    try {
      view.setVisible(false)
    } catch (err) {
      warn(`setVisible(false) failed: ${(err && err.message) || err}`)
    }
    e.client = makeAdapterClient(wc, slot, { ipcMain, setTimeout: setT, clearTimeout: clearT, now, log })
    wc.on('render-process-gone', (_event, details) => handleCrash(e, details))
    applyZoom(e)
    applyLayoutToViews({ [ANALYST_LAYOUT_KEY]: view }, visibleLayout())
    e.cancelLoad = loadWithRetry(wc, site.newChatUrl, { tag: `analyst ${slot}`, log, setTimeout: setT })
    trackNavigation(e, site.newChatUrl)
    info(`hidden analyst view created on ${site.partition}`)
    for (const cb of created) {
      try {
        cb(slot, wc)
      } catch (err) {
        warn(`onCreated listener failed: ${(err && err.message) || err}`)
      }
    }
    // The cleared health above re-opened main's own gate (rejectFromHealth(null) lets a turn
    // through); publish it too, or the renderer's fourth tab keeps the crashed chip of the view
    // this one replaced until the adapter's next change / 10 s heartbeat.
    publish()
    return e
  }

  function dispose(e) {
    if (!e || e.disposed) return
    e.disposed = true
    if (e.cancelLoad) e.cancelLoad()
    if (e.pending) e.pending.settle()
    if (e.client) e.client.dispose()
    try {
      if (typeof contentView.removeChildView === 'function') contentView.removeChildView(e.view)
    } catch (_err) {
      /* already detached */
    }
    try {
      if (typeof e.wc.close === 'function' && !(typeof e.wc.isDestroyed === 'function' && e.wc.isDestroyed())) e.wc.close()
    } catch (_err) {
      /* already gone */
    }
  }

  function handleCrash(e, details) {
    const reason = details && details.reason
    if (e.disposed || reason === 'clean-exit') return
    if (entry !== e) return
    let url = ''
    try {
      url = e.wc.getURL()
    } catch (_err) {
      url = ''
    }
    error(`render process gone (${reason || 'unknown'}, exit ${details && details.exitCode})`)
    const t = now()
    crashes = crashes.filter((ts) => t - ts < CRASH_WINDOW_MS)
    crashes.push(t)
    setHealth(crashedHealth(e.slot, { url, now }))
    dispose(e)
    entry = null
    if (crashes.length > CRASH_LIMIT) {
      error(`the analyst view crashed ${crashes.length} times in ${CRASH_WINDOW_MS / 1000} s; not recreating now (the next analyst call builds it again)`)
      return
    }
    const timer = setT(() => {
      if (entry !== null) return // something already recreated it
      try {
        create()
      } catch (err) {
        error(`recreate failed: ${(err && err.message) || err}`)
      }
    }, RECREATE_DELAY_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  /** The layout actually applied: the reported rect only counts while the analyst is `visible`. */
  function visibleLayout() {
    if (!wanted()) return normalizeLayout(null)
    return lastLayout
  }

  function ensure() {
    const slot = chosen()
    if (slot === null) {
      if (entry) {
        dispose(entry)
        entry = null
      }
      return null
    }
    const e = live()
    if (e && e.slot === slot) return e
    if (entry) dispose(entry)
    entry = null
    return create()
  }

  function setHealth(h) {
    if (h === null || typeof h !== 'object' || Array.isArray(h)) return null
    const before = health
    health = h
    // Decision 7: a signed-out or challenged analyst page can only be fixed by hand, so reveal it.
    // Only on the TRANSITION into that state: the adapter re-publishes every 10 s, and a user who
    // hid the tab again while the page is still challenged must not have it reopened under them.
    const wasBroken = !!before && REVEAL_SESSIONS.includes(before.session)
    if (REVEAL_SESSIONS.includes(h.session) && !wasBroken && !wanted()) {
      info(`session is ${h.session}; revealing the analyst page`)
      setVisible(true) // publishes
      return health
    }
    publish()
    return health
  }

  function setVisible(visible) {
    // Never revealed while no analyst is chosen: the tab would take half the deck with no view
    // behind it (nothing can be created — `ensure()` returns null — and no rect brings one back).
    const next = visible === true && chosen() !== null
    if (next !== (visible === true)) info('no analyst is chosen; there is no page to reveal')
    if (typeof settings.setAnalystVisible === 'function') settings.setAnalystVisible(next)
    if (next) ensure()
    const e = live()
    // false hides the view at once; true waits for the renderer's rect (nothing is shown at 0,0).
    if (e) applyLayoutToViews({ [ANALYST_LAYOUT_KEY]: e.view }, visibleLayout())
    publish()
    return next
  }

  function setAnalyst(slot) {
    if (slot !== null && !SLOTS.includes(slot)) throw new Error(`analyst: unknown slot ${String(slot)}`)
    const before = chosen()
    if (typeof settings.setAnalyst === 'function') settings.setAnalyst(slot)
    let published = false
    if (before !== slot) {
      const had = !!live()
      if (entry) {
        dispose(entry) // the partition changes with the slot: the old session must not stay attached
        entry = null
      }
      health = null
      crashes = []
      chats.clear() // the recorded chat URLs belong to the site that is going away
      if (had && slot !== null) create() // recreate hidden on the new partition; otherwise stay lazy
      // No analyst → nothing behind the fourth tab: hide it, or the deck keeps half its width on an
      // empty pane (the renderer keys the tab on `visible` alone, and no rect can bring a view back).
      if (slot === null && wanted()) {
        setVisible(false) // publishes
        published = true
      }
      info(`analyst page set to ${slot === null ? 'none' : slot}`)
    }
    if (!published) publish()
    return chosen()
  }

  const manager = {
    slot: chosen,
    visible: wanted,
    state,
    ensure,
    get() {
      const e = live()
      return e ? e.view : null
    },
    webContents() {
      const e = live()
      return e ? e.wc : null
    },
    /** The adapter client for `slot`, creating the hidden view on demand; null = no analyst chosen. */
    adapterFor(slot) {
      const want = chosen()
      if (want === null || (slot !== undefined && slot !== null && slot !== want)) return null
      const e = ensure()
      return e ? e.client : null
    },
    slotOfSender(event) {
      const e = live()
      if (!e) return null
      if (!event || !event.sender) return null
      const sender = event.sender
      const same = sender === e.wc || (typeof sender.id === 'number' && sender.id === e.wc.id)
      if (!same) return null
      let frame = null
      try {
        frame = event.senderFrame
      } catch (_err) {
        return null
      }
      if (frame === undefined) return e.slot
      if (frame === null) return null
      return frame.parent ? null : e.slot
    },
    applyLayout(normalized) {
      lastLayout = normalized && typeof normalized === 'object' ? normalized : normalizeLayout(null)
      if (lastLayout[ANALYST_LAYOUT_KEY] && wanted()) ensure() // the fourth tab was opened before any analyst call
      const e = live()
      if (!e) return []
      return applyLayoutToViews({ [ANALYST_LAYOUT_KEY]: e.view }, visibleLayout())
    },
    layout: () => lastLayout,
    setAnalyst,
    setVisible,
    setHealth,
    getHealth: () => health,
    newChatUrl() {
      const slot = chosen()
      return slot === null ? null : sites[slot].newChatUrl
    },
    currentUrl() {
      const e = live()
      if (!e) return ''
      try {
        return String(e.wc.getURL() || '')
      } catch (_err) {
        return ''
      }
    },
    async loadUrl(url) {
      const e = live()
      if (!e) {
        const err = new Error('analyst: no live view')
        err.code = 'view_crashed'
        throw err
      }
      if (typeof url !== 'string' || url === '') throw new Error('loadUrl: url is required')
      const site = sites[e.slot]
      if (url !== site.url && url !== site.newChatUrl && !isSiteUrl(url, site)) {
        const out = new Error('analyst: refusing to open a URL off the site\'s hosts')
        out.code = 'navigation'
        throw out
      }
      if (e.cancelLoad) e.cancelLoad()
      e.cancelLoad = null
      const tracker = trackNavigation(e, url)
      try {
        await e.wc.loadURL(url)
      } catch (err) {
        if (err && (err.errno === -3 || err.code === 'ERR_ABORTED')) return true
        tracker.settle()
        const out = new Error(`analyst: could not open a new chat (${(err && err.message) || err})`)
        out.code = 'navigation'
        throw out
      }
      tracker.settle()
      return true
    },
    pendingNavigation() {
      const e = live()
      return e && e.pending ? e.pending.promise : null
    },
    /** The analyst chat `conversationId` last used, or null. */
    chatFor(conversationId) {
      if (typeof conversationId !== 'string' || conversationId === '') return null
      return chats.get(conversationId) || null
    },
    /** Which conversation owns `url`, or null when no conversation has been in that chat. */
    chatOwner(url) {
      if (typeof url !== 'string' || url === '') return null
      for (const [convId, u] of chats) if (u === url) return convId
      return null
    },
    /**
     * Record the analyst chat a finished turn of `conversationId` landed in (the orchestrator only
     * offers URLs matching the site's chatUrlPattern). Newest last, capped at ANALYST_CHAT_MEMORY:
     * a long session must not grow a map forever.
     */
    noteChat(conversationId, url) {
      if (typeof conversationId !== 'string' || conversationId === '' || typeof url !== 'string' || url === '') return null
      chats.delete(conversationId)
      chats.set(conversationId, url)
      while (chats.size > ANALYST_CHAT_MEMORY) chats.delete(chats.keys().next().value)
      return url
    },
    focus() {
      const e = live()
      if (!e) return false
      try {
        e.wc.focus() // the Stage 0 spike: a hidden view still takes focus, and execCommand then lands
        return true
      } catch (_err) {
        return false
      }
    },
    /** `{op:'config', selectors}` to the analyst view too (§4 hot reload); 1 when it went out. */
    pushConfig(selectors) {
      const e = live()
      if (!e) return 0
      try {
        e.wc.send(REQUEST_CHANNEL, { op: 'config', selectors })
        return 1
      } catch (err) {
        warn(`config push failed: ${(err && err.message) || err}`)
        return 0
      }
    },
    reload() {
      const e = live()
      if (!e) return false
      try {
        e.wc.reload()
      } catch (_err) {
        return false
      }
      trackNavigation(e, manager.currentUrl())
      return true
    },
    onCreated(cb) {
      if (typeof cb !== 'function') return () => {}
      created.add(cb)
      return () => created.delete(cb)
    },
    /** New ground for the live view (a theme change) and for every view created from here on. */
    setBackgroundColor(color) {
      if (typeof color !== 'string' || color === '') return false
      background = color
      const e = live()
      return e ? paintBackground(e.view, color, { log }) : false
    },
    destroy() {
      if (entry) dispose(entry)
      entry = null
    },
  }
  return manager
}
