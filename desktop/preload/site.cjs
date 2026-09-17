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
// Stage 1 (site-adapters): the full adapter — selectors v1 with session detection (scoped: chat
// content is never a wall or banner), `findFirst` over the document + open shadow roots,
// `waitForComposer`, the idempotent verified insertion cascade, submit polling with confirmation,
// `ready`, `insertAndSubmit`, `countMessages`/`countAssistant`, cancel, busy, health on change +
// 10 s heartbeat, requests parked during boot.
//
// Stage 2 (capture-adapters): selectors v2 (`stop`/`assistant`/`assistantText`/`done`/`quietMs`/
// `firstTokenMs`/`captureTimeoutMs` per site, contract §4), the `observe` op (final-text capture:
// a new assistant container beyond `baselineCount`, done by done-selector | stop-gone | quiet,
// `timeout` with the partial text, MutationObserver throttled to 100 ms + a 300 ms poll), the
// `snapshot` op (`scrubDom`), `errorText` → `site_error` carrying only the matched phrase, and the
// `config` hot reload (re-merge onto the defaults, health re-run). Readings taken where the contract
// is silent (also listed in the S6 build log):
//   * `DEFAULT_SELECTORS.version` stays 1: v2 is additive per site, and main's loader pins the
//     version check (an override carrying `version: 2` warns and is otherwise applied).
//   * observe: `timeoutMs` overrides `captureTimeoutMs`, `quietMs` overrides `quietMs`, an optional
//     `firstTokenMs` overrides `firstTokenMs` (the first-token wait is capped by the budget); a
//     missing `baselineCount` means the current `countAssistant()`.
//   * "the done selector on the last container" = a VISIBLE `done` match that is the last container,
//     inside it, or after it in document order (an older turn's copy button never counts).
//   * "stop button seen then gone" = seen during THIS observe; while it is visible the reply is
//     never quiet; when it was never seen (the reply finished before observe started) quiet applies.
//   * quiet needs non-blank text; an empty container waits for the budget (`timeout`, partial "").
//   * the text is normalised (CRLF → LF, NBSP → space) and never trimmed.
//   * a banner mid-reply is `site_error` whose message is the configured `errorText` phrase that
//     matched — never the banner's or the page's text; a wall / challenge mid-reply answers
//     `logged_out` / `challenge`; the partial text rides along on those and on `cancelled` when it is
//     non-blank, and always on `timeout`.
//   * snapshot: comments, doctype and whitespace-only text nodes are dropped (a non-blank text node
//     becomes `…`), `<template>` content is not serialised, open shadow roots are emitted as
//     `<template shadowrootmode="open">`, and kept attribute VALUES are rewritten where they carry
//     identity (uuid, `@`, `/c/`, `/chat/`, `googleusercontent`, `x.com/`) so the output passes the
//     fixture lint (`test/unit/preload/_fixture-lint.js`).
//   * `config`: a full config is re-merged onto DEFAULT_SELECTORS (every key present, unknown keys
//     dropped with the usual warnings); a bare site block is taken as-is.

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
  const HEALTH_MUTATION_THROTTLE_MS = 400
  /** Contract §3: the send cascade is polled every 150 ms (the composer wait uses the same tick). */
  const SEND_POLL_MS = 150
  const CONFIRM_POLL_MS = 100
  /** Contract §3: insertion is verified by the composer text ending with the last 20 characters. */
  const VERIFY_TAIL_CHARS = 20
  /** After an insertion, let the editor's own reconciliation frame run before reading back. */
  const INSERT_SETTLE_MS = 60
  const MAX_SHADOW_DEPTH = 8
  /** Stage 2 observe cadence: a DOM mutation triggers a check at most every 100 ms; a poll runs every 300 ms regardless. */
  const OBSERVE_THROTTLE_MS = 100
  const OBSERVE_POLL_MS = 300
  /** snapshot (contract §2/§3): elements dropped with their subtrees, and the only attributes kept (emitted in DOM order). */
  const SNAPSHOT_DROP_TAGS = Object.freeze(['script', 'style', 'link', 'meta', 'img', 'svg', 'iframe', 'video', 'audio'])
  const SNAPSHOT_KEEP_ATTRS = Object.freeze([
    'id',
    'class',
    'role',
    'contenteditable',
    'aria-label',
    'data-testid',
    'data-message-author-role',
    'data-lexical-editor',
    'type',
    'disabled',
    'placeholder',
    'translate',
  ])
  const VOID_TAGS = Object.freeze(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  /** What every non-blank text node becomes in a snapshot. */
  const TEXT_PLACEHOLDER = '\u2026'

  /**
   * What `countMessages()` counts: every element matching one of these generic message containers
   * — user AND assistant turns — de-duplicated, in the document and its open shadow roots. It is a
   * monotonic "a message was appended" signal used to confirm a submission (the user turn appears),
   * not a reply count; 0 when nothing matches. The same list defines "inside a chat message" for
   * the session rules: text and links rendered inside one of these never count as a wall or banner.
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
  const MESSAGE_SELECTOR = MESSAGE_SELECTORS.join(', ')

  /**
   * What `countAssistant()` counts: assistant-role containers only (+ a v2 `assistant` cascade).
   * This is the `assistantCount` handed to main (contract §2/§3) — Stage 2's observe baseline — so
   * the user's own turn, appended after the sample, is never mistaken for the reply.
   */
  const ASSISTANT_SELECTORS = Object.freeze([
    "[data-message-author-role='assistant']", // chatgpt
    '.font-claude-response', // claude
    '.font-claude-message', // claude (older markup)
    "div[id^='response-']", // grok
  ])

  /**
   * Where `errorText` (contract §4) is looked for: alert-like containers only, never the whole
   * body — a reply or prompt that merely mentions "rate limit" or "Something went wrong" is chat
   * content, not a banner. Containers inside a message, or wrapping the thread/composer, are skipped.
   */
  const ALERT_SELECTORS = Object.freeze(["[role='alert']", "[role='status']", "[role='dialog']", "[role='alertdialog']", '[aria-live]'])

  /**
   * The Cloudflare interstitial's exact tab title. `challengeTitle` is a substring rule and the
   * sites put the conversation title in the tab title, so a substring hit only counts when it is
   * this exact title, or corroborated by a missing composer / a `challenge` element.
   */
  const CLOUDFLARE_CHALLENGE_TITLES = Object.freeze(['Just a moment...', 'Just a moment\u2026'])

  /**
   * Selector config — contract §4 verbatim: the v1 keys, plus the v2 keys (`stop`, `assistant`,
   * `assistantText`, `done`, `quietMs`, `firstTokenMs`, `captureTimeoutMs`) added per site in Stage
   * 2. `version` stays 1: v2 is additive, and an override file written against v1 keeps working
   * (main's loader warns on any other version). Override file: <userData>/selectors.json.
   * Empty `stop` + `done` ⇒ quiet detection (claude and grok have no done marker; their stop
   * buttons are the done signal, quiet the fallback).
   */
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
      // v2 (Stage 2)
      stop: ["button[data-testid='stop-button']", "button[aria-label='Stop streaming']", "button[aria-label='Stop answering']"],
      assistant: ["[data-message-author-role='assistant']"],
      assistantText: ['.markdown', '.whitespace-pre-wrap'],
      done: ["button[data-testid='copy-turn-action-button']"],
      quietMs: 2500,
      firstTokenMs: 90000,
      captureTimeoutMs: 300000,
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
      // v2 (Stage 2)
      stop: ["button[aria-label='Stop response']", "button[aria-label*='Stop']"],
      assistant: ['.font-claude-response:not(#markdown-artifact)', '.font-claude-message'],
      assistantText: [],
      done: [],
      quietMs: 2500,
      firstTokenMs: 90000,
      captureTimeoutMs: 300000,
    },
    grok: {
      chatUrlPattern: '^https://grok\\.com/(c|chat)/[A-Za-z0-9-]+',
      // Verified live on grok.com (signed in, 2026-09-16; contract §4): the composer is a
      // TipTap/ProseMirror div inside a <form>. A hidden 14 px helper <textarea> also exists on the
      // page, so a bare `textarea` entry must NEVER be a fallback — it matched the helper, the
      // insertion "verified" against it and the prompt vanished.
      composer: [
        "div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']",
        "div[role='textbox'][aria-label='Ask Grok anything']",
        "div.ProseMirror[contenteditable='true']",
        "textarea[aria-label='Ask Grok anything']",
        "textarea[placeholder*='Grok']",
        "div[contenteditable='true'][data-lexical-editor='true']",
      ],
      // Rendered only once the editor holds text (an "Enter voice mode" button occupies the slot
      // while it is empty): `submit()` polls this cascade AFTER the insertion, never before.
      send: ["button[data-testid='chat-submit']", "button[aria-label='Submit']", "button[type='submit']"],
      loggedOut: ["a[href*='/sign-in']", "a[href*='accounts.x.ai']"],
      loggedOutUrl: ['accounts.x.ai', '/sign-in'],
      challenge: ["iframe[src*='challenges.cloudflare.com']"],
      challengeTitle: ['Just a moment'],
      errorText: ['unusual activity'],
      composerWaitMs: 15000,
      sendWaitMs: 18000,
      submitVerifyMs: 5000,
      // v2 (Stage 2)
      stop: ["button[aria-label='Stop']", "button[aria-label*='Stop']"],
      assistant: ["div[id^='response-']"],
      assistantText: ['.response-content-markdown'],
      done: [],
      quietMs: 2500,
      firstTokenMs: 90000,
      captureTimeoutMs: 300000,
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

  /** The usable entries of a selector cascade: non-empty strings, in order; `[]` for anything else. */
  function nonEmptyCascade(cascade) {
    return Array.isArray(cascade) ? cascade.filter((s) => typeof s === 'string' && s !== '') : []
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

  /** Rendered (a non-empty box) and not hidden by CSS. Elements without layout APIs (fakes) count as visible. */
  function isVisible(el, win) {
    if (!el) return false
    try {
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false
      if (typeof el.getBoundingClientRect === 'function') {
        // Playwright's rule: a collapsed 0×0 box (an overflow-hidden or animated-out duplicate) is not visible
        const r = el.getBoundingClientRect()
        if (r && (r.width === 0 || r.height === 0)) return false
      }
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

  /** `fn()` returned true; a throwing `fn` (no attribute API, an unsupported pseudo-class) counts as false. */
  function safeTrue(fn) {
    try {
      return fn() === true
    } catch (_e) {
      return false
    }
  }

  /** Not `disabled` (property, attribute or `:disabled` — a disabled <fieldset> ancestor counts) and not `aria-disabled="true"`. */
  function isEnabled(el) {
    if (!el) return false
    if (el.disabled === true) return false
    if (safeTrue(() => typeof el.matches === 'function' && el.matches(':disabled'))) return false
    if (safeTrue(() => typeof el.hasAttribute === 'function' && el.hasAttribute('disabled'))) return false
    if (safeTrue(() => typeof el.getAttribute === 'function' && String(el.getAttribute('aria-disabled')).toLowerCase() === 'true')) return false
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

  // ---------------------------------------------------------------------------------------------
  // DOM snapshot scrubbing (contract §3 `scrubDom`; Stage 2)
  // ---------------------------------------------------------------------------------------------

  function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /**
   * Kept attribute values are structure, but on the real sites a few carry identity (a chat or
   * message uuid inside an id, an e-mail in a label, an avatar host in a class): every pattern the
   * fixture lint rejects is rewritten, so a snapshot can be committed under test/fixtures/dom/.
   */
  function scrubValue(v) {
    return String(v)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'uuid')
      .replace(/googleusercontent/gi, 'img-host')
      .replace(/x\.com\//gi, 'x-com/')
      .replace(/\/(c|chat)\//g, '/$1-/')
      .replace(/@/g, '(at)')
  }

  function tagNameOf(node) {
    const n = typeof node.localName === 'string' && node.localName !== '' ? node.localName : String(node.nodeName || node.tagName || '')
    return n.toLowerCase()
  }

  /** `[name, value]` pairs from a NamedNodeMap / array of `{name, value}`, or a plain object (fakes). */
  function attrsOf(node) {
    const a = node.attributes
    if (!a) return []
    if (typeof a.length === 'number') {
      return Array.from(a, (x) => [String(x.name).toLowerCase(), x.value === null || x.value === undefined ? '' : String(x.value)])
    }
    if (isPlainObject(a)) return Object.keys(a).map((k) => [k.toLowerCase(), String(a[k])])
    return []
  }

  function childrenOf(node) {
    const c = node.childNodes
    return c && typeof c.length === 'number' ? Array.from(c) : []
  }

  function scrubNode(node, out) {
    if (!node || typeof node.nodeType !== 'number') return
    const type = node.nodeType
    if (type === 3) {
      const s = typeof node.data === 'string' ? node.data : typeof node.nodeValue === 'string' ? node.nodeValue : ''
      if (s.trim() !== '') out.push(TEXT_PLACEHOLDER)
      return
    }
    if (type === 11) {
      for (const c of childrenOf(node)) scrubNode(c, out)
      return
    }
    if (type !== 1) return // comments, doctype, processing instructions, cdata: dropped
    const tag = tagNameOf(node)
    if (SNAPSHOT_DROP_TAGS.includes(tag)) return
    out.push('<' + tag)
    for (const [name, value] of attrsOf(node)) {
      if (SNAPSHOT_KEEP_ATTRS.includes(name)) out.push(' ' + name + '="' + escapeAttr(scrubValue(value)) + '"')
    }
    out.push('>')
    if (VOID_TAGS.includes(tag)) return
    if (node.shadowRoot) {
      out.push('<template shadowrootmode="open">')
      scrubNode(node.shadowRoot, out)
      out.push('</template>')
    }
    for (const c of childrenOf(node)) scrubNode(c, out)
    out.push('</' + tag + '>')
  }

  /**
   * scrubDom(document) → string (contract §3): the page's structure and nothing else — every
   * `script|style|link|meta|img|svg|iframe|video|audio` dropped with its subtree, only
   * SNAPSHOT_KEEP_ATTRS kept (values passed through `scrubValue`), every non-blank text node
   * replaced by `…`, whitespace-only text / comments / doctype dropped, open shadow roots inlined
   * as `<template shadowrootmode="open">`. Accepts a Document (its documentElement) or any node.
   */
  function scrubDom(doc) {
    const root = doc && doc.documentElement ? doc.documentElement : doc
    const out = []
    scrubNode(root, out)
    return '<!doctype html>\n' + out.join('') + '\n'
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
   * `selectors` may be the full config (`{version, chatgpt, claude, grok}`, re-merged onto
   * DEFAULT_SELECTORS so every key exists) or one site's block (taken as-is).
   * `timers` ({setTimeout, clearTimeout}) is injectable for tests; `now` stamps `ts`/`ms` and
   * drives timeouts. Every async op takes an optional `{signal}` (AbortSignal-like) and rejects
   * with `AdapterError('cancelled')` once it is aborted.
   */
  function createAdapter({ document, window, site, selectors, now = Date.now, timers } = {}) {
    if (!document) throw new Error('createAdapter: document is required')
    const win = window || (document.defaultView ? document.defaultView : null)
    const setT = (timers && timers.setTimeout) || globalThis.setTimeout
    const clearT = (timers && timers.clearTimeout) || globalThis.clearTimeout

    /**
     * This site's block out of `next`: a full config is re-merged onto DEFAULT_SELECTORS (override
     * replaces per key; unknown keys are dropped; every v1/v2 key is present afterwards), a bare
     * block (`{composer: [...]}`) is used as-is, anything else is null.
     */
    function resolveSelectors(next) {
      if (isPlainObject(next) && site && isPlainObject(next[site])) {
        const merged = mergeSelectors(DEFAULT_SELECTORS, next).merged
        return isPlainObject(merged[site]) ? merged[site] : next[site]
      }
      if (isPlainObject(next) && Array.isArray(next.composer)) return next
      return null
    }
    let sel = resolveSelectors(selectors) || siteSelectors(undefined, site) || {}

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
     * `enabled`/`accept`, the first matching ELEMENT of an entry that passes the filters (an entry
     * whose matches are all hidden, disabled or rejected does not stop the cascade).
     */
    function findFirst(cascade, { visible = false, enabled = false, accept = null } = {}) {
      if (!Array.isArray(cascade)) return null
      let roots = null
      const shadow = () => (roots === null ? (roots = openShadowRoots(document)) : roots)
      const filtered = visible || enabled || typeof accept === 'function'
      for (const selector of cascade) {
        if (typeof selector !== 'string' || selector === '') continue
        if (!filtered) {
          const el = deepQuerySelector(document, selector, shadow)
          if (el) return { el, selector }
          continue
        }
        for (const el of deepQuerySelectorAll(document, selector, shadow)) {
          if (visible && !isVisible(el, win)) continue
          if (enabled && !isEnabled(el)) continue
          if (accept && !accept(el)) continue
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

    /** True when `el` sits inside a rendered chat message (MESSAGE_SELECTORS); elements without `closest` (fakes) count as outside. */
    function insideMessage(el) {
      try {
        return !!(el && typeof el.closest === 'function' && el.closest(MESSAGE_SELECTOR))
      } catch (_e) {
        return false
      }
    }

    /** True when `container` wraps the thread or the composer: a layout region (an `aria-live` app root), not a banner. */
    function wrapsChat(container, composerEl) {
      if (queryOne(container, MESSAGE_SELECTOR)) return true
      try {
        return !!(composerEl && container !== composerEl && typeof container.contains === 'function' && container.contains(composerEl))
      } catch (_e) {
        return false
      }
    }

    /**
     * The rendered text of every alert-like container (ALERT_SELECTORS, document + open shadow
     * roots) that is neither inside a chat message nor wrapping the thread/composer. Replaces the
     * whole-body scan: chat content never counts as a banner, and no layout is forced on the body.
     */
    function alertTexts(composerEl) {
      const roots = openShadowRoots(document)
      const seen = new Set()
      const out = []
      for (const selector of ALERT_SELECTORS) {
        for (const el of deepQuerySelectorAll(document, selector, roots)) {
          if (seen.has(el)) continue
          seen.add(el)
          if (insideMessage(el) || wrapsChat(el, composerEl)) continue
          const t = readText(el)
          if (t !== '') out.push(t)
        }
      }
      return out
    }

    function includesAny(haystack, needles, { ci = false } = {}) {
      if (!Array.isArray(needles) || !haystack) return false
      const h = ci ? haystack.toLowerCase() : haystack
      return needles.some((n) => typeof n === 'string' && n !== '' && h.includes(ci ? n.toLowerCase() : n))
    }

    /**
     * The first configured `errorText` phrase found (case-insensitively) in an alert-like container
     * outside the chat — returned VERBATIM FROM THE CONFIG, never the banner's text, so an error
     * message built from it carries no page content. Null when nothing matches.
     */
    function matchedErrorPhrase(composerEl) {
      const phrases = nonEmptyCascade(sel.errorText)
      if (phrases.length === 0) return null
      for (const text of alertTexts(composerEl)) {
        const h = text.toLowerCase()
        const hit = phrases.find((p) => h.includes(p.toLowerCase()))
        if (hit) return hit
      }
      return null
    }

    /** A rendered match first (a hidden or collapsed editor earlier in the DOM never wins), else any match (presence during mount). */
    function findComposer() {
      return findFirst(sel.composer, { visible: true }) || findFirst(sel.composer)
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

    /**
     * Contract §4 rules, in order: loggedOutUrl → challengeTitle → challenge → loggedOut → errorText → ok/unknown.
     * Scope: `challengeTitle` counts only as the exact Cloudflare title or when corroborated (no
     * composer, or a `challenge` element); `loggedOut` must be visible and outside a chat message;
     * `errorText` is looked for in alert-like containers only (see ALERT_SELECTORS), never in the
     * thread or the composer — a reply that mentions "rate limit" or links to /login stays `ok`.
     */
    function sessionState() {
      if (includesAny(href(), sel.loggedOutUrl)) return 'logged_out'
      const composer = findComposer()
      const t = title()
      const challengeEl = anyMatch(sel.challenge)
      if (includesAny(t, sel.challengeTitle) && (challengeEl || !composer || CLOUDFLARE_CHALLENGE_TITLES.includes(t.trim()))) return 'challenge'
      if (challengeEl) return 'challenge'
      if (findFirst(sel.loggedOut, { visible: true, accept: (el) => !insideMessage(el) })) return 'logged_out'
      if (matchedErrorPhrase(composer ? composer.el : null) !== null) return 'blocked'
      return composer ? 'ok' : 'unknown'
    }

    /** Health (contract §1): `reply` = an assistant container exists (v2 `assistant` cascade + ASSISTANT_SELECTORS); `stop` = a visible stop button, null only without a stop cascade. */
    function health() {
      const composer = findComposer()
      const send = findSend()
      const stop = hasStopCascade() ? findStop() : null
      const reply = findFirst(assistantCascade().concat(ASSISTANT_SELECTORS))
      return {
        composer: composer !== null,
        send: send !== null,
        reply: reply !== null,
        stop: hasStopCascade() ? stop !== null : null,
        session: sessionState(),
        matched: {
          composer: composer ? composer.selector : null,
          send: send ? send.selector : null,
          reply: reply ? reply.selector : null,
          stop: stop ? stop.selector : null,
          error: null,
        },
        url: href(),
        host: host(),
        title: title(),
        ts: Math.round(clock()),
      }
    }

    function countDistinct(cascades) {
      const seen = new Set()
      const roots = openShadowRoots(document)
      for (const selector of cascades) {
        if (typeof selector !== 'string' || selector === '') continue
        for (const el of deepQuerySelectorAll(document, selector, roots)) seen.add(el)
      }
      return seen.size
    }

    const assistantCascade = () => (Array.isArray(sel.assistant) ? sel.assistant : [])

    /** See MESSAGE_SELECTORS: every rendered message, user and assistant (+ a v2 `assistant` cascade) — the submit-confirmation signal. */
    function countMessages() {
      return countDistinct(assistantCascade().concat(MESSAGE_SELECTORS))
    }

    /** See ASSISTANT_SELECTORS: assistant turns only (+ a v2 `assistant` cascade) — the `assistantCount` reported to main. */
    function countAssistant() {
      return countDistinct(assistantCascade().concat(ASSISTANT_SELECTORS))
    }

    /** Document-order comparator over compareDocumentPosition; 0 without the API (fakes keep insertion order). */
    function docOrder(a, b) {
      try {
        if (a === b || typeof a.compareDocumentPosition !== 'function') return 0
        const p = a.compareDocumentPosition(b)
        if (p & 4) return -1 // b follows a
        if (p & 2) return 1 // b precedes a
      } catch (_e) {
        /* fall through */
      }
      return 0
    }

    /** Every assistant container (the same set `countAssistant()` counts), de-duplicated, in document order. */
    function assistantContainers() {
      const seen = new Set()
      const out = []
      const roots = openShadowRoots(document)
      for (const selector of assistantCascade().concat(ASSISTANT_SELECTORS)) {
        if (typeof selector !== 'string' || selector === '') continue
        for (const el of deepQuerySelectorAll(document, selector, roots)) {
          if (seen.has(el)) continue
          seen.add(el)
          out.push(el)
        }
      }
      return out.length > 1 ? out.sort(docOrder) : out
    }

    /** `el` is `container` itself, inside it, or later in document order — an older turn's marker never counts. */
    function onOrAfter(container, el) {
      if (container === el) return true
      try {
        if (typeof container.contains === 'function' && container.contains(el)) return true
        if (typeof container.compareDocumentPosition === 'function') return (container.compareDocumentPosition(el) & 4) !== 0
      } catch (_e) {
        /* fall through */
      }
      return false
    }

    /** A visible `done` match on or after `container` (the "done selector on the last container"); null without a done cascade. */
    function findDone(container) {
      const cascade = nonEmptyCascade(sel.done)
      if (cascade.length === 0) return null
      return findFirst(cascade, { visible: true, accept: (el) => onOrAfter(container, el) })
    }

    /** A container's reply text: its first `assistantText` match, else the container itself, as rendered text (innerText, else textContent). */
    function replyText(container) {
      for (const selector of nonEmptyCascade(sel.assistantText)) {
        const hit = queryOne(container, selector)
        if (hit) return readText(hit)
      }
      return readText(container)
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

    /** A wall / challenge / banner that appeared meanwhile is the reason, not "no composer": throw it. */
    function throwIfRejected() {
      const state = sessionState()
      if (REJECT_STATES.includes(state)) throw stateError(state)
    }

    /** Wait for the composer to exist (every 150 ms up to `timeoutMs`, default `composerWaitMs`). */
    async function waitForComposer(timeoutMs, { signal } = {}) {
      const ms = nonNegativeInt(timeoutMs, nonNegativeInt(sel.composerWaitMs, 15000))
      const found = await poll(() => findComposer(), { intervalMs: SEND_POLL_MS, timeoutMs: ms, signal })
      if (!found) {
        throwIfRejected()
        throw new AdapterError('composer_not_found', `no composer within ${ms} ms (tried: ${cascadeText(sel.composer)})`)
      }
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
     * Idempotent: a composer that already holds exactly `text` (the leftover of a failed attempt —
     * nothing is ever cleared) is left alone and reported `already_present`, so a retry never
     * submits the prompt doubled. Otherwise each attempt is verified after INSERT_SETTLE_MS: the
     * composer must now hold the previous text followed by `text` (whitespace-insensitive — strictly
     * stronger than the §3 tail-20 rule, which it implies), so a no-op insertion is a failed attempt
     * and falls through to the next method, and finally to `site_error`.
     */
    async function insertText(text, { signal } = {}) {
      if (typeof text !== 'string') throw new AdapterError('site_error', 'insertText: text must be a string')
      const found = findComposer()
      if (!found) throw new AdapterError('composer_not_found', `no composer (tried: ${cascadeText(sel.composer)})`)
      const el = found.el
      const before = squash(readText(el))
      if (before === squash(text)) return { method: 'already_present' }
      const expected = before + squash(text)
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
        if (squash(readText(current ? current.el : el)) === expected) return true
        attempts.push(`${method}: ${threw ? `threw ${threw}` : ran ? 'ran' : 'did not run'}; the composer text is not the previous text followed by the inserted text`)
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

    /**
     * stop button | composer emptied | countMessages() grew, polled every 100 ms up to `verifyMs`.
     * The third signal keeps its contract name `assistant_count` (§2 `confirmedBy`) although it is
     * the message count (user turns included) that grows when a submission lands.
     */
    function confirmSubmission(verifyMs, baseline, signal) {
      return poll(
        () => {
          if (findStop()) return 'stop_button'
          const c = findComposer()
          if (c && isBlank(readText(c.el))) return 'composer_cleared'
          if (countMessages() > baseline) return 'assistant_count'
          return null
        },
        { intervalMs: CONFIRM_POLL_MS, timeoutMs: verifyMs, signal },
      )
    }

    /**
     * Submit what is in the composer (contract §3): poll the send cascade every 150 ms up to
     * `timeoutMs` (default `sendWaitMs`) for a visible, enabled button, click it and confirm within
     * `submitVerifyMs`; else one Enter on the composer and confirm again. `assistantCount` is the
     * `countAssistant()` sample (assistant turns only) taken immediately before the action that
     * confirmed; the confirmation baseline is the `countMessages()` sample taken at the same time.
     */
    async function submit(timeoutMs, { signal } = {}) {
      const waitMs = nonNegativeInt(timeoutMs, nonNegativeInt(sel.sendWaitMs, 18000))
      const verifyMs = nonNegativeInt(sel.submitVerifyMs, 5000)
      const button = await poll(() => findSendButton(), { intervalMs: SEND_POLL_MS, timeoutMs: waitMs, signal })
      let assistantCount = 0
      if (button) {
        const baseline = countMessages()
        assistantCount = countAssistant()
        clickEl(button.el)
        const confirmedBy = await confirmSubmission(verifyMs, baseline, signal)
        if (confirmedBy) return { method: 'click', sendSelector: button.selector, confirmedBy, assistantCount }
      }
      const composer = findComposer()
      if (composer) {
        const baseline = countMessages()
        assistantCount = countAssistant()
        pressEnter(composer.el)
        const confirmedBy = await confirmSubmission(verifyMs, baseline, signal)
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
        throwIfRejected()
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

    // ---- capture (Stage 2) ------------------------------------------------------------------

    /**
     * observe op (contract §2/§3): wait for a NEW assistant container beyond `baselineCount` (the
     * `assistantCount` main took from insertAndSubmit), then follow the LAST container until the
     * reply is done and resolve `{text, doneBy, ms}` with its final text — one text, at the end
     * (streaming re-renders are non-monotonic; Decision 16).
     *
     *   first token   a container beyond the baseline within `firstTokenMs` (capped by the budget),
     *                 else `reply_not_found`
     *   done          `done_selector`  a visible `done` match on or after the last container
     *                 `stop_gone`      a stop button was seen during this observe and is gone now
     *                 `quiet`          the text is non-blank and unchanged for `quietMs` while no stop
     *                                  button is visible (the only signal when stop + done are empty)
     *   budget        `timeoutMs` (default `captureTimeoutMs`) elapsed → `timeout` with the partial text
     *   session       a banner → `site_error` whose message is ONLY the configured phrase that matched;
     *                 a wall / challenge → `logged_out` / `challenge`; `cancelled` on abort — each with
     *                 the partial text when it is non-blank
     *   cadence       a MutationObserver on the document throttled to OBSERVE_THROTTLE_MS plus an
     *                 OBSERVE_POLL_MS poll (the poll alone where MutationObserver does not exist)
     *   text          the last container's first `assistantText` match, else the container itself,
     *                 as rendered text; CRLF → LF and NBSP → space, never trimmed
     * `quietMs` / `timeoutMs` / `firstTokenMs` in the message override the selectors; a missing
     * `baselineCount` means the current count.
     */
    function observe({ baselineCount, quietMs, timeoutMs, firstTokenMs, signal } = {}) {
      const t0 = clock()
      const baseline = nonNegativeInt(baselineCount, countAssistant())
      const quiet = nonNegativeInt(quietMs, nonNegativeInt(sel.quietMs, 2500))
      const budget = nonNegativeInt(timeoutMs, nonNegativeInt(sel.captureTimeoutMs, 300000))
      const firstToken = Math.min(nonNegativeInt(firstTokenMs, nonNegativeInt(sel.firstTokenMs, 90000)), budget)
      let container = null
      let text = ''
      let lastText = null
      let lastChangeAt = t0
      let seenStop = false
      const partial = () => (isBlank(text) ? undefined : text)

      /** One sample: throws the terminal AdapterError, returns the doneBy string, or null to keep going. */
      const check = () => {
        const now = clock()
        if (signal && signal.aborted) throw new AdapterError('cancelled', 'cancelled by main', partial())
        const state = sessionState()
        if (state === 'blocked') {
          const composer = findComposer()
          throw new AdapterError('site_error', matchedErrorPhrase(composer ? composer.el : null) || 'blocked', partial())
        }
        if (state === 'logged_out' || state === 'challenge') throw new AdapterError(state, stateError(state).message, partial())
        const containers = assistantContainers()
        if (containers.length > baseline) container = containers[containers.length - 1]
        if (!container) {
          if (now - t0 >= firstToken) {
            throw new AdapterError(
              'reply_not_found',
              `no assistant container beyond ${baseline} within ${firstToken} ms (tried: ${cascadeText(assistantCascade().concat(ASSISTANT_SELECTORS))})`,
            )
          }
          return null
        }
        text = normalizeText(replyText(container))
        if (text !== lastText) {
          lastText = text
          lastChangeAt = now
        }
        if (findDone(container)) return 'done_selector'
        if (findStop()) {
          seenStop = true
          lastChangeAt = now // the site says it is still replying: never quiet while the stop button shows
        } else if (seenStop) {
          return 'stop_gone'
        } else if (!isBlank(text) && now - lastChangeAt >= quiet) {
          return 'quiet'
        }
        if (now - t0 >= budget) throw new AdapterError('timeout', `the reply was still in progress after ${budget} ms`, text)
        return null
      }

      return new Promise((resolve, reject) => {
        let settled = false
        let throttle = null
        let pollTimer = null
        let mo = null
        const onAbort = () => settle(() => reject(new AdapterError('cancelled', 'cancelled by main', partial())))
        const cleanup = () => {
          if (mo) {
            try {
              mo.disconnect()
            } catch (_e) {
              /* ignore */
            }
            mo = null
          }
          if (throttle !== null) clearT(throttle)
          if (pollTimer !== null) clearT(pollTimer)
          throttle = pollTimer = null
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
        }
        function settle(fn) {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const run = () => {
          if (settled) return
          let doneBy = null
          try {
            doneBy = check()
          } catch (e) {
            settle(() => reject(e))
            return
          }
          if (doneBy) settle(() => resolve({ text, doneBy, ms: Math.round(clock() - t0) }))
        }
        const schedulePoll = () => {
          pollTimer = setT(() => {
            pollTimer = null
            run()
            if (!settled) schedulePoll()
          }, OBSERVE_POLL_MS)
        }
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort)
        const MO = ctor('MutationObserver')
        if (MO) {
          try {
            mo = new MO(() => {
              if (settled || throttle !== null) return
              throttle = setT(() => {
                throttle = null
                run()
              }, OBSERVE_THROTTLE_MS)
            })
            mo.observe(document, { childList: true, characterData: true, subtree: true, attributes: true })
          } catch (_e) {
            mo = null
          }
        }
        run()
        if (!settled) schedulePoll()
      })
    }

    /** snapshot op (contract §2): the scrubbed DOM — structure and selector-bearing attributes only, every text node `…`. */
    async function snapshot({ signal } = {}) {
      throwIfAborted(signal)
      return { html: scrubDom(document) }
    }

    /** Hot reload (config op): re-merge a full config onto the defaults, or take a bare block; anything else is ignored. */
    function setSelectors(next) {
      const resolved = resolveSelectors(next)
      if (resolved) sel = resolved
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
      countMessages,
      countAssistant,
      ready,
      url: href,
      setSelectors,
      // ---- Stage 2 --------------------------------------------------------------------------
      observe,
      snapshot,
      assistantContainers,
      replyText,
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
   * Messages that arrive before `adapter:config` settles are parked and replayed in order once
   * an adapter exists (dropped when the preload stays inert), so main never waits its full
   * budget for a request that landed during boot.
   * Returns `{ready: Promise<boolean>, dispose()}` (ready resolves true when an adapter was created).
   */
  function attachIpc(ipc, factory, { setInterval: setI = globalThis.setInterval, clearInterval: clearI = globalThis.clearInterval } = {}) {
    if (!ipc || typeof ipc.invoke !== 'function' || typeof ipc.on !== 'function' || typeof ipc.send !== 'function') {
      throw new Error('attachIpc: ipc must provide invoke/on/send')
    }
    let adapter = null
    let booting = true // adapter:config not answered yet: messages are parked in `backlog`
    const backlog = []
    let inFlight = null // {reqId, op, controller}
    let lastHealthKey = null
    let lastHealthAt = 0
    let timer = null
    let mutationObserver = null
    let mutationTimer = null
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
      if (op === 'observe') {
        const r = await adapter.observe({ ...msg, signal })
        return { ...r, url: adapter.url() }
      }
      if (op === 'snapshot') return adapter.snapshot({ signal })
      throw new AdapterError('site_error', `unknown op ${String(op)}`)
    }

    const handle = (msg) => {
      if (disposed || !msg || typeof msg !== 'object') return
      if (booting) {
        backlog.push(msg)
        return
      }
      if (!adapter) return
      const op = msg.op
      if (op === 'config') {
        // hot reload (Stage 2): re-merge the selectors, re-run health, no reply
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

    /** Boot is over: replay the parked messages in order when an adapter exists, drop them otherwise. */
    const settle = (created) => {
      booting = false
      const queued = backlog.splice(0)
      if (created) for (const msg of queued) handle(msg)
      return created
    }

    const ready = Promise.resolve()
      .then(() => ipc.invoke('adapter:config'))
      .then((config) => {
        if (disposed) return false
        if (!config || typeof config !== 'object' || config.site === null || config.site === undefined) return false
        adapter = factory(config)
        if (!adapter) return false
        publishHealth(true)
        timer = setI(() => publishHealth(false), HEALTH_POLL_MS)
        // DOM changes (a stop button appearing/disappearing, a login wall) refresh main's cache
        // within HEALTH_MUTATION_THROTTLE_MS instead of waiting for the poll; guarded for node tests.
        try {
          const MO = typeof globalThis.MutationObserver === 'function' ? globalThis.MutationObserver : null
          const doc = typeof globalThis.document === 'object' && globalThis.document ? globalThis.document : null
          if (MO && doc && doc.documentElement) {
            mutationObserver = new MO(() => {
              if (mutationTimer !== null || disposed) return
              mutationTimer = globalThis.setTimeout(() => {
                mutationTimer = null
                publishHealth(false)
              }, HEALTH_MUTATION_THROTTLE_MS)
            })
            mutationObserver.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class', 'style', 'hidden', 'aria-label', 'data-testid'] })
          }
        } catch (_e) {
          /* no DOM here (unit tests) */
        }
        return true
      })
      .catch(() => false)
      .then(settle)

    return {
      ready,
      dispose() {
        disposed = true
        if (mutationObserver) {
          try {
            mutationObserver.disconnect()
          } catch (_e) {
            /* ignore */
          }
          mutationObserver = null
        }
        if (mutationTimer !== null) {
          globalThis.clearTimeout(mutationTimer)
          mutationTimer = null
        }
        backlog.length = 0
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
      ASSISTANT_SELECTORS,
      ALERT_SELECTORS,
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
      scrubDom,
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
      OBSERVE_THROTTLE_MS,
      OBSERVE_POLL_MS,
      SNAPSHOT_DROP_TAGS,
      SNAPSHOT_KEEP_ATTRS,
    }
  }

  if (shouldBoot()) boot()
})()
