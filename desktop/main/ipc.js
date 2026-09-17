// desktop/main/ipc.js — every `panes:*` channel and the site-preload channels (contract §2).
// Validation first, always: `slot ∈ SLOTS`, `targets ⊆ SLOTS`, `direction ∈ in|out|reset`,
// `on` a boolean, `convId` a string ≤ 200 chars or null, and the sender must be the renderer's
// main frame; a violation rejects `Error('bad_request')` (fire-and-forget channels drop it
// silently). `adapter:config` is resolved by the sender's webContents id: a site view gets its
// slot and the FULL merged selectors object, anything else (SSO popup, unknown page) gets
// `site: null` and stays inert. `panes:getInfo` also replays the cached health, the zoom factor
// of every view and the bridge state (`panes:health` / `panes:zoom` / `panes:bridge`): the
// renderer calls it once its listeners exist, so nothing sent while the page was still loading
// stays lost.
//
// Stage 2: `panes:getCapture` / `panes:setCapture` (settings.json; the bridge `capture` frame is
// re-sent by main's settings subscription), `panes:openChats(convId|null)` → per slot
// 'navigated' (a recorded link that differs) | 'new' (no link → newChatUrl) | 'kept' (already
// there, a turn in flight on that view, a link that failed or is still loading after
// OPEN_CHATS_LOAD_TIMEOUT_MS); `null` = the open conversation was cleared: every pane is 'kept'
// and nothing is navigated (§2). The three panes are opened in parallel. `panes:signOut(slot)`
// (clearStorageData on that partition only, then newChatUrl), `panes:snapshot(slot)` (adapter
// `snapshot` → scrubbed HTML under `<userData>/snapshots/<slot>-<ts>.html` → {path}).
// `prompt:send` is gone (§2: removed in Stage 2) — no handler, nothing answers on that channel.
// No electron import: `ipcMain`, the view manager, settings, chats, `fs` and the timers are injected.

import nodeFs from 'node:fs'
import path from 'node:path'
import { SLOTS, publicSites } from './sites.js'
import { normalizeLayout } from './layout.js'
import { isExternalUrl } from './policy.js'

export const MAX_PROMPT_CHARS = 32768
export const MAX_CONV_ID_CHARS = 200
export const SNAPSHOT_TIMEOUT_MS = 15000
/** panes:openChats waits at most this long for one pane's recorded chat to load (then 'kept'; the load goes on). */
export const OPEN_CHATS_LOAD_TIMEOUT_MS = 15000
export const ZOOM_DIRECTIONS = Object.freeze(['in', 'out', 'reset'])
export const MODES = Object.freeze(['tabs', 'split'])
export const OPEN_CHATS_RESULTS = Object.freeze(['navigated', 'new', 'kept'])

export function badRequest() {
  return new Error('bad_request')
}

export function requireSlot(slot) {
  if (typeof slot !== 'string' || !SLOTS.includes(slot)) throw badRequest()
  return slot
}

/** targets ⊆ SLOTS; de-duplicated and returned in SLOTS order (an empty list is allowed). */
export function requireTargets(targets) {
  if (!Array.isArray(targets)) throw badRequest()
  const seen = new Set()
  for (const t of targets) seen.add(requireSlot(t))
  return SLOTS.filter((s) => seen.has(s))
}

export function requireText(text) {
  if (typeof text !== 'string' || text.length > MAX_PROMPT_CHARS) throw badRequest()
  return text
}

export function requireDirection(direction) {
  if (typeof direction !== 'string' || !ZOOM_DIRECTIONS.includes(direction)) throw badRequest()
  return direction
}

export function requireBoolean(v) {
  if (typeof v !== 'boolean') throw badRequest()
  return v
}

/** A conversation id for `panes:openChats`: null, or a non-empty string ≤ 200 chars. */
export function requireConvId(v) {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v === '' || v.length > MAX_CONV_ID_CHARS) throw badRequest()
  return v
}

/** `{mode, active}` for 'panes:active' (both required). */
export function requireActive(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw badRequest()
  if (typeof state.mode !== 'string' || !MODES.includes(state.mode)) throw badRequest()
  return { mode: state.mode, active: requireSlot(state.active) }
}

/** Stamp the selectors loader's error into a health object's `matched.error` when the adapter reported none. */
export function annotateHealth(health, selectorsError) {
  if (!selectorsError) return health
  const matched = health.matched && typeof health.matched === 'object' ? health.matched : {}
  if (matched.error) return health
  return { ...health, matched: { ...matched, error: String(selectorsError) } }
}

/** The `panes:bridge` payload for a bridge state: `{connected:true, since}` | `{connected:false, error?}`. */
export function publicBridgeState(b) {
  if (b.connected && b.since != null) return { connected: true, since: b.since }
  const out = { connected: b.connected }
  if (!b.connected && typeof b.error === 'string' && b.error !== '') out.error = b.error
  return out
}

/** The file name a DOM snapshot is written under: `<slot>-<ts>.html` (ts = integer ms). */
export function snapshotFileName(slot, ts) {
  return `${requireSlot(slot)}-${Math.round(Number(ts) || 0)}.html`
}

/**
 * saveDomSnapshot({views, snapshotsDir, fs, now}, slot) → {path}: the adapter's `snapshot` op
 * (scrubbed HTML) written under `<snapshotsDir>/<slot>-<ts>.html`. Shared by `panes:snapshot`
 * and the Site menu.
 */
export async function saveDomSnapshot({ views, snapshotsDir, fs = nodeFs, now = Date.now }, slot) {
  requireSlot(slot)
  const client = views && typeof views.adapterFor === 'function' ? views.adapterFor(slot) : null
  if (!client) throw new Error('view_crashed')
  if (!snapshotsDir) throw new Error('snapshots_unavailable')
  const res = await client.request('snapshot', {}, { timeoutMs: SNAPSHOT_TIMEOUT_MS })
  if (!res || typeof res.html !== 'string') throw new Error('site_error')
  fs.mkdirSync(snapshotsDir, { recursive: true })
  const file = path.join(snapshotsDir, snapshotFileName(slot, now()))
  fs.writeFileSync(file, res.html, 'utf8')
  return { path: file }
}

/**
 * registerIpc(deps) → {state, dispose}
 *   ipcMain             {handle, on, removeHandler, removeListener}
 *   isRenderer(event)   true only for the renderer window's main frame
 *   views               the view manager (views.js)
 *   layoutState         mutable {mode, active} shared with shortcuts (updated from 'panes:active')
 *   orchestrator        {inflight(slot)} (Stage 2: `run` is driven by the bridge client, not IPC)
 *   selectors           {current, reload, lastError}
 *   settings            {getCapture, setCapture}
 *   chats               {get(convId, slot)}
 *   sites               the resolved site table
 *   version, dev        for 'panes:getInfo' / 'adapter:config'
 *   getBackend()        {port, url} | null for 'panes:getInfo'
 *   getBridgeState()    {connected, since?, error?} replayed as 'panes:bridge'
 *   snapshotsDir        <userData>/snapshots
 *   onHealth(slot, h)   called after an adapter health report is cached (main → bridge `health` frame)
 *   openExternal(url)   shell.openExternal
 *   sendToRenderer(channel, ...args)
 *   fs, now, log, setTimeout, clearTimeout
 */
export function registerIpc({
  ipcMain,
  isRenderer,
  views,
  layoutState,
  orchestrator = null,
  selectors,
  settings = null,
  chats = null,
  sites,
  version,
  dev = false,
  getBackend = null,
  getBridgeState = null,
  snapshotsDir = null,
  onHealth = null,
  openExternal,
  sendToRenderer,
  fs = nodeFs,
  now = Date.now,
  log = console,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') throw new Error('registerIpc: ipcMain is required')
  if (typeof isRenderer !== 'function') throw new Error('registerIpc: isRenderer is required')
  if (!views) throw new Error('registerIpc: views is required')
  const state = layoutState || { mode: null, active: null }
  const handled = []
  const listened = []

  const handle = (channel, fn) => {
    ipcMain.handle(channel, fn)
    handled.push(channel)
  }
  const on = (channel, fn) => {
    ipcMain.on(channel, fn)
    listened.push([channel, fn])
  }
  const requireRenderer = (event) => {
    if (!isRenderer(event)) throw badRequest()
  }
  const warn = (m) => log && typeof log.warn === 'function' && log.warn(`[ipc] ${m}`)
  const emit = (channel, ...args) => {
    try {
      if (typeof sendToRenderer === 'function') sendToRenderer(channel, ...args)
    } catch (e) {
      warn(`send ${channel} failed: ${(e && e.message) || e}`)
    }
  }

  /** Cached health + zoom of every view and the bridge state, re-sent to the renderer. */
  const replayState = () => {
    if (typeof views.slots === 'function') {
      for (const slot of views.slots()) {
        if (typeof views.getHealth === 'function') {
          const h = views.getHealth(slot)
          if (h) emit('panes:health', slot, h)
        }
        if (typeof views.zoomFactor === 'function') {
          const factor = views.zoomFactor(slot)
          if (typeof factor === 'number') emit('panes:zoom', { slot, factor })
        }
      }
    }
    if (typeof getBridgeState === 'function') {
      const b = getBridgeState()
      if (b && typeof b.connected === 'boolean') emit('panes:bridge', publicBridgeState(b))
    }
  }

  const inflight = (slot) => !!(orchestrator && typeof orchestrator.inflight === 'function' && orchestrator.inflight(slot))

  /** `{timedOut:true}` after `ms`, else `{timedOut:false, value}`; a rejection propagates only before the timeout. */
  const bounded = (promise, ms) =>
    new Promise((resolve, reject) => {
      let timer = setT(() => {
        timer = null
        resolve({ timedOut: true })
      }, ms)
      Promise.resolve(promise).then(
        (value) => {
          if (timer === null) return
          clearT(timer)
          resolve({ timedOut: false, value })
        },
        (e) => {
          if (timer === null) return
          clearT(timer)
          reject(e)
        },
      )
    })

  /** One pane for `panes:openChats`: 'navigated' | 'new' | 'kept'. Never rejects. */
  async function openChat(slot, convId) {
    if (convId === null) return 'kept' // the open conversation was cleared: nothing to open, the pane stays (§2)
    try {
      if (inflight(slot)) {
        warn(`openChats: ${slot} has a turn in flight; kept`)
        return 'kept'
      }
      const current = typeof views.currentUrl === 'function' ? views.currentUrl(slot) : ''
      const link = chats && typeof chats.get === 'function' ? chats.get(convId, slot) : null
      if (link) {
        if (current === link) return 'kept'
        if (typeof views.loadUrl !== 'function') return 'kept'
        try {
          const r = await bounded(views.loadUrl(slot, link), OPEN_CHATS_LOAD_TIMEOUT_MS)
          if (r.timedOut) {
            warn(`openChats: ${slot} is still loading the recorded chat after ${OPEN_CHATS_LOAD_TIMEOUT_MS} ms; kept`)
            return 'kept'
          }
          emit('panes:turn', { slot, phase: 'idle' })
          return 'navigated'
        } catch (e) {
          warn(`openChats: ${slot} could not open the recorded chat: ${(e && e.message) || e}`)
          return 'kept'
        }
      }
      return openFresh(slot, current)
    } catch (e) {
      warn(`openChats: ${slot} failed: ${(e && e.message) || e}; kept`)
      return 'kept'
    }
  }

  /** No recorded link: a fresh chat unless the pane is already on newChatUrl. */
  function openFresh(slot, current) {
    const fresh = sites && sites[slot] ? sites[slot].newChatUrl : null
    if (fresh && current === fresh) return 'kept'
    views.newChat(slot)
    emit('panes:turn', { slot, phase: 'idle' })
    return 'new'
  }

  // --- renderer → main -------------------------------------------------------------------------
  handle('panes:getInfo', (event) => {
    requireRenderer(event)
    const layout = state.mode && state.active ? { mode: state.mode, active: state.active } : null
    replayState()
    let backend = null
    if (typeof getBackend === 'function') {
      const b = getBackend()
      if (b && typeof b.url === 'string' && Number.isInteger(b.port)) backend = { port: b.port, url: b.url }
    }
    return { version: String(version || ''), dev: !!dev, sites: publicSites(sites), backend, layout }
  })

  on('panes:layout', (event, layout) => {
    if (!isRenderer(event)) return
    views.applyLayout(normalizeLayout(layout))
  })

  on('panes:active', (event, next) => {
    if (!isRenderer(event)) return
    let parsed
    try {
      parsed = requireActive(next)
    } catch (_e) {
      return
    }
    state.mode = parsed.mode
    state.active = parsed.active
  })

  handle('panes:newChat', async (event, targets) => {
    requireRenderer(event)
    for (const slot of requireTargets(targets)) views.newChat(slot)
  })

  handle('panes:reload', async (event, slot) => {
    requireRenderer(event)
    requireSlot(slot)
    if (selectors && typeof selectors.reload === 'function') selectors.reload() // §4: re-read the override on pane Reload
    views.reload(slot)
  })

  handle('panes:openExternal', async (event, slot) => {
    requireRenderer(event)
    requireSlot(slot)
    const url = views.currentUrl(slot)
    if (isExternalUrl(url) && typeof openExternal === 'function') await openExternal(url)
  })

  handle('panes:inspect', async (event, slot) => {
    requireRenderer(event)
    requireSlot(slot)
    if (dev) views.inspect(slot)
  })

  handle('panes:focus', async (event, slot) => {
    requireRenderer(event)
    requireSlot(slot)
    views.focus(slot)
  })

  handle('panes:zoom', async (event, slot, direction) => {
    requireRenderer(event)
    requireSlot(slot)
    requireDirection(direction)
    const factor = views.zoom(slot, direction)
    emit('panes:zoom', { slot, factor })
    return { factor }
  })

  // --- Stage 2 ---------------------------------------------------------------------------------
  handle('panes:getCapture', (event) => {
    requireRenderer(event)
    if (!settings || typeof settings.getCapture !== 'function') throw new Error('capture_unavailable')
    return settings.getCapture()
  })

  handle('panes:setCapture', async (event, slot, on) => {
    requireRenderer(event)
    requireSlot(slot)
    requireBoolean(on)
    if (!settings || typeof settings.setCapture !== 'function') throw new Error('capture_unavailable')
    settings.setCapture(slot, on)
  })

  handle('panes:openChats', async (event, convId) => {
    requireRenderer(event)
    const id = requireConvId(convId)
    const results = await Promise.all(SLOTS.map((slot) => openChat(slot, id))) // the three loads run in parallel
    const out = {}
    SLOTS.forEach((slot, i) => {
      out[slot] = results[i]
    })
    return out
  })

  handle('panes:signOut', async (event, slot) => {
    requireRenderer(event)
    requireSlot(slot)
    if (typeof views.signOut !== 'function') throw new Error('sign_out_unavailable')
    await views.signOut(slot)
  })

  handle('panes:snapshot', async (event, slot) => {
    requireRenderer(event)
    requireSlot(slot)
    return saveDomSnapshot({ views, snapshotsDir, fs, now }, slot)
  })

  // --- site preload → main ---------------------------------------------------------------------
  handle('adapter:config', (event) => {
    const site = views.slotOfSender(event)
    const config = selectors && typeof selectors.current === 'function' ? selectors.current() : null
    return { site, selectors: config, dev: !!dev }
  })

  on('triplex:adapter:health', (event, health) => {
    const slot = views.slotOfSender(event)
    if (slot === null || health === null || typeof health !== 'object' || Array.isArray(health)) return
    const annotated = annotateHealth(health, selectors && typeof selectors.lastError === 'function' ? selectors.lastError() : null)
    views.setHealth(slot, annotated)
    emit('panes:health', slot, annotated)
    if (typeof onHealth === 'function') {
      try {
        onHealth(slot, annotated) // Stage 2: main forwards it to the bridge as a `health` frame
      } catch (e) {
        warn(`onHealth failed: ${(e && e.message) || e}`)
      }
    }
  })

  return {
    state,
    replayState,
    dispose() {
      for (const channel of handled) if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel)
      for (const [channel, fn] of listened) if (typeof ipcMain.removeListener === 'function') ipcMain.removeListener(channel, fn)
    },
  }
}
