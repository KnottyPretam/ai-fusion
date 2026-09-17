// desktop/main/selectors.js — selector config loader (contract §4).
//
//   defaults  = DEFAULT_SELECTORS from preload/site.cjs (the adapter's own table)
//   override  = <userData>/selectors.json or TRIPLEX_SELECTORS_FILE, merged per site / per key
//               through site.cjs's mergeSelectors (override REPLACES; unknown keys warn)
//   bad JSON  = the last good config is kept and `lastError()` names the problem (main stamps it
//               into health.matched.error); a missing file is not an error.
//
// Read at start, on pane Reload (`reload()`) and, from Stage 2, on `fs.watch` (`watch()`: the
// override's directory is watched — editors save by rename, which would orphan a watch on the file
// itself — debounced WATCH_DEBOUNCE_MS, then `load()`; `onChange` fires when the effective config
// or the error state changed, so main pushes `{op:'config'}` to every view and the adapters
// re-publish health; an invalid file keeps the last good config and surfaces `lastError()`).
// No electron import; the file system is injected so node --test can drive it with fakes.

import { readFileSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// site.cjs boots only inside a page; requiring it here yields its pure exports.
const siteAdapter = require('../preload/site.cjs')

export const DEFAULT_SELECTORS = siteAdapter.DEFAULT_SELECTORS
export const mergeSelectors = siteAdapter.mergeSelectors
/**
 * The adapter's per-attempt settle delay inside `insertText` (site.cjs exports it; 120 ms when a
 * build does not). The orchestrator budgets two of them per insertAndSubmit.
 */
export const INSERT_SETTLE_MS = Number.isFinite(siteAdapter.INSERT_SETTLE_MS) && siteAdapter.INSERT_SETTLE_MS >= 0 ? siteAdapter.INSERT_SETTLE_MS : 120
export const WATCH_DEBOUNCE_MS = 250

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

/**
 * Pure step: merge one override object (or a raw JSON string) onto `defaults`.
 * Returns `{merged, warnings, error}`: `error` is null unless the input could not be parsed, in
 * which case `merged` is null (the caller keeps its last good config).
 */
export function mergeOverride(defaults, override) {
  let parsed = override
  if (typeof override === 'string') {
    try {
      parsed = JSON.parse(override)
    } catch (e) {
      return { merged: null, warnings: [], error: `selectors override is not valid JSON: ${e.message}` }
    }
  }
  const { merged, warnings } = mergeSelectors(defaults, parsed)
  return { merged, warnings: warnings.slice(), error: null }
}

/**
 * createSelectorsLoader({filePath, defaults, readFile, log}) → loader
 *   loader.load()      read + merge; returns {config, warnings, error}; keeps the last good config
 *   loader.reload()    alias of load()
 *   loader.current()   the effective full config object ({version, chatgpt, claude, grok})
 *   loader.lastError() string | null (bad JSON / unreadable file), cleared by the next good load
 *   loader.warnings()  the warnings of the last successful merge
 *   loader.filePath    the override path (or null when no override is configured)
 */
export function createSelectorsLoader({ filePath = null, defaults = DEFAULT_SELECTORS, readFile = readFileSync, log = console } = {}) {
  let current = deepClone(defaults)
  let lastError = null
  let lastWarnings = []

  function readOverride() {
    if (!filePath) return { text: null, error: null }
    try {
      return { text: String(readFile(filePath, 'utf8')), error: null }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { text: null, error: null }
      return { text: null, error: `selectors override ${filePath} is unreadable: ${(e && e.message) || e}` }
    }
  }

  function load() {
    const { text, error: readError } = readOverride()
    if (readError) {
      lastError = readError
      if (log && typeof log.warn === 'function') log.warn(`[selectors] ${readError} (keeping the last good config)`)
      return { config: current, warnings: lastWarnings, error: lastError }
    }
    if (text === null) {
      current = deepClone(defaults)
      lastError = null
      lastWarnings = []
      return { config: current, warnings: lastWarnings, error: null }
    }
    const { merged, warnings, error } = mergeOverride(defaults, text)
    if (error) {
      lastError = `${filePath}: ${error}`
      if (log && typeof log.warn === 'function') log.warn(`[selectors] ${lastError} (keeping the last good config)`)
      return { config: current, warnings: lastWarnings, error: lastError }
    }
    current = merged
    lastError = null
    lastWarnings = warnings
    if (warnings.length && log && typeof log.warn === 'function') {
      for (const w of warnings) log.warn(`[selectors] ${filePath}: ${w}`)
    }
    return { config: current, warnings: lastWarnings, error: null }
  }

  /**
   * watch({watch, setTimeout, clearTimeout, debounceMs, onChange}) → stop()
   * Watches the override's directory (filtered to its basename), debounces, reloads and calls
   * `onChange({config, error, warnings, changed})`. No override path → no watch. A watcher that
   * cannot be created (missing directory, EMFILE) is logged and ignored: Reload still re-reads.
   */
  function watch({ watch: doWatch = fsWatch, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout, debounceMs = WATCH_DEBOUNCE_MS, onChange } = {}) {
    if (!filePath) return () => {}
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    let timer = null
    let watcher = null
    let stopped = false

    const fire = () => {
      timer = null
      if (stopped) return
      const before = JSON.stringify(current)
      const beforeError = lastError
      load()
      const changed = JSON.stringify(current) !== before || lastError !== beforeError
      if (typeof onChange === 'function') {
        try {
          onChange({ config: current, error: lastError, warnings: lastWarnings.slice(), changed })
        } catch (e) {
          if (log && typeof log.warn === 'function') log.warn(`[selectors] onChange failed: ${(e && e.message) || e}`)
        }
      }
    }
    const schedule = () => {
      if (stopped) return
      if (timer !== null) clearT(timer)
      timer = setT(fire, debounceMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
    try {
      watcher = doWatch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename === null || filename === undefined || String(filename) === base) schedule()
      })
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (e) => {
          if (log && typeof log.warn === 'function') log.warn(`[selectors] watch on ${dir} failed: ${(e && e.message) || e}`)
        })
      }
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[selectors] cannot watch ${dir}: ${(e && e.message) || e} (Reload still re-reads the override)`)
      return () => {}
    }
    return () => {
      stopped = true
      if (timer !== null) clearT(timer)
      timer = null
      try {
        if (watcher && typeof watcher.close === 'function') watcher.close()
      } catch (_e) {
        /* already closed */
      }
    }
  }

  return {
    filePath,
    load,
    reload: load,
    current: () => current,
    lastError: () => lastError,
    warnings: () => lastWarnings.slice(),
    watch,
  }
}

function blockFor(config, slot) {
  return (config && config[slot]) || DEFAULT_SELECTORS[slot] || {}
}

function numIn(block, k, d) {
  return typeof block[k] === 'number' && Number.isFinite(block[k]) && block[k] >= 0 ? block[k] : d
}

/** Timeouts the orchestrator budgets per site, taken from the merged config (defaults when missing). */
export function timeoutsFor(config, slot) {
  const block = blockFor(config, slot)
  const composerWaitMs = numIn(block, 'composerWaitMs', 15000)
  const sendWaitMs = numIn(block, 'sendWaitMs', 18000)
  const submitVerifyMs = numIn(block, 'submitVerifyMs', 5000)
  return { composerWaitMs, sendWaitMs, submitVerifyMs }
}

/** Selectors v2 capture budgets per site (contract §4 defaults when the config predates v2). */
export function captureTimeoutsFor(config, slot) {
  const block = blockFor(config, slot)
  return {
    quietMs: numIn(block, 'quietMs', 2500),
    firstTokenMs: numIn(block, 'firstTokenMs', 90000),
    captureTimeoutMs: numIn(block, 'captureTimeoutMs', 300000),
  }
}

/** The site's `chatUrlPattern` source string (the default when the config has none). */
export function chatUrlPatternFor(config, slot) {
  const block = blockFor(config, slot)
  if (typeof block.chatUrlPattern === 'string' && block.chatUrlPattern !== '') return block.chatUrlPattern
  const d = DEFAULT_SELECTORS[slot]
  return d && typeof d.chatUrlPattern === 'string' ? d.chatUrlPattern : ''
}
