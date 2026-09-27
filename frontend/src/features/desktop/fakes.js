// Test fakes for the desktop renderer (not a test file: vitest only collects *.test.{js,jsx}).
//
// fakeTriplex()  — the `window.triplex` surface of desktop/preload/renderer.cjs (contract §2,
//                  Stage 1 + Stage 2: getCapture/setCapture/onBridge/onTurn/openChats/signOut/
//                  saveDomSnapshot; `sendPrompt` is gone; Stage 3: setAnalyst/showAnalyst/onAnalyst;
//                  Theme: setTheme/onTheme; Council (2026-09-27): sites, getCouncil/setCouncil/
//                  onCouncil, getOpenRouterKey/setOpenRouterKey/onOpenRouterKey — `getCouncil` answers
//                  the three web panes, `getOpenRouterKey` "not configured"; `emit.council(spec)` /
//                  `emit.openRouterKey(status)` drive the subscriptions)
//                  with vi.fn() methods; `emit.health(slot, h)`
//                  / `emit.shortcut(name)` / `emit.zoom({slot, factor})` / `emit.bridge({connected})`
//                  / `emit.turn({slot, phase})` / `emit.analyst({slot, visible, health})` drive the
//                  subscribed callbacks; `unsubscribed` counts the returned unsubscribe calls per channel.
// installFakeResizeObserver() — a ResizeObserver whose instances are collected in `.instances`;
//                  `triggerResize()` calls every live observer's callback.
// syncFrames()   — requestAnimationFrame that runs the callback synchronously (so the
//                  rAF-throttled setLayout fires inside the effect that scheduled it).
// mockRect(el, rect) — pins getBoundingClientRect() for one element (jsdom measures 0×0).
// Stage 2 (the prompt bar posts a Triplex Send): `stubFetch(routes)`, `jsonResponse`,
// `sseResponse(events)`, `controlledStream()`, `conv(over)` and `CFG` — the stubbed-fetch harness
// of features/send/useSendTurn.test.jsx / SendPane.test.jsx, so the desktop specs drive the real
// api/http.js + api/sse.js + useSendTurn.js against canned responses.
// Pre-parse (2026-09-23): `preparse.start/retry/done/degraded/stream` build the events of a
//                  `POST …/preparse` stream in the shapes backend/features/preparse.py sends;
//                  `controlledStream().bind(signal)` makes a pending read reject with AbortError when
//                  the fetch is aborted, as a browser's reader does (the Cancel button's path) —
//                  `stubFetch` hands the route's `respond` the request's `signal` for that.
import { vi } from 'vitest'

export const RECTS = {
  claude: { x: 0, y: 40, width: 500, height: 600 },
  chatgpt: { x: 500, y: 40, width: 500, height: 600 },
  grok: { x: 1000, y: 40, width: 500, height: 600 },
}

export const CHANNELS = ['health', 'shortcut', 'zoom', 'bridge', 'turn', 'analyst', 'theme', 'council', 'openRouterKey']

/** Main's key status when no key is stored (the shape of `getOpenRouterKey` / `panes:openRouterKey`). */
export const KEY_UNSET = { configured: false, prefix: '', length: 0, pushed: false }
/** …and when one is (a 73-char `sk-or-v1-…` key, pushed to the backend). */
export const KEY_SET = { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: true }

/** A rect for the analyst viewport (tests pass `{...RECTS, analyst: ANALYST_RECT}` to pinViewportRects). */
export const ANALYST_RECT = { x: 1500, y: 40, width: 400, height: 600 }

export function fakeTriplex(over = {}) {
  const listeners = {}
  const unsubscribed = {}
  for (const c of CHANNELS) {
    listeners[c] = new Set()
    unsubscribed[c] = 0
  }
  const subscribe = (channel) =>
    vi.fn((cb) => {
      listeners[channel].add(cb)
      return () => {
        listeners[channel].delete(cb)
        unsubscribed[channel] += 1
      }
    })
  const api = {
    version: '0.1.0',
    slots: ['claude', 'chatgpt', 'grok'],
    sites: ['claude', 'chatgpt', 'grok'],
    getInfo: vi.fn(async () => ({ version: '0.1.0', dev: true, sites: {}, backend: null, layout: null })),
    setLayout: vi.fn(),
    setActive: vi.fn(),
    newChat: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    inspect: vi.fn(async () => {}),
    focusPane: vi.fn(async () => {}),
    zoom: vi.fn(async (_slot, direction) => ({ factor: direction === 'in' ? 1.1 : direction === 'out' ? 0.9 : 1 })),
    onHealth: subscribe('health'),
    onShortcut: subscribe('shortcut'),
    onZoom: subscribe('zoom'),
    // Stage 2. `getCapture` hands the map back synchronously so the many synchronous specs stay
    // act()-clean (the preload's promise shape is covered by the capture specs with an async fake).
    getCapture: vi.fn(() => ({ claude: false, chatgpt: false, grok: false })),
    setCapture: vi.fn(async () => {}),
    onBridge: subscribe('bridge'),
    onTurn: subscribe('turn'),
    openChats: vi.fn(async () => ({ claude: 'kept', chatgpt: 'kept', grok: 'kept' })),
    signOut: vi.fn(async () => {}),
  exportTurn: vi.fn(async () => ({ cancelled: false, formats: ['md'], files: { md: '/tmp/x.md' }, paths: ['/tmp/x.md'], defaultName: 'x' })),
    saveDomSnapshot: vi.fn(async () => ({ path: '/tmp/snapshot.html' })),
    // Stage 3
    setAnalyst: vi.fn(async () => {}),
    showAnalyst: vi.fn(async () => {}),
    onAnalyst: subscribe('analyst'),
    // Theme (main's settings.json is authoritative; getInfo carries it, onTheme announces changes)
    setTheme: vi.fn(async (theme) => ({ theme })),
    onTheme: subscribe('theme'),
    // Council (2026-09-27): main's default council for new conversations and the key status.
    getCouncil: vi.fn(async () => ({ slots: { ...CFG.slots } })),
    setCouncil: vi.fn(async (spec) => spec),
    onCouncil: subscribe('council'),
    getOpenRouterKey: vi.fn(async () => KEY_UNSET),
    setOpenRouterKey: vi.fn(async (key) => (key ? KEY_SET : KEY_UNSET)),
    onOpenRouterKey: subscribe('openRouterKey'),
    ...over,
  }
  api.listeners = listeners
  api.unsubscribed = unsubscribed
  api.emit = {
    health: (slot, h) => {
      for (const cb of [...listeners.health]) cb(slot, h)
    },
    shortcut: (name) => {
      for (const cb of [...listeners.shortcut]) cb(typeof name === 'string' ? { name } : name)
    },
    zoom: (msg) => {
      for (const cb of [...listeners.zoom]) cb(msg)
    },
    bridge: (msg) => {
      for (const cb of [...listeners.bridge]) cb(msg)
    },
    turn: (msg) => {
      for (const cb of [...listeners.turn]) cb(msg)
    },
    analyst: (msg) => {
      for (const cb of [...listeners.analyst]) cb(msg)
    },
    theme: (msg) => {
      for (const cb of [...listeners.theme]) cb(msg)
    },
    council: (msg) => {
      for (const cb of [...listeners.council]) cb(msg)
    },
    openRouterKey: (msg) => {
      for (const cb of [...listeners.openRouterKey]) cb(msg)
    },
  }
  return api
}

export function health(over = {}) {
  return {
    composer: true,
    send: true,
    reply: null,
    stop: null,
    session: 'ok',
    matched: { composer: '#prompt-textarea', send: "button[data-testid='send-button']", reply: null, stop: null, error: null },
    url: 'https://chatgpt.com/',
    host: 'chatgpt.com',
    title: 'ChatGPT',
    ts: 1,
    ...over,
  }
}

export function installFakeResizeObserver() {
  const instances = []
  class FakeResizeObserver {
    constructor(cb) {
      this.cb = cb
      this.targets = new Set()
      this.alive = true
      instances.push(this)
    }
    observe(el) {
      this.targets.add(el)
    }
    unobserve(el) {
      this.targets.delete(el)
    }
    disconnect() {
      this.targets.clear()
      this.alive = false
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return {
    instances,
    triggerResize() {
      for (const ro of instances) if (ro.alive) ro.cb([...ro.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() })), ro)
    },
  }
}

export function syncFrames() {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb) => {
      cb(0)
      return 1
    }),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

export function mockRect(el, rect) {
  el.getBoundingClientRect = () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height })
}

/**
 * Pin getBoundingClientRect on the prototype BEFORE render so the very first layout report already
 * measures: `pane-<slot>-viewport` elements return `rects[slot]` (the analyst viewport
 * `rects.analyst`, S3), everything else 0×0.
 * Undone by vi.restoreAllMocks(); call again with new rects to simulate a resize.
 */
export function pinViewportRects(rects = RECTS) {
  const zero = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measure() {
    const id = typeof this.getAttribute === 'function' ? this.getAttribute('data-testid') : null
    const m = /^pane-(claude|chatgpt|grok|analyst)-viewport$/.exec(id || '')
    const rect = m && rects[m[1]]
    return rect ? { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height } : zero
  })
}

// ---------------------------------------------------------------------------------------------
// Stubbed-fetch harness (Stage 2)
// ---------------------------------------------------------------------------------------------

export const CFG = {
  slots: {
    claude: { model: 'web:claude', effort: 'off' },
    chatgpt: { model: 'web:chatgpt', effort: 'off' },
    grok: { model: 'web:grok', effort: 'off' },
  },
  analyst_model: 'web:chatgpt:analyst',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

/** A five-member council: the three web panes plus Gemini on OpenRouter and Qwen on local Ollama (mixed transports). */
export const CFG5 = {
  slots: {
    claude: { model: 'web:claude', effort: 'off' },
    chatgpt: { model: 'web:chatgpt', effort: 'off' },
    grok: { model: 'web:grok', effort: 'off' },
    gemini: { model: 'google/gemini-2.5-pro', effort: 'medium' },
    qwen: { model: 'ollama:qwen3', effort: 'off' },
  },
  analyst_model: 'web:chatgpt:analyst',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

/** A two-member council with no site at all: two token agents. */
export const CFG2 = {
  slots: {
    chatgpt: { model: 'openai/gpt-5', effort: 'medium' },
    qwen: { model: 'qwen/qwen3-235b-a22b', effort: 'off' },
  },
  analyst_model: 'openai/gpt-5',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

/**
 * The desktop `GET /api/models` catalog with `raw.transport` (backend/llm/webmodels.py): the web
 * panes and hidden analyst pages, a local Ollama model, and — once a key is configured — OpenRouter
 * entries whose vendor is the slug prefix.
 */
export const DESKTOP_CATALOG = [
  { id: 'web:claude', name: 'Claude (web session)', vendor: 'anthropic', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:chatgpt', name: 'ChatGPT (web session)', vendor: 'openai', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:grok', name: 'Grok (web session)', vendor: 'x-ai', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:claude:analyst', name: 'Claude web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:chatgpt:analyst', name: 'ChatGPT web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'web:grok:analyst', name: 'Grok web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false, raw: { transport: 'web' } },
  { id: 'ollama:hermes3', name: 'hermes3 (local Ollama)', vendor: 'ollama', efforts: ['off'], structured_outputs: false, raw: { transport: 'ollama' } },
  { id: 'ollama:qwen3', name: 'qwen3 (local Ollama)', vendor: 'ollama', efforts: ['off'], structured_outputs: false, raw: { transport: 'ollama' } },
  { id: 'openai/gpt-5', name: 'GPT-5', vendor: 'openai', efforts: ['low', 'medium', 'high'], structured_outputs: true, raw: { transport: 'openrouter' } },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'google', efforts: ['low', 'medium', 'high'], structured_outputs: true, raw: { transport: 'openrouter' } },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', vendor: 'deepseek', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', vendor: 'qwen', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash', vendor: 'xiaomi', efforts: ['off', 'low', 'medium', 'high'], structured_outputs: false, raw: { transport: 'openrouter' } },
]

/** The `models` slice loaded with DESKTOP_CATALOG (or any item list). */
export function modelsState(items = DESKTOP_CATALOG) {
  const byId = {}
  for (const m of items) byId[m.id] = m
  return { items, byId, loaded: true, error: null }
}

export function conv(over = {}) {
  const cfg = over.slot_config || CFG
  const threads = {}
  for (const slot of Object.keys(cfg.slots)) threads[slot] = []
  return {
    schema_version: 1,
    id: 'c1',
    title: 'New conversation',
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
    slot_config: cfg,
    threads,
    turns: [],
    ...over,
  }
}

export function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

/** One SSE response whose whole body is served in a single chunk, then closed. */
export function sseResponse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  const chunks = [new TextEncoder().encode(text)]
  let i = 0
  return {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
        cancel: async () => {},
        releaseLock() {},
      }),
    },
  }
}

/** The rejection a browser's `reader.read()` produces once the fetch's signal is aborted. */
function abortError() {
  return typeof DOMException === 'function' ? new DOMException('The operation was aborted.', 'AbortError') : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

/**
 * A stream whose chunks the test serves by hand: `push(events)` = one chunk, `end()` closes it.
 * `bind(signal)` (optional) ties it to the request's AbortSignal: a pending read rejects with
 * AbortError when the signal fires, and every later read too.
 */
export function controlledStream() {
  const queue = []
  let waiter = null
  let aborted = false
  const serve = (item) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve(item)
    } else queue.push(item)
  }
  const response = {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: () => {
          if (aborted) return Promise.reject(abortError())
          return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => (waiter = { resolve, reject }))
        },
        cancel: async () => {},
        releaseLock() {},
      }),
    },
  }
  return {
    response,
    push: (events) => serve({ value: new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), done: false }),
    end: () => serve({ value: undefined, done: true }),
    bind: (signal) => {
      if (!signal || typeof signal.addEventListener !== 'function') return
      signal.addEventListener('abort', () => {
        aborted = true
        if (waiter) {
          const w = waiter
          waiter = null
          w.reject(abortError())
        }
      })
    },
  }
}

/** Route stubbed fetch calls by method + url; records every call in order. */
export function stubFetch(routes) {
  const calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase()
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const r = routes.find((x) => x.method === method && (x.url instanceof RegExp ? x.url.test(url) : x.url === url))
      if (!r) throw new TypeError(`fetch failed: unstubbed ${method} ${url}`)
      return typeof r.respond === 'function' ? r.respond({ method, url, body, signal: init.signal }) : r.respond
    }),
  )
  return calls
}

export const seqOf = (calls) => calls.map((c) => `${c.method} ${c.url}`)

// ---------------------------------------------------------------------------------------------
// Pre-parse (2026-09-23): the events of one `POST …/preparse` stream
// ---------------------------------------------------------------------------------------------

/** The progress narration backend/features/preparse.py sends as preparse_retry{error} (its NOTICE). */
export const PREPARSE_NOTICE = 'restating the question concisely'
/**
 * Stands in for the backend's answer-format block (backend/prompts/preparse.py ANSWER_FORMAT): the
 * composed prompt looks like the real thing without pinning that text here — the desktop app spec
 * checks the real one through the fake site.
 */
export const ANSWER_FORMAT_STANDIN =
  'Answer format, follow it exactly:\nFirst, one paragraph that answers the question directly.\nThen a line "Key claims:" and a numbered list of at most 8 claims.\nThen a line "Uncertain:" and one sentence.'

const preparseUsage = () => ({ calls: [], totals: { prompt_tokens: 120, completion_tokens: 40, reasoning_tokens: 0, cost_usd: 0, latency_ms: 47000, calls: 1 } })

export const preparse = {
  start: () => ({ type: 'preparse_start' }),
  retry: (error = PREPARSE_NOTICE) => ({ type: 'preparse_retry', error }),
  /** `prompt` defaults to the restated question with the answer block appended, as `compose()` builds it. */
  done: ({ question = 'What is the capital of Australia?', original = question, prompt = `${question}\n\n${ANSWER_FORMAT_STANDIN}` } = {}) => ({
    type: 'preparse_done',
    prompt,
    original,
    question,
    usage: preparseUsage(),
  }),
  degraded: ({ error = 'parse_error', original = 'draft', raw_attempts = [''] } = {}) => ({ type: 'preparse_degraded', error, original, raw_attempts, usage: preparseUsage() }),
  /** start → the notice → done: one whole successful stream, for `sseResponse`. */
  stream: (over) => [preparse.start(), preparse.retry(), preparse.done(over)],
}
