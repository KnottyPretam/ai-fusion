// desktop/main/selectors.js — selector config loader (contract §4).
//
//   defaults  = DEFAULT_SELECTORS from preload/site.cjs (the adapter's own table)
//   override  = <userData>/selectors.json or TRIPLEX_SELECTORS_FILE, merged per site / per key
//               through site.cjs's mergeSelectors (override REPLACES; unknown keys warn)
//   bad JSON  = the last good config is kept and `lastError()` names the problem (main stamps it
//               into health.matched.error); a missing file is not an error.
//
// Read at start and on pane Reload (`reload()`); Stage 2 adds fs.watch. No electron import; the
// file system is injected so node --test can drive it with a fake `readFile`.

import { readFileSync } from 'node:fs'
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

  return {
    filePath,
    load,
    reload: load,
    current: () => current,
    lastError: () => lastError,
    warnings: () => lastWarnings.slice(),
  }
}

/** Timeouts the orchestrator budgets per site, taken from the merged config (defaults when missing). */
export function timeoutsFor(config, slot) {
  const block = (config && config[slot]) || DEFAULT_SELECTORS[slot] || {}
  const num = (k, d) => (typeof block[k] === 'number' && Number.isFinite(block[k]) && block[k] >= 0 ? block[k] : d)
  const composerWaitMs = num('composerWaitMs', 15000)
  const sendWaitMs = num('sendWaitMs', 18000)
  const submitVerifyMs = num('submitVerifyMs', 5000)
  return { composerWaitMs, sendWaitMs, submitVerifyMs }
}
