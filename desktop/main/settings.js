// desktop/main/settings.js — <userData>/settings.json (contract §5), atomic JSON.
//
//   {"version":1,
//    "window":{"x","y","width","height","maximized"},
//    "zoom":{"claude":1,"chatgpt":1,"grok":1},
//    "capture":{"claude":false,"chatgpt":false,"grok":false},
//    "analyst":"chatgpt","analystVisible":false}
//
// Main owns these keys (window bounds / zoom / capture / analyst; the renderer mirrors layout,
// active tab and targets in localStorage). Writes are tmp-in-same-dir + rename. Window bounds are
// debounced (`queueWindowBounds`) and clamped at launch to the work area of the display that
// matches them (`screen.getDisplayMatching`, injected). No electron import: `fs`, `screen` and the
// timers are arguments so node --test drives everything with a temp dir and fakes.

import nodeFs from 'node:fs'
import path from 'node:path'
import { SLOTS } from './sites.js'

export const SETTINGS_VERSION = 1
export const SETTINGS_FILE = 'settings.json'
export const DEFAULT_WINDOW = Object.freeze({ width: 1600, height: 900 })
export const MIN_WINDOW = Object.freeze({ width: 640, height: 480 })
export const ZOOM = Object.freeze({ min: 0.5, max: 2.0, step: 0.1 })
export const BOUNDS_DEBOUNCE_MS = 500
export const ANALYST_CHOICES = Object.freeze([...SLOTS, null])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)

function perSlot(value) {
  const o = {}
  for (const s of SLOTS) o[s] = value
  return o
}

/** A fresh defaults object (never shared). */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    window: { x: null, y: null, width: DEFAULT_WINDOW.width, height: DEFAULT_WINDOW.height, maximized: false },
    zoom: perSlot(1),
    capture: perSlot(false),
    analyst: 'chatgpt',
    analystVisible: false,
  }
}

/** Zoom factor rounded to one decimal and clamped to [0.5, 2.0]; non-numbers → 1. */
export function clampZoom(factor) {
  if (!isFiniteNumber(factor)) return 1
  const r = Math.round(factor * 10) / 10
  return Math.min(ZOOM.max, Math.max(ZOOM.min, r))
}

/** Next zoom factor for 'in' | 'out' | 'reset' from `current`. */
export function stepZoom(current, direction) {
  const c = clampZoom(current)
  if (direction === 'in') return clampZoom(c + ZOOM.step)
  if (direction === 'out') return clampZoom(c - ZOOM.step)
  return 1
}

const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * Clamp window bounds to a work area: width/height between MIN_WINDOW and the work area, x/y so
 * the window stays inside it. Null x/y stay null (Electron centres the window). Returns a new
 * object `{x, y, width, height}`.
 */
export function clampBounds(bounds, workArea) {
  const b = isPlainObject(bounds) ? bounds : {}
  const wa = isPlainObject(workArea) ? workArea : null
  let width = isFiniteNumber(b.width) ? Math.round(b.width) : DEFAULT_WINDOW.width
  let height = isFiniteNumber(b.height) ? Math.round(b.height) : DEFAULT_WINDOW.height
  width = Math.max(MIN_WINDOW.width, width)
  height = Math.max(MIN_WINDOW.height, height)
  let x = isFiniteNumber(b.x) ? Math.round(b.x) : null
  let y = isFiniteNumber(b.y) ? Math.round(b.y) : null
  if (wa && isFiniteNumber(wa.width) && isFiniteNumber(wa.height)) {
    width = Math.min(width, Math.max(MIN_WINDOW.width, Math.round(wa.width)))
    height = Math.min(height, Math.max(MIN_WINDOW.height, Math.round(wa.height)))
    const wx = isFiniteNumber(wa.x) ? Math.round(wa.x) : 0
    const wy = isFiniteNumber(wa.y) ? Math.round(wa.y) : 0
    if (x !== null) x = clampNum(x, wx, Math.max(wx, wx + Math.round(wa.width) - width))
    if (y !== null) y = clampNum(y, wy, Math.max(wy, wy + Math.round(wa.height) - height))
  }
  return { x, y, width, height }
}

/** Merge an unknown document onto the defaults, keeping only well-typed values. */
export function sanitizeSettings(raw) {
  const out = defaultSettings()
  if (!isPlainObject(raw)) return out
  if (isPlainObject(raw.window)) {
    const w = raw.window
    out.window.x = isFiniteNumber(w.x) ? Math.round(w.x) : null
    out.window.y = isFiniteNumber(w.y) ? Math.round(w.y) : null
    if (isFiniteNumber(w.width)) out.window.width = Math.max(MIN_WINDOW.width, Math.round(w.width))
    if (isFiniteNumber(w.height)) out.window.height = Math.max(MIN_WINDOW.height, Math.round(w.height))
    out.window.maximized = w.maximized === true
  }
  if (isPlainObject(raw.zoom)) {
    for (const s of SLOTS) if (isFiniteNumber(raw.zoom[s])) out.zoom[s] = clampZoom(raw.zoom[s])
  }
  if (isPlainObject(raw.capture)) {
    for (const s of SLOTS) if (typeof raw.capture[s] === 'boolean') out.capture[s] = raw.capture[s]
  }
  if (raw.analyst === null || SLOTS.includes(raw.analyst)) out.analyst = raw.analyst
  if (typeof raw.analystVisible === 'boolean') out.analystVisible = raw.analystVisible
  return out
}

/**
 * createSettings({dir, fs, screen, setTimeout, clearTimeout, debounceMs, log}) → settings
 *   load()                         read <dir>/settings.json (missing / corrupt → defaults + warning)
 *   get()                          a deep copy of the current document
 *   file                           the absolute path
 *   save()                         atomic write now
 *   getZoom(slot) / setZoom(slot, factor)        clamped; setZoom saves immediately; returns the factor
 *   getCapture() / setCapture(slot, on)          Stage 2 callers; saves immediately
 *   getAnalyst() / setAnalyst(slot|null) / setAnalystVisible(bool)   Stage 3 callers; save immediately
 *   windowBoundsForLaunch()        {x?, y?, width, height, maximized} clamped to screen.getDisplayMatching(...).workArea
 *   queueWindowBounds(bounds, maximized)   debounced save of the (normal) window bounds
 *   flushWindowBounds()            write a pending bounds update now (window close / before-quit)
 */
export function createSettings({
  dir,
  fs = nodeFs,
  screen = null,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  debounceMs = BOUNDS_DEBOUNCE_MS,
  log = console,
} = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createSettings: dir is required')
  const file = path.join(dir, SETTINGS_FILE)
  let doc = defaultSettings()
  let pendingBounds = null
  let timer = null

  const warn = (m) => {
    if (log && typeof log.warn === 'function') log.warn(`[settings] ${m}`)
  }

  function load() {
    let text = null
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (!e || e.code !== 'ENOENT') warn(`${file} unreadable (${(e && e.message) || e}); using defaults`)
      doc = defaultSettings()
      return get()
    }
    try {
      const parsed = JSON.parse(String(text))
      if (isPlainObject(parsed) && parsed.version !== undefined && parsed.version !== SETTINGS_VERSION) {
        warn(`${file} has version ${JSON.stringify(parsed.version)}; expected ${SETTINGS_VERSION} (keeping what fits)`)
      }
      doc = sanitizeSettings(parsed)
    } catch (e) {
      warn(`${file} is not valid JSON (${(e && e.message) || e}); using defaults`)
      doc = defaultSettings()
    }
    return get()
  }

  function get() {
    return JSON.parse(JSON.stringify(doc))
  }

  function save() {
    const tmp = path.join(dir, `.${SETTINGS_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch (e) {
      warn(`could not write ${file}: ${(e && e.message) || e}`)
      try {
        fs.unlinkSync(tmp)
      } catch (_e) {
        /* nothing to clean */
      }
      return false
    }
  }

  function requireSlot(slot) {
    if (!SLOTS.includes(slot)) throw new Error(`settings: unknown slot ${String(slot)}`)
    return slot
  }

  function getZoom(slot) {
    return doc.zoom[requireSlot(slot)]
  }

  function setZoom(slot, factor) {
    const f = clampZoom(factor)
    doc.zoom[requireSlot(slot)] = f
    save()
    return f
  }

  function getCapture() {
    return { ...doc.capture }
  }

  function setCapture(slot, on) {
    doc.capture[requireSlot(slot)] = !!on
    save()
    return doc.capture[slot]
  }

  function getAnalyst() {
    return doc.analyst
  }

  function setAnalyst(slot) {
    if (slot !== null && !SLOTS.includes(slot)) throw new Error(`settings: unknown analyst ${String(slot)}`)
    doc.analyst = slot
    save()
    return doc.analyst
  }

  function setAnalystVisible(visible) {
    doc.analystVisible = !!visible
    save()
    return doc.analystVisible
  }

  function workAreaFor(bounds) {
    if (!screen || typeof screen.getDisplayMatching !== 'function') return null
    try {
      const probe = {
        x: isFiniteNumber(bounds.x) ? bounds.x : 0,
        y: isFiniteNumber(bounds.y) ? bounds.y : 0,
        width: bounds.width,
        height: bounds.height,
      }
      const display = screen.getDisplayMatching(probe)
      return display && isPlainObject(display.workArea) ? display.workArea : null
    } catch (_e) {
      return null
    }
  }

  function windowBoundsForLaunch() {
    const w = doc.window
    const clamped = clampBounds(w, workAreaFor(w))
    const out = { width: clamped.width, height: clamped.height, maximized: w.maximized === true }
    if (clamped.x !== null && clamped.y !== null) {
      out.x = clamped.x
      out.y = clamped.y
    }
    return out
  }

  function applyPendingBounds() {
    if (!pendingBounds) return false
    const { bounds, maximized } = pendingBounds
    pendingBounds = null
    const next = clampBounds(bounds, null)
    if (next.x !== null) doc.window.x = next.x
    if (next.y !== null) doc.window.y = next.y
    doc.window.width = next.width
    doc.window.height = next.height
    doc.window.maximized = maximized === true
    return save()
  }

  function queueWindowBounds(bounds, maximized = false) {
    if (!isPlainObject(bounds)) return
    pendingBounds = { bounds: { ...bounds }, maximized: !!maximized }
    if (timer !== null) clearT(timer)
    timer = setT(() => {
      timer = null
      applyPendingBounds()
    }, debounceMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function flushWindowBounds() {
    if (timer !== null) {
      clearT(timer)
      timer = null
    }
    return applyPendingBounds()
  }

  return {
    file,
    load,
    get,
    save,
    getZoom,
    setZoom,
    getCapture,
    setCapture,
    getAnalyst,
    setAnalyst,
    setAnalystVisible,
    windowBoundsForLaunch,
    queueWindowBounds,
    flushWindowBounds,
    hasPendingBounds: () => pendingBounds !== null,
  }
}
