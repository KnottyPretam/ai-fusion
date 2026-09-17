'use strict'
// desktop/preload/site.cjs — the site adapter (contracts §2 message protocol, §3 interface, §4 selectors).
//
// Self-contained on purpose: this file runs as a *sandboxed* Electron preload
// (`sandbox:true`, `contextIsolation:true`), where `require` only resolves 'electron' and a few
// Node built-ins, never sibling files. The same file is injected verbatim into a plain Chrome
// page by the Playwright `adapters` project (with `window.__triplexFakeIpc` installed first)
// and `require`d by `node --test` for its pure exports.
//
// Rules: nothing is ever assigned to `window`/`globalThis` for the page; the prompt text is always
// a message field (never interpolated into code); the adapter never clears the composer on
// failure; one op in flight per view.
//
// Stage 0: `health()`, `sessionState()`, `findComposer()` and the IPC plumbing are real; every
// other op answers `{ok:false, code:'composer_not_found', message:'stage 0 stub'}`.

const SLOTS = Object.freeze(['claude', 'chatgpt', 'grok'])

const SESSION_STATES = Object.freeze(['ok', 'logged_out', 'challenge', 'blocked', 'unknown'])

const HEALTH_HEARTBEAT_MS = 10000
const HEALTH_POLL_MS = 1500

/** Selector config v1 — contract §4, verbatim. Override file: <userData>/selectors.json. */
const DEFAULT_SELECTORS = {
  version: 1,
  chatgpt: {
    chatUrlPattern: '^https://chatgpt\\.com/c/[A-Za-z0-9-]+',
    composer: [
      '#prompt-textarea',
      "div[contenteditable='true'].ProseMirror",
      "div[role='textbox'][aria-label='Chat with ChatGPT']",
      "div[contenteditable='true'][role='textbox']",
    ],
    send: [
      "button[data-testid='send-button']",
      '#composer-submit-button',
      "button[aria-label='Send prompt']",
      "button[aria-label='Send message']",
      'button.composer-submit-button-color',
    ],
    loggedOut: ["a[href*='/auth/login']", "button[data-testid='login-button']"],
    loggedOutUrl: ['/auth/login', 'auth.openai.com', 'auth0.openai.com'],
    challenge: ["iframe[src*='challenges.cloudflare.com']", '#challenge-running', '#challenge-form'],
    challengeTitle: ['Just a moment'],
    errorText: ['Unusual activity has been detected', "You've reached", 'Something went wrong'],
    composerWaitMs: 15000,
    sendWaitMs: 18000,
    submitVerifyMs: 5000,
  },
  claude: {
    chatUrlPattern: '^https://claude\\.ai/chat/[0-9a-f-]+',
    composer: [
      "div[contenteditable='true'].ProseMirror",
      "div[contenteditable='true'][data-testid]",
      "div[contenteditable='true']",
    ],
    send: ["button[aria-label='Send message']", "button[aria-label*='Send Message']", "button[aria-label*='Send']"],
    loggedOut: ["a[href*='/login']", "button[data-testid='login-with-google']"],
    loggedOutUrl: ['/login'],
    challenge: ["iframe[src*='challenges.cloudflare.com']"],
    challengeTitle: ['Just a moment'],
    errorText: ['unusual activity', 'rate limit'],
    composerWaitMs: 15000,
    sendWaitMs: 18000,
    submitVerifyMs: 5000,
  },
  grok: {
    chatUrlPattern: '^https://grok\\.com/(c|chat)/[A-Za-z0-9-]+',
    composer: [
      "textarea[aria-label='Ask Grok anything']",
      "textarea[placeholder='Ask anything']",
      "textarea[placeholder*='Grok']",
      "textarea[data-testid='grok-compose-input']",
      "div[contenteditable='true'][data-lexical-editor='true']",
      'textarea',
    ],
    send: ["button[aria-label='Submit']", "button[aria-label='Send message']", "button[type='submit']"],
    loggedOut: ["a[href*='/sign-in']", "a[href*='accounts.x.ai']"],
    loggedOutUrl: ['accounts.x.ai', '/sign-in'],
    challenge: ["iframe[src*='challenges.cloudflare.com']"],
    challengeTitle: ['Just a moment'],
    errorText: ['unusual activity'],
    composerWaitMs: 15000,
    sendWaitMs: 18000,
    submitVerifyMs: 5000,
  },
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone)
  if (isPlainObject(v)) {
    const out = {}
    for (const k of Object.keys(v)) out[k] = clone(v[k])
    return out
  }
  return v
}

function kindOf(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

/**
 * Merge a selectors override into the defaults: per site, per key, the override REPLACES the
 * default value. Unknown sites/keys and type mismatches are skipped and reported in `warnings`.
 * Returns `{merged, warnings}`; `defaults` is never mutated.
 */
function mergeSelectors(defaults, override) {
  const merged = clone(defaults)
  const warnings = []
  if (override === undefined || override === null) return { merged, warnings }
  if (!isPlainObject(override)) {
    warnings.push('override: expected a JSON object')
    return { merged, warnings }
  }
  for (const site of Object.keys(override)) {
    const block = override[site]
    if (site === 'version') {
      if (block !== defaults.version) warnings.push(`version: expected ${defaults.version}, got ${JSON.stringify(block)}`)
      continue
    }
    if (!isPlainObject(defaults[site])) {
      warnings.push(`${site}: unknown site`)
      continue
    }
    if (!isPlainObject(block)) {
      warnings.push(`${site}: expected an object`)
      continue
    }
    for (const key of Object.keys(block)) {
      if (!Object.prototype.hasOwnProperty.call(defaults[site], key)) {
        warnings.push(`${site}.${key}: unknown key`)
        continue
      }
      const want = kindOf(defaults[site][key])
      const got = kindOf(block[key])
      if (want !== got) {
        warnings.push(`${site}.${key}: expected ${want}, got ${got}`)
        continue
      }
      if (want === 'array' && !block[key].every((x) => typeof x === 'string')) {
        warnings.push(`${site}.${key}: expected a list of strings`)
        continue
      }
      merged[site][key] = clone(block[key])
    }
  }
  return { merged, warnings }
}

function hostMatches(hostname, host) {
  if (typeof hostname !== 'string' || typeof host !== 'string') return false
  const a = hostname.toLowerCase().replace(/\.$/, '')
  const b = host.toLowerCase().replace(/\.$/, '')
  return a === b || a.endsWith('.' + b)
}

/** Map a hostname (or a subdomain of a listed host) to a slot via `sites[slot].hosts`; null when unknown. */
function siteFor(hostname, sites) {
  if (!sites || typeof hostname !== 'string') return null
  const order = SLOTS.filter((s) => s in sites).concat(Object.keys(sites).filter((s) => !SLOTS.includes(s)))
  for (const slot of order) {
    const hosts = sites[slot] && sites[slot].hosts
    if (Array.isArray(hosts) && hosts.some((h) => hostMatches(hostname, h))) return slot
  }
  return null
}

/** Pick the per-site block out of either a full selectors config or an already-narrowed block. */
function siteSelectors(selectors, site) {
  if (isPlainObject(selectors) && site && isPlainObject(selectors[site])) return selectors[site]
  if (isPlainObject(selectors) && Array.isArray(selectors.composer)) return selectors
  return site && DEFAULT_SELECTORS[site] ? DEFAULT_SELECTORS[site] : null
}

class AdapterError extends Error {
  constructor(code, message, partial) {
    super(message || code)
    this.name = 'AdapterError'
    this.code = code
    if (partial !== undefined) this.partial = partial
  }
}

// ---------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------

/**
 * createAdapter({document, window, site, selectors, now}) — contract §3.
 * `selectors` may be the full config (`{version, chatgpt, claude, grok}`) or one site's block.
 * Stage 0 implements health()/sessionState()/findComposer(); the rest are stubs.
 */
function createAdapter({ document, window, site, selectors, now = Date.now } = {}) {
  if (!document) throw new Error('createAdapter: document is required')
  const win = window || (document.defaultView ? document.defaultView : null)
  let sel = siteSelectors(selectors, site) || {}

  const stub = (op) => new AdapterError('composer_not_found', 'stage 0 stub')

  function query(selector) {
    try {
      return document.querySelector(selector)
    } catch (_e) {
      return null // an invalid selector in an override never breaks the cascade
    }
  }

  function findFirst(cascade) {
    if (!Array.isArray(cascade)) return null
    for (const selector of cascade) {
      if (typeof selector !== 'string' || selector === '') continue
      const el = query(selector)
      if (el) return { el, selector }
    }
    return null
  }

  function anyMatch(cascade) {
    return findFirst(cascade) !== null
  }

  function href() {
    try {
      return String((win && win.location && win.location.href) || (document.location && document.location.href) || '')
    } catch (_e) {
      return ''
    }
  }

  function host() {
    try {
      return String((win && win.location && win.location.hostname) || (document.location && document.location.hostname) || '')
    } catch (_e) {
      return ''
    }
  }

  function title() {
    try {
      return String(document.title || '')
    } catch (_e) {
      return ''
    }
  }

  function bodyText() {
    try {
      const body = document.body
      if (!body) return ''
      // innerText = rendered text only (script/style contents excluded); textContent is the fallback
      // for documents without layout (node tests).
      const t = typeof body.innerText === 'string' ? body.innerText : body.textContent
      return String(t || '')
    } catch (_e) {
      return ''
    }
  }

  function includesAny(haystack, needles, { ci = false } = {}) {
    if (!Array.isArray(needles) || !haystack) return false
    const h = ci ? haystack.toLowerCase() : haystack
    return needles.some((n) => typeof n === 'string' && n !== '' && h.includes(ci ? n.toLowerCase() : n))
  }

  function findComposer() {
    return findFirst(sel.composer)
  }

  function findSend() {
    return findFirst(sel.send)
  }

  /** Contract §4 rules, in order: loggedOutUrl → challengeTitle → challenge → loggedOut → errorText → ok/unknown. */
  function sessionState() {
    if (includesAny(href(), sel.loggedOutUrl)) return 'logged_out'
    if (includesAny(title(), sel.challengeTitle)) return 'challenge'
    if (anyMatch(sel.challenge)) return 'challenge'
    if (anyMatch(sel.loggedOut)) return 'logged_out'
    if (includesAny(bodyText(), sel.errorText, { ci: true })) return 'blocked'
    return findComposer() ? 'ok' : 'unknown'
  }

  function health() {
    const composer = findComposer()
    const send = findSend()
    return {
      composer: composer !== null,
      send: send !== null,
      reply: null,
      stop: null,
      session: sessionState(),
      matched: {
        composer: composer ? composer.selector : null,
        send: send ? send.selector : null,
        reply: null,
        stop: null,
        error: null,
      },
      url: href(),
      host: host(),
      title: title(),
      ts: Number(now()) || 0,
    }
  }

  function setSelectors(next) {
    const block = siteSelectors(next, site)
    if (block) sel = block
  }

  return {
    site: site || null,
    health,
    sessionState,
    findComposer,
    setSelectors,
    // ---- Stage 1+ (stubs in Stage 0) ---------------------------------------------------------
    waitForComposer: async () => {
      throw stub('ready')
    },
    insertText: async () => {
      throw stub('insertText')
    },
    submit: async () => {
      throw stub('submit')
    },
    insertAndSubmit: async () => {
      throw stub('insertAndSubmit')
    },
    countAssistant: () => 0,
    observe: async () => {
      throw stub('observe')
    },
    snapshot: async () => {
      throw stub('snapshot')
    },
  }
}

// ---------------------------------------------------------------------------------------------
// IPC plumbing (contract §2, "Main ↔ site preload")
// ---------------------------------------------------------------------------------------------

function healthKey(h) {
  // change detection ignores the timestamp
  const { ts, ...rest } = h
  return JSON.stringify(rest)
}

/**
 * attachIpc(ipc, factory):
 *   ipc     — `{invoke(channel, payload) → Promise, on(channel, (event, msg) => void), send(channel, payload)}`
 *             (Electron's `ipcRenderer` or the test's `window.__triplexFakeIpc`).
 *   factory — `(config) => adapter` called once with the `adapter:config` reply when `config.site`
 *             is not null; a null site leaves the preload inert (SSO popups, unknown pages).
 * Listens on 'triplex:adapter', answers on 'triplex:adapter:result', and publishes
 * 'triplex:adapter:health' on every change plus a 10 s heartbeat.
 * Returns `{ready: Promise<boolean>, dispose()}` (ready resolves true when an adapter was created).
 */
function attachIpc(ipc, factory, { setInterval: setI = globalThis.setInterval, clearInterval: clearI = globalThis.clearInterval } = {}) {
  if (!ipc || typeof ipc.invoke !== 'function' || typeof ipc.on !== 'function' || typeof ipc.send !== 'function') {
    throw new Error('attachIpc: ipc must provide invoke/on/send')
  }
  let adapter = null
  let inFlight = null // {reqId, op} — one op per view; Stage 0 never keeps one for long
  let lastHealthKey = null
  let lastHealthAt = 0
  let timer = null
  let disposed = false

  const reply = (res) => {
    try {
      ipc.send('triplex:adapter:result', res)
    } catch (_e) {
      /* the channel is gone; nothing to do */
    }
  }

  const publishHealth = (force) => {
    if (!adapter || disposed) return
    let h
    try {
      h = adapter.health()
    } catch (e) {
      return
    }
    const key = healthKey(h)
    const due = h.ts - lastHealthAt >= HEALTH_HEARTBEAT_MS
    if (force || key !== lastHealthKey || due) {
      lastHealthKey = key
      lastHealthAt = h.ts
      try {
        ipc.send('triplex:adapter:health', h)
      } catch (_e) {
        /* ignore */
      }
    }
  }

  const handle = (msg) => {
    if (!adapter || disposed || !msg || typeof msg !== 'object') return
    const op = msg.op
    if (op === 'config') {
      // hot reload (Stage 2): replace selectors, no reply
      if (msg.selectors !== undefined) adapter.setSelectors(msg.selectors)
      publishHealth(true)
      return
    }
    const reqId = msg.reqId
    if (typeof reqId !== 'string' || reqId === '') return
    if (op === 'health') {
      let h
      try {
        h = adapter.health()
      } catch (e) {
        reply({ reqId, ok: false, op, code: 'site_error', message: String((e && e.message) || e) })
        return
      }
      reply({ reqId, ok: true, op: 'health', health: h })
      return
    }
    if (op === 'cancel') {
      const cancelled = inFlight !== null && inFlight.reqId === msg.target
      if (cancelled) inFlight = null
      reply({ reqId, ok: true, op: 'cancel', cancelled })
      return
    }
    if (op === 'ready' || op === 'insertAndSubmit' || op === 'observe' || op === 'snapshot') {
      if (inFlight !== null) {
        reply({ reqId, ok: false, op, code: 'busy', message: `op ${inFlight.op} (${inFlight.reqId}) in flight` })
        return
      }
      // Stage 0: no DOM write ever happens; every real op is a stub.
      reply({ reqId, ok: false, op, code: 'composer_not_found', message: 'stage 0 stub' })
      return
    }
    reply({ reqId, ok: false, op: String(op), code: 'site_error', message: `unknown op ${String(op)}` })
  }

  ipc.on('triplex:adapter', (_event, msg) => handle(msg))

  const ready = Promise.resolve()
    .then(() => ipc.invoke('adapter:config'))
    .then((config) => {
      if (disposed) return false
      if (!config || typeof config !== 'object' || config.site === null || config.site === undefined) return false
      adapter = factory(config)
      if (!adapter) return false
      publishHealth(true)
      timer = setI(() => publishHealth(false), HEALTH_POLL_MS)
      return true
    })
    .catch(() => false)

  return {
    ready,
    dispose() {
      disposed = true
      if (timer !== null) clearI(timer)
      timer = null
      adapter = null
    },
  }
}

function pickIpc() {
  if (typeof window !== 'undefined' && window && window.__triplexFakeIpc) return window.__triplexFakeIpc
  if (typeof process !== 'undefined' && process && process.versions && process.versions.electron) {
    try {
      return require('electron').ipcRenderer
    } catch (_e) {
      return null
    }
  }
  return null
}

/** Boot only inside a page (Electron preload or a Chrome page carrying `window.__triplexFakeIpc`). */
function shouldBoot() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (window.__triplexFakeIpc) return true
  return typeof process !== 'undefined' && !!(process && process.versions && process.versions.electron)
}

function boot() {
  const ipc = pickIpc()
  if (!ipc) return null
  return attachIpc(ipc, (config) =>
    createAdapter({
      document,
      window,
      site: config.site,
      selectors: config.selectors || DEFAULT_SELECTORS,
    }),
  )
}

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = {
    SLOTS,
    SESSION_STATES,
    DEFAULT_SELECTORS,
    mergeSelectors,
    siteFor,
    hostMatches,
    createAdapter,
    AdapterError,
    attachIpc,
    boot,
    HEALTH_HEARTBEAT_MS,
    HEALTH_POLL_MS,
  }
}

if (shouldBoot()) boot()
