import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './index.jsx' // registers the `slots` slice
import '../meter/index.jsx' // registers the `meter` slice: the columns mirror its session cost-cap flag
import SlotColumn from './SlotColumn.jsx'
import { COST_CAP_TEXT, domainOf, fmtCost, fmtTokens } from './SlotColumn.jsx'
import { useDispatch } from '../../state/store.jsx'
import { applyEvents, renderWithStore, sample } from '../../state/testing.jsx'

// Captures the store's dispatch so a test can do what the sidebar does (conversation/loaded).
function DispatchProbe({ onReady }) {
  onReady(useDispatch())
  return null
}

const CFG = {
  slots: {
    claude: { model: 'anthropic/claude-opus-5', effort: 'medium' },
    chatgpt: { model: 'openai/gpt-5.6-sol', effort: 'medium' },
    grok: { model: 'x-ai/grok-4.6', effort: 'medium' },
  },
  analyst_model: 'openai/gpt-5.6-luna',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

const MODELS = [
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'], mandatory_reasoning: false },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'], mandatory_reasoning: false },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', vendor: 'openai', efforts: ['off', 'low', 'medium', 'high'], mandatory_reasoning: false },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'openai', efforts: ['off', 'low', 'medium', 'high'], mandatory_reasoning: false },
  { id: 'x-ai/grok-4.6', name: 'Grok 4.6', vendor: 'x-ai', efforts: ['low', 'medium', 'high'], mandatory_reasoning: true },
]

function modelsState(items = MODELS) {
  const byId = {}
  for (const m of items) byId[m.id] = m
  return { items, byId, loaded: true, error: null }
}

function conv(over = {}) {
  return {
    schema_version: 1,
    id: 'c1',
    title: 'T',
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    slot_config: CFG,
    threads: { claude: [], chatgpt: [], grok: [] },
    turns: [],
    ...over,
  }
}

function preloadedWith(c, extra = {}) {
  return { conversation: c, slotConfig: c ? c.slot_config : null, models: modelsState(), ...extra }
}

const msg = (role, content, over = {}) => ({ role, content, kind: 'chat', turn_id: 't1', ts: '2026-09-07T00:00:00.000Z', meta: null, ...over })

afterEach(() => vi.unstubAllGlobals())

describe('SlotColumn: persisted thread', () => {
  test('fusion messages render with the fusion marker and the round label', () => {
    const c = conv({
      threads: {
        claude: [
          msg('user', 'What is the gyro range?'),
          msg('assistant', 'Up to **2000** deg/s.'),
          msg('user', 'Peers hold otherwise…', { kind: 'fusion_challenge', turn_id: 'f1', meta: { divergence_id: 'd1', round: 1 } }),
          msg('assistant', '{"stance":"defend","justification":"datasheet","revised_claim":null,"confidence":0.9,"persuaded_by":null}', { kind: 'fusion_reply', turn_id: 'f1', meta: { divergence_id: 'd1', round: 1 } }),
        ],
        chatgpt: [],
        grok: [],
      },
    })
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    const messages = screen.getAllByTestId('slot-claude-message')
    expect(messages).toHaveLength(4)
    expect(messages[0]).toHaveAttribute('data-role', 'user')
    expect(messages[0].className).not.toContain('fusion')
    expect(messages[1].className).not.toContain('fusion')
    expect(messages[2]).toHaveAttribute('data-kind', 'fusion_challenge')
    expect(messages[2].className).toContain('fusion')
    expect(messages[3]).toHaveAttribute('data-kind', 'fusion_reply')
    expect(messages[3].className).toContain('fusion')
    const labels = screen.getAllByTestId('slot-claude-fusion-label')
    expect(labels).toHaveLength(2)
    expect(labels[0]).toHaveTextContent('Fusion round 1 · d1')
    expect(labels[0]).toHaveTextContent('challenge')
    expect(labels[1]).toHaveTextContent('Fusion round 1 · d1')
    expect(labels[1]).toHaveTextContent('reply')
    // The raw JSON reply is shown verbatim (pretty-printed), not through markdown.
    expect(messages[3]).toHaveTextContent('"stance": "defend"')
    // Assistant chat replies go through markdown inside .markdown-content.
    expect(messages[1].querySelector('.markdown-content strong')).toHaveTextContent('2000')
  })

  test('persisted per-slot reasoning / citations / truncation / effort come from the latest turn after refetch', () => {
    const turn = {
      id: 't1',
      type: 'send',
      prompt: 'q',
      slot_config: CFG,
      responses: { claude: 'answer', chatgpt: 'b', grok: 'c' },
      reasoning: { claude: 'persisted chain of thought' },
      citations: { claude: [{ type: 'url_citation', url_citation: { url: 'https://www.bosch-sensortec.com/bmi088', title: 'BMI088 datasheet' } }] },
      truncated: { claude: true },
      effort_applied: { claude: 'low', chatgpt: 'medium', grok: 'medium' },
      usage: { calls: [{ prompt_tokens: 100, completion_tokens: 2400, reasoning_tokens: 0, cost_usd: 0.0123, latency_ms: 850, model: 'anthropic/claude-opus-5', role: 'claude', purpose: 'chat' }], totals: {} },
    }
    const c = conv({ threads: { claude: [msg('user', 'q'), msg('assistant', 'answer')], chatgpt: [], grok: [] }, turns: [turn] })
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    const reasoning = screen.getByTestId('slot-claude-reasoning')
    expect(reasoning.tagName).toBe('DETAILS')
    expect(reasoning).toHaveTextContent('persisted chain of thought')
    const cites = screen.getByTestId('slot-claude-citations')
    const link = within(cites).getByRole('link')
    expect(link).toHaveTextContent('bosch-sensortec.com')
    expect(link).toHaveAttribute('href', 'https://www.bosch-sensortec.com/bmi088')
    expect(cites).toHaveTextContent('BMI088 datasheet')
    expect(screen.getByTestId('slot-claude-truncated')).toHaveTextContent(/truncated/i)
    // Effort badge: applied 'low' vs configured 'medium' -> coerced marker.
    const badge = screen.getByTestId('slot-claude-effort-badge')
    expect(badge).toHaveTextContent('low (coerced)')
    expect(badge).toHaveAttribute('data-coerced', 'true')
    const chip = screen.getByTestId('slot-claude-status')
    expect(chip).toHaveTextContent('2500 tok')
    expect(chip).toHaveTextContent('$0.0123')
    expect(chip).toHaveTextContent('850 ms')
  })

  test('a persisted slot error renders the error box with the partial text (nothing appended)', () => {
    const turn = {
      id: 't1',
      type: 'send',
      prompt: 'q',
      slot_config: CFG,
      responses: { claude: 'a', chatgpt: 'b', grok: null },
      errors: { grok: 'Provider disconnected' },
      partial: { grok: 'partial grok text' },
      effort_applied: { claude: 'medium', chatgpt: 'medium', grok: 'medium' },
      usage: { calls: [], totals: {} },
    }
    const c = conv({ turns: [turn] })
    renderWithStore(<SlotColumn slot="grok" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    expect(screen.getByTestId('slot-grok-error')).toHaveTextContent('Provider disconnected')
    expect(screen.getByTestId('slot-grok-persisted-error')).toHaveTextContent('partial grok text')
    expect(screen.queryAllByTestId('slot-grok-message')).toHaveLength(0)
    // No coerced marker when applied == configured.
    expect(screen.getByTestId('slot-grok-effort-badge')).toHaveAttribute('data-coerced', 'false')
  })

  test('every errored turn stays in the history at its place, not only the newest one', () => {
    const usage = { calls: [], totals: {} }
    const t1 = { id: 't1', type: 'send', prompt: 'q1', slot_config: CFG, responses: { claude: 'a1', chatgpt: 'b1', grok: null }, errors: { grok: 'Provider disconnected' }, partial: { grok: 'partial one' }, usage }
    const t2 = { id: 't2', type: 'send', prompt: 'q2', slot_config: CFG, responses: { claude: 'a2', chatgpt: 'b2', grok: 'c2' }, usage }
    const t3 = { id: 't3', type: 'continue', slot: 'grok', prompt: 'q3', response: null, error: 'timeout', slot_config: CFG, usage }
    const c = conv({
      threads: { claude: [], chatgpt: [], grok: [msg('user', 'q2', { turn_id: 't2' }), msg('assistant', 'c2', { turn_id: 't2' })] },
      turns: [t1, t2, t3],
    })
    renderWithStore(<SlotColumn slot="grok" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    const blocks = screen.getAllByTestId('slot-grok-persisted-error')
    expect(blocks.map((b) => b.getAttribute('data-turn-id'))).toEqual(['t1', 't3'])
    expect(blocks[0]).toHaveTextContent('q1')
    expect(blocks[0]).toHaveTextContent('partial one')
    expect(blocks[0]).toHaveTextContent('Provider disconnected')
    expect(blocks[0]).toHaveTextContent('nothing was appended')
    expect(blocks[1]).toHaveTextContent('q3')
    expect(blocks[1]).toHaveTextContent('timeout')
    // Chronological order in the column: t1's error, t2's exchange, t3's error.
    const order = [...screen.getByTestId('slot-grok-thread').querySelectorAll('[data-turn-id]')].map((el) => el.getAttribute('data-turn-id'))
    expect(order).toEqual(['t1', 't2', 't2', 't3'])
    expect(screen.getAllByTestId('slot-grok-message')).toHaveLength(2)
    // The `slot-<slot>-error` test id follows the newest turn only.
    expect(screen.getByTestId('slot-grok-error')).toHaveTextContent('timeout')
    expect(screen.queryByText('No messages yet.')).toBeNull()
  })

  test('an errored turn older than the newest successful one is still shown, in front of it', () => {
    const usage = { calls: [], totals: {} }
    const t1 = { id: 't1', type: 'send', prompt: 'q1', slot_config: CFG, responses: { claude: null, chatgpt: 'b1', grok: 'c1' }, errors: { claude: 'boom' }, partial: {}, usage }
    const t2 = { id: 't2', type: 'send', prompt: 'q2', slot_config: CFG, responses: { claude: 'a2', chatgpt: 'b2', grok: 'c2' }, usage }
    const c = conv({ threads: { claude: [msg('user', 'q2', { turn_id: 't2' }), msg('assistant', 'a2', { turn_id: 't2' })], chatgpt: [], grok: [] }, turns: [t1, t2] })
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    const block = screen.getByTestId('slot-claude-persisted-error')
    expect(block).toHaveAttribute('data-turn-id', 't1')
    expect(block).toHaveTextContent('boom')
    expect(block.compareDocumentPosition(screen.getAllByTestId('slot-claude-message')[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('slot-claude-error')).toBeNull() // not the newest turn
    // Chip still reflects the newest (successful) turn: no error status.
    expect(screen.getByTestId('slot-claude-status')).toHaveAttribute('data-status', 'idle')
  })

  test('the thread opens scrolled to the newest message and re-scrolls when the thread reloads', () => {
    const heightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(777)
    try {
      const c = conv({ threads: { claude: [msg('user', 'q'), msg('assistant', 'a')], chatgpt: [], grok: [] } })
      let dispatch
      renderWithStore(
        <>
          <SlotColumn slot="claude" onContinue={() => {}} />
          <DispatchProbe onReady={(d) => (dispatch = d)} />
        </>,
        { preloaded: preloadedWith(c) },
      )
      const el = screen.getByTestId('slot-claude-thread')
      expect(el.scrollTop).toBe(777)
      el.scrollTop = 0
      heightSpy.mockReturnValue(999)
      // Selecting another conversation in the sidebar (a new thread object) scrolls to its newest message.
      const c2 = conv({ id: 'c2', threads: { claude: [msg('user', 'q'), msg('assistant', 'a'), msg('user', 'q2', { turn_id: 't2' }), msg('assistant', 'a2', { turn_id: 't2' })], chatgpt: [], grok: [] } })
      act(() => dispatch({ type: 'conversation/loaded', conversation: c2 }))
      expect(el.scrollTop).toBe(999)
      // An unrelated store change (no new thread) leaves the user's scroll position alone.
      el.scrollTop = 0
      act(() => dispatch({ type: 'conversations/list', items: [] }))
      expect(el.scrollTop).toBe(0)
    } finally {
      heightSpy.mockRestore()
    }
  })
})

describe('SlotColumn: live stream', () => {
  test('streams markdown, then shows the truncation warning on slot_done{truncated}', () => {
    const state = applyEvents('send', [sample.turnStart(), sample.slotStart('chatgpt'), sample.slotDelta('chatgpt', 'Hello **world**')], { preloaded: preloadedWith(conv()) })
    const { unmount } = renderWithStore(<SlotColumn slot="chatgpt" pendingPrompt="hi" onContinue={() => {}} />, { preloaded: state })
    const live = screen.getByTestId('slot-chatgpt-live')
    expect(screen.getByTestId('slot-chatgpt-pending')).toHaveTextContent('hi')
    expect(live.querySelector('.markdown-content strong')).toHaveTextContent('world')
    expect(screen.getByTestId('slot-chatgpt-status')).toHaveTextContent('streaming')
    expect(screen.queryByTestId('slot-chatgpt-truncated')).toBeNull()
    unmount()
    const done = applyEvents('send', [{ ...sample.slotDone('chatgpt'), finish_reason: 'length', truncated: true }], { state })
    renderWithStore(<SlotColumn slot="chatgpt" onContinue={() => {}} />, { preloaded: done })
    expect(screen.getByTestId('slot-chatgpt-truncated')).toHaveTextContent(/truncated/i)
    expect(screen.getByTestId('slot-chatgpt-status')).toHaveTextContent('done')
    expect(screen.getByTestId('slot-chatgpt-status')).toHaveTextContent('30 tok')
  })

  test('live reasoning is collapsible and citations are domain-named links', () => {
    const state = applyEvents(
      'send',
      [
        sample.turnStart(),
        sample.slotStart('claude'),
        { type: 'slot_reasoning', slot: 'claude', text: 'let me think' },
        { type: 'slot_citations', slot: 'claude', items: [{ type: 'url_citation', url_citation: { url: 'https://www.example.org/a/b', title: 'Example' } }] },
        sample.slotDelta('claude', 'text'),
      ],
      { preloaded: preloadedWith(conv()) },
    )
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: state })
    const details = screen.getByTestId('slot-claude-reasoning')
    expect(details.tagName).toBe('DETAILS')
    expect(details).toHaveTextContent('let me think')
    const link = within(screen.getByTestId('slot-claude-citations')).getByRole('link')
    expect(link).toHaveTextContent('example.org')
    expect(link).toHaveAttribute('target', '_blank')
  })

  test('citation links are only made for http(s) urls; other schemes render as text', () => {
    const items = [
      { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'evil' } },
      { type: 'url_citation', url_citation: { url: 'data:text/html,hi', title: 'data' } },
      { type: 'url_citation', url_citation: { url: 'https://good.example/x', title: 'Good' } },
    ]
    const state = applyEvents('send', [sample.turnStart(), sample.slotStart('claude'), { type: 'slot_citations', slot: 'claude', items }, sample.slotDelta('claude', 'text')], {
      preloaded: preloadedWith(conv()),
    })
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: state })
    const cites = screen.getByTestId('slot-claude-citations')
    const links = within(cites).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://good.example/x')
    expect(cites.querySelector('a[href^="javascript"], a[href^="data"]')).toBeNull()
    const unlinked = within(cites).getAllByTestId('citation-unlinked')
    expect(unlinked.map((u) => u.textContent)).toEqual(['javascript:alert(1)', 'data:text/html,hi'])
    expect(cites).toHaveTextContent('evil')
    expect(cites.querySelectorAll('li')).toHaveLength(3)
  })

  test('slot_error shows the error box with code and keeps the partial text', () => {
    const state = applyEvents('send', [sample.turnStart(), sample.slotStart('grok'), sample.slotDelta('grok', 'partial grok'), { ...sample.slotError('grok', 'Provider disconnected'), code: 502 }], {
      preloaded: preloadedWith(conv()),
    })
    renderWithStore(<SlotColumn slot="grok" onContinue={() => {}} />, { preloaded: state })
    const box = screen.getByTestId('slot-grok-error')
    expect(box).toHaveTextContent('Provider disconnected')
    expect(box).toHaveTextContent('[502]')
    expect(screen.getByTestId('slot-grok-live')).toHaveTextContent('partial grok')
    expect(screen.getByTestId('slot-grok')).toHaveAttribute('data-status', 'error')
  })

  test('effort badge reports the applied effort with the coerced marker while live', () => {
    const state = applyEvents('send', [sample.turnStart(), { type: 'slot_start', slot: 'grok', model: 'x-ai/grok-4.6', effort: 'low', effort_coerced: true }], { preloaded: preloadedWith(conv()) })
    renderWithStore(<SlotColumn slot="grok" onContinue={() => {}} />, { preloaded: state })
    expect(screen.getByTestId('slot-grok-effort-badge')).toHaveTextContent('low (coerced)')
  })
})

describe('SlotColumn: header controls', () => {
  test('model dropdown is filtered by vendor', () => {
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(conv()) })
    const select = screen.getByTestId('slot-claude-model')
    const values = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(values).toEqual(['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5'])
    expect(select).toHaveValue('anthropic/claude-opus-5')
    expect(select).not.toBeDisabled()
  })

  test('model dropdown keeps the configured slug when the catalog lacks it', () => {
    const c = conv({ slot_config: { ...CFG, slots: { ...CFG.slots, chatgpt: { model: 'openai/gpt-7-nova', effort: 'high' } } } })
    renderWithStore(<SlotColumn slot="chatgpt" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    const select = screen.getByTestId('slot-chatgpt-model')
    const values = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(values).toEqual(['openai/gpt-7-nova', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-luna'])
    expect(select).toHaveValue('openai/gpt-7-nova')
    // Unknown model -> the four default efforts.
    const efforts = [...screen.getByTestId('slot-chatgpt-effort').querySelectorAll('option')].map((o) => o.value)
    expect(efforts).toEqual(['off', 'low', 'medium', 'high'])
  })

  test("effort selector hides 'off' for a mandatory-reasoning model and shows it otherwise", () => {
    renderWithStore(
      <>
        <SlotColumn slot="grok" onContinue={() => {}} />
        <SlotColumn slot="claude" onContinue={() => {}} />
      </>,
      { preloaded: preloadedWith(conv()) },
    )
    const grok = [...screen.getByTestId('slot-grok-effort').querySelectorAll('option')].map((o) => o.value)
    expect(grok).toEqual(['low', 'medium', 'high'])
    expect(grok).not.toContain('off')
    const claude = [...screen.getByTestId('slot-claude-effort').querySelectorAll('option')].map((o) => o.value)
    expect(claude).toEqual(['off', 'low', 'medium', 'high'])
    expect(screen.getByTestId('slot-claude-effort')).toHaveValue('medium')
  })

  test('controls are disabled without a conversation', () => {
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: { conversation: null, slotConfig: null, models: modelsState() } })
    expect(screen.getByTestId('slot-claude-model')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-effort')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-composer')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-continue')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-label')).toHaveTextContent('Claude')
  })

  test('changing the effort PUTs the merged slot config and adopts the server copy', async () => {
    const calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : undefined
        calls.push({ method: init.method || 'GET', url, body })
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(conv()) })
    const user = userEvent.setup()
    await user.selectOptions(screen.getByTestId('slot-claude-effort'), 'high')
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe('/api/conversations/c1/slot_config')
    expect(calls[0].body.slots.claude).toEqual({ model: 'anthropic/claude-opus-5', effort: 'high' })
    expect(calls[0].body.slots.grok).toEqual(CFG.slots.grok) // full config, other slots intact
    expect(calls[0].body.analyst_model).toBe('openai/gpt-5.6-luna')
    await waitFor(() => expect(screen.getByTestId('slot-claude-effort')).toHaveValue('high'))
  })

  test("switching to a mandatory model with effort 'off' coerces the effort in the same PUT", async () => {
    const calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : undefined
        calls.push({ method: init.method || 'GET', url, body })
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    const items = [...MODELS, { id: 'anthropic/claude-fable-5.1', name: 'Fable', vendor: 'anthropic', efforts: ['low', 'medium', 'high'], mandatory_reasoning: true }]
    const c = conv({ slot_config: { ...CFG, slots: { ...CFG.slots, claude: { model: 'anthropic/claude-opus-5', effort: 'off' } } } })
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: { conversation: c, slotConfig: c.slot_config, models: modelsState(items) } })
    const user = userEvent.setup()
    await user.selectOptions(screen.getByTestId('slot-claude-model'), 'anthropic/claude-fable-5.1')
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body.slots.claude).toEqual({ model: 'anthropic/claude-fable-5.1', effort: 'low' })
    await waitFor(() => expect(screen.getByTestId('slot-claude-effort')).toHaveValue('low'))
    const efforts = [...screen.getByTestId('slot-claude-effort').querySelectorAll('option')].map((o) => o.value)
    expect(efforts).toEqual(['low', 'medium', 'high'])
  })

  test('a failed save reloads the server copy and shows the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        if ((init.method || 'GET') === 'PUT') return { ok: false, status: 422, json: async () => ({ detail: { error: 'unsupported_effort', slot: 'claude', model: 'anthropic/claude-opus-5', effort: 'high', supported: ['low'] } }) }
        return { ok: true, status: 200, json: async () => CFG }
      }),
    )
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(conv()) })
    const user = userEvent.setup()
    await user.selectOptions(screen.getByTestId('slot-claude-effort'), 'high')
    await waitFor(() => expect(screen.getByTestId('slot-claude-config-error')).toHaveTextContent('unsupported_effort'))
    expect(screen.getByTestId('slot-claude-effort')).toHaveValue('medium')
  })
})

describe('SlotColumn: solo composer', () => {
  test('Enter posts the continue prompt; Shift+Enter inserts a newline', async () => {
    const onContinue = vi.fn()
    renderWithStore(<SlotColumn slot="grok" onContinue={onContinue} />, { preloaded: preloadedWith(conv()) })
    const user = userEvent.setup()
    const ta = screen.getByTestId('slot-grok-composer')
    await user.type(ta, 'line one{Shift>}{Enter}{/Shift}line two')
    expect(ta).toHaveValue('line one\nline two')
    expect(onContinue).not.toHaveBeenCalled()
    await user.type(ta, '{Enter}')
    expect(onContinue).toHaveBeenCalledWith('line one\nline two')
    expect(ta).toHaveValue('')
  })

  test('the Continue button submits and is disabled while any stream is streaming', async () => {
    const onContinue = vi.fn()
    const { unmount } = renderWithStore(<SlotColumn slot="claude" onContinue={onContinue} />, { preloaded: preloadedWith(conv()) })
    const user = userEvent.setup()
    await user.type(screen.getByTestId('slot-claude-composer'), 'go')
    await user.click(screen.getByTestId('slot-claude-continue'))
    expect(onContinue).toHaveBeenCalledWith('go')
    unmount()
    const streaming = { send: { status: 'idle', error: null, httpStatus: null }, analyze: { status: 'streaming', error: null, httpStatus: null }, fusion: { status: 'idle', error: null, httpStatus: null } }
    renderWithStore(<SlotColumn slot="claude" onContinue={onContinue} />, { preloaded: preloadedWith(conv(), { streams: streaming }) })
    expect(screen.getByTestId('slot-claude-composer')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-continue')).toBeDisabled()
  })
})

describe('formatting helpers', () => {
  test('fmtTokens / fmtCost / domainOf', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(12345)).toBe('12.3k')
    expect(fmtTokens(null)).toBe('-')
    expect(fmtCost(0)).toBe('$0')
    expect(fmtCost(0.00001)).toBe('<$0.0001')
    expect(fmtCost(0.0123)).toBe('$0.0123')
    expect(fmtCost(undefined)).toBe('-')
    expect(domainOf('https://www.example.com/x?y=1')).toBe('example.com')
    expect(domainOf('not a url')).toBe('not a url')
  })
})

describe('SlotColumn: Phase 5 — grounded badge, citations, cost cap', () => {
  // The exact wording backend/llm/client.py puts in slot_error.message (no code inside it).
  const CAP_MSG = 'session cost cap reached: spent $10.0412 of SESSION_COST_CAP_USD=$10.00; live calls refused'
  const capError = (slot) => ({ type: 'slot_error', slot, code: 'cost_cap_exceeded', error_type: 'triplex', message: CAP_MSG, partial: '' })
  const cite = (url, title) => ({ type: 'url_citation', url_citation: { url, title } })
  const noUsage = { calls: [], totals: {} }
  const cappedTurn = () => ({
    id: 't1',
    type: 'send',
    prompt: 'q',
    slot_config: CFG,
    responses: { claude: null, chatgpt: 'b', grok: 'c' },
    errors: { claude: CAP_MSG },
    partial: { claude: '' },
    effort_applied: { claude: 'medium', chatgpt: 'medium', grok: 'medium' },
    usage: noUsage,
  })
  const cappedConv = () =>
    conv({ threads: { claude: [], chatgpt: [msg('user', 'q'), msg('assistant', 'b')], grok: [msg('user', 'q'), msg('assistant', 'c')] }, turns: [cappedTurn()] })

  test('the grounded badge on the header follows slotConfig.grounded, live', () => {
    let dispatch
    renderWithStore(
      <>
        <SlotColumn slot="claude" onContinue={() => {}} />
        <SlotColumn slot="grok" onContinue={() => {}} />
        <DispatchProbe onReady={(d) => (dispatch = d)} />
      </>,
      { preloaded: preloadedWith(conv()) },
    )
    expect(screen.queryByTestId('slot-claude-grounded')).toBeNull()
    expect(screen.queryByTestId('slot-grok-grounded')).toBeNull()
    act(() => dispatch({ type: 'slotConfig/update', patch: { grounded: true } }))
    for (const slot of ['claude', 'grok']) {
      const badge = screen.getByTestId(`slot-${slot}-grounded`)
      expect(badge).toHaveTextContent('grounded')
      expect(badge).toHaveAttribute('title', expect.stringMatching(/web-search plugin/))
      // It sits in the header's title row, next to the provider label.
      expect(badge.parentElement).toBe(screen.getByTestId(`slot-${slot}-label`).parentElement)
    }
    act(() => dispatch({ type: 'slotConfig/update', patch: { grounded: false } }))
    expect(screen.queryByTestId('slot-claude-grounded')).toBeNull()
    // A loaded conversation with grounded on shows it straight away.
    act(() => dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c2', slot_config: { ...CFG, grounded: true } }) }))
    expect(screen.getByTestId('slot-claude-grounded')).toBeInTheDocument()
  })

  test('persisted citations of send and continue turns are de-duplicated domain links that open in a new tab', () => {
    const sendTurn = {
      id: 't1',
      type: 'send',
      prompt: 'q',
      slot_config: CFG,
      responses: { claude: 'a', chatgpt: 'b', grok: 'c' },
      citations: {
        claude: [
          cite('https://www.bosch-sensortec.com/media/bst-bmi088-ds001.pdf', 'BMI088 Datasheet'),
          cite('https://www.bosch-sensortec.com/media/bst-bmi088-ds001.pdf', 'BMI088 Datasheet (again)'), // same url twice
          cite('javascript:alert(1)', 'evil'),
        ],
      },
      effort_applied: { claude: 'medium', chatgpt: 'medium', grok: 'medium' },
      usage: noUsage,
    }
    const contTurn = {
      id: 't2',
      type: 'continue',
      slot: 'claude',
      prompt: 'more',
      response: 'r',
      citations: [cite('https://example.org/x', 'Ex'), cite('http://example.org/y', 'Ex plain http'), cite('https://example.org/x', 'dup')],
      truncated: false,
      effort_applied: 'medium',
      slot_config: CFG,
      usage: noUsage,
    }
    const c = conv({
      threads: { claude: [msg('user', 'q'), msg('assistant', 'a'), msg('user', 'more', { turn_id: 't2' }), msg('assistant', 'r', { turn_id: 't2' })], chatgpt: [], grok: [] },
      turns: [sendTurn, contTurn],
    })
    renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: preloadedWith(c) })
    const messages = screen.getAllByTestId('slot-claude-message')
    expect(messages).toHaveLength(4)
    // SendTurn.citations[claude] under t1's reply (an older turn: no test id, so query the DOM).
    const older = messages[1]
    expect(older.querySelectorAll('ol li')).toHaveLength(2) // the duplicate url was dropped, the javascript: item kept as text
    const olderLinks = older.querySelectorAll('a')
    expect(olderLinks).toHaveLength(1)
    expect(olderLinks[0]).toHaveTextContent('bosch-sensortec.com') // hostname text, www. stripped
    expect(olderLinks[0]).toHaveAttribute('href', 'https://www.bosch-sensortec.com/media/bst-bmi088-ds001.pdf')
    expect(olderLinks[0]).toHaveAttribute('target', '_blank')
    expect(olderLinks[0].getAttribute('rel')).toMatch(/\bnoopener\b/)
    expect(older).toHaveTextContent('BMI088 Datasheet')
    expect(older).not.toHaveTextContent('(again)')
    expect(older).toHaveTextContent('javascript:alert(1)')
    expect(older.querySelector('a[href^="javascript"]')).toBeNull()
    // ContinueTurn.citations under t2's reply (the newest turn carries the test id).
    const cites = screen.getByTestId('slot-claude-citations')
    expect(cites.querySelectorAll('li')).toHaveLength(2)
    const links = within(cites).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['example.org', 'example.org'])
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['https://example.org/x', 'http://example.org/y'])
    for (const l of links) {
      expect(l).toHaveAttribute('target', '_blank')
      expect(l.getAttribute('rel')).toMatch(/\bnoopener\b/)
    }
    expect(cites).not.toHaveTextContent('dup')
  })

  test('a live cost_cap_exceeded slot_error explains the cap in the error box and pins the notice on every column', () => {
    const state = applyEvents('send', [sample.turnStart(), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok'), capError('claude')], {
      preloaded: preloadedWith(conv()),
    })
    expect(state.meter.costCapExceeded).toBe(true) // the meter flagged it (W12)
    renderWithStore(
      <>
        <SlotColumn slot="claude" onContinue={() => {}} />
        <SlotColumn slot="grok" onContinue={() => {}} />
      </>,
      { preloaded: state },
    )
    const box = screen.getByTestId('slot-claude-error')
    expect(box).toHaveTextContent('[cost_cap_exceeded]')
    expect(box).toHaveTextContent(CAP_MSG)
    expect(box).toHaveAttribute('data-cost-cap', 'true')
    expect(within(box).getByTestId('cost-cap-note')).toHaveTextContent(COST_CAP_TEXT)
    expect(box.querySelector('a')).toBeNull() // plain text, link-free
    for (const slot of ['claude', 'grok']) {
      const notice = screen.getByTestId(`slot-${slot}-cost-cap`)
      expect(notice).toHaveTextContent(/session cost cap reached/i)
      expect(notice).toHaveTextContent(/SESSION_COST_CAP_USD/)
      expect(notice).toHaveAttribute('role', 'status')
      expect(notice.querySelector('a')).toBeNull()
    }
    expect(COST_CAP_TEXT).not.toMatch(/https?:|<a/i)
    // grok itself was not refused: still streaming, no error box of its own.
    expect(screen.getByTestId('slot-grok')).toHaveAttribute('data-status', 'streaming')
    expect(screen.queryByTestId('slot-grok-error')).toBeNull()
  })

  test('the notice persists across the post-stream refetch and the persisted cost-cap error explains itself', () => {
    const state = applyEvents(
      'send',
      [sample.turnStart(), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok'), capError('claude'), { type: 'conversation/loaded', conversation: cappedConv() }],
      { preloaded: preloadedWith(conv()) },
    )
    expect(state.slots.claude.status).toBe('idle') // live buffers dropped by the refetch
    renderWithStore(
      <>
        <SlotColumn slot="claude" onContinue={() => {}} />
        <SlotColumn slot="chatgpt" onContinue={() => {}} />
      </>,
      { preloaded: state },
    )
    expect(screen.getByTestId('slot-claude-cost-cap')).toHaveTextContent(COST_CAP_TEXT)
    expect(screen.getByTestId('slot-chatgpt-cost-cap')).toHaveTextContent(COST_CAP_TEXT)
    const box = screen.getByTestId('slot-claude-error') // PersistedError: nothing was appended to the thread
    expect(box).toHaveTextContent(CAP_MSG)
    expect(box).toHaveAttribute('data-cost-cap', 'true')
    expect(within(box).getByTestId('cost-cap-note')).toBeInTheDocument()
    expect(screen.queryAllByTestId('slot-claude-message')).toHaveLength(0)
    // Switching conversation does not clear it: the backend cap is per session.
    const switched = applyEvents('send', [{ type: 'conversation/loaded', conversation: conv({ id: 'c2' }) }], { state })
    expect(switched.meter.costCapExceeded).toBe(true)
  })

  test('a fresh page load (no session flag yet) still derives the notice from the persisted turn, on that column only', () => {
    renderWithStore(
      <>
        <SlotColumn slot="claude" onContinue={() => {}} />
        <SlotColumn slot="chatgpt" onContinue={() => {}} />
      </>,
      { preloaded: preloadedWith(cappedConv()) },
    )
    expect(screen.getByTestId('slot-claude-cost-cap')).toBeInTheDocument()
    expect(within(screen.getByTestId('slot-claude-error')).getByTestId('cost-cap-note')).toBeInTheDocument()
    expect(screen.queryByTestId('slot-chatgpt-cost-cap')).toBeNull()
  })

  test('a plain slot error shows neither the notice nor the explanation', () => {
    const state = applyEvents('send', [sample.turnStart(), sample.slotStart('grok'), { ...sample.slotError('grok', 'Provider disconnected'), code: 502 }], { preloaded: preloadedWith(conv()) })
    renderWithStore(<SlotColumn slot="grok" onContinue={() => {}} />, { preloaded: state })
    expect(screen.getByTestId('slot-grok-error')).toHaveAttribute('data-cost-cap', 'false')
    expect(screen.queryByTestId('cost-cap-note')).toBeNull()
    expect(screen.queryByTestId('slot-grok-cost-cap')).toBeNull()
  })

  test('a cost-cap error surfaced by an Analyze or Fusion stream (complete_json) pins the notice on the send columns too', () => {
    const viaFusion = applyEvents('fusion', [{ type: 'exchange', round: 1, divergence_id: 'd1', model: 'R3', stance: 'unavailable', error: 'cost_cap_exceeded' }], { preloaded: preloadedWith(conv()) })
    const { unmount } = renderWithStore(<SlotColumn slot="claude" onContinue={() => {}} />, { preloaded: viaFusion })
    expect(screen.getByTestId('slot-claude-cost-cap')).toHaveTextContent(/cost cap/i)
    unmount()
    const viaAnalyze = applyEvents('analyze', [{ type: 'analyze_retry', error: 'cost_cap_exceeded' }], { preloaded: preloadedWith(conv()) })
    renderWithStore(<SlotColumn slot="grok" onContinue={() => {}} />, { preloaded: viaAnalyze })
    expect(screen.getByTestId('slot-grok-cost-cap')).toBeInTheDocument()
    expect(screen.queryByTestId('slot-grok-error')).toBeNull() // no slot of its own failed
  })
})
