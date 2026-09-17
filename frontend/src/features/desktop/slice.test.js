import { afterEach, describe, expect, test, vi } from 'vitest'
import './index.jsx' // registers the `panes` slice next to the core ones
import { initialState, rootReducer } from '../../state/registry.js'
import {
  ATTENTION_SESSIONS,
  PERSIST_KEYS,
  SLOT_IDS,
  healthLevel,
  healthText,
  healthTitle,
  initialPanes,
  loadPersistedPanes,
  needsAttention,
  panesReducer,
  persistPanes,
  resultNeedsAttention,
  selectedTargets,
  sessionOf,
  sessionText,
} from './slice.js'
import { health } from './fakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

describe('panes slice: shape and reducer', () => {
  test('initial state matches contract §7 and accepts persisted overrides key by key', () => {
    const s = initialPanes()
    expect(s.mode).toBe('split')
    expect(s.active).toBe('chatgpt')
    expect(s.targets).toEqual({ claude: true, chatgpt: true, grok: true })
    expect(s.sending).toBe(false)
    const r = initialPanes({ mode: 'tabs', active: 'grok', targets: { claude: false, grok: 'yes' } })
    expect(r.mode).toBe('tabs')
    expect(r.active).toBe('grok')
    expect(r.targets).toEqual({ claude: false, chatgpt: true, grok: true })
    const bad = initialPanes({ mode: 'stack', active: 'gemini', targets: 'x' })
    expect(bad.mode).toBe('split')
    expect(bad.active).toBe('chatgpt')
    expect(bad.targets).toEqual({ claude: true, chatgpt: true, grok: true })
  })

  test('no-op actions and malformed payloads return the same object', () => {
    const s = initialPanes()
    for (const a of [
      { type: 'panes/mode', mode: 'split' },
      { type: 'panes/mode', mode: 'stack' },
      { type: 'panes/active', active: 'chatgpt' },
      { type: 'panes/active', active: 'gemini' },
      { type: 'panes/target', slot: 'claude', on: true },
      { type: 'panes/target', slot: 'nope', on: false },
      { type: 'panes/health', slot: 'gemini', health: health() },
      { type: 'panes/health', slot: 'claude', health: null },
      { type: 'panes/sendResult', results: {} },
      { type: 'panes/sendResult', results: { gemini: { ok: true } } },
      { type: 'panes/zoom', slot: 'claude', factor: 1 },
      { type: 'panes/zoom', slot: 'claude', factor: -1 },
      { type: 'panes/zoom', slot: 'claude', factor: 'big' },
      { type: 'panes/turn', slot: 'claude', phase: 42 },
      { type: 'something/else' },
    ]) {
      expect(panesReducer(s, a)).toBe(s)
    }
  })

  test('sendStart clears the targets it names and sets sending; sendResult stores per-slot results', () => {
    let s = panesReducer(initialPanes(), { type: 'panes/sendResult', results: { claude: { ok: true, ms: 10 }, grok: { ok: false, code: 'send_not_found', ms: 0 } } })
    expect(s.sending).toBe(false)
    expect(Object.keys(s.lastSend)).toEqual(['claude', 'grok'])
    const started = panesReducer(s, { type: 'panes/sendStart', targets: ['claude'] })
    expect(started.sending).toBe(true)
    expect(started.lastSend).toEqual({ grok: { ok: false, code: 'send_not_found', ms: 0 } })
    // an omitted target list clears everything
    const all = panesReducer(s, { type: 'panes/sendStart' })
    expect(all.lastSend).toEqual({})
    // a second sendStart while sending with nothing to clear is a no-op
    expect(panesReducer(started, { type: 'panes/sendStart', targets: ['claude'] })).toBe(started)
    const done = panesReducer(started, { type: 'panes/sendResult', results: { claude: { ok: true, ms: 1200, composerSelector: '#prompt-textarea' } } })
    expect(done.sending).toBe(false)
    expect(done.lastSend.claude.composerSelector).toBe('#prompt-textarea')
    expect(done.lastSend.grok).toBe(s.lastSend.grok)
  })

  test('health / zoom / target updates keep the untouched per-slot maps and keys by identity', () => {
    const s = initialPanes()
    const h = health()
    const withHealth = panesReducer(s, { type: 'panes/health', slot: 'chatgpt', health: h })
    expect(withHealth.health.chatgpt).toBe(h)
    expect(withHealth.zoom).toBe(s.zoom)
    expect(withHealth.targets).toBe(s.targets)
    expect(withHealth.lastSend).toBe(s.lastSend)
    const zoomed = panesReducer(withHealth, { type: 'panes/zoom', slot: 'grok', factor: 1.1 })
    expect(zoomed.zoom).toEqual({ claude: 1, chatgpt: 1, grok: 1.1 })
    expect(zoomed.health).toBe(withHealth.health)
    const untargeted = panesReducer(zoomed, { type: 'panes/target', slot: 'claude', on: false })
    expect(untargeted.targets).toEqual({ claude: false, chatgpt: true, grok: true })
    expect(untargeted.zoom).toBe(zoomed.zoom)
    // a stale health drop-out (null) is stored as null
    expect(panesReducer(withHealth, { type: 'panes/health', slot: 'chatgpt', health: 'gone' }).health.chatgpt).toBe(null)
  })

  test('slice identity across the root reducer: other slices untouched, no-op leaves the root state', () => {
    const state = initialState()
    const same = rootReducer(state, { type: 'panes/mode', mode: state.panes.mode })
    expect(same).toBe(state)
    const next = rootReducer(state, { type: 'panes/active', active: 'claude' })
    expect(next).not.toBe(state)
    expect(next.panes.active).toBe('claude')
    expect(next.panes.health).toBe(state.panes.health)
    expect(next.panes.targets).toBe(state.panes.targets)
    for (const key of Object.keys(state)) if (key !== 'panes') expect(next[key]).toBe(state[key])
    // and a Send-stream action leaves the panes slice alone
    const streamed = rootReducer(next, { type: 'sse/start', feature: 'send' })
    expect(streamed.panes).toBe(next.panes)
  })
})

describe('panes slice: derivations', () => {
  test('selectedTargets keeps SLOT order and drops unknown keys', () => {
    expect(selectedTargets({ grok: true, claude: true, chatgpt: false, gemini: true })).toEqual(['claude', 'grok'])
    expect(selectedTargets(null)).toEqual([])
  })

  test('session helpers', () => {
    expect(sessionOf(null)).toBe('unknown')
    expect(sessionOf(health({ session: 'blocked' }))).toBe('blocked')
    expect(sessionOf({ session: 7 })).toBe('unknown')
    for (const s of ATTENTION_SESSIONS) expect(needsAttention(s)).toBe(true)
    expect(needsAttention('ok')).toBe(false)
    expect(needsAttention('unknown')).toBe(false)
    expect(resultNeedsAttention({ ok: false, code: 'logged_out' })).toBe(true)
    expect(resultNeedsAttention({ ok: true, code: 'logged_out' })).toBe(false)
    expect(resultNeedsAttention({ ok: false, code: 'send_not_found' })).toBe(false)
    expect(resultNeedsAttention(undefined)).toBe(false)
    expect(sessionText('ok')).toBe('signed in')
    expect(sessionText('logged_out')).toBe('signed out')
    expect(sessionText('weird')).toBe('unknown')
  })

  test('healthLevel: none / bad / warn / ok', () => {
    expect(healthLevel(null)).toBe('none')
    expect(healthLevel(health())).toBe('ok')
    expect(healthLevel(health({ send: false }))).toBe('warn')
    expect(healthLevel(health({ composer: false, send: false }))).toBe('bad')
    expect(healthLevel(health({ session: 'challenge' }))).toBe('bad')
  })

  test('healthText and healthTitle', () => {
    expect(healthText(null)).toBe('no health yet')
    expect(healthText(health())).toBe('composer ✓ send ✓ · signed in')
    expect(healthText(health({ send: false, session: 'logged_out' }))).toBe('composer ✓ send ✗ · signed out')
    const title = healthTitle(health())
    expect(title).toContain('composer: #prompt-textarea')
    expect(title).toContain("send: button[data-testid='send-button']")
    expect(title).toContain('url: https://chatgpt.com/')
    expect(healthTitle(health({ matched: { composer: null, send: null, error: 'bad selectors.json' } }))).toContain('composer: none')
    expect(healthTitle(health({ matched: { composer: null, send: null, error: 'bad selectors.json' } }))).toContain('error: bad selectors.json')
    expect(healthTitle(null)).toMatch(/no health/)
  })
})

describe('panes slice: localStorage persistence', () => {
  test('round-trips mode / active / targets through the three renderer-owned keys', () => {
    const storage = memoryStorage()
    persistPanes(storage, { ...initialPanes(), mode: 'tabs', active: 'grok', targets: { claude: false, chatgpt: true, grok: true } })
    expect(storage.dump()).toEqual({
      [PERSIST_KEYS.mode]: 'tabs',
      [PERSIST_KEYS.active]: 'grok',
      [PERSIST_KEYS.targets]: JSON.stringify({ claude: false, chatgpt: true, grok: true }),
    })
    expect(loadPersistedPanes(storage)).toEqual({ mode: 'tabs', active: 'grok', targets: { claude: false, chatgpt: true, grok: true } })
    expect(initialPanes(loadPersistedPanes(storage)).mode).toBe('tabs')
  })

  test('invalid stored values are ignored and a throwing storage never propagates', () => {
    const junk = memoryStorage({ [PERSIST_KEYS.mode]: 'stack', [PERSIST_KEYS.active]: 'gemini', [PERSIST_KEYS.targets]: '{not json' })
    expect(loadPersistedPanes(junk)).toEqual({})
    const partial = memoryStorage({ [PERSIST_KEYS.targets]: JSON.stringify({ claude: 'no', grok: false }) })
    expect(loadPersistedPanes(partial)).toEqual({ targets: { grok: false } })
    const broken = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadPersistedPanes(broken)).toEqual({})
    expect(() => persistPanes(broken, initialPanes())).not.toThrow()
    expect(loadPersistedPanes(null)).toEqual({})
    expect(() => persistPanes(null, initialPanes())).not.toThrow()
  })

  test('defaults to the global localStorage and survives one that throws on access', () => {
    localStorage.setItem(PERSIST_KEYS.mode, 'tabs')
    expect(loadPersistedPanes().mode).toBe('tabs')
    persistPanes(undefined, { ...initialPanes(), mode: 'split' })
    expect(localStorage.getItem(PERSIST_KEYS.mode)).toBe('split')
    localStorage.clear()
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    })
    expect(loadPersistedPanes()).toEqual({})
    expect(() => persistPanes(undefined, initialPanes())).not.toThrow()
  })

  test('SLOT_IDS is the contract order', () => {
    expect(SLOT_IDS).toEqual(['claude', 'chatgpt', 'grok'])
  })
})
