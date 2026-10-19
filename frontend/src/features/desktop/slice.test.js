import { afterEach, describe, expect, test, vi } from 'vitest'
import './index.jsx' // registers the `panes` slice next to the core ones
import { initialState, rootReducer } from '../../state/registry.js'
import {
  ATTENTION_SESSIONS,
  CAPTURE_NOTICE_KEY,
  CAPTURE_NOTICE_TEXT,
  CLASSIC_SITES,
  DRAWER_TAB_KEYS,
  NOT_CAPTURED,
  NOT_CAPTURED_MESSAGE_PREFIX,
  PERSIST_KEYS,
  DEFAULT_COUNCIL,
  SITES,
  SLOT_IDS,
  allCaptureTouched,
  healthLevel,
  healthText,
  healthTitle,
  initialPanes,
  loadCaptureTouched,
  loadPersistedPanes,
  needsAttention,
  notCapturedSlots,
  panesReducer,
  persistCaptureTouched,
  persistPanes,
  phaseText,
  resultNeedsAttention,
  selectedTargets,
  sendOutcome,
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
    const bad = initialPanes({ mode: 'stack', active: 'bing', targets: 'x' })
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
      { type: 'panes/active', active: 'bing' },
      { type: 'panes/target', slot: 'claude', on: true },
      { type: 'panes/target', slot: 'nope', on: false },
      { type: 'panes/health', slot: 'bing', health: health() },
      { type: 'panes/health', slot: 'qwen', health: health() }, // a catalog vendor without a site: no health map entry
      { type: 'panes/health', slot: 'claude', health: null },
      { type: 'panes/sendResult', results: {} },
      { type: 'panes/sendResult', results: { bing: { ok: true } } },
      { type: 'panes/zoom', slot: 'claude', factor: 1 },
      { type: 'panes/zoom', slot: 'claude', factor: -1 },
      { type: 'panes/zoom', slot: 'claude', factor: 'big' },
      { type: 'panes/turn', slot: 'claude', phase: 42 },
      { type: 'something/else' },
      // send-stream events that carry no per-slot outcome, or belong to another feature
      { type: 'sse', feature: 'send', event: { type: 'slot_delta', slot: 'claude', text: 'x' } },
      { type: 'sse', feature: 'send', event: { type: 'slot_start', slot: 'claude' } },
      { type: 'sse', feature: 'send', event: { type: 'slot_done', slot: 'bing' } },
      { type: 'panes/council', council: { slots: { claude: { model: 'web:claude' } } } }, // one member: invalid
      { type: 'panes/council', council: { slots: { claude: { model: 'web:claude' }, bing: { model: 'x/y' } } } },
      { type: 'panes/council', council: null }, // already null
      { type: 'panes/openRouterKey', status: null }, // already null
      { type: 'sse', feature: 'send', event: { type: 'turn_start', slots: ['claude'] } },
      { type: 'sse', feature: 'send', event: null },
      { type: 'sse', feature: 'send' },
      { type: 'sse', feature: 'analyze', event: { type: 'slot_done', slot: 'claude' } },
      { type: 'sse', feature: 'fusion', event: { type: 'slot_error', slot: 'claude', code: 'logged_out' } },
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

  test('rereadResult (2026-10-18) writes ONLY lastSend[slot]: a send in flight stays in flight', () => {
    const started = panesReducer(initialPanes(), { type: 'panes/sendStart', targets: ['claude'] })
    expect(started.sending).toBe(true)
    const line = { ok: false, reread: 'running' }
    const s = panesReducer(started, { type: 'panes/rereadResult', slot: 'chatgpt', result: line })
    expect(s.sending).toBe(true)
    expect(s.lastSend.chatgpt).toBe(line)
    // idle: sending stays false
    const idle = panesReducer(initialPanes(), { type: 'panes/rereadResult', slot: 'chatgpt', result: line })
    expect(idle.sending).toBe(false)
    expect(idle.lastSend).toEqual({ chatgpt: line })
    // the same object again, an unknown slot, or no result: unchanged identity
    expect(panesReducer(s, { type: 'panes/rereadResult', slot: 'chatgpt', result: line })).toBe(s)
    expect(panesReducer(s, { type: 'panes/rereadResult', slot: 'bing', result: line })).toBe(s)
    expect(panesReducer(s, { type: 'panes/rereadResult', slot: 'chatgpt', result: null })).toBe(s)
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
  test('selectedTargets keeps council order, drops unknown keys, and reads an absent member as on', () => {
    // the default council is every site (four since 2026-10-17): Gemini, absent from the map, is on
    expect(selectedTargets({ grok: true, claude: true, chatgpt: false, bing: true })).toEqual(['claude', 'grok', 'gemini'])
    // absent = on: a freshly seated member is targeted before its checkbox was ever touched
    expect(selectedTargets(null)).toEqual(['claude', 'chatgpt', 'grok', 'gemini'])
    expect(selectedTargets({ chatgpt: false }, ['chatgpt', 'qwen'])).toEqual(['qwen'])
    expect(selectedTargets({ qwen: false, gemini: true }, ['claude', 'gemini', 'qwen', 'mimo'])).toEqual(['claude', 'gemini', 'mimo'])
    // never a slot outside the council, whatever the map says
    expect(selectedTargets({ grok: true }, ['claude', 'chatgpt'])).toEqual(['claude', 'chatgpt'])
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
  test('round-trips mode / active / targets / drawerOpen through the four renderer-owned keys', () => {
    const storage = memoryStorage()
    persistPanes(storage, { ...initialPanes(), mode: 'tabs', active: 'grok', targets: { claude: false, chatgpt: true, grok: true } })
    expect(storage.dump()).toEqual({
      [PERSIST_KEYS.mode]: 'tabs',
      [PERSIST_KEYS.active]: 'grok',
      [PERSIST_KEYS.targets]: JSON.stringify({ claude: false, chatgpt: true, grok: true }),
      [PERSIST_KEYS.drawerOpen]: 'false',
    })
    expect(loadPersistedPanes(storage)).toEqual({ mode: 'tabs', active: 'grok', targets: { claude: false, chatgpt: true, grok: true }, drawerOpen: false })
    expect(initialPanes(loadPersistedPanes(storage)).mode).toBe('tabs')
  })

  test('invalid stored values are ignored and a throwing storage never propagates', () => {
    const junk = memoryStorage({ [PERSIST_KEYS.mode]: 'stack', [PERSIST_KEYS.active]: 'bing', [PERSIST_KEYS.targets]: '{not json' })
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

  test('SLOT_IDS is the catalog order (classic three first); SITES the four with a view; the default council is every site', () => {
    expect(SLOT_IDS).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'qwen', 'mimo'])
    expect(SITES).toEqual(['claude', 'chatgpt', 'grok', 'gemini'])
    expect(CLASSIC_SITES).toEqual(['claude', 'chatgpt', 'grok'])
    expect(DEFAULT_COUNCIL).toEqual(SITES)
    expect(DEFAULT_COUNCIL).not.toBe(SITES) // a copy: a caller mutating one never changes the other
  })
})

describe('panes slice: send-stream outcomes (Stage 2)', () => {
  const done = (slot, latency_ms = 1234) => ({ type: 'sse', feature: 'send', event: { type: 'slot_done', slot, usage: { latency_ms, cost_usd: 0 }, finish_reason: 'stop', truncated: false } })
  const err = (slot, code, message = `${code} for ${slot}`) => ({ type: 'sse', feature: 'send', event: { type: 'slot_error', slot, code, error_type: 'site', message, partial: '' } })

  test('sendOutcome shapes: slot_done → ok with the latency; not_captured → ok with the code; other codes → failed', () => {
    expect(sendOutcome({ type: 'slot_done', slot: 'claude', usage: { latency_ms: 1234 } })).toEqual({ ok: true, ms: 1234 })
    expect(sendOutcome({ type: 'slot_done', slot: 'claude' })).toEqual({ ok: true, ms: 0 })
    expect(sendOutcome({ type: 'slot_done', slot: 'claude', usage: { latency_ms: 'x' } })).toEqual({ ok: true, ms: 0 })
    expect(sendOutcome({ type: 'slot_error', slot: 'grok', code: NOT_CAPTURED, message: 'capture is off for grok; the reply is in the site pane' })).toEqual({
      ok: true,
      code: 'not_captured',
      message: 'capture is off for grok; the reply is in the site pane',
      ms: 0,
    })
    expect(sendOutcome({ type: 'slot_error', slot: 'grok', code: 'send_not_found', message: 'no send button' })).toEqual({ ok: false, code: 'send_not_found', message: 'no send button', ms: 0 })
    expect(sendOutcome({ type: 'slot_error', slot: 'grok', code: 500, message: 7 })).toEqual({ ok: false, code: '500', message: '', ms: 0 })
    expect(sendOutcome({ type: 'slot_error', slot: 'grok' })).toEqual({ ok: false, code: 'error', message: '', ms: 0 })
    expect(sendOutcome({ type: 'slot_delta', slot: 'grok', text: 'x' })).toBeNull()
    expect(sendOutcome({ type: 'slot_done', slot: 'bing' })).toBeNull()
    expect(sendOutcome({ type: 'slot_done', slot: 'qwen', usage: { latency_ms: 5 } })).toEqual({ ok: true, ms: 5 }) // a token/local member has an outcome too
    expect(sendOutcome(null)).toBeNull()
  })

  test('slot_done / slot_error record lastSend per slot; turn_start clears the listed slots; other keys keep identity', () => {
    const s0 = initialPanes()
    const s1 = panesReducer(s0, done('claude'))
    expect(s1.lastSend).toEqual({ claude: { ok: true, ms: 1234 } })
    expect(s1.sending).toBe(false)
    expect(s1.health).toBe(s0.health)
    expect(s1.targets).toBe(s0.targets)
    const s2 = panesReducer(s1, err('chatgpt', NOT_CAPTURED, 'capture is off for chatgpt; the reply is in the site pane'))
    expect(s2.lastSend.chatgpt).toEqual({ ok: true, code: 'not_captured', message: 'capture is off for chatgpt; the reply is in the site pane', ms: 0 })
    expect(s2.lastSend.claude).toBe(s1.lastSend.claude)
    const s3 = panesReducer(s2, err('grok', 'send_not_found', 'no enabled send button within 18000 ms'))
    expect(s3.lastSend.grok).toEqual({ ok: false, code: 'send_not_found', message: 'no enabled send button within 18000 ms', ms: 0 })
    expect(resultNeedsAttention(s3.lastSend.grok)).toBe(false)
    // a later subset send / solo continue clears exactly the listed slots
    const s4 = panesReducer(s3, { type: 'sse', feature: 'send', event: { type: 'turn_start', turn_id: 't2', feature: 'send', slots: ['grok', 'bogus'] } })
    expect(Object.keys(s4.lastSend)).toEqual(['claude', 'chatgpt'])
    expect(s4.lastSend.claude).toBe(s3.lastSend.claude)
    // an unlisted turn_start clears all three
    const s5 = panesReducer(s3, { type: 'sse', feature: 'send', event: { type: 'turn_start', turn_id: 't2', feature: 'send' } })
    expect(s5.lastSend).toEqual({})
    // the outcome of the last send is kept across a conversation switch / refetch (Stage 1 semantics)
    expect(panesReducer(s3, { type: 'conversation/loaded', conversation: { id: 'c2' } })).toBe(s3)
    expect(panesReducer(s3, { type: 'conversation/cleared' })).toBe(s3)
  })

  test('an attention slot_error (logged_out | challenge | blocked) activates that pane in tabs mode only', () => {
    const tabs = { ...initialPanes(), mode: 'tabs', active: 'chatgpt' }
    for (const code of ATTENTION_SESSIONS) {
      const next = panesReducer(tabs, err('grok', code))
      expect(next.active).toBe('grok')
      expect(next.lastSend.grok.ok).toBe(false)
      expect(resultNeedsAttention(next.lastSend.grok)).toBe(true)
    }
    // already active: only the outcome changes
    expect(panesReducer(tabs, err('chatgpt', 'logged_out')).active).toBe('chatgpt')
    // other failures and successes never switch
    expect(panesReducer(tabs, err('grok', 'send_not_found')).active).toBe('chatgpt')
    expect(panesReducer(tabs, err('grok', NOT_CAPTURED)).active).toBe('chatgpt')
    expect(panesReducer(tabs, done('grok')).active).toBe('chatgpt')
    // split mode shows every pane already
    const split = { ...initialPanes(), mode: 'split', active: 'chatgpt' }
    expect(panesReducer(split, err('grok', 'logged_out')).active).toBe('chatgpt')
  })

  test('through the root reducer a send outcome touches only the panes slice (the idle slots slice ignores a stale slot_done)', () => {
    const state = initialState()
    const next = rootReducer(state, done('claude'))
    expect(next.panes.lastSend.claude).toEqual({ ok: true, ms: 1234 })
    expect(next.slots).toBe(state.slots)
    // Stage 3: the drawer registers the meter slice in this graph, and the meter BOOKS a slot_done
    // (usage / calls) by design; every other slice keeps identity.
    for (const key of Object.keys(state)) if (key !== 'panes' && key !== 'meter') expect(next[key]).toBe(state[key])
  })

  test('phaseText', () => {
    expect(phaseText(undefined)).toBe('')
    expect(phaseText('')).toBe('')
    expect(phaseText('idle')).toBe('idle')
    expect(phaseText('typing')).toBe('typing…')
    expect(phaseText('submitted')).toBe('submitted')
    expect(phaseText('replying')).toBe('replying…')
    expect(phaseText('done')).toBe('done')
    expect(phaseText('error')).toBe('error')
    expect(phaseText('observing')).toBe('observing')
    expect(phaseText(7)).toBe('')
  })
})

describe('panes slice: capture-notice persistence (Stage 2)', () => {
  test('round-trips the touched map through triplex.panes.captureNoticeSeen; allCaptureTouched', () => {
    const storage = memoryStorage()
    expect(loadCaptureTouched(storage)).toEqual({ claude: false, chatgpt: false, grok: false, gemini: false })
    persistCaptureTouched(storage, { claude: true, grok: 'yes' })
    expect(storage.dump()).toEqual({ [CAPTURE_NOTICE_KEY]: JSON.stringify({ claude: true, chatgpt: false, grok: true, gemini: false }) })
    expect(loadCaptureTouched(storage)).toEqual({ claude: true, chatgpt: false, grok: true, gemini: false })
    expect(allCaptureTouched(loadCaptureTouched(storage))).toBe(false)
    persistCaptureTouched(storage, { claude: true, chatgpt: true, grok: true })
    expect(allCaptureTouched(loadCaptureTouched(storage))).toBe(false) // Gemini's switch is still unset
    persistCaptureTouched(storage, { claude: true, chatgpt: true, grok: true, gemini: true })
    expect(allCaptureTouched(loadCaptureTouched(storage))).toBe(true)
    expect(allCaptureTouched(null)).toBe(false)
    // only the switches on screen count (PaneDeck passes the council's site panes)
    const three = { claude: true, chatgpt: true, grok: true, gemini: false }
    expect(allCaptureTouched(three, ['claude', 'chatgpt', 'grok'])).toBe(true)
    expect(allCaptureTouched(three, ['claude', 'gemini'])).toBe(false)
    expect(allCaptureTouched(three, [])).toBe(true) // no site pane at all: nothing to decide
  })

  test('a bare true means the classic three seen (Gemini not yet); junk, a missing key, a null storage and a throwing storage mean none', () => {
    const none = { claude: false, chatgpt: false, grok: false, gemini: false }
    expect(loadCaptureTouched(memoryStorage({ [CAPTURE_NOTICE_KEY]: 'true' }))).toEqual({ claude: true, chatgpt: true, grok: true, gemini: false })
    expect(loadCaptureTouched(memoryStorage({ [CAPTURE_NOTICE_KEY]: '{not json' }))).toEqual(none)
    expect(loadCaptureTouched(memoryStorage({ [CAPTURE_NOTICE_KEY]: JSON.stringify({ claude: 'yes', chatgpt: 1, gemini: true, qwen: true }) }))).toEqual({ ...none, gemini: true })
    expect(loadCaptureTouched(memoryStorage())).toEqual(none)
    expect(loadCaptureTouched(null)).toEqual(none)
    const broken = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadCaptureTouched(broken)).toEqual({ claude: false, chatgpt: false, grok: false, gemini: false })
    expect(() => persistCaptureTouched(broken, { claude: true })).not.toThrow()
    expect(() => persistCaptureTouched(null, { claude: true })).not.toThrow()
    expect(() => persistCaptureTouched(memoryStorage(), null)).not.toThrow()
  })

  test('defaults to the global localStorage', () => {
    localStorage.setItem(CAPTURE_NOTICE_KEY, JSON.stringify({ grok: true }))
    expect(loadCaptureTouched()).toEqual({ claude: false, chatgpt: false, grok: true, gemini: false })
    persistCaptureTouched(undefined, { claude: true, chatgpt: true, grok: true })
    expect(JSON.parse(localStorage.getItem(CAPTURE_NOTICE_KEY))).toEqual({ claude: true, chatgpt: true, grok: true, gemini: false })
    localStorage.clear()
  })
})

describe('panes slice: Stage 3 (bridge error, drawerOpen persistence, notCapturedSlots)', () => {
  test('panes/bridge keeps the error main sends only while disconnected', () => {
    const s0 = initialPanes()
    const s1 = panesReducer(s0, { type: 'panes/bridge', connected: false, error: 'port_in_use' })
    expect(s1.bridge).toEqual({ connected: false, error: 'port_in_use' })
    expect(panesReducer(s1, { type: 'panes/bridge', connected: false, error: 'port_in_use' })).toBe(s1)
    const s2 = panesReducer(s1, { type: 'panes/bridge', connected: true, since: 5, error: 'stale' })
    expect(s2.bridge).toEqual({ connected: true, since: 5 })
    const s3 = panesReducer(s2, { type: 'panes/bridge', connected: false })
    expect(s3.bridge).toEqual({ connected: false })
    expect(panesReducer(s3, { type: 'panes/bridge', connected: false, error: '' })).toBe(s3)
    expect(panesReducer(s3, { type: 'panes/bridge', connected: false, error: 42 })).toBe(s3)
  })

  test('drawerOpen: initialPanes honours the persisted boolean; load / persist round-trip through the renderer-owned key', () => {
    expect(PERSIST_KEYS.drawerOpen).toBe('triplex.panes.drawerOpen')
    expect(initialPanes().drawerOpen).toBe(false)
    expect(initialPanes({ drawerOpen: true }).drawerOpen).toBe(true)
    expect(initialPanes({ drawerOpen: 'true' }).drawerOpen).toBe(false)
    expect(loadPersistedPanes(memoryStorage({ [PERSIST_KEYS.drawerOpen]: 'true' }))).toEqual({ drawerOpen: true })
    expect(loadPersistedPanes(memoryStorage({ [PERSIST_KEYS.drawerOpen]: 'false' }))).toEqual({ drawerOpen: false })
    expect(loadPersistedPanes(memoryStorage({ [PERSIST_KEYS.drawerOpen]: 'yes' }))).toEqual({})
    const storage = memoryStorage()
    persistPanes(storage, { ...initialPanes(), drawerOpen: true })
    expect(storage.getItem(PERSIST_KEYS.drawerOpen)).toBe('true')
    persistPanes(storage, initialPanes())
    expect(storage.getItem(PERSIST_KEYS.drawerOpen)).toBe('false')
    expect(panesReducer(initialPanes(), { type: 'panes/drawer' }).drawerOpen).toBe(true)
    expect(panesReducer(initialPanes({ drawerOpen: true }), { type: 'panes/drawer', open: false }).drawerOpen).toBe(false)
    expect(initialState().panes.drawerOpen).toBe(false)
  })

  test('notCapturedSlots reads the persisted not_captured messages of a send turn, in slot order', () => {
    const msg = (slot) => `${NOT_CAPTURED_MESSAGE_PREFIX}${slot}; the reply is in the site pane`
    const turn = { id: 't1', type: 'send', prompt: 'q', responses: { claude: null, chatgpt: 'B', grok: null }, errors: { grok: msg('grok'), claude: msg('claude') } }
    expect(NOT_CAPTURED_MESSAGE_PREFIX).toBe('capture is off for ')
    expect(notCapturedSlots(turn)).toEqual(['claude', 'grok'])
    expect(notCapturedSlots({ ...turn, errors: { grok: 'grok is signed out; sign in from the pane' } })).toEqual([])
    expect(notCapturedSlots({ ...turn, errors: {} })).toEqual([])
    expect(notCapturedSlots({ ...turn, errors: undefined })).toEqual([])
    expect(notCapturedSlots({ ...turn, type: 'analyze' })).toEqual([])
    expect(notCapturedSlots(null)).toEqual([])
    expect(notCapturedSlots({ ...turn, errors: { bing: msg('bing'), chatgpt: 42 } })).toEqual([])
  })
})

describe('panes slice: Gemini, the fourth site (2026-10-17)', () => {
  test('the initial per-site maps stay the classic three (the frozen desktop-smoke pins them); the reducers accept Gemini', () => {
    const s0 = initialPanes()
    for (const key of ['targets', 'health', 'zoom', 'capture']) expect(Object.keys(s0[key])).toEqual(CLASSIC_SITES)
    expect('gemini' in s0.health).toBe(false)
    const h = health({ host: 'gemini.google.com', url: 'https://gemini.google.com/app', title: 'Gemini' })
    const s1 = panesReducer(s0, { type: 'panes/health', slot: 'gemini', health: h })
    expect(s1.health.gemini).toBe(h)
    expect(healthText(s1.health.gemini)).toBe('composer ✓ send ✓ · signed in')
    const s2 = panesReducer(s1, { type: 'panes/zoom', slot: 'gemini', factor: 1.1 })
    expect(s2.zoom.gemini).toBe(1.1)
    const s3 = panesReducer(s2, { type: 'panes/capture', capture: { claude: false, chatgpt: false, grok: false, gemini: true } })
    expect(s3.capture).toEqual({ claude: false, chatgpt: false, grok: false, gemini: true })
    const s4 = panesReducer(s3, { type: 'panes/capture', slot: 'gemini', on: false })
    expect(s4.capture.gemini).toBe(false)
    const s5 = panesReducer(s4, { type: 'panes/turn', slot: 'gemini', phase: 'replying' })
    expect(s5.turn.gemini).toBe('replying')
    expect(panesReducer(s5, { type: 'panes/analyst', slot: 'gemini' }).analyst.slot).toBe('gemini')
    // a vendor without a site is still refused for the per-site maps
    expect(panesReducer(s0, { type: 'panes/health', slot: 'deepseek', health: h })).toBe(s0)
    expect(panesReducer(s0, { type: 'panes/zoom', slot: 'qwen', factor: 2 })).toBe(s0)
    // the readers of a missing key: no health yet, off, on (target), not attention
    expect(healthText(s0.health.gemini)).toBe('no health yet')
    expect(healthLevel(s0.health.gemini)).toBe('none')
    expect(!!s0.capture.gemini).toBe(false)
    expect(selectedTargets(s0.targets, ['claude', 'gemini'])).toEqual(['claude', 'gemini'])
  })

  test('the capture notice names Google’s terms and four switches', () => {
    expect(CAPTURE_NOTICE_TEXT).toMatch(/Google’s forbid “using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages”/)
    expect(CAPTURE_NOTICE_TEXT).toMatch(/each of the four switches/)
    expect(CAPTURE_NOTICE_TEXT).not.toMatch(/three switches/)
  })
})

describe('panes slice: drawerTab (2026-10-17)', () => {
  test('starts on analyze and is not persisted', () => {
    expect(initialPanes().drawerTab).toBe('analyze')
    expect(initialPanes({ drawerTab: 'agents' }).drawerTab).toBe('analyze')
    const storage = memoryStorage()
    persistPanes(storage, { ...initialPanes(), drawerTab: 'agents' })
    expect(Object.values(storage.dump()).some((v) => String(v).includes('agents'))).toBe(false)
  })

  test('panes/drawer {open, tab} opens on that tab; an unknown tab is ignored; a toggle keeps the tab; no change keeps identity', () => {
    const s0 = initialPanes()
    const s1 = panesReducer(s0, { type: 'panes/drawer', open: true, tab: 'agents' })
    expect(s1).toMatchObject({ drawerOpen: true, drawerTab: 'agents' })
    expect(panesReducer(s1, { type: 'panes/drawer', open: true, tab: 'agents' })).toBe(s1)
    const s2 = panesReducer(s1, { type: 'panes/drawer', open: true, tab: 'bogus' })
    expect(s2).toBe(s1)
    const s3 = panesReducer(s1, { type: 'panes/drawer' })
    expect(s3).toMatchObject({ drawerOpen: false, drawerTab: 'agents' })
    const s4 = panesReducer(s3, { type: 'panes/drawer', open: true, tab: 'fusion' })
    expect(s4).toMatchObject({ drawerOpen: true, drawerTab: 'fusion' })
    // the tab can change while the drawer stays open
    expect(panesReducer(s4, { type: 'panes/drawer', open: true, tab: 'settings' })).toMatchObject({ drawerOpen: true, drawerTab: 'settings' })
    expect(DRAWER_TAB_KEYS).toEqual(['analyze', 'fusion', 'captured', 'agents', 'settings'])
  })
})
