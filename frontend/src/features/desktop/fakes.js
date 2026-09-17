// Test fakes for the desktop renderer (not a test file: vitest only collects *.test.{js,jsx}).
//
// fakeTriplex()  — the `window.triplex` surface of desktop/preload/renderer.cjs (contract §2,
//                  Stage 1) with vi.fn() methods; `emit.health(slot, h)` / `emit.shortcut(name)` /
//                  `emit.zoom({slot, factor})` drive the subscribed callbacks; `unsubscribed`
//                  counts the returned unsubscribe calls per channel.
// installFakeResizeObserver() — a ResizeObserver whose instances are collected in `.instances`;
//                  `triggerResize()` calls every live observer's callback.
// syncFrames()   — requestAnimationFrame that runs the callback synchronously (so the
//                  rAF-throttled setLayout fires inside the effect that scheduled it).
// mockRect(el, rect) — pins getBoundingClientRect() for one element (jsdom measures 0×0).
import { vi } from 'vitest'

export const RECTS = {
  claude: { x: 0, y: 40, width: 500, height: 600 },
  chatgpt: { x: 500, y: 40, width: 500, height: 600 },
  grok: { x: 1000, y: 40, width: 500, height: 600 },
}

export function fakeTriplex(over = {}) {
  const listeners = { health: new Set(), shortcut: new Set(), zoom: new Set() }
  const unsubscribed = { health: 0, shortcut: 0, zoom: 0 }
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
    sendPrompt: vi.fn(async ({ targets }) => {
      const results = {}
      for (const slot of targets) results[slot] = { ok: true, ms: 1234, composerSelector: '#prompt-textarea', sendSelector: "button[data-testid='send-button']", url: `https://${slot}.example/c/1` }
      return { results }
    }),
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
 * measures: `pane-<slot>-viewport` elements return `rects[slot]`, everything else 0×0.
 * Undone by vi.restoreAllMocks(); call again with new rects to simulate a resize.
 */
export function pinViewportRects(rects = RECTS) {
  const zero = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measure() {
    const id = typeof this.getAttribute === 'function' ? this.getAttribute('data-testid') : null
    const m = /^pane-(claude|chatgpt|grok)-viewport$/.exec(id || '')
    const rect = m && rects[m[1]]
    return rect ? { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height } : zero
  })
}
