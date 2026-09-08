import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SendPane from './index.jsx' // registers the `slots` slice and exports the pane
import { useDispatch } from '../../state/store.jsx'
import { renderWithStore, sample } from '../../state/testing.jsx'

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
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', vendor: 'openai', efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'x-ai/grok-4.6', name: 'Grok 4.6', vendor: 'x-ai', efforts: ['low', 'medium', 'high'], mandatory_reasoning: true },
]

function conv(over = {}) {
  return {
    schema_version: 1,
    id: 'c1',
    title: 'New conversation',
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    slot_config: CFG,
    threads: { claude: [], chatgpt: [], grok: [] },
    turns: [],
    ...over,
  }
}

const msg = (role, content, turn_id = 't1') => ({ role, content, kind: 'chat', turn_id, ts: '2026-09-07T00:00:00.000Z', meta: null })

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

function sse(events) {
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

// Route stubbed fetch calls by method + url; records every call in order.
function stubFetch(routes) {
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

const seqOf = (calls) => calls.map((c) => `${c.method} ${c.url}`).filter((s) => s !== 'GET /api/models')

// Captures the store's dispatch so a test can do what the sidebar does (conversation/loaded ...).
function DispatchProbe({ onReady }) {
  onReady(useDispatch())
  return null
}

// A stream whose chunks the test serves by hand: `push(events)` = one chunk, `end()` closes it.
function controlledStream() {
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

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

const withTurn = () =>
  conv({
    threads: { claude: [msg('user', 'q0'), msg('assistant', 'a0')], chatgpt: [msg('user', 'q0'), msg('assistant', 'a0')], grok: [msg('user', 'q0'), msg('assistant', 'a0')] },
    turns: [{ id: 't0', type: 'send', prompt: 'q0', slot_config: CFG, responses: { claude: 'a0', chatgpt: 'a0', grok: 'a0' }, usage: { calls: [], totals: {} } }],
  })

const fullSendStream = (turnId, texts) => [
  sample.turnStart(turnId),
  sample.slotStart('claude'),
  sample.slotStart('chatgpt'),
  sample.slotStart('grok'),
  sample.slotDelta('claude', texts.claude),
  sample.slotDelta('chatgpt', texts.chatgpt),
  sample.slotDelta('grok', texts.grok),
  sample.slotDone('claude'),
  sample.slotDone('chatgpt'),
  sample.slotDone('grok'),
  sample.turnDone(turnId),
]

afterEach(() => vi.unstubAllGlobals())

describe('SendPane', () => {
  test('renders without a conversation even when every loader rejects (Node-style fetch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    renderWithStore(<SendPane />)
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(screen.getByTestId(`slot-${slot}`)).toBeInTheDocument()
    expect(screen.getByTestId('send-composer')).not.toBeDisabled()
    expect(screen.getByTestId('send-button')).toBeDisabled() // empty prompt
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/models', expect.anything()))
    expect(screen.queryByTestId('send-error')).toBeNull()
  })

  test('first send: creates the conversation, streams to /send, refetches, then refreshes the list', async () => {
    const created = conv()
    const turn = {
      id: 't1',
      type: 'send',
      prompt: 'hello council',
      slot_config: CFG,
      responses: { claude: 'Hi from claude', chatgpt: 'Hi from chatgpt', grok: 'Hi from grok' },
      effort_applied: { claude: 'medium', chatgpt: 'medium', grok: 'medium' },
      usage: { calls: [], totals: {} },
    }
    const after = conv({
      title: 'hello council',
      threads: {
        claude: [msg('user', 'hello council'), msg('assistant', 'Hi from claude')],
        chatgpt: [msg('user', 'hello council'), msg('assistant', 'Hi from chatgpt')],
        grok: [msg('user', 'hello council'), msg('assistant', 'Hi from grok')],
      },
      turns: [turn],
    })
    const calls = stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations', respond: json(created, 201) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'Hi from claude', chatgpt: 'Hi from chatgpt', grok: 'Hi from grok' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
      { method: 'GET', url: '/api/conversations', respond: json([{ id: 'c1', title: 'hello council', created_at: '', updated_at: '', turn_count: 1 }]) },
    ])
    renderWithStore(<SendPane />)
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'hello council{Enter}')
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(calls.find((c) => c.url === '/api/conversations' && c.method === 'POST').body).toEqual({})
    expect(calls.find((c) => c.url === '/api/conversations/c1/send').body).toEqual({ prompt: 'hello council' })
    // Composer cleared on submit; the persisted thread renders after the refetch.
    expect(screen.getByTestId('send-composer')).toHaveValue('')
    expect(await screen.findByText('Hi from claude')).toBeInTheDocument()
    expect(screen.getByText('Hi from grok')).toBeInTheDocument()
    expect(screen.getByTestId('slot-claude')).toHaveAttribute('data-status', 'idle') // live buffer cleared by conversation/loaded
    expect(screen.queryByTestId('slot-claude-live')).toBeNull()
    expect(screen.getAllByTestId('slot-chatgpt-message')).toHaveLength(2)
    // Model dropdowns now reflect the created conversation's config.
    expect(screen.getByTestId('slot-grok-model')).toHaveValue('x-ai/grok-4.6')
    expect(screen.getByTestId('send-composer')).not.toBeDisabled()
  })

  test('a later send on an existing conversation does not refresh the list', async () => {
    const existing = conv({
      threads: { claude: [msg('user', 'q0'), msg('assistant', 'a0')], chatgpt: [msg('user', 'q0'), msg('assistant', 'a0')], grok: [msg('user', 'q0'), msg('assistant', 'a0')] },
      turns: [{ id: 't0', type: 'send', prompt: 'q0', slot_config: CFG, responses: { claude: 'a0', chatgpt: 'a0', grok: 'a0' }, usage: { calls: [], totals: {} } }],
    })
    const after = conv({ ...existing, turns: [...existing.turns, { id: 't1', type: 'send', prompt: 'second', slot_config: CFG, responses: { claude: 'A', chatgpt: 'B', grok: 'C' }, usage: { calls: [], totals: {} } }] })
    const calls = stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'A', chatgpt: 'B', grok: 'C' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
    ])
    renderWithStore(<SendPane />, { preloaded: { conversation: existing, slotConfig: CFG } })
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'second')
    await user.click(screen.getByTestId('send-button'))
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1']))
    await new Promise((r) => setTimeout(r, 20))
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1'])
  })

  test('Shift+Enter inserts a newline without sending; blank prompts never send', async () => {
    const calls = stubFetch([{ method: 'GET', url: '/api/models', respond: json(MODELS) }])
    renderWithStore(<SendPane />)
    const user = userEvent.setup()
    const ta = screen.getByTestId('send-composer')
    await user.type(ta, '   {Enter}')
    await user.type(ta, 'a{Shift>}{Enter}{/Shift}b')
    expect(ta).toHaveValue('   a\nb')
    expect(seqOf(calls)).toEqual([])
  })

  test('composer and per-column controls are disabled while the send stream is streaming', () => {
    const calls = stubFetch([{ method: 'GET', url: '/api/models', respond: json(MODELS) }])
    const streams = { send: { status: 'streaming', error: null, httpStatus: null }, analyze: { status: 'idle', error: null, httpStatus: null }, fusion: { status: 'idle', error: null, httpStatus: null } }
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]))
    // Preloaded catalog: the pane must not refetch models it already has.
    renderWithStore(<SendPane />, { preloaded: { conversation: conv(), slotConfig: CFG, streams, models: { items: MODELS, byId, loaded: true, error: null } } })
    expect(calls).toEqual([])
    expect(screen.getByTestId('send-composer')).toBeDisabled()
    expect(screen.getByTestId('send-button')).toBeDisabled()
    expect(screen.getByTestId('send-button')).toHaveTextContent('Streaming')
    expect(screen.getByTestId('slot-claude-composer')).toBeDisabled()
  })

  test('live deltas reach only their own column while the stream is open', async () => {
    // A stream whose reader never finishes: the pane stays in the live state.
    const text = [sample.turnStart('t1'), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok'), sample.slotDelta('grok', 'only grok')].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
    const chunk = new TextEncoder().encode(text)
    let served = false
    stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      {
        method: 'POST',
        url: '/api/conversations/c1/send',
        respond: () => ({
          ok: true,
          status: 200,
          json: async () => null,
          body: {
            getReader: () => ({
              read: () => {
                if (!served) {
                  served = true
                  return Promise.resolve({ value: chunk, done: false })
                }
                return new Promise(() => {}) // never resolves
              },
              cancel: async () => {},
              releaseLock() {},
            }),
          },
        }),
      },
    ])
    renderWithStore(<SendPane />, { preloaded: { conversation: conv(), slotConfig: CFG } })
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'q{Enter}')
    await waitFor(() => expect(screen.getByTestId('slot-grok-live')).toHaveTextContent('only grok'))
    expect(screen.getByTestId('slot-claude-live')).not.toHaveTextContent('only grok')
    expect(screen.getByTestId('slot-claude')).toHaveAttribute('data-status', 'streaming')
    expect(screen.getByTestId('slot-grok')).toHaveAttribute('data-status', 'streaming')
    // Every column shows the pending prompt bubble; the composer is locked.
    expect(screen.getAllByText('q')).toHaveLength(3)
    expect(screen.getByTestId('send-composer')).toBeDisabled()
  })

  test('solo continue streams under feature key send (main composer locked, only its column live) and refetches', async () => {
    const existing = withTurn()
    const after = conv({
      ...existing,
      threads: { ...existing.threads, grok: [...existing.threads.grok, msg('user', 'deeper', 't1'), msg('assistant', 'grok goes deeper', 't1')] },
      turns: [...existing.turns, { id: 't1', type: 'continue', slot: 'grok', prompt: 'deeper', response: 'grok goes deeper', slot_config: CFG, usage: { calls: [], totals: {} } }],
    })
    const stream = controlledStream()
    const calls = stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations/c1/slots/grok/continue', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
    ])
    renderWithStore(<SendPane />, { preloaded: { conversation: existing, slotConfig: CFG } })
    const user = userEvent.setup()
    await user.type(screen.getByTestId('slot-grok-composer'), 'deeper{Enter}')
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/slots/grok/continue']))
    expect(calls[calls.length - 1].body).toEqual({ prompt: 'deeper' })
    stream.push([{ type: 'turn_start', turn_id: 't1', feature: 'continue', slots: ['grok'] }, sample.slotStart('grok'), sample.slotDelta('grok', 'grok goes')])
    await waitFor(() => expect(screen.getByTestId('slot-grok-live')).toHaveTextContent('grok goes'))
    // Live state is what proves the frozen feature key: streams.send is the one streaming, so the
    // main composer reads "Streaming…" and every composer is locked, while only grok's column is live.
    expect(screen.getByTestId('send-button')).toHaveTextContent('Streaming')
    expect(screen.getByTestId('send-composer')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-composer')).toBeDisabled()
    expect(screen.getByTestId('slot-grok')).toHaveAttribute('data-status', 'streaming')
    expect(screen.getByTestId('slot-grok-pending')).toHaveTextContent('deeper')
    for (const other of ['claude', 'chatgpt']) {
      expect(screen.getByTestId(`slot-${other}`)).toHaveAttribute('data-status', 'idle')
      expect(screen.queryByTestId(`slot-${other}-live`)).toBeNull()
      expect(screen.queryByTestId(`slot-${other}-pending`)).toBeNull()
    }
    stream.push([sample.slotDelta('grok', ' deeper'), sample.slotDone('grok'), sample.turnDone('t1')])
    stream.end()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/slots/grok/continue', 'GET /api/conversations/c1']))
    await waitFor(() => expect(screen.getAllByTestId('slot-grok-message')).toHaveLength(4))
    expect(screen.getByText('grok goes deeper')).toBeInTheDocument()
    expect(screen.getAllByTestId('slot-claude-message')).toHaveLength(2) // other threads untouched
    expect(screen.queryByTestId('slot-grok-live')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('send-composer')).not.toBeDisabled())
    expect(screen.getByTestId('send-button')).toHaveTextContent('Send')
  })

  test('a pre-stream 409 surfaces in the banner and leaves the columns idle', async () => {
    stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: json({ detail: { error: 'busy' } }, 409) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
    ])
    renderWithStore(<SendPane />, { preloaded: { conversation: conv(), slotConfig: CFG } })
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'again{Enter}')
    await waitFor(() => expect(screen.getByTestId('send-error')).toHaveTextContent('busy'))
    expect(screen.getByTestId('slot-claude')).toHaveAttribute('data-status', 'idle')
    expect(screen.queryByTestId('slot-claude-pending')).toBeNull()
    expect(screen.getByTestId('send-composer')).not.toBeDisabled()
  })
  test('switching conversation mid-stream isolates the stale stream: no live text, no pending bubble, no refetch of the old id', async () => {
    const stream = controlledStream()
    const calls = stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
      { method: 'GET', url: '/api/conversations', respond: json([]) },
    ])
    let dispatch
    renderWithStore(
      <>
        <SendPane />
        <DispatchProbe onReady={(d) => (dispatch = d)} />
      </>,
      { preloaded: { conversation: conv(), slotConfig: CFG } },
    )
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'q{Enter}')
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send']))
    stream.push([sample.turnStart('t1'), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok'), sample.slotDelta('claude', 'A')])
    await waitFor(() => expect(screen.getByTestId('slot-claude-live')).toHaveTextContent('A'))
    expect(screen.getAllByTestId(/^slot-\w+-pending$/)).toHaveLength(3)
    expect(screen.getByTestId('slot-claude-effort-badge')).toHaveTextContent('medium')

    // The sidebar selects another conversation while A's stream is still open.
    const c2 = conv({ id: 'c2', title: 'Other', threads: { claude: [msg('user', 'old q', 'x1'), msg('assistant', 'old answer', 'x1')], chatgpt: [], grok: [] }, turns: [] })
    act(() => dispatch({ type: 'conversation/loaded', conversation: c2 }))
    expect(screen.queryByTestId('slot-claude-live')).toBeNull()
    expect(screen.queryAllByTestId(/^slot-\w+-pending$/)).toHaveLength(0)
    expect(screen.getByTestId('slot-claude')).toHaveAttribute('data-status', 'idle')
    expect(screen.queryByTestId('slot-claude-effort-badge')).toBeNull()
    expect(screen.getByText('old answer')).toBeInTheDocument()

    // Later events of A's stream must not repopulate B's columns.
    stream.push([sample.slotDelta('claude', 'B'), sample.slotDelta('grok', 'G'), sample.slotDone('claude'), sample.slotDone('chatgpt'), { ...sample.slotError('grok', 'boom'), partial: 'G' }])
    await tick()
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      expect(screen.queryByTestId(`slot-${slot}-live`)).toBeNull()
      expect(screen.getByTestId(`slot-${slot}`)).toHaveAttribute('data-status', 'idle')
    }
    expect(screen.queryByText('AB')).toBeNull()
    expect(screen.queryByTestId('slot-grok-error')).toBeNull()
    // A's stream is still open, so the composer stays locked (streams.send is streaming).
    expect(screen.getByTestId('send-composer')).toBeDisabled()

    stream.push([sample.turnDone('t1')])
    stream.end()
    await waitFor(() => expect(screen.getByTestId('send-composer')).not.toBeDisabled())
    await tick()
    // No refetch of c1 (it would navigate the user back); the first-send list refresh still runs.
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations'])
    expect(screen.getByText('old answer')).toBeInTheDocument()
    expect(screen.queryByTestId('send-error')).toBeNull()
    expect(screen.queryAllByTestId(/^slot-\w+-pending$/)).toHaveLength(0)
  })

  test('the composer stays locked between the end of the stream and the refetch', async () => {
    const existing = withTurn()
    const after = conv({ ...existing, turns: [...existing.turns, { id: 't1', type: 'send', prompt: 'q', slot_config: CFG, responses: { claude: 'A', chatgpt: 'B', grok: 'C' }, usage: { calls: [], totals: {} } }] })
    let resolveRefetch
    const calls = stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'A', chatgpt: 'B', grok: 'C' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: () => new Promise((r) => (resolveRefetch = () => r(json(after)))) },
    ])
    renderWithStore(<SendPane />, { preloaded: { conversation: existing, slotConfig: CFG } })
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'q{Enter}')
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1']))
    // Stream finished (slots done, streams.send done) but the refetch is pending: still locked.
    await waitFor(() => expect(screen.getByTestId('slot-claude')).toHaveAttribute('data-status', 'done'))
    expect(screen.getByTestId('send-button')).toHaveTextContent('Send')
    expect(screen.getByTestId('send-composer')).toBeDisabled()
    expect(screen.getByTestId('send-button')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-composer')).toBeDisabled()
    expect(screen.getByTestId('slot-claude-pending')).toHaveTextContent('q')
    await act(async () => resolveRefetch())
    await waitFor(() => expect(screen.getByTestId('send-composer')).not.toBeDisabled())
    expect(screen.getByTestId('slot-claude')).toHaveAttribute('data-status', 'idle')
    expect(screen.queryByTestId('slot-claude-pending')).toBeNull()
    expect(screen.getByTestId('slot-claude-composer')).not.toBeDisabled()
  })

  test('the error banner is scoped to the conversation it belongs to and is retired on a switch', async () => {
    stubFetch([
      { method: 'GET', url: '/api/models', respond: json(MODELS) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: json({ detail: { error: 'busy' } }, 409) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
    ])
    let dispatch
    renderWithStore(
      <>
        <SendPane />
        <DispatchProbe onReady={(d) => (dispatch = d)} />
      </>,
      { preloaded: { conversation: conv(), slotConfig: CFG } },
    )
    const user = userEvent.setup()
    await user.type(screen.getByTestId('send-composer'), 'again{Enter}')
    await waitFor(() => expect(screen.getByTestId('send-error')).toHaveTextContent('busy'))
    act(() => dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c2' }) }))
    expect(screen.queryByTestId('send-error')).toBeNull()
    // ...and it does not come back when the user returns to c1.
    act(() => dispatch({ type: 'conversation/loaded', conversation: conv() }))
    expect(screen.queryByTestId('send-error')).toBeNull()
    expect(screen.getByTestId('send-composer')).not.toBeDisabled()
    // A new failure in c1 shows again.
    await user.type(screen.getByTestId('send-composer'), 'once more{Enter}')
    await waitFor(() => expect(screen.getByTestId('send-error')).toHaveTextContent('busy'))
  })

})
