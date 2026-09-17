import { afterEach, describe, expect, test, vi } from 'vitest'
import './index.jsx' // registers the `panes` slice next to the core ones
import { initialState, rootReducer } from '../../state/registry.js'
import {
  ATTENTION_SESSIONS,
  CAPTURE_NOTICE_KEY,
  NOT_CAPTURED,
  NOT_CAPTURED_MESSAGE_PREFIX,
  PERSIST_KEYS,
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
      // send-stream events that carry no per-slot outcome, or belong to another feature
      { type: 'sse', feature: 'send', event: { type: 'slot_delta', slot: 'claude', text: 'x' } },
      { type: 'sse', feature: 'send', event: { type: 'slot_start', slot: 'claude' } },
      { type: 'sse', feature: 'send', event: { type: 'slot_done', slot: 'gemini' } },
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
    expect(sendOutcome({ type: 'slot_done', slot: 'gemini' })).toBeNull()
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
    expect(loadCaptureTouched(storage)).toEqual({ claude: false, chatgpt: false, grok: false })
    persistCaptureTouched(storage, { claude: true, grok: 'yes' })
    expect(storage.dump()).toEqual({ [CAPTURE_NOTICE_KEY]: JSON.stringify({ claude: true, chatgpt: false, grok: true }) })
    expect(loadCaptureTouched(storage)).toEqual({ claude: true, chatgpt: false, grok: true })
    expect(allCaptureTouched(loadCaptureTouched(storage))).toBe(false)
    persistCaptureTouched(storage, { claude: true, chatgpt: true, grok: true })
    expect(allCaptureTouched(loadCaptureTouched(storage))).toBe(true)
    expect(allCaptureTouched(null)).toBe(false)
  })

  test('a bare true means all seen; junk, a missing key, a null storage and a throwing storage mean none', () => {
    expect(loadCaptureTouched(memoryStorage({ [CAPTURE_NOTICE_KEY]: 'true' }))).toEqual({ claude: true, chatgpt: true, grok: true })
    expect(loadCaptureTouched(memoryStorage({ [CAPTURE_NOTICE_KEY]: '{not json' }))).toEqual({ claude: false, chatgpt: false, grok: false })
    expect(loadCaptureTouched(memoryStorage({ [CAPTURE_NOTICE_KEY]: JSON.stringify({ claude: 'yes', chatgpt: 1, gemini: true }) }))).toEqual({ claude: false, chatgpt: false, grok: false })
    expect(loadCaptureTouched(memoryStorage())).toEqual({ claude: false, chatgpt: false, grok: false })
    expect(loadCaptureTouched(null)).toEqual({ claude: false, chatgpt: false, grok: false })
    const broken = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadCaptureTouched(broken)).toEqual({ claude: false, chatgpt: false, grok: false })
    expect(() => persistCaptureTouched(broken, { claude: true })).not.toThrow()
    expect(() => persistCaptureTouched(null, { claude: true })).not.toThrow()
    expect(() => persistCaptureTouched(memoryStorage(), null)).not.toThrow()
  })

  test('defaults to the global localStorage', () => {
    localStorage.setItem(CAPTURE_NOTICE_KEY, JSON.stringify({ grok: true }))
    expect(loadCaptureTouched()).toEqual({ claude: false, chatgpt: false, grok: true })
    persistCaptureTouched(undefined, { claude: true, chatgpt: true, grok: true })
    expect(JSON.parse(localStorage.getItem(CAPTURE_NOTICE_KEY))).toEqual({ claude: true, chatgpt: true, grok: true })
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
    expect(notCapturedSlots({ ...turn, errors: { gemini: msg('gemini'), chatgpt: 42 } })).toEqual([])
  })
})
