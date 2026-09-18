// Test fakes for the desktop renderer (not a test file: vitest only collects *.test.{js,jsx}).
//
// fakeTriplex()  — the `window.triplex` surface of desktop/preload/renderer.cjs (contract §2,
//                  Stage 1 + Stage 2: getCapture/setCapture/onBridge/onTurn/openChats/signOut/
//                  saveDomSnapshot; `sendPrompt` is gone; Stage 3: setAnalyst/showAnalyst/onAnalyst;
//                  Theme: setTheme/onTheme)
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
import { vi } from 'vitest'

export const RECTS = {
  claude: { x: 0, y: 40, width: 500, height: 600 },
  chatgpt: { x: 500, y: 40, width: 500, height: 600 },
  grok: { x: 1000, y: 40, width: 500, height: 600 },
}

export const CHANNELS = ['health', 'shortcut', 'zoom', 'bridge', 'turn', 'analyst', 'theme']

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
    saveDomSnapshot: vi.fn(async () => ({ path: '/tmp/snapshot.html' })),
    // Stage 3
    setAnalyst: vi.fn(async () => {}),
    showAnalyst: vi.fn(async () => {}),
    onAnalyst: subscribe('analyst'),
    // Theme (main's settings.json is authoritative; getInfo carries it, onTheme announces changes)
    setTheme: vi.fn(async (theme) => ({ theme })),
    onTheme: subscribe('theme'),
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

export function conv(over = {}) {
  return {
    schema_version: 1,
    id: 'c1',
    title: 'New conversation',
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
    slot_config: CFG,
    threads: { claude: [], chatgpt: [], grok: [] },
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

/** A stream whose chunks the test serves by hand: `push(events)` = one chunk, `end()` closes it. */
export function controlledStream() {
  const queue = []
  let waiter = null
  const serve = (item) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(item)
    } else queue.push(item)
  }
  const response = {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (waiter = r))),
        cancel: async () => {},
        releaseLock() {},
      }),
    },
  }
  return {
    response,
    push: (events) => serve({ value: new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), done: false }),
    end: () => serve({ value: undefined, done: true }),
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
      return typeof r.respond === 'function' ? r.respond({ method, url, body }) : r.respond
    }),
  )
  return calls
}

export const seqOf = (calls) => calls.map((c) => `${c.method} ${c.url}`)
