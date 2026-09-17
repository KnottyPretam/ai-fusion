// Stage 2 (integrator pre-work). The startTurn cases of SendPane.test.jsx ported to the hook
// (SendPane.test.jsx itself is unchanged and still covers the pane), plus the `slots` body rule.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { hasSlice } from '../../state/registry.js'
import { renderWithStore, sample } from '../../state/testing.jsx'
import { SLOT_IDS } from './slice.js'
import { sendBody, subsetSlots, useSendTurn } from './useSendTurn.js'

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

const seqOf = (calls) => calls.map((c) => `${c.method} ${c.url}`)
const sendCalls = (calls) => calls.filter((c) => c.method === 'POST' && c.url === '/api/conversations/c1/send')

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

const IDLE = { status: 'idle', error: null, httpStatus: null }

// Renders the hook's outputs as text and hands the latest bindings (plus dispatch, so a test can
// do what the sidebar does) to the test.
function Harness({ onReady }) {
  const t = useSendTurn()
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  onReady({ ...t, dispatch })
  return (
    <div>
      <span data-testid="locked">{String(t.locked)}</span>
      <span data-testid="in-flight">{String(t.inFlight)}</span>
      <span data-testid="pending">{t.pending ? JSON.stringify(t.pending) : 'none'}</span>
      <span data-testid="banner">{t.banner ?? 'none'}</span>
      <span data-testid="local-error">{t.localError ?? 'none'}</span>
      <span data-testid="banner-for">{String(t.bannerFor)}</span>
      <span data-testid="conversation">{conversation ? conversation.id : 'none'}</span>
    </div>
  )
}

function mount(preloaded) {
  let latest
  renderWithStore(<Harness onReady={(t) => (latest = t)} />, { preloaded })
  // Always the bindings of the latest render: startTurn is re-created on a conversation change.
  return () => latest
}

// Kick a turn off without awaiting it (the test may hold the stream open).
function start(hook, args) {
  let p
  act(() => {
    p = hook().startTurn(args)
  })
  return p
}

const text = (id) => screen.getByTestId(id).textContent
const pendingOf = () => (text('pending') === 'none' ? null : JSON.parse(text('pending')))

afterEach(() => vi.unstubAllGlobals())

describe('sendBody / subsetSlots', () => {
  test('a strict subset posts { prompt, slots }: known ids only, de-duplicated, in slot order', () => {
    expect(sendBody('q', ['grok'])).toEqual({ prompt: 'q', slots: ['grok'] })
    expect(sendBody('q', ['grok', 'claude'])).toEqual({ prompt: 'q', slots: ['claude', 'grok'] })
    expect(sendBody('q', ['grok', 'grok', 'bogus'])).toEqual({ prompt: 'q', slots: ['grok'] })
    expect(subsetSlots(['chatgpt', 'claude'])).toEqual(['claude', 'chatgpt'])
  })

  test('omitted, null, a non-array, empty, unknown-only or all three post { prompt }', () => {
    for (const slots of [undefined, null, 'grok', {}, 7, [], ['bogus'], SLOT_IDS.slice(), ['grok', 'chatgpt', 'claude', 'grok']]) {
      expect(sendBody('q', slots)).toEqual({ prompt: 'q' })
      expect(subsetSlots(slots)).toBeNull()
    }
    expect(sendBody('q')).toEqual({ prompt: 'q' })
  })
})

describe('useSendTurn', () => {
  test('importing the hook registers the slots slice', () => {
    expect(hasSlice('slots')).toBe(true)
  })

  test('a blank prompt and a solo continue without a conversation are refused without a request', async () => {
    const calls = stubFetch([])
    const hook = mount()
    expect(await hook().startTurn({ prompt: '   ' })).toBe(false)
    expect(await hook().startTurn({ slot: 'grok', prompt: 'deeper' })).toBe(false)
    expect(await hook().startTurn()).toBe(false)
    expect(calls).toEqual([])
    expect(text('locked')).toBe('false')
    expect(text('pending')).toBe('none')
  })

  test('first send: creates the conversation, posts { prompt }, refetches, then refreshes the list', async () => {
    const created = conv()
    const after = conv({
      title: 'hello council',
      threads: {
        claude: [msg('user', 'hello council'), msg('assistant', 'Hi from claude')],
        chatgpt: [msg('user', 'hello council'), msg('assistant', 'Hi from chatgpt')],
        grok: [msg('user', 'hello council'), msg('assistant', 'Hi from grok')],
      },
      turns: [{ id: 't1', type: 'send', prompt: 'hello council', slot_config: CFG, responses: { claude: 'Hi from claude', chatgpt: 'Hi from chatgpt', grok: 'Hi from grok' }, usage: { calls: [], totals: {} } }],
    })
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations', respond: json(created, 201) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'Hi from claude', chatgpt: 'Hi from chatgpt', grok: 'Hi from grok' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
      { method: 'GET', url: '/api/conversations', respond: json([{ id: 'c1', title: 'hello council', created_at: '', updated_at: '', turn_count: 1 }]) },
    ])
    const hook = mount()
    const p = start(hook, { prompt: 'hello council' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(await p).toBe(true)
    expect(calls[0].body).toEqual({})
    expect(calls[1].body).toEqual({ prompt: 'hello council' })
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(text('in-flight')).toBe('false')
    expect(text('pending')).toBe('none')
    expect(text('banner')).toBe('none')
    expect(text('banner-for')).toBe('c1')
    expect(text('conversation')).toBe('c1')
  })

  test('while the stream is open: locked, pending lists all three slots for the turn\'s conversation', async () => {
    const stream = controlledStream()
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
      { method: 'GET', url: '/api/conversations', respond: json([]) },
    ])
    const hook = mount({ conversation: conv(), slotConfig: CFG })
    const p = start(hook, { prompt: 'q' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send']))
    stream.push([sample.turnStart('t1'), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok'), sample.slotDelta('grok', 'only grok')])
    await waitFor(() => expect(text('locked')).toBe('true'))
    expect(text('in-flight')).toBe('true')
    expect(pendingOf()).toEqual({ prompt: 'q', slots: ['claude', 'chatgpt', 'grok'], convId: 'c1' })
    stream.push([sample.slotDone('claude'), sample.slotDone('chatgpt'), sample.slotDone('grok'), sample.turnDone('t1')])
    stream.end()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(await p).toBe(true)
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(text('pending')).toBe('none')
  })

  test('the lock is held across the create round-trip: a second call during POST /api/conversations is refused', async () => {
    const created = conv()
    const after = conv({ title: 'hello', turns: [{ id: 't1', type: 'send', prompt: 'hello', slot_config: CFG, responses: { claude: 'Hi', chatgpt: 'Hi', grok: 'Hi' }, usage: { calls: [], totals: {} } }] })
    let resolveCreate
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations', respond: () => new Promise((r) => (resolveCreate = () => r(json(created, 201)))) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'Hi', chatgpt: 'Hi', grok: 'Hi' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
      { method: 'GET', url: '/api/conversations', respond: json([{ id: 'c1', title: 'hello', created_at: '', updated_at: '', turn_count: 1 }]) },
    ])
    const hook = mount()
    const p = start(hook, { prompt: 'hello' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations']))
    // POST /api/conversations is pending: already locked, nothing pending yet, banner scoped to "no conversation".
    expect(text('locked')).toBe('true')
    expect(text('in-flight')).toBe('true')
    expect(text('pending')).toBe('none')
    expect(text('banner-for')).toBe('null')
    // A second turn while the create is in flight is refused by the hook itself (the latest
    // bindings still see `conversation === null`: unguarded, this would create a second one).
    expect(await hook().startTurn({ prompt: 'again' })).toBe(false)
    await tick()
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])

    await act(async () => resolveCreate())
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(await p).toBe(true)
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/conversations')).toHaveLength(1)
    expect(sendCalls(calls)).toHaveLength(1)
    expect(text('banner-for')).toBe('c1')
  })

  test('a later send on an existing conversation does not refresh the list', async () => {
    const existing = withTurn()
    const after = conv({ ...existing, turns: [...existing.turns, { id: 't1', type: 'send', prompt: 'second', slot_config: CFG, responses: { claude: 'A', chatgpt: 'B', grok: 'C' }, usage: { calls: [], totals: {} } }] })
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'A', chatgpt: 'B', grok: 'C' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
    ])
    const hook = mount({ conversation: existing, slotConfig: CFG })
    const p = start(hook, { prompt: 'second' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1']))
    expect(await p).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1'])
    await waitFor(() => expect(text('locked')).toBe('false'))
  })

  test('the lock stays held between the end of the stream and the refetch', async () => {
    const existing = withTurn()
    let resolveRefetch
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'A', chatgpt: 'B', grok: 'C' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: () => new Promise((r) => (resolveRefetch = () => r(json(existing)))) },
    ])
    const hook = mount({ conversation: existing, slotConfig: CFG })
    start(hook, { prompt: 'q' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1']))
    // streams.send is done (a consumer keyed on it alone would unlock) but the refetch is pending.
    await tick()
    expect(text('locked')).toBe('true')
    expect(text('in-flight')).toBe('true')
    expect(pendingOf()).toEqual({ prompt: 'q', slots: ['claude', 'chatgpt', 'grok'], convId: 'c1' })
    await act(async () => resolveRefetch())
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(text('pending')).toBe('none')
  })

  test('solo continue: posts { prompt } to the slot\'s continue url (slots ignored), pending lists only that slot', async () => {
    const existing = withTurn()
    const after = conv({
      ...existing,
      threads: { ...existing.threads, grok: [...existing.threads.grok, msg('user', 'deeper', 't1'), msg('assistant', 'grok goes deeper', 't1')] },
      turns: [...existing.turns, { id: 't1', type: 'continue', slot: 'grok', prompt: 'deeper', response: 'grok goes deeper', slot_config: CFG, usage: { calls: [], totals: {} } }],
    })
    const stream = controlledStream()
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/slots/grok/continue', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(after) },
    ])
    const hook = mount({ conversation: existing, slotConfig: CFG })
    const p = start(hook, { slot: 'grok', prompt: 'deeper', slots: ['claude'] })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/slots/grok/continue']))
    expect(calls[0].body).toEqual({ prompt: 'deeper' })
    await waitFor(() => expect(pendingOf()).toEqual({ prompt: 'deeper', slots: ['grok'], convId: 'c1' }))
    expect(text('locked')).toBe('true')
    stream.push([{ type: 'turn_start', turn_id: 't1', feature: 'continue', slots: ['grok'] }, sample.slotStart('grok'), sample.slotDelta('grok', 'grok goes deeper'), sample.slotDone('grok'), sample.turnDone('t1')])
    stream.end()
    // Not a first send: no list refresh.
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/slots/grok/continue', 'GET /api/conversations/c1']))
    expect(await p).toBe(true)
    await waitFor(() => expect(text('locked')).toBe('false'))
    await tick()
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/slots/grok/continue', 'GET /api/conversations/c1'])
    expect(text('pending')).toBe('none')
  })

  test('slots: ["grok"] posts { prompt, slots: ["grok"] } and the pending prompt lists exactly grok', async () => {
    const stream = controlledStream()
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
      { method: 'GET', url: '/api/conversations', respond: json([]) },
    ])
    const hook = mount({ conversation: conv(), slotConfig: CFG })
    const p = start(hook, { prompt: 'q', slots: ['grok'] })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send']))
    expect(calls[0].body).toEqual({ prompt: 'q', slots: ['grok'] })
    await waitFor(() => expect(pendingOf()).toEqual({ prompt: 'q', slots: ['grok'], convId: 'c1' }))
    stream.push([{ ...sample.turnStart('t1'), slots: ['grok'] }, sample.slotStart('grok'), sample.slotDelta('grok', 'G'), sample.slotDone('grok'), sample.turnDone('t1')])
    stream.end()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(await p).toBe(true)
    await waitFor(() => expect(text('locked')).toBe('false'))
  })

  test('slots with all three, [], a non-array or unknown ids post { prompt } with all three pending', async () => {
    let stream = controlledStream()
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
      { method: 'GET', url: '/api/conversations', respond: json([]) },
    ])
    const hook = mount({ conversation: conv(), slotConfig: CFG })
    const variants = [SLOT_IDS.slice(), ['grok', 'chatgpt', 'claude', 'grok'], [], 'grok', ['bogus'], null]
    for (let n = 0; n < variants.length; n++) {
      stream = controlledStream()
      const p = start(hook, { prompt: `q${n}`, slots: variants[n] })
      await waitFor(() => expect(sendCalls(calls)).toHaveLength(n + 1))
      expect(sendCalls(calls)[n].body).toEqual({ prompt: `q${n}` })
      await waitFor(() => expect(pendingOf()).toEqual({ prompt: `q${n}`, slots: ['claude', 'chatgpt', 'grok'], convId: 'c1' }))
      await act(async () => {
        stream.push(fullSendStream(`t${n}`, { claude: 'A', chatgpt: 'B', grok: 'C' }))
        stream.end()
      })
      await waitFor(() => expect(text('locked')).toBe('false'))
      expect(await p).toBe(true)
      expect(text('pending')).toBe('none')
    }
  })

  test('a conversation switch mid-stream drops the refetch of the old id; the first-send list refresh still runs', async () => {
    const stream = controlledStream()
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => stream.response },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
      { method: 'GET', url: '/api/conversations', respond: json([]) },
    ])
    const hook = mount({ conversation: conv(), slotConfig: CFG })
    const p = start(hook, { prompt: 'q' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send']))
    stream.push([sample.turnStart('t1'), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok'), sample.slotDelta('claude', 'A')])
    await waitFor(() => expect(pendingOf()).toEqual({ prompt: 'q', slots: ['claude', 'chatgpt', 'grok'], convId: 'c1' }))
    expect(text('banner-for')).toBe('c1')

    // The sidebar selects another conversation while c1's stream is still open.
    const c2 = conv({ id: 'c2', title: 'Other' })
    act(() => hook().dispatch({ type: 'conversation/loaded', conversation: c2 }))
    expect(text('conversation')).toBe('c2')
    expect(text('banner-for')).toBe('undefined') // retired
    // The pending prompt still names c1: a consumer scopes it by convId, as SendPane does.
    expect(pendingOf().convId).toBe('c1')
    // c1's stream is still open: still locked (streams.send is streaming).
    expect(text('locked')).toBe('true')

    stream.push([sample.slotDone('claude'), sample.slotDone('chatgpt'), sample.slotDone('grok'), sample.turnDone('t1')])
    stream.end()
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(await p).toBe(true)
    await tick()
    // No refetch of c1 (it would navigate the user back); the first-send list refresh still runs.
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations'])
    expect(text('conversation')).toBe('c2')
    expect(text('pending')).toBe('none')
    expect(text('banner')).toBe('none')
  })

  test('a post-stream refetch that resolves after a conversation switch is dropped (isCurrent)', async () => {
    const existing = withTurn()
    const after = conv({ ...existing, turns: [...existing.turns, { id: 't1', type: 'send', prompt: 'q', slot_config: CFG, responses: { claude: 'A', chatgpt: 'B', grok: 'C' }, usage: { calls: [], totals: {} } }] })
    let resolveRefetch
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sse(fullSendStream('t1', { claude: 'A', chatgpt: 'B', grok: 'C' })) },
      { method: 'GET', url: '/api/conversations/c1', respond: () => new Promise((r) => (resolveRefetch = () => r(json(after)))) },
    ])
    const hook = mount({ conversation: existing, slotConfig: CFG })
    const p = start(hook, { prompt: 'q' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1']))
    // streams.send is done (the sidebar is live again) while c1's refetch is still pending.
    await tick()
    expect(text('in-flight')).toBe('true')
    const c2 = conv({ id: 'c2', title: 'Other' })
    act(() => hook().dispatch({ type: 'conversation/loaded', conversation: c2 }))
    expect(text('conversation')).toBe('c2')

    await act(async () => resolveRefetch())
    await act(async () => {})
    expect(await p).toBe(true)
    // c1's late copy never lands: the store stays on c2.
    expect(text('conversation')).toBe('c2')
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(text('pending')).toBe('none')
    expect(text('banner')).toBe('none')
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1'])
  })

  test('a pre-stream 409 is the banner for that conversation, leaves nothing pending, unlocks, and is retired on a switch', async () => {
    stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: json({ detail: { error: 'busy' } }, 409) },
      { method: 'GET', url: '/api/conversations/c1', respond: json(conv()) },
    ])
    const hook = mount({ conversation: conv(), slotConfig: CFG })
    const p = start(hook, { prompt: 'again' })
    await waitFor(() => expect(text('banner')).toBe('busy'))
    expect(await p).toBe(false)
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(text('pending')).toBe('none')
    expect(text('local-error')).toBe('none') // the stream's error, not a local one
    expect(text('banner-for')).toBe('c1')
    act(() => hook().dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c2' }) }))
    expect(text('banner')).toBe('none')
    // ...and it does not come back when the user returns to c1.
    act(() => hook().dispatch({ type: 'conversation/loaded', conversation: conv() }))
    expect(text('banner')).toBe('none')
    expect(text('locked')).toBe('false')
    // A new failure in c1 shows again.
    start(hook, { prompt: 'once more' })
    await waitFor(() => expect(text('banner')).toBe('busy'))
  })

  test('a failed create surfaces localError, unlocks, leaves nothing pending; clearError retires it', async () => {
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: json({ detail: { error: 'boom' } }, 500) }])
    const hook = mount()
    const p = start(hook, { prompt: 'hello' })
    await waitFor(() => expect(text('local-error')).toBe('boom'))
    expect(await p).toBe(false)
    expect(text('banner')).toBe('boom')
    await waitFor(() => expect(text('locked')).toBe('false'))
    expect(text('pending')).toBe('none')
    expect(text('conversation')).toBe('none')
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])
    act(() => hook().clearError())
    expect(text('banner')).toBe('none')
    expect(text('local-error')).toBe('none')
    expect(text('banner-for')).toBe('undefined')
  })

  test('locked reflects any running feature stream even with no turn of its own in flight', () => {
    stubFetch([])
    mount({ conversation: conv(), slotConfig: CFG, streams: { send: IDLE, analyze: { status: 'streaming', error: null, httpStatus: null }, fusion: IDLE } })
    expect(text('locked')).toBe('true')
    expect(text('in-flight')).toBe('false')
  })
})
