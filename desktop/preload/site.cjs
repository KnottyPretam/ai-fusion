'use strict'
// desktop/preload/site.cjs — the site adapter (contracts §2 message protocol, §3 interface, §4 selectors).
//
// Self-contained on purpose: this file runs as a *sandboxed* Electron preload
// (`sandbox:true`, `contextIsolation:true`), where `require` only resolves 'electron' and a few
// Node built-ins, never sibling files. The same file is injected verbatim into a plain Chrome
// page by the Playwright `adapters` project (with `window.__triplexFakeIpc` installed first)
// and `require`d by `node --test` for its pure exports. The whole body is one IIFE so that,
// injected into a page's main world, it leaves no global bindings behind.
//
// Rules: nothing is ever assigned to `window`/`globalThis` for the page; the prompt text is always
// a message field (never interpolated into code); the adapter never clears the composer on
// failure; one op in flight per view (a second one answers `busy`); `ms`/`ts` are integers.
//
// Boot environments (contract §3: boots when `process.versions.electron` or `window.__triplexFakeIpc` exists):
//   * Electron preload — `require('electron').ipcRenderer` is the IPC; `adapter:config` is answered
//     by main from the sender id (`site:null` = stay inert, e.g. an SSO popup).
//   * Playwright (test/adapters/*.spec.js) — the spec installs the fake IPC with `page.addInitScript`
//     BEFORE injecting this file. Its exact shape, the only surface this file touches:
//       window.__triplexFakeIpc = {
//         invoke(channel, ...args) → Promise   // invoke('adapter:config') resolves {site: slot|null, selectors, dev}
//         on(channel, handler)                 // registers handler(event, msg) for channel 'triplex:adapter'
//         send(channel, payload)               // receives 'triplex:adapter:result' and 'triplex:adapter:health'
//       }
//     The spec delivers a main → preload message by calling the handler it received through `on`
//     (its helper `request(msg)` does that and resolves with the matching 'triplex:adapter:result').
//   * node --test — no `window`, never boots; `module.exports` exposes the pure parts.
//
// Stage 1 (site-adapters): the full adapter — selectors v1 with session detection, `findFirst`
// over the document + open shadow roots, `waitForComposer`, the verified insertion cascade,
// submit polling with confirmation, `ready`, `insertAndSubmit`, `countAssistant`, cancel, busy,
// health on change + 10 s heartbeat. `observe` and `snapshot` arrive in Stage 2.

;(() => {
  'use strict'

  const SLOTS = Object.freeze(['claude', 'chatgpt', 'grok'])

  const SESSION_STATES = Object.freeze(['ok', 'logged_out', 'challenge', 'blocked', 'unknown'])
  /** Session states that reject an op before any DOM write (contract §3). */
  const REJECT_STATES = Object.freeze(['logged_out', 'challenge', 'blocked'])
  /** Result codes the adapter mints (contract §2); anything else is reported as `site_error`. */
  const RESULT_CODES = Object.freeze([
    'composer_not_found',
    'send_not_found',
    'not_submitted',
    'reply_not_found',
    'timeout',
    'cancelled',
    'busy',
    'site_error',
    'logged_out',
    'challenge',
    'blocked',
  ])

  const HEALTH_HEARTBEAT_MS = 10000
  const HEALTH_POLL_MS = 1500
  /** Contract §3: the send cascade is polled every 150 ms (the composer wait uses the same tick). */
  const SEND_POLL_MS = 150
  const CONFIRM_POLL_MS = 100
  /** Contract §3: insertion is verified by the composer text ending with the last 20 characters. */
  const VERIFY_TAIL_CHARS = 20
  /** After an insertion, let the editor's own reconciliation frame run before reading back. */
  const INSERT_SETTLE_MS = 60
  const MAX_SHADOW_DEPTH = 8

  /**
   * What `countAssistant()` counts in v1 (no `assistant` cascade until selectors v2): every element
   * matching one of these generic message containers — user AND assistant turns — de-duplicated,
   * in the document and its open shadow roots. It is a monotonic "a message was appended" signal
   * used to confirm a submission (the user turn appears), not a reply count; 0 when nothing matches.
   * A v2 `assistant` cascade (Stage 2) is counted in addition when present.
   */
  const MESSAGE_SELECTORS = Object.freeze([
    '[data-message-author-role]', // chatgpt (and the fake site): user + assistant turns
    "[data-testid='user-message']", // claude user turns
    '.font-claude-message', // claude assistant turns (older markup)
    '.font-claude-response', // claude assistant turns
    "div[id^='response-']", // grok assistant turns
    '.message-bubble', // grok user/assistant bubbles
  ])

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
  // Pure helpers (no DOM)
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

  /** CRLF → LF and NBSP → space; everything else byte-for-byte. */
  function normalizeText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
  }

  function squash(s) {
    return normalizeText(s).replace(/\s+/g, '')
  }

  /**
   * Insertion verification (contract §3): `actual` must end with the last `n` characters of
   * `expected`. Compared with whitespace removed on both sides, because editors legitimately
   * re-render whitespace (paragraphs for newlines, NBSP for runs of spaces) while every
   * non-whitespace character must survive verbatim.
   */
  function tailMatches(actual, expected, n = VERIFY_TAIL_CHARS) {
    const tail = squash(expected).slice(-n)
    return squash(actual).endsWith(tail)
  }

  function isBlank(s) {
    return normalizeText(s).trim() === ''
  }

  /** A non-negative integer from `v`, else `fallback`. */
  function nonNegativeInt(v, fallback) {
    const n = Number(v)
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
  }

  function isResultCode(code) {
    return typeof code === 'string' && RESULT_CODES.includes(code)
  }

  class AdapterError extends Error {
    constructor(code, message, partial) {
      super(message || code)
      this.name = 'AdapterError'
      this.code = isResultCode(code) ? code : 'site_error'
      if (partial !== undefined) this.partial = partial
    }
  }

  // ---------------------------------------------------------------------------------------------
  // DOM helpers (take the root/element as arguments; testable with plain fake objects)
  // ---------------------------------------------------------------------------------------------

  function queryOne(root, selector) {
    try {
      return (root && typeof root.querySelector === 'function' && root.querySelector(selector)) || null
    } catch (_e) {
      return null // an invalid selector in an override never breaks the cascade
    }
  }

  function queryAll(root, selector) {
    try {
      if (!root || typeof root.querySelectorAll !== 'function') return []
      return Array.from(root.querySelectorAll(selector))
    } catch (_e) {
      return []
    }
  }

  /** Every OPEN shadow root under `root`, nested ones included (closed roots are unreachable by design). */
  function openShadowRoots(root, depth = 0, out = []) {
    for (const el of queryAll(root, '*')) {
      if (el && el.shadowRoot) {
        out.push(el.shadowRoot)
        if (depth < MAX_SHADOW_DEPTH) openShadowRoots(el.shadowRoot, depth + 1, out)
      }
    }
    return out
  }

  function resolveRoots(root, roots) {
    if (typeof roots === 'function') return roots()
    if (Array.isArray(roots)) return roots
    return openShadowRoots(root)
  }

  /** querySelector over `root`, then over its open shadow roots (`roots`: array, lazy function or omitted). */
  function deepQuerySelector(root, selector, roots) {
    const hit = queryOne(root, selector)
    if (hit) return hit
    for (const sr of resolveRoots(root, roots)) {
      const h = queryOne(sr, selector)
      if (h) return h
    }
    return null
  }

  /** querySelectorAll over `root` and its open shadow roots, document order per root. */
  function deepQuerySelectorAll(root, selector, roots) {
    const out = queryAll(root, selector)
    for (const sr of resolveRoots(root, roots)) out.push(...queryAll(sr, selector))
    return out
  }

  /** Rendered (has a box) and not hidden by CSS. Elements without layout APIs (fakes) count as visible. */
  function isVisible(el, win) {
    if (!el) return false
    try {
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false
      const view = win || (el.ownerDocument && el.ownerDocument.defaultView) || null
      if (view && typeof view.getComputedStyle === 'function') {
        const cs = view.getComputedStyle(el)
        if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return false
      }
    } catch (_e) {
      /* treat as visible */
    }
    return true
  }

  /** Not `disabled` and not `aria-disabled="true"`. */
  function isEnabled(el) {
    if (!el) return false
    if (el.disabled === true) return false
    try {
      if (typeof el.getAttribute === 'function' && String(el.getAttribute('aria-disabled')).toLowerCase() === 'true') return false
    } catch (_e) {
      /* no attributes: enabled */
    }
    return true
  }

  function tagOf(el) {
    return el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  }

  function isTextField(el) {
    const t = tagOf(el)
    return t === 'TEXTAREA' || t === 'INPUT'
  }

  /** The composer's current text: `value` for text fields, rendered text (innerText, else textContent) otherwise. */
  function readText(el) {
    if (!el) return ''
    try {
      if (isTextField(el)) return String(el.value === null || el.value === undefined ? '' : el.value)
      const t = typeof el.innerText === 'string' ? el.innerText : el.textContent
      return String(t === null || t === undefined ? '' : t)
    } catch (_e) {
      return ''
    }
  }

  function makeController() {
    const AC = globalThis.AbortController
    if (typeof AC === 'function') return new AC()
    const signal = { aborted: false }
    return {
      signal,
      abort() {
        signal.aborted = true
      },
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Adapter
  // ---------------------------------------------------------------------------------------------

  /**
   * createAdapter({document, window, site, selectors, now = Date.now, timers}) — contract §3.
   * `selectors` may be the full config (`{version, chatgpt, claude, grok}`) or one site's block.
   * `timers` ({setTimeout}) is injectable for tests; `now` stamps `ts`/`ms` and drives timeouts.
   * Every async op takes an optional `{signal}` (AbortSignal-like) and rejects with
   * `AdapterError('cancelled')` once it is aborted.
   */
  function createAdapter({ document, window, site, selectors, now = Date.now, timers } = {}) {
    if (!document) throw new Error('createAdapter: document is required')
    const win = window || (document.defaultView ? document.defaultView : null)
    const setT = (timers && timers.setTimeout) || globalThis.setTimeout
    let sel = siteSelectors(selectors, site) || {}

    const sleep = (ms) => new Promise((resolve) => setT(resolve, ms))
    const clock = () => Number(now()) || 0

    function throwIfAborted(signal) {
      if (signal && signal.aborted) throw new AdapterError('cancelled', 'cancelled by main')
    }

    /** Call `fn` every `intervalMs` until it returns a truthy value (returned) or `timeoutMs` elapses (null). */
    async function poll(fn, { intervalMs, timeoutMs, signal }) {
      const t0 = clock()
      for (;;) {
        throwIfAborted(signal)
        const r = fn()
        if (r) return r
        const left = timeoutMs - (clock() - t0)
        if (left <= 0) return null
        await sleep(Math.min(intervalMs, left))
      }
    }

    /**
     * First cascade entry with a match in the document or an open shadow root. With `visible`/
     * `enabled`, the first matching ELEMENT of an entry that passes the filters (an entry whose
     * matches are all hidden or disabled does not stop the cascade).
     */
    function findFirst(cascade, { visible = false, enabled = false } = {}) {
      if (!Array.isArray(cascade)) return null
      let roots = null
      const shadow = () => (roots === null ? (roots = openShadowRoots(document)) : roots)
      for (const selector of cascade) {
        if (typeof selector !== 'string' || selector === '') continue
        if (!visible && !enabled) {
          const el = deepQuerySelector(document, selector, shadow)
          if (el) return { el, selector }
          continue
        }
        for (const el of deepQuerySelectorAll(document, selector, shadow)) {
          if (visible && !isVisible(el, win)) continue
          if (enabled && !isEnabled(el)) continue
          return { el, selector }
        }
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

    /** The send button the adapter would click: visible and enabled, document + open shadow roots. */
    function findSendButton() {
      return findFirst(sel.send, { visible: true, enabled: true })
    }

    function hasStopCascade() {
      return Array.isArray(sel.stop) && sel.stop.some((s) => typeof s === 'string' && s !== '')
    }

    function findStop() {
      return hasStopCascade() ? findFirst(sel.stop, { visible: true }) : null
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
      const stop = hasStopCascade() ? findStop() : null
      return {
        composer: composer !== null,
        send: send !== null,
        reply: null,
        stop: hasStopCascade() ? stop !== null : null,
        session: sessionState(),
        matched: {
          composer: composer ? composer.selector : null,
          send: send ? send.selector : null,
          reply: null,
          stop: stop ? stop.selector : null,
          error: null,
        },
        url: href(),
        host: host(),
        title: title(),
        ts: Math.round(clock()),
      }
    }

    /** See MESSAGE_SELECTORS: distinct elements matching the generic message containers (+ a v2 `assistant` cascade). */
    function countAssistant() {
      const seen = new Set()
      const roots = openShadowRoots(document)
      const cascades = (Array.isArray(sel.assistant) ? sel.assistant : []).concat(MESSAGE_SELECTORS)
      for (const selector of cascades) {
        if (typeof selector !== 'string' || selector === '') continue
        for (const el of deepQuerySelectorAll(document, selector, roots)) seen.add(el)
      }
      return seen.size
    }

    function cascadeText(cascade) {
      return Array.isArray(cascade) ? cascade.join(', ') : String(cascade)
    }

    function stateError(state) {
      const why = {
        logged_out: 'the site shows its login wall',
        challenge: 'the site is showing a browser challenge',
        blocked: 'the site reports unusual activity or an error banner',
      }
      return new AdapterError(state, `${state}: ${why[state] || 'session is not ok'}`)
    }

    /** Wait for the composer to exist (every 150 ms up to `timeoutMs`, default `composerWaitMs`). */
    async function waitForComposer(timeoutMs, { signal } = {}) {
      const ms = nonNegativeInt(timeoutMs, nonNegativeInt(sel.composerWaitMs, 15000))
      const found = await poll(() => findComposer(), { intervalMs: SEND_POLL_MS, timeoutMs: ms, signal })
      if (!found) throw new AdapterError('composer_not_found', `no composer within ${ms} ms (tried: ${cascadeText(sel.composer)})`)
      return found
    }

    /**
     * Session gate shared by ready/insertAndSubmit: a wall/challenge/error state rejects at once
     * (no DOM write); `unknown` (page still loading) waits for the composer, then re-checks.
     */
    async function requireSessionOk({ timeoutMs, signal } = {}) {
      const first = sessionState()
      if (REJECT_STATES.includes(first)) throw stateError(first)
      const found = await waitForComposer(timeoutMs, { signal })
      const state = sessionState()
      if (REJECT_STATES.includes(state)) throw stateError(state)
      if (state !== 'ok') throw new AdapterError('composer_not_found', 'the composer disappeared while checking the session')
      return found
    }

    // ---- insertion --------------------------------------------------------------------------

    function focusEl(el) {
      try {
        if (typeof el.focus === 'function') el.focus()
      } catch (_e) {
        /* focus is best effort */
      }
    }

    function ctor(name) {
      const C = (win && win[name]) || globalThis[name]
      return typeof C === 'function' ? C : null
    }

    function makeEvent(name, fallbackName, type, init) {
      const C = ctor(name)
      if (C) {
        try {
          return new C(type, init)
        } catch (_e) {
          /* fall through to the plain event */
        }
      }
      const F = fallbackName ? ctor(fallbackName) : null
      return F ? new F(type, init) : null
    }

    function dispatch(el, ev) {
      if (!ev) return false
      try {
        el.dispatchEvent(ev)
        return true
      } catch (_e) {
        return false
      }
    }

    function inputEvent(text) {
      return makeEvent('InputEvent', 'Event', 'input', { bubbles: true, cancelable: false, composed: true, inputType: 'insertText', data: text })
    }

    /** contenteditable: focus, explicit Range collapsed at the end, execCommand('insertText'), then InputEvent('input'). */
    function insertViaExecCommand(el, text) {
      const doc = el.ownerDocument || document
      const view = doc.defaultView || win
      focusEl(el)
      const range = doc.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const selection = view && typeof view.getSelection === 'function' ? view.getSelection() : doc.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const ok = doc.execCommand('insertText', false, text) === true
      dispatch(el, inputEvent(text))
      return ok
    }

    /** contenteditable fallback: a synthetic paste carrying a DataTransfer with text/plain. */
    function insertViaPaste(el, text) {
      const DT = ctor('DataTransfer')
      if (!DT) return false
      const dt = new DT()
      dt.setData('text/plain', text)
      focusEl(el)
      const ev = makeEvent('ClipboardEvent', null, 'paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt })
      return dispatch(el, ev)
    }

    /** <textarea>/<input>: the native prototype value setter (bypasses React's instance tracker) + input. */
    function insertViaNativeValue(el, text) {
      const proto = ctor(tagOf(el) === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement')
      const desc = proto && proto.prototype ? Object.getOwnPropertyDescriptor(proto.prototype, 'value') : null
      focusEl(el)
      const next = readText(el) + text
      if (desc && typeof desc.set === 'function') desc.set.call(el, next)
      else el.value = next
      dispatch(el, inputEvent(text))
      return true
    }

    /**
     * Insert `text` at the end of the composer with the verified cascade (contract §3):
     * contenteditable → execCommand, else synthetic paste; text field → native value setter.
     * Each attempt is verified (`tailMatches`) after INSERT_SETTLE_MS; nothing is ever cleared.
     */
    async function insertText(text, { signal } = {}) {
      if (typeof text !== 'string') throw new AdapterError('site_error', 'insertText: text must be a string')
      const found = findComposer()
      if (!found) throw new AdapterError('composer_not_found', `no composer (tried: ${cascadeText(sel.composer)})`)
      const el = found.el
      const attempts = []
      const attempt = async (method, fn) => {
        let ran = false
        let threw = null
        try {
          ran = fn() === true
        } catch (e) {
          threw = String((e && e.message) || e)
        }
        await sleep(INSERT_SETTLE_MS)
        throwIfAborted(signal)
        const current = findComposer()
        if (tailMatches(readText(current ? current.el : el), text)) return true
        attempts.push(`${method}: ${threw ? `threw ${threw}` : ran ? 'ran' : 'did not run'}; the composer text does not end with the inserted text`)
        return false
      }
      if (isTextField(el)) {
        if (await attempt('nativeValue', () => insertViaNativeValue(el, text))) return { method: 'nativeValue' }
      } else {
        if (await attempt('execCommand', () => insertViaExecCommand(el, text))) return { method: 'execCommand' }
        if (await attempt('paste', () => insertViaPaste(el, text))) return { method: 'paste' }
      }
      throw new AdapterError('site_error', `insertText: ${attempts.join('; ')}`)
    }

    // ---- submission -------------------------------------------------------------------------

    function clickEl(el) {
      try {
        if (typeof el.click === 'function') {
          el.click()
          return true
        }
      } catch (_e) {
        /* fall through */
      }
      return dispatch(el, makeEvent('MouseEvent', 'Event', 'click', { bubbles: true, cancelable: true, composed: true }))
    }

    /** One Enter: keydown / keypress / keyup, composed:true, on the composer. */
    function pressEnter(el) {
      focusEl(el)
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const init = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: type === 'keypress' ? 13 : 0,
          bubbles: true,
          cancelable: true,
          composed: true,
        }
        dispatch(el, makeEvent('KeyboardEvent', 'Event', type, init))
      }
    }

    /** stop button | composer emptied | countAssistant() grew, polled every 100 ms up to `verifyMs`. */
    function confirmSubmission(verifyMs, baseline, signal) {
      return poll(
        () => {
          if (findStop()) return 'stop_button'
          const c = findComposer()
          if (c && isBlank(readText(c.el))) return 'composer_cleared'
          if (countAssistant() > baseline) return 'assistant_count'
          return null
        },
        { intervalMs: CONFIRM_POLL_MS, timeoutMs: verifyMs, signal },
      )
    }

    /**
     * Submit what is in the composer (contract §3): poll the send cascade every 150 ms up to
     * `timeoutMs` (default `sendWaitMs`) for a visible, enabled button, click it and confirm within
     * `submitVerifyMs`; else one Enter on the composer and confirm again. `assistantCount` is the
     * `countAssistant()` sample taken immediately before the action that confirmed.
     */
    async function submit(timeoutMs, { signal } = {}) {
      const waitMs = nonNegativeInt(timeoutMs, nonNegativeInt(sel.sendWaitMs, 18000))
      const verifyMs = nonNegativeInt(sel.submitVerifyMs, 5000)
      const button = await poll(() => findSendButton(), { intervalMs: SEND_POLL_MS, timeoutMs: waitMs, signal })
      let assistantCount = 0
      if (button) {
        assistantCount = countAssistant()
        clickEl(button.el)
        const confirmedBy = await confirmSubmission(verifyMs, assistantCount, signal)
        if (confirmedBy) return { method: 'click', sendSelector: button.selector, confirmedBy, assistantCount }
      }
      const composer = findComposer()
      if (composer) {
        assistantCount = countAssistant()
        pressEnter(composer.el)
        const confirmedBy = await confirmSubmission(verifyMs, assistantCount, signal)
        if (confirmedBy) return { method: 'enter', sendSelector: button ? button.selector : null, confirmedBy, assistantCount }
      }
      if (!button) {
        throw new AdapterError('send_not_found', `no visible, enabled send button within ${waitMs} ms (tried: ${cascadeText(sel.send)}); Enter did not submit either`)
      }
      throw new AdapterError('not_submitted', `clicked ${button.selector} and pressed Enter, but no stop button, emptied composer or new message confirmed the submission within ${verifyMs} ms`)
    }

    /** ready op (contract §2): session ok, composer present and no stop button, within `timeoutMs`. */
    async function ready(timeoutMs, { signal } = {}) {
      const ms = nonNegativeInt(timeoutMs, nonNegativeInt(sel.composerWaitMs, 15000))
      const first = sessionState()
      if (REJECT_STATES.includes(first)) throw stateError(first)
      const t0 = clock()
      const found = await poll(
        () => {
          const c = findComposer()
          return c && !findStop() ? c : null
        },
        { intervalMs: SEND_POLL_MS, timeoutMs: ms, signal },
      )
      if (!found) {
        if (findComposer()) throw new AdapterError('timeout', `the stop button is still visible after ${Math.round(clock() - t0)} ms (the site is still replying)`)
        throw new AdapterError('composer_not_found', `no composer within ${ms} ms (tried: ${cascadeText(sel.composer)})`)
      }
      const state = sessionState()
      if (REJECT_STATES.includes(state)) throw stateError(state)
      if (state !== 'ok') throw new AdapterError('composer_not_found', 'the composer disappeared while checking the session')
      return found
    }

    /** insertAndSubmit op (contract §2/§3): session gate → insertText → submit; `ms` is the whole op. */
    async function insertAndSubmit(text, { signal } = {}) {
      const t0 = clock()
      if (typeof text !== 'string' || text === '') throw new AdapterError('site_error', 'insertAndSubmit: text must be a non-empty string')
      const composer = await requireSessionOk({ signal })
      await insertText(text, { signal })
      const s = await submit(undefined, { signal })
      return {
        submitted: true,
        composerSelector: composer.selector,
        sendSelector: s.sendSelector,
        assistantCount: s.assistantCount,
        confirmedBy: s.confirmedBy,
        ms: Math.round(clock() - t0),
      }
    }

    /** Hot reload (config op): take the site block of a full config or a bare block; anything else is ignored. */
    function setSelectors(next) {
      if (isPlainObject(next) && site && isPlainObject(next[site])) sel = next[site]
      else if (isPlainObject(next) && Array.isArray(next.composer)) sel = next
    }

    const notYet = (op) => async () => {
      throw new AdapterError('site_error', `${op} is not available before stage 2`)
    }

    return {
      site: site || null,
      health,
      sessionState,
      findComposer,
      findSendButton,
      waitForComposer,
      insertText,
      submit,
      insertAndSubmit,
      countAssistant,
      ready,
      url: href,
      setSelectors,
      // ---- Stage 2 --------------------------------------------------------------------------
      observe: notYet('observe'),
      snapshot: notYet('snapshot'),
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

  function errorResult(reqId, op, e) {
    const code = e && isResultCode(e.code) ? e.code : 'site_error'
    const res = { reqId, ok: false, op, code, message: String((e && e.message) || e || code) }
    if (e && e.partial !== undefined) res.partial = e.partial
    return res
  }

  /**
   * attachIpc(ipc, factory):
   *   ipc     — `{invoke(channel, payload) → Promise, on(channel, (event, msg) => void), send(channel, payload)}`
   *             (Electron's `ipcRenderer` or the test's `window.__triplexFakeIpc`).
   *   factory — `(config) => adapter` called once with the `adapter:config` reply when `config.site`
   *             is not null; a null site leaves the preload inert (SSO popups, unknown pages).
   * Listens on 'triplex:adapter', answers on 'triplex:adapter:result', and publishes
   * 'triplex:adapter:health' on every change plus a 10 s heartbeat. One op in flight per view:
   * a second ready/insertAndSubmit/observe/snapshot answers `busy`; `cancel{target}` aborts it.
   * Returns `{ready: Promise<boolean>, dispose()}` (ready resolves true when an adapter was created).
   */
  function attachIpc(ipc, factory, { setInterval: setI = globalThis.setInterval, clearInterval: clearI = globalThis.clearInterval } = {}) {
    if (!ipc || typeof ipc.invoke !== 'function' || typeof ipc.on !== 'function' || typeof ipc.send !== 'function') {
      throw new Error('attachIpc: ipc must provide invoke/on/send')
    }
    let adapter = null
    let inFlight = null // {reqId, op, controller}
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

    const runOp = async (op, msg, signal) => {
      if (op === 'ready') {
        const r = await adapter.ready(msg.timeoutMs, { signal })
        return { composerSelector: r.selector }
      }
      if (op === 'insertAndSubmit') {
        const r = await adapter.insertAndSubmit(msg.text, { signal })
        return { ...r, url: adapter.url() }
      }
      if (op === 'observe') return adapter.observe({ ...msg, signal })
      if (op === 'snapshot') return adapter.snapshot({ signal })
      throw new AdapterError('site_error', `unknown op ${String(op)}`)
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
        if (cancelled) inFlight.controller.abort() // the op answers `cancelled` itself and frees the slot
        reply({ reqId, ok: true, op: 'cancel', cancelled })
        return
      }
      if (op === 'ready' || op === 'insertAndSubmit' || op === 'observe' || op === 'snapshot') {
        if (inFlight !== null) {
          reply({ reqId, ok: false, op, code: 'busy', message: `op ${inFlight.op} (${inFlight.reqId}) in flight` })
          return
        }
        const controller = makeController()
        inFlight = { reqId, op, controller }
        Promise.resolve()
          .then(() => runOp(op, msg, controller.signal))
          .then(
            (res) => reply({ reqId, ok: true, op, ...res }),
            (e) => reply(errorResult(reqId, op, e)),
          )
          .then(() => {
            if (inFlight !== null && inFlight.reqId === reqId) inFlight = null
            publishHealth(false)
          })
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
        if (inFlight !== null) inFlight.controller.abort()
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
      REJECT_STATES,
      RESULT_CODES,
      MESSAGE_SELECTORS,
      DEFAULT_SELECTORS,
      mergeSelectors,
      siteFor,
      hostMatches,
      siteSelectors,
      normalizeText,
      tailMatches,
      isBlank,
      nonNegativeInt,
      openShadowRoots,
      deepQuerySelector,
      deepQuerySelectorAll,
      isVisible,
      isEnabled,
      isTextField,
      readText,
      createAdapter,
      AdapterError,
      attachIpc,
      boot,
      HEALTH_HEARTBEAT_MS,
      HEALTH_POLL_MS,
      SEND_POLL_MS,
      CONFIRM_POLL_MS,
      VERIFY_TAIL_CHARS,
      INSERT_SETTLE_MS,
    }
  }

  if (shouldBoot()) boot()
})()
