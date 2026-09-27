// Council (2026-09-27): the Send feature over a council of 2..5 agents from the 7-vendor catalog —
// the pure rules (councilOf / transportOf / slotStyle / vendorModels / subsetSlots / sendBody) and
// the pane mapping the council rather than a fixed three. The three-slot cases of slice.test.js /
// SendPane.test.jsx / SlotColumn.test.jsx keep their pins; this file adds the 2- and 5-member ones.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import SendPane, { SlotColumn } from './index.jsx'
import { councilWords } from './SendPane.jsx'
import { TRANSPORT_TITLES } from './SlotColumn.jsx'
import { DEFAULT_COUNCIL, SITES, SLOT_IDS, SLOT_LABELS, SLOT_VENDORS, councilOf, initialSlots, isSiteId, slotStyle, transportOf, vendorModels } from './slice.js'
import { sendBody, subsetSlots, useSendTurn } from './useSendTurn.js'
import { renderWithStore } from '../../state/testing.jsx'

afterEach(() => vi.unstubAllGlobals())

const CFG2 = {
  slots: { chatgpt: { model: 'openai/gpt-5', effort: 'medium' }, qwen: { model: 'qwen/qwen3-235b-a22b', effort: 'off' } },
  analyst_model: 'openai/gpt-5',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}
const CFG5 = {
  slots: {
    // deliberately NOT in catalog order: councilOf must re-key
    qwen: { model: 'ollama:qwen3', effort: 'off' },
    claude: { model: 'web:claude', effort: 'off' },
    gemini: { model: 'google/gemini-2.5-pro', effort: 'medium' },
    chatgpt: { model: 'web:chatgpt', effort: 'off' },
    grok: { model: 'web:grok', effort: 'off' },
  },
  analyst_model: 'web:chatgpt:analyst',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}
const conv = (cfg, over = {}) => {
  const threads = {}
  for (const s of Object.keys(cfg.slots)) threads[s] = []
  return { schema_version: 1, id: 'c1', title: 'T', created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z', slot_config: cfg, threads, turns: [], ...over }
}
const MODELS = { items: [], byId: {}, loaded: true, error: null }

describe('the catalog and the council view', () => {
  test('SLOT_IDS is the 7-vendor catalog with the classic three first; SITES and DEFAULT_COUNCIL are those three', () => {
    expect(SLOT_IDS).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'qwen', 'mimo'])
    expect(DEFAULT_COUNCIL).toEqual(['claude', 'chatgpt', 'grok'])
    expect(SITES).toEqual(['claude', 'chatgpt', 'grok'])
    expect(Object.keys(SLOT_VENDORS)).toEqual(SLOT_IDS)
    expect(SLOT_VENDORS).toMatchObject({ gemini: 'google', deepseek: 'deepseek', qwen: 'qwen', mimo: 'xiaomi' })
    expect(Object.keys(SLOT_LABELS)).toEqual(SLOT_IDS)
    expect(SLOT_LABELS).toMatchObject({ gemini: 'Gemini', deepseek: 'DeepSeek', qwen: 'Qwen', mimo: 'MiMo' })
    for (const s of SLOT_IDS) expect(isSiteId(s)).toBe(SITES.includes(s))
  })

  test('the slice is eager over the whole catalog: seven Slot objects whatever the council', () => {
    const s = initialSlots()
    for (const slot of SLOT_IDS) expect(s[slot]).toMatchObject({ status: 'idle', buffer: '' })
  })

  test('councilOf reads the seated slots in CATALOG order, whatever the dict order; null without a config', () => {
    expect(councilOf(CFG5)).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    expect(councilOf(CFG2)).toEqual(['chatgpt', 'qwen'])
    expect(councilOf({ slots: {} })).toBeNull()
    expect(councilOf(null)).toBeNull()
    expect(councilOf({})).toBeNull()
    expect(councilOf({ slots: { bing: {} } })).toBeNull() // an unknown vendor is not a seat
    expect(councilOf({ slots: { grok: {}, bing: {} } })).toEqual(['grok'])
  })

  test('transportOf: the model string IS the transport', () => {
    expect(transportOf('web:claude')).toBe('web')
    expect(transportOf('ollama:qwen3')).toBe('ollama')
    expect(transportOf('qwen/qwen3-235b-a22b')).toBe('openrouter')
    expect(transportOf('')).toBeNull()
    expect(transportOf(null)).toBeNull()
    expect(transportOf(42)).toBeNull()
  })

  test('slotStyle sets --slot-color from the palette token of each of the seven vendors; unknown → the border', () => {
    for (const slot of SLOT_IDS) expect(slotStyle(slot)).toEqual({ '--slot-color': `var(--${slot})` })
    expect(slotStyle('bing')).toEqual({ '--slot-color': 'var(--border)' })
  })

  test("vendorModels admits the vendor's slugs, the site's web entry and every ollama:* model, never another vendor or a hidden analyst page", () => {
    const items = [
      { id: 'web:claude', vendor: 'anthropic' },
      { id: 'web:claude:analyst', vendor: 'triplex-analyst' },
      { id: 'anthropic/claude-sonnet-4.5', vendor: 'anthropic' },
      { id: 'qwen/qwen3-235b-a22b', vendor: 'qwen' },
      { id: 'ollama:qwen3', vendor: 'ollama' },
      { id: 'ollama:hermes3', vendor: 'ollama' },
    ]
    expect(vendorModels(items, 'claude', 'web:claude').map((m) => m.id)).toEqual(['web:claude', 'anthropic/claude-sonnet-4.5', 'ollama:qwen3', 'ollama:hermes3'])
    expect(vendorModels(items, 'qwen', 'ollama:qwen3').map((m) => m.id)).toEqual(['qwen/qwen3-235b-a22b', 'ollama:qwen3', 'ollama:hermes3'])
    // a configured id the catalog lacks is prepended as missing, for any vendor
    expect(vendorModels(items, 'mimo', 'xiaomi/mimo-v2-flash')[0]).toMatchObject({ id: 'xiaomi/mimo-v2-flash', vendor: 'xiaomi', missing: true })
  })
})

describe('the subset rule against a council', () => {
  test('subsetSlots: council members only, council order, strict subset — else null', () => {
    const council = ['chatgpt', 'gemini', 'qwen']
    expect(subsetSlots(['qwen', 'chatgpt'], council)).toEqual(['chatgpt', 'qwen'])
    expect(subsetSlots(['qwen', 'chatgpt', 'gemini'], council)).toBeNull() // the whole council
    expect(subsetSlots(['grok'], council)).toBeNull() // a catalog vendor outside the council is nothing
    expect(subsetSlots(['grok', 'qwen'], council)).toEqual(['qwen'])
    expect(subsetSlots(['qwen', 'qwen'], council)).toEqual(['qwen'])
    expect(subsetSlots([], council)).toBeNull()
    expect(subsetSlots(null, council)).toBeNull()
    // the default council is the classic three: the pre-council calls are unchanged
    expect(subsetSlots(['grok', 'claude'])).toEqual(['claude', 'grok'])
    expect(subsetSlots(['claude', 'chatgpt', 'grok'])).toBeNull()
    expect(subsetSlots(['gemini'])).toBeNull()
  })

  test('sendBody posts {prompt} for the whole council and {prompt, slots} for a strict subset of it', () => {
    expect(sendBody('hi', ['chatgpt', 'qwen'], ['chatgpt', 'qwen'])).toEqual({ prompt: 'hi' })
    expect(sendBody('hi', ['qwen'], ['chatgpt', 'qwen'])).toEqual({ prompt: 'hi', slots: ['qwen'] })
    expect(sendBody('hi', null, ['chatgpt', 'qwen'])).toEqual({ prompt: 'hi' })
    expect(sendBody('hi', ['claude'])).toEqual({ prompt: 'hi', slots: ['claude'] })
  })

  test("useSendTurn judges the subset against the conversation's own council and pends exactly the council", async () => {
    const calls = []
    // A send stream the test closes by hand, so `pending` can be read while the turn is open.
    let finish = null
    const openStream = () => ({
      ok: true,
      status: 200,
      json: async () => null,
      body: { getReader: () => ({ read: () => new Promise((resolve) => (finish = () => resolve({ value: undefined, done: true }))), cancel: async () => {}, releaseLock() {} }) },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
        if (url === '/api/conversations/c1/send') return openStream()
        if (url === '/api/conversations/c1') return { ok: true, status: 200, json: async () => conv(CFG2) }
        return { ok: true, status: 200, json: async () => [] }
      }),
    )
    let hook
    function Probe() {
      hook = useSendTurn()
      return <span data-testid="pending">{hook.pending ? hook.pending.slots.join(',') : '-'}</span>
    }
    renderWithStore(<Probe />, { preloaded: { conversation: conv(CFG2), slotConfig: CFG2 } })
    await waitFor(() => expect(typeof hook.startTurn).toBe('function'))
    // the whole two-member council (a stray catalog vendor ignored): {prompt}, pending = the council
    let p = hook.startTurn({ prompt: 'q', slots: ['chatgpt', 'qwen', 'grok'] })
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('chatgpt,qwen'))
    expect(calls.find((c) => c.url === '/api/conversations/c1/send').body).toEqual({ prompt: 'q' })
    await waitFor(() => expect(finish).not.toBeNull())
    finish()
    await p
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('-'))
    calls.length = 0
    finish = null
    // a strict subset of that council
    p = hook.startTurn({ prompt: 'q2', slots: ['qwen'] })
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('qwen'))
    expect(calls.find((c) => c.url === '/api/conversations/c1/send').body).toEqual({ prompt: 'q2', slots: ['qwen'] })
    await waitFor(() => expect(finish).not.toBeNull())
    finish()
    await p
  })
})

describe('SendPane and SlotColumn over a council', () => {
  test('two members: two columns in catalog order, data-council-size=2, the composer wording reads the count', () => {
    renderWithStore(<SendPane />, { preloaded: { conversation: conv(CFG2), slotConfig: CFG2, models: MODELS } })
    const grid = screen.getByTestId('send-grid')
    expect(grid).toHaveAttribute('data-council-size', '2')
    expect([...grid.querySelectorAll('[data-testid^="slot-"][data-slot]')].map((el) => el.getAttribute('data-slot'))).toEqual(['chatgpt', 'qwen'])
    expect(screen.queryByTestId('slot-claude')).toBeNull()
    expect(screen.getByTestId('send-composer')).toHaveAttribute('placeholder', 'Send to both models… (Enter to send, Shift+Enter for a newline)')
    expect(screen.getByTestId('send-button')).toHaveAttribute('title', 'Send this prompt to both models at once. Each answers in its own thread, with its own history.')
    expect(screen.getByTestId('slot-qwen-label')).toHaveTextContent('Qwen')
  })

  test('five members: five columns in catalog order whatever the dict order; every column carries its --slot-color', () => {
    renderWithStore(<SendPane />, { preloaded: { conversation: conv(CFG5), slotConfig: CFG5, models: MODELS } })
    const grid = screen.getByTestId('send-grid')
    expect(grid).toHaveAttribute('data-council-size', '5')
    const columns = [...grid.querySelectorAll('[data-testid^="slot-"][data-slot]')]
    expect(columns.map((el) => el.getAttribute('data-slot'))).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    for (const el of columns) expect(el.style.getPropertyValue('--slot-color')).toBe(`var(--${el.getAttribute('data-slot')})`)
    expect(screen.getByTestId('send-composer')).toHaveAttribute('placeholder', 'Send to all five models… (Enter to send, Shift+Enter for a newline)')
  })

  test('the three-slot wording is byte-identical to before ("all three models")', () => {
    expect(councilWords(3)).toBe('all three')
    expect(councilWords(2)).toBe('both')
    expect(councilWords(5)).toBe('all five')
    expect(councilWords(7)).toBe('all 7')
  })

  test('an explicit `council` prop wins; with no conversation the default is the classic three', () => {
    renderWithStore(<SendPane council={['grok', 'mimo']} />, { preloaded: { models: MODELS } })
    expect([...screen.getByTestId('send-grid').querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot'))).toEqual(['grok', 'mimo'])
  })

  test('with no conversation and no desktop default the pane shows the classic three', () => {
    renderWithStore(<SendPane />, { preloaded: { models: MODELS } })
    expect(screen.getByTestId('send-grid')).toHaveAttribute('data-council-size', '3')
    expect([...screen.getByTestId('send-grid').querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot'))).toEqual(['claude', 'chatgpt', 'grok'])
  })

  test("SlotColumn shows the transport badge from the configured model, and drops the Continue box with solo={false}", () => {
    const { unmount } = renderWithStore(
      <>
        <SlotColumn slot="claude" />
        <SlotColumn slot="gemini" solo={false} />
        <SlotColumn slot="qwen" />
      </>,
      { preloaded: { conversation: conv(CFG5), slotConfig: CFG5, models: MODELS } },
    )
    expect(screen.getByTestId('slot-claude-transport')).toHaveTextContent('web')
    expect(screen.getByTestId('slot-claude-transport')).toHaveAttribute('data-transport', 'web')
    expect(screen.getByTestId('slot-claude-transport')).toHaveAttribute('title', TRANSPORT_TITLES.web)
    expect(screen.getByTestId('slot-gemini-transport')).toHaveTextContent('OpenRouter')
    expect(screen.getByTestId('slot-gemini-transport')).toHaveAttribute('data-transport', 'openrouter')
    expect(screen.getByTestId('slot-qwen-transport')).toHaveTextContent('local')
    expect(screen.getByTestId('slot-qwen-transport')).toHaveAttribute('data-transport', 'ollama')
    // solo (default) keeps the Continue box; solo={false} has none
    expect(screen.getByTestId('slot-claude-composer')).toBeInTheDocument()
    expect(screen.getByTestId('slot-claude-continue')).toHaveAttribute('title', 'Ask Claude alone. The other threads are left byte-for-byte as they were.')
    expect(screen.queryByTestId('slot-gemini-composer')).toBeNull()
    expect(screen.queryByTestId('slot-gemini-continue')).toBeNull()
    expect(screen.getByTestId('slot-qwen-composer')).toBeInTheDocument()
    unmount()
    // no model configured (no conversation): no badge at all
    renderWithStore(<SlotColumn slot="mimo" />, { preloaded: { models: MODELS } })
    expect(screen.queryByTestId('slot-mimo-transport')).toBeNull()
  })
})
