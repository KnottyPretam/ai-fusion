// desktop/main/openrouter-key.js — the user's OpenRouter key: encrypted at rest, pushed over HTTP,
// never in env, never in the renderer, never in a log line (plan "A council anyone can assemble",
// backbone 5; contract §5/§6).
//
//   at rest    `safeStorage.encryptString` → base64 in settings.json `openrouterKey`. When the OS
//              keyring is not there (`isEncryptionAvailable()` false — Linux without libsecret / kwallet,
//              or before `ready`) `set` REFUSES with `encryption_unavailable` and names the backend
//              `getSelectedStorageBackend()` reports; the key is never written as plaintext. The one
//              exception is the E2E app run, where main.js calls `safeStorage.setUsePlainTextEncryption
//              (true)` before this module exists (TRIPLEX_E2E_APP=1 only; Electron then reports the
//              `basic_text` backend as available).
//   in memory  the plaintext is cached in this closure after a `set` or the first successful decrypt,
//              so the status line and every push read it without touching the keyring again.
//   decrypt    a ciphertext that no longer decrypts (a keyring reset, another backend, a copied
//              profile) is cleared and reported `undecryptable` — never a crash, never a stale blob
//              that fails every launch. A keyring that is merely UNAVAILABLE right now (gnome-keyring
//              not unlocked yet, a late daemon) keeps the blob (nothing proved it undecryptable),
//              reports `encryption_unavailable` ONCE, and re-checks the keyring every KEY_RECHECK_MS;
//              the moment the blob decrypts, `pushed` is false (that key was never sent) and the
//              injected `onDecrypted()` fires so main.js can push it — a status that reads "pushed"
//              always means the key the user configured is the one the backend holds.
//   push       `sync({url, token, council, analystModel})`: PUT /api/session/openrouter_key {key} (or
//              DELETE when no key is configured; NOTHING when a key is configured but unreadable — a
//              DELETE there would say "no key" for a key the user did enter, and a "pushed" for a
//              push that never happened), then PUT /api/session/defaults {slot_config} — the default council
//              the backend's `POST /api/conversations {}` seats — both with `Authorization: Bearer
//              <BRIDGE_TOKEN>`, a 10 s abort each, to a LOOPBACK backend only (a remote backend, even
//              one TRIPLEX_ALLOW_REMOTE_BACKEND=1 let the bridge attach to, never gets the key). A 401 /
//              403 stops at once (the token is not the backend's); another non-2xx stops with the
//              status; a transport failure (ECONNREFUSED while the backend restarts, a timeout) retries
//              SYNC_RETRIES times SYNC_RETRY_MS apart. Calls coalesce: a `sync` during a run marks it to
//              run once more at the end with the LATEST state, and returns that run's promise.
//
// The key is a secret and the rule is mechanical: no log line, error message, thrown error or IPC
// reply is ever built from it. Everything reported is a fixed code, a length, the public format
// marker (`sk-or-v1-` — and ONLY that literal: a key in any other shape shows no prefix, because nine
// characters of it would be nine characters of the secret) or an HTTP status. The tests scan every
// line for the key. Pure module: `settings` (getOpenRouterKeyCiphertext / setOpenRouterKeyCiphertext),
// `safeStorage`, `fetch`, the timers, the logger and `onDecrypted` are injected; main.js is the only
// caller with the real ones.

import { LOOPBACK_HOSTS } from './sites.js'
import { councilSlots } from './council.js'

export const KEY_MIN_CHARS = 20
export const KEY_MAX_CHARS = 512
/** The public format marker of an OpenRouter key: the ONLY prefix a status ever shows. */
export const KEY_PUBLIC_PREFIX = 'sk-or-v1-'
/** Its length — what the status line shows of a key, and never more. */
export const KEY_PREFIX_CHARS = KEY_PUBLIC_PREFIX.length
/** While a stored key is unreadable (no keyring yet), how often the keyring is asked again. */
export const KEY_RECHECK_MS = 15000
export const SYNC_TIMEOUT_MS = 10000
export const SYNC_RETRY_MS = 2000
export const SYNC_RETRIES = 5
export const KEY_PATH = '/api/session/openrouter_key'
export const DEFAULTS_PATH = '/api/session/defaults'
/** Every code this module reports (status.error, a thrown Error's message, a sync result). Never the key. */
export const KEY_ERRORS = Object.freeze({
  encryptionUnavailable: 'encryption_unavailable',
  undecryptable: 'undecryptable',
  syncUnavailable: 'sync_unavailable',
  syncRefusedRemote: 'sync_refused_remote',
  syncUnauthorized: 'sync_unauthorized',
  syncRejected: 'sync_rejected',
  syncUnreachable: 'sync_unreachable',
  syncStopped: 'sync_stopped',
})

const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/

/** True for a plausible key: printable ASCII without whitespace, KEY_MIN_CHARS..KEY_MAX_CHARS. */
export function isKeyShape(key) {
  return typeof key === 'string' && key.length >= KEY_MIN_CHARS && key.length <= KEY_MAX_CHARS && PRINTABLE_ASCII_RE.test(key)
}

/** The backend base URL names a loopback host (the only place a key is ever pushed to). */
export function isLoopbackUrl(url) {
  try {
    const u = new URL(String(url))
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.includes(u.hostname.toLowerCase().replace(/\.$/, ''))
  } catch (_e) {
    return false
  }
}

/**
 * The `PUT /api/session/defaults` body: the council's slots plus the frozen backend defaults for the
 * rest (a `SlotConfig` needs every field — mirrors the renderer's desktopSlotConfig). `analystModel`
 * is what the spawn env would carry as ANALYST_MODEL ('' = none). Null when the council has no members.
 */
export function defaultsBody(council, analystModel = '') {
  const slots = councilSlots(council)
  if (slots.length === 0) return null
  const spec = {}
  for (const slot of slots) spec[slot] = { model: council.slots[slot].model, effort: council.slots[slot].effort }
  return { slot_config: { slots: spec, analyst_model: typeof analystModel === 'string' ? analystModel : '', max_iterations: 2, materiality_min: 'medium', grounded: false } }
}

/** A transport error's identity WITHOUT its message (a message could carry a URL or a body): code or name only. */
function codeOf(e) {
  if (!e) return 'error'
  if (typeof e.code === 'string' && e.code) return e.code
  if (e.cause && typeof e.cause.code === 'string' && e.cause.code) return e.cause.code
  if (typeof e.name === 'string' && e.name) return e.name
  return 'error'
}

/**
 * createOpenRouterKey({settings, safeStorage, fetch, setTimeout, clearTimeout, log, onDecrypted, recheckMs}) → keys
 *   set(key)        encrypt + persist + cache; throws Error('bad_request') on a bad shape and
 *                   Error('encryption_unavailable') (with `.backend`) when no keyring; returns status()
 *   clear()         forget the key (settings + cache); returns status()
 *   plaintext()     the key or null (lazy decrypt; an undecryptable blob is cleared; an unreadable one
 *                   is re-tried every `recheckMs` and `onDecrypted()` fires when it finally reads)
 *   status()        {configured, prefix, length, pushed, error?} — the ONLY shape the renderer sees;
 *                   `pushed` is true only for a push that sent what is configured (the key, or its absence)
 *   sync(args)      push key + defaults to a loopback backend (see the header); resolves {ok, error?}
 *   dispose()       drop pending retry / re-check timers (quit)
 */
export function createOpenRouterKey({ settings, safeStorage, fetch: fetchImpl = globalThis.fetch, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout, log = console, onDecrypted = null, recheckMs = KEY_RECHECK_MS } = {}) {
  if (!settings || typeof settings.getOpenRouterKeyCiphertext !== 'function' || typeof settings.setOpenRouterKeyCiphertext !== 'function') throw new Error('createOpenRouterKey: settings is required')
  let cached = null // the plaintext, after a set or a successful decrypt
  let pushed = false
  let lastError = null
  let unavailableWarned = false // the "stored but unreadable" line is said once per unreadable spell
  let recheck = null // the timer that asks the keyring again while a stored key is unreadable
  let stopped = false
  let inflight = null
  let again = false
  let lastArgs = null
  const pendingTimers = new Set()

  const say = (level, m) => {
    if (log && typeof log[level] === 'function') log[level](`[openrouter-key] ${m}`)
  }
  const warn = (m) => say('warn', m)
  const info = (m) => say('log', m)

  function backendName() {
    try {
      if (safeStorage && typeof safeStorage.getSelectedStorageBackend === 'function') return String(safeStorage.getSelectedStorageBackend())
    } catch (_e) {
      /* not every platform has the call */
    }
    return 'unknown'
  }

  function encryptionAvailable() {
    try {
      return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable())
    } catch (_e) {
      return false
    }
  }

  function set(key) {
    if (!isKeyShape(key)) throw new Error('bad_request')
    if (!encryptionAvailable()) {
      const backend = backendName()
      lastError = KEY_ERRORS.encryptionUnavailable
      warn(`refused: ${KEY_ERRORS.encryptionUnavailable} (safeStorage backend: ${backend}) — the key is never stored in plaintext; install a keyring (libsecret / kwallet) and try again`)
      const e = new Error(KEY_ERRORS.encryptionUnavailable)
      e.backend = backend
      throw e
    }
    const ciphertext = safeStorage.encryptString(key).toString('base64')
    settings.setOpenRouterKeyCiphertext(ciphertext)
    cached = key
    pushed = false
    lastError = null
    readable()
    info(`stored (${key.length} chars, encrypted with ${backendName()}); not yet pushed`)
    return status()
  }

  function clear() {
    cached = null
    settings.setOpenRouterKeyCiphertext(null)
    pushed = false
    lastError = null
    readable()
    info('cleared; the backend is told on the next sync')
    return status()
  }

  /** The unreadable spell (if any) is over: no more re-checks, the warning may be said again next time. */
  function readable() {
    unavailableWarned = false
    if (recheck !== null) {
      clearT(recheck)
      recheck = null
    }
  }

  /** Ask the keyring again in `recheckMs` — once armed per unreadable spell, never after dispose(). */
  function armRecheck() {
    if (recheck !== null || stopped || !(recheckMs > 0)) return
    recheck = setT(() => {
      recheck = null
      plaintext()
    }, recheckMs)
    if (recheck && typeof recheck.unref === 'function') recheck.unref() // a real timer never holds the process
  }

  function plaintext() {
    if (cached !== null) return cached
    const ciphertext = settings.getOpenRouterKeyCiphertext()
    if (ciphertext === null || ciphertext === undefined) return null
    if (!encryptionAvailable()) {
      // Nothing proved the blob bad — the keyring is just not there right now. Keep it, say so once,
      // and come back: a keyring unlocked after launch is the common shape of this on Linux.
      if (!unavailableWarned) warn(`a key is stored but ${KEY_ERRORS.encryptionUnavailable} (safeStorage backend: ${backendName()}); it stays encrypted until a keyring is available (re-checked every ${recheckMs} ms)`)
      unavailableWarned = true
      lastError = KEY_ERRORS.encryptionUnavailable
      armRecheck()
      return null
    }
    let key = null
    try {
      key = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    } catch (_e) {
      key = null
    }
    if (!isKeyShape(key)) {
      // Decrypted to garbage or not at all: the blob belongs to another keyring / profile. Clear it,
      // so the next launch does not fail the same way, and say so once.
      settings.setOpenRouterKeyCiphertext(null)
      lastError = KEY_ERRORS.undecryptable
      pushed = false
      readable()
      warn(`the stored ciphertext could not be decrypted (safeStorage backend: ${backendName()}); the key was cleared — enter it again in Settings`)
      return null
    }
    cached = key
    const wasUnreadable = unavailableWarned
    readable()
    if (lastError === KEY_ERRORS.encryptionUnavailable) lastError = null
    if (wasUnreadable) {
      // The key the backend holds (if any) is not this one — nothing could have sent it. Say so in
      // the status and let main push it now, not on the next reconnect.
      pushed = false
      info(`the stored key decrypted (${key.length} chars, ${backendName()}); not yet pushed`)
      if (typeof onDecrypted === 'function') {
        try {
          onDecrypted()
        } catch (e) {
          warn(`onDecrypted failed: ${codeOf(e)}`)
        }
      }
    }
    return cached
  }

  function status() {
    const key = plaintext()
    const stored = key !== null || settings.getOpenRouterKeyCiphertext() != null
    const out = { configured: stored, prefix: key !== null && key.startsWith(KEY_PUBLIC_PREFIX) ? KEY_PUBLIC_PREFIX : '', length: key !== null ? key.length : 0, pushed }
    if (lastError) out.error = lastError
    return out
  }

  function delay(ms) {
    return new Promise((resolve) => {
      const entry = { t: null, resolve }
      entry.t = setT(() => {
        pendingTimers.delete(entry)
        resolve()
      }, ms)
      pendingTimers.add(entry)
    })
  }

  /** One HTTP step with the retry policy. Resolves {kind: 'ok'|'unauthorized'|'rejected'|'unreachable'|'stopped', status?, cause?}; never rejects. */
  async function request(base, headers, step) {
    for (let attempt = 0; ; attempt++) {
      if (stopped) return { kind: 'stopped' }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = setT(() => controller && controller.abort(), SYNC_TIMEOUT_MS)
      let res
      try {
        res = await fetchImpl(base + step.path, {
          method: step.method,
          headers,
          ...(step.body !== undefined ? { body: JSON.stringify(step.body) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        })
      } catch (e) {
        clearT(timer)
        const cause = codeOf(e)
        if (attempt >= SYNC_RETRIES) return { kind: 'unreachable', cause }
        warn(`${step.method} ${step.path}: ${cause}; retry ${attempt + 1}/${SYNC_RETRIES} in ${SYNC_RETRY_MS} ms`)
        await delay(SYNC_RETRY_MS)
        continue
      }
      clearT(timer)
      const st = res && Number.isInteger(res.status) ? res.status : 0
      if (st === 401 || st === 403) return { kind: 'unauthorized', status: st }
      if (!res || res.ok === false || st < 200 || st >= 300) return { kind: 'rejected', status: st }
      return { kind: 'ok', status: st }
    }
  }

  function fail(code, m) {
    lastError = code
    pushed = false
    warn(m)
    return { ok: false, error: code }
  }

  async function runOnce(args) {
    const { url, token, council, analystModel = '' } = args || {}
    if (typeof url !== 'string' || url === '' || typeof token !== 'string' || token === '') return fail(KEY_ERRORS.syncUnavailable, 'no backend URL or bridge token to push to; nothing sent')
    if (!isLoopbackUrl(url)) return fail(KEY_ERRORS.syncRefusedRemote, 'refusing to push the key to a non-loopback backend; nothing sent')
    const key = plaintext()
    // A blob still on disk after plaintext() said null is a key the user entered that cannot be read
    // right now (an undecryptable one was just cleared): the key step is neither a PUT nor a DELETE.
    const unreadable = key === null && settings.getOpenRouterKeyCiphertext() != null
    const base = url.replace(/\/+$/, '')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const defaults = defaultsBody(council, analystModel)
    const steps = []
    if (!unreadable) steps.push(key !== null ? { method: 'PUT', path: KEY_PATH, body: { key } } : { method: 'DELETE', path: KEY_PATH })
    if (defaults) steps.push({ method: 'PUT', path: DEFAULTS_PATH, body: defaults })
    for (const step of steps) {
      const r = await request(base, headers, step)
      if (r.kind === 'ok') continue
      if (r.kind === 'stopped') return { ok: false, error: KEY_ERRORS.syncStopped }
      if (r.kind === 'unauthorized') return fail(KEY_ERRORS.syncUnauthorized, `${step.method} ${step.path}: HTTP ${r.status}; not retrying (is BRIDGE_TOKEN the backend's?)`)
      if (r.kind === 'unreachable') return fail(KEY_ERRORS.syncUnreachable, `${step.method} ${step.path}: ${r.cause} after ${SYNC_RETRIES} retries; giving up until the next connect`)
      return fail(KEY_ERRORS.syncRejected, `${step.method} ${step.path}: HTTP ${r.status}; not retrying`)
    }
    if (unreadable) {
      // The defaults went out; the key did not. `pushed` stays false and the error stays what the
      // user has to fix — the run is not a success until the key itself has been sent.
      info(`pushed: key stored but ${KEY_ERRORS.encryptionUnavailable} — not sent; defaults ${defaults ? `${councilSlots(council).length} agents` : 'skipped'}`)
      return { ok: false, error: KEY_ERRORS.encryptionUnavailable }
    }
    pushed = true
    lastError = null
    info(`pushed: key ${key !== null ? 'configured' : 'cleared'}, defaults ${defaults ? `${councilSlots(council).length} agents` : 'skipped'}`)
    return { ok: true }
  }

  function sync(args) {
    lastArgs = args
    if (inflight) {
      again = true
      return inflight
    }
    inflight = (async () => {
      try {
        let result
        do {
          again = false
          try {
            result = await runOnce(lastArgs)
          } catch (e) {
            result = fail(KEY_ERRORS.syncRejected, `unexpected failure: ${codeOf(e)}`)
          }
        } while (again && !stopped)
        return result
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  function dispose() {
    stopped = true
    if (recheck !== null) {
      clearT(recheck)
      recheck = null
    }
    for (const entry of pendingTimers) {
      clearT(entry.t)
      entry.resolve() // the waiting request sees `stopped` and ends `sync_stopped`
    }
    pendingTimers.clear()
  }

  return { set, clear, plaintext, status, sync, dispose, inflight: () => inflight !== null }
}
