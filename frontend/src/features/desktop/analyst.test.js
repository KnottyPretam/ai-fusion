import { describe, expect, test } from 'vitest'
import {
  ANALYST_KEY,
  ANALYST_NONE,
  DEFAULT_ANALYST,
  WEB_ANALYST_IDS,
  analystKind,
  analystSlotOf,
  desktopSlotConfig,
  desktopSlots,
  isDesktopAnalyst,
  loadAnalyst,
  persistAnalyst,
  webAnalystId,
  webAnalystName,
} from './analyst.js'

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }
}

describe('analyst choice: pure helpers', () => {
  test('analystKind / isDesktopAnalyst / analystSlotOf classify the three legal states and the rest', () => {
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      expect(analystKind(`web:${slot}:analyst`)).toBe('web')
      expect(isDesktopAnalyst(`web:${slot}:analyst`)).toBe(true)
      expect(analystSlotOf(`web:${slot}:analyst`)).toBe(slot)
    }
    expect(analystKind('ollama:hermes3')).toBe('ollama')
    expect(isDesktopAnalyst('ollama:hermes3')).toBe(true)
    expect(analystSlotOf('ollama:hermes3')).toBeNull()
    for (const none of ['', null, undefined]) {
      expect(analystKind(none)).toBe('none')
      expect(isDesktopAnalyst(none)).toBe(false)
      expect(analystSlotOf(none)).toBeNull()
    }
    // pre-pivot OpenRouter slugs, pane models, malformed strings
    for (const other of ['openai/gpt-5.6-luna', 'web:chatgpt', 'web:gemini:analyst', 'ollama:', 'web:chatgpt:analyst ', 42]) {
      expect(analystKind(other)).toBe('other')
      expect(isDesktopAnalyst(other)).toBe(false)
      expect(analystSlotOf(other)).toBeNull()
    }
  })

  test('the fixed web analyst ids and names mirror the desktop catalog', () => {
    expect(WEB_ANALYST_IDS).toEqual(['web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst'])
    expect(webAnalystId('grok')).toBe('web:grok:analyst')
    expect(webAnalystName('chatgpt')).toBe('ChatGPT web session (hidden analyst page)')
    expect(DEFAULT_ANALYST).toBe('web:chatgpt:analyst')
    expect(ANALYST_KEY).toBe('triplex.desktop.analyst')
  })
})

describe('analyst choice: localStorage mirror', () => {
  test('loadAnalyst returns the default when nothing (or junk) is stored, the stored desktop analyst otherwise, and "" for none', () => {
    expect(loadAnalyst(memoryStorage())).toBe(DEFAULT_ANALYST)
    expect(loadAnalyst(memoryStorage({ [ANALYST_KEY]: 'openai/gpt-5.6-luna' }))).toBe(DEFAULT_ANALYST)
    expect(loadAnalyst(memoryStorage({ [ANALYST_KEY]: 'web:grok:analyst' }))).toBe('web:grok:analyst')
    expect(loadAnalyst(memoryStorage({ [ANALYST_KEY]: 'ollama:hermes3' }))).toBe('ollama:hermes3')
    expect(loadAnalyst(memoryStorage({ [ANALYST_KEY]: '' }))).toBe(ANALYST_NONE)
    expect(loadAnalyst(null)).toBe(DEFAULT_ANALYST)
    expect(
      loadAnalyst({
        getItem() {
          throw new Error('SecurityError')
        },
      }),
    ).toBe(DEFAULT_ANALYST)
  })

  test('persistAnalyst writes the choice ("" included) and never throws', () => {
    const storage = memoryStorage()
    persistAnalyst(storage, 'ollama:hermes3')
    expect(storage.map.get(ANALYST_KEY)).toBe('ollama:hermes3')
    persistAnalyst(storage, '')
    expect(storage.map.get(ANALYST_KEY)).toBe('')
    persistAnalyst(storage, null) // not a string: ignored
    expect(storage.map.get(ANALYST_KEY)).toBe('')
    expect(() =>
      persistAnalyst(
        {
          setItem() {
            throw new Error('QuotaExceededError')
          },
        },
        'web:claude:analyst',
      ),
    ).not.toThrow()
    expect(() => persistAnalyst(null, 'web:claude:analyst')).not.toThrow()
  })

  test('the real localStorage round-trips', () => {
    localStorage.clear()
    expect(loadAnalyst()).toBe(DEFAULT_ANALYST)
    persistAnalyst(undefined, 'web:claude:analyst')
    expect(localStorage.getItem(ANALYST_KEY)).toBe('web:claude:analyst')
    expect(loadAnalyst()).toBe('web:claude:analyst')
    localStorage.clear()
  })
})

describe('desktopSlotConfig', () => {
  test('is the full SlotConfig of a desktop conversation: web:* panes at effort off, the chosen analyst, the backend defaults', () => {
    expect(desktopSlots()).toEqual({
      claude: { model: 'web:claude', effort: 'off' },
      chatgpt: { model: 'web:chatgpt', effort: 'off' },
      grok: { model: 'web:grok', effort: 'off' },
    })
    expect(desktopSlotConfig('ollama:hermes3')).toEqual({
      slots: desktopSlots(),
      analyst_model: 'ollama:hermes3',
      max_iterations: 2,
      materiality_min: 'medium',
      grounded: false,
    })
    expect(desktopSlotConfig('').analyst_model).toBe('')
    expect(desktopSlotConfig(null).analyst_model).toBe('') // an explicit non-string is "none", never a silent default
    expect(desktopSlotConfig(undefined).analyst_model).toBe(DEFAULT_ANALYST) // undefined = the persisted choice (default parameter)
  })

  test('defaults to the persisted choice', () => {
    localStorage.clear()
    expect(desktopSlotConfig().analyst_model).toBe(DEFAULT_ANALYST)
    localStorage.setItem(ANALYST_KEY, 'web:grok:analyst')
    expect(desktopSlotConfig().analyst_model).toBe('web:grok:analyst')
    // every call is a fresh object (nothing shared, nothing mutated across creates)
    const a = desktopSlotConfig()
    const b = desktopSlotConfig()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.slots).not.toBe(b.slots)
    localStorage.clear()
  })
})
