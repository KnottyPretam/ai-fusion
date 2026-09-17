// desktop/main/ipc.js — every `panes:*` channel, `prompt:send` and the site-preload channels
// (contract §2). Validation first, always: `slot ∈ SLOTS`, `text` string ≤ 32768 chars,
// `targets ⊆ SLOTS`, `direction ∈ in|out|reset`, and the sender must be the renderer's main
// frame; a violation rejects `Error('bad_request')` (fire-and-forget channels drop it silently).
// `adapter:config` is resolved by the sender's webContents id: a site view gets its slot and the
// FULL merged selectors object, anything else (SSO popup, unknown page) gets `site: null` and
// stays inert. `panes:getInfo` also replays the cached health and the zoom factor of every view
// (`panes:health` / `panes:zoom`): the renderer calls it once its listeners exist, so nothing sent
// while the page was still loading stays lost. No electron import: `ipcMain`, the view manager and
// the renderer test are injected.

import { SLOTS, publicSites } from './sites.js'
import { normalizeLayout } from './layout.js'
import { isExternalUrl } from './policy.js'

export const MAX_PROMPT_CHARS = 32768
export const ZOOM_DIRECTIONS = Object.freeze(['in', 'out', 'reset'])
export const MODES = Object.freeze(['tabs', 'split'])

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

/** `{mode, active}` for 'panes:active' (both required). */
export function requireActive(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw badRequest()
  if (typeof state.mode !== 'string' || !MODES.includes(state.mode)) throw badRequest()
  return { mode: state.mode, active: requireSlot(state.active) }
}

/** The `prompt:send` body: `{targets, text}` → `{targets (normalized), text}`. */
export function requirePrompt(req) {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) throw badRequest()
  return { targets: requireTargets(req.targets), text: requireText(req.text) }
}

/** Stamp the selectors loader's error into a health object's `matched.error` when the adapter reported none. */
export function annotateHealth(health, selectorsError) {
  if (!selectorsError) return health
  const matched = health.matched && typeof health.matched === 'object' ? health.matched : {}
  if (matched.error) return health
  return { ...health, matched: { ...matched, error: String(selectorsError) } }
}

/**
 * registerIpc(deps) → {dispose}
 *   ipcMain             {handle, on, removeHandler, removeListener}
 *   isRenderer(event)   true only for the renderer window's main frame
 *   views               the view manager (views.js)
 *   layoutState         mutable {mode, active} shared with shortcuts (updated from 'panes:active')
 *   orchestrator        {submitAll}
 *   selectors           {current, reload, lastError}
 *   sites               the resolved site table
 *   version, dev        for 'panes:getInfo' / 'adapter:config'
 *   openExternal(url)   shell.openExternal
 *   sendToRenderer(channel, ...args)
 */
export function registerIpc({ ipcMain, isRenderer, views, layoutState, orchestrator, selectors, sites, version, dev = false, openExternal, sendToRenderer, log = console } = {}) {
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
  const emit = (channel, ...args) => {
    try {
      if (typeof sendToRenderer === 'function') sendToRenderer(channel, ...args)
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[ipc] send ${channel} failed: ${(e && e.message) || e}`)
    }
  }

  /** Cached health + zoom of every view, re-sent to the renderer (a view manager without the getters is skipped). */
  const replayState = () => {
    if (typeof views.slots !== 'function') return
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

  // --- renderer → main -------------------------------------------------------------------------
  handle('panes:getInfo', (event) => {
    requireRenderer(event)
    const layout = state.mode && state.active ? { mode: state.mode, active: state.active } : null
    replayState()
    return { version: String(version || ''), dev: !!dev, sites: publicSites(sites), backend: null, layout }
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

  handle('prompt:send', async (event, req) => {
    requireRenderer(event)
    const { targets, text } = requirePrompt(req)
    if (!orchestrator || typeof orchestrator.submitAll !== 'function') throw new Error('prompt_unavailable')
    return orchestrator.submitAll({ targets, text })
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
  })

  return {
    state,
    dispose() {
      for (const channel of handled) if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel)
      for (const [channel, fn] of listened) if (typeof ipcMain.removeListener === 'function') ipcMain.removeListener(channel, fn)
    },
  }
}
