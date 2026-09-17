// PromptBar (Stage 2): the unified prompt is a Triplex Send. Stubbed fetch (the harness of
// features/send/useSendTurn.test.jsx, shared from ./fakes.js) drives the real api/http.js +
// api/sse.js + useSendTurn.js; `window.triplex` is the fake of the Stage 2 preload surface.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './index.jsx' // registers the `panes` slice (and, through useSendTurn, `slots`)
import PromptBar, { BRIDGE_BANNER_TEXT, formatResult, resultTitle } from './PromptBar.jsx'
import { NOT_CAPTURED, initialPanes } from './slice.js'
import { renderWithStore, sample } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { CFG, conv, controlledStream, fakeTriplex, jsonResponse, seqOf, sseResponse, stubFetch } from './fakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The store's dispatch, captured by the Probe so a test can drive the slices from outside PromptBar. */
const store = { dispatch: null }

function Probe() {
  const p = useSlice('panes')
  const c = useSlice('conversation')
  store.dispatch = useDispatch()
  return <div data-testid="probe">{`${p.mode}:${p.active}:${p.sending}:${c ? c.id : 'none'}`}</div>
}

function mount(fake, over = {}, preloaded = {}) {
  return renderWithStore(
    <>
      <PromptBar api={fake} />
      <Probe />
    </>,
    { preloaded: { panes: { ...initialPanes(), ...over }, ...preloaded } },
  )
}

const composer = () => screen.getByTestId('prompt-composer')
const sendBtn = () => screen.getByTestId('prompt-send')
const result = (slot) => screen.getByTestId(`prompt-result-${slot}`)
const type = (text) => fireEvent.change(composer(), { target: { value: text } })
const enter = (init = {}) => fireEvent.keyDown(composer(), { key: 'Enter', code: 'Enter', ...init })
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

const IDLE = { status: 'idle', error: null, httpStatus: null }
const STREAMING = { status: 'streaming', error: null, httpStatus: null }

const msg = (role, content, turn_id = 't1') => ({ role, content, kind: 'chat', turn_id, ts: '2026-09-16T00:00:00.000Z', meta: null })

const slotError = (slot, code, message, error_type = 'site') => ({ type: 'slot_error', slot, code, error_type, message, partial: '' })
const NOT_CAPTURED_MSG = (slot) => `capture is off for ${slot}; the reply is in the site pane`

/** turn_start … turn_done for `slots` (all three by default), every slot captured. */
function fullStream(turnId, slots = ['claude', 'chatgpt', 'grok']) {
  return [
    { ...sample.turnStart(turnId), slots },
    ...slots.map((s) => sample.slotStart(s, `web:${s}`, 'off')),
    ...slots.map((s) => sample.slotDelta(s, `Echo from ${s}`)),
    ...slots.map((s) => sample.slotDone(s, { model: `web:${s}`, cost_usd: 0, latency_ms: 500 })),
    sample.turnDone(turnId),
  ]
}

/** The persisted conversation after one captured send. */
function afterSend(prompt, over = {}) {
  const responses = { claude: 'Echo from claude', chatgpt: 'Echo from chatgpt', grok: 'Echo from grok' }
  return conv({
    title: prompt.slice(0, 60),
    threads: { claude: [msg('user', prompt), msg('assistant', responses.claude)], chatgpt: [msg('user', prompt), msg('assistant', responses.chatgpt)], grok: [msg('user', prompt), msg('assistant', responses.grok)] },
    turns: [{ id: 't1', type: 'send', prompt, slot_config: CFG, responses, usage: { calls: [], totals: {} } }],
    ...over,
  })
}

/** Every route of one turn: create (optional), the send stream, the refetch, the list refresh. */
function stubTurn({ create = false, id = 'c1', send, after = conv({ id }) } = {}) {
  return stubFetch([
    ...(create ? [{ method: 'POST', url: '/api/conversations', respond: jsonResponse(conv({ id }), 201) }] : []),
    { method: 'POST', url: `/api/conversations/${id}/send`, respond: send },
    { method: 'GET', url: `/api/conversations/${id}`, respond: jsonResponse(after) },
    { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
  ])
}

describe('PromptBar: pure helpers', () => {
  test('formatResult: captured / not captured / failed', () => {
    expect(formatResult({ ok: true, ms: 1234 })).toBe('sent ✓ captured · 1.2 s')
    expect(formatResult({ ok: true, ms: 0 })).toBe('sent ✓ captured')
    expect(formatResult({ ok: true, code: NOT_CAPTURED, message: NOT_CAPTURED_MSG('grok'), ms: 0 })).toBe('sent ✓ not captured')
    expect(formatResult({ ok: false, code: 'send_not_found', message: 'no enabled send button', ms: 0 })).toBe('✗ send_not_found')
    expect(formatResult({ ok: false })).toBe('✗ error')
    expect(formatResult(null)).toBe('')
    expect(formatResult('x')).toBe('')
  })

  test('resultTitle carries the message (and the Stage 1 selector / url keys when present)', () => {
    expect(resultTitle({ ok: false, code: 'send_not_found', message: 'no send button', ms: 0 })).toBe('no send button')
    expect(resultTitle({ ok: false, code: 'x', message: 'no send button', sendSelector: "button[aria-label='Submit']", url: 'https://grok.com/' })).toBe(
      "no send button\nsend: button[aria-label='Submit']\nurl: https://grok.com/",
    )
    expect(resultTitle({ ok: true, ms: 5 })).toBe('')
    expect(resultTitle(null)).toBe('')
  })
})

describe('PromptBar: Send through useSendTurn', () => {
  test('a first Send creates a conversation, posts {prompt} (all three checked), clears the composer, leaves the panes on their chats (no openChats) and shows one result line per slot', async () => {
    const fake = fakeTriplex()
    const calls = stubTurn({ create: true, send: () => sseResponse(fullStream('t1')), after: afterSend('hello all') })
    mount(fake)
    type('hello `x` "y" ${z}\nline2')
    enter()
    expect(composer()).toHaveValue('') // cleared at submit; the text is the turn's prompt
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(calls[0].body).toEqual({})
    expect(calls[1].body).toEqual({ prompt: 'hello `x` "y" ${z}\nline2' })
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:c1'))
    // the conversation id changed (null → c1) under panes.sending: it is this Send's own create, so
    // the panes are adopted (Decision 12) — never renavigated under the in-flight bridge requests
    expect(fake.openChats).not.toHaveBeenCalled()
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      expect(result(slot)).toHaveTextContent('sent ✓ captured · 0.5 s')
      expect(result(slot)).toHaveAttribute('data-ok', 'true')
    }
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-locked', 'false')
    expect(composer()).not.toHaveAttribute('readonly')
    expect(fake.openChats).not.toHaveBeenCalled() // the refetch re-dispatched the same id; sending is over
  })

  test('a strict subset of targets posts {prompt, slots}; only the listed slots get a result line; no conversation is created', async () => {
    const fake = fakeTriplex()
    const calls = stubTurn({ send: () => sseResponse(fullStream('t1', ['chatgpt', 'grok'])) })
    mount(fake, { targets: { claude: false, chatgpt: true, grok: true } }, { conversation: conv(), slotConfig: CFG })
    expect(screen.getByTestId('prompt-target-claude')).not.toBeChecked()
    type('subset')
    fireEvent.click(sendBtn())
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(calls[0].body).toEqual({ prompt: 'subset', slots: ['chatgpt', 'grok'] })
    await waitFor(() => expect(result('grok')).toHaveTextContent('Grok sent ✓ captured'))
    expect(result('chatgpt')).toHaveTextContent('ChatGPT sent ✓ captured')
    expect(screen.queryByTestId('prompt-result-claude')).toBeNull()
    // the panes stay on c1's chats: no id change, no openChats
    expect(fake.openChats).not.toHaveBeenCalled()
  })

  test('Shift+Enter does not send; an IME composition does not send', () => {
    const calls = stubFetch([])
    mount(fakeTriplex(), {}, { conversation: conv() })
    type('draft')
    enter({ shiftKey: true })
    enter({ isComposing: true })
    enter({ keyCode: 229 })
    expect(calls).toEqual([])
    expect(composer()).toHaveValue('draft')
  })

  test('Send is disabled while empty and while no target is checked', () => {
    const calls = stubFetch([])
    mount(fakeTriplex(), {}, { conversation: conv() })
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn().title).toMatch(/type a prompt/)
    type('   ')
    expect(sendBtn()).toBeDisabled()
    enter()
    type('go')
    expect(sendBtn()).toBeEnabled()
    for (const slot of ['claude', 'chatgpt', 'grok']) fireEvent.click(screen.getByTestId(`prompt-target-${slot}`))
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn().title).toMatch(/at least one target/)
    enter()
    fireEvent.click(screen.getByTestId('prompt-target-grok'))
    expect(sendBtn()).toBeEnabled()
    expect(calls).toEqual([])
  })

  test('locks while the stream is open; result lines for slot_done / not_captured / send_not_found; unlocks after the refetch with the focus back and the lines kept', async () => {
    const stream = controlledStream()
    const fake = fakeTriplex()
    const calls = stubTurn({ send: () => stream.response })
    mount(fake, {}, { conversation: conv(), slotConfig: CFG })
    type('lock me')
    act(() => composer().focus())
    expect(document.activeElement).toBe(composer())
    enter()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send']))
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn()).toHaveTextContent('Sending…')
    expect(screen.getByTestId('prompt-newchat')).toBeDisabled()
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'true')
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:true:c1')
    // main is about to focus a site view: the composer is read-only and no longer focused, so a
    // keystroke typed now cannot land in that site's composer between insert and submit
    expect(composer()).toHaveAttribute('readonly')
    expect(composer()).toHaveAttribute('aria-busy', 'true')
    expect(document.activeElement).not.toBe(composer())
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(result(slot)).toHaveAttribute('data-ok', 'pending')
    // Enter during a send is ignored
    type('typed during the send')
    enter()
    expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send'])

    stream.push([sample.turnStart('t1'), sample.slotStart('claude', 'web:claude', 'off'), sample.slotStart('chatgpt', 'web:chatgpt', 'off'), sample.slotStart('grok', 'web:grok', 'off')])
    await tick()
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(result(slot)).toHaveAttribute('data-ok', 'pending')
    stream.push([
      sample.slotDone('claude', { model: 'web:claude', cost_usd: 0, latency_ms: 1234 }),
      slotError('chatgpt', NOT_CAPTURED, NOT_CAPTURED_MSG('chatgpt'), 'triplex'),
      slotError('grok', 'send_not_found', 'no enabled send button within 18000 ms'),
    ])
    await waitFor(() => expect(result('claude')).toHaveTextContent('Claude sent ✓ captured · 1.2 s'))
    expect(result('claude')).toHaveAttribute('data-ok', 'true')
    expect(result('chatgpt')).toHaveTextContent('ChatGPT sent ✓ not captured')
    expect(result('chatgpt')).toHaveAttribute('data-ok', 'true')
    expect(result('chatgpt')).toHaveAttribute('data-code', 'not_captured')
    expect(result('chatgpt').title).toContain('capture is off for chatgpt')
    expect(result('grok')).toHaveTextContent('Grok ✗ send_not_found')
    expect(result('grok')).toHaveAttribute('data-ok', 'false')
    expect(result('grok').title).toContain('no enabled send button')
    // still locked: the stream is open
    expect(composer()).toHaveAttribute('readonly')

    stream.push([sample.turnDone('t1')])
    stream.end()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-locked', 'false')
    expect(composer()).not.toHaveAttribute('readonly')
    expect(composer()).toHaveAttribute('aria-busy', 'false')
    // the focus comes back because the composer had it when the send started
    expect(document.activeElement).toBe(composer())
    // the outcome lines survive the post-stream refetch (which resets the live `slots` slice)
    expect(result('claude')).toHaveTextContent('sent ✓ captured')
    expect(result('chatgpt')).toHaveTextContent('sent ✓ not captured')
    expect(result('grok')).toHaveTextContent('✗ send_not_found')
  })

  test('locked while streams.send streams even for a stream started elsewhere; unlocks when it ends', () => {
    stubFetch([])
    mount(fakeTriplex(), {}, { conversation: conv(), streams: { send: STREAMING, analyze: IDLE, fusion: IDLE } })
    type('x')
    expect(sendBtn()).toBeDisabled()
    expect(sendBtn().title).toMatch(/stream is running/)
    expect(composer()).toHaveAttribute('readonly')
    expect(screen.getByTestId('prompt-newchat')).toBeDisabled()
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-locked', 'true')
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false') // not this bar's send
    act(() => store.dispatch({ type: 'sse/end', feature: 'send', ok: true }))
    expect(sendBtn()).toBeEnabled()
    expect(composer()).not.toHaveAttribute('readonly')
    expect(screen.getByTestId('prompt-newchat')).toBeEnabled()
  })

  test('a panes/sendStart from outside PromptBar locks and blurs the composer too; the focus returns only if it had it', () => {
    stubFetch([])
    mount(fakeTriplex())
    type('draft')
    act(() => composer().focus())
    act(() => store.dispatch({ type: 'panes/sendStart' }))
    expect(composer()).toHaveAttribute('readonly')
    expect(document.activeElement).not.toBe(composer())
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:true:none')
    act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))
    expect(composer()).not.toHaveAttribute('readonly')
    expect(document.activeElement).toBe(composer())
    expect(composer()).toHaveValue('draft')
    // a composer that was NOT focused at sendStart is left alone afterwards
    act(() => composer().blur())
    act(() => store.dispatch({ type: 'panes/sendStart' }))
    act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))
    expect(document.activeElement).not.toBe(composer())
  })

  test('a pre-stream 409 shows the banner, leaves no result line, restores the text and unlocks', async () => {
    const calls = stubTurn({ send: jsonResponse({ detail: { error: 'busy' } }, 409) })
    mount(fakeTriplex(), {}, { conversation: conv(), slotConfig: CFG })
    type('again')
    enter()
    expect(composer()).toHaveValue('')
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('busy'))
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
    expect(composer()).toHaveValue('again')
    expect(sendBtn()).toBeEnabled()
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(screen.queryByTestId(`prompt-result-${slot}`)).toBeNull()
    expect(seqOf(calls)[0]).toBe('POST /api/conversations/c1/send')
  })

  test('a failed create shows the banner and restores the text', async () => {
    stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'boom' } }, 500) }])
    mount(fakeTriplex())
    type('hello')
    enter()
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('boom'))
    await waitFor(() => expect(composer()).toHaveValue('hello'))
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:none')
  })

  test('typing with the keyboard (userEvent) works and Enter sends once', async () => {
    const user = userEvent.setup()
    const calls = stubTurn({ send: () => sseResponse(fullStream('t1')), after: afterSend('typed\nmore') })
    mount(fakeTriplex(), {}, { conversation: conv(), slotConfig: CFG })
    await user.type(composer(), 'typed{Shift>}{Enter}{/Shift}more')
    expect(composer()).toHaveValue('typed\nmore')
    expect(calls).toEqual([])
    await user.keyboard('{Enter}')
    await waitFor(() => expect(seqOf(calls)[0]).toBe('POST /api/conversations/c1/send'))
    expect(calls[0].body).toEqual({ prompt: 'typed\nmore' })
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  test('renders and sends under a partial api (no openChats / onBridge / getCapture)', async () => {
    const calls = stubTurn({ create: true, send: () => sseResponse(fullStream('t1')), after: afterSend('no api') })
    expect(() => mount({})).not.toThrow()
    expect(screen.getByTestId('bridge-banner')).toBeInTheDocument() // nothing said "connected"
    type('no api')
    enter()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    await waitFor(() => expect(result('grok')).toHaveTextContent('sent ✓ captured'))
  })
})

describe('PromptBar: auto-reveal', () => {
  const reveal = (code, slot = 'grok') => [
    sample.turnStart('t1'),
    sample.slotStart('claude'),
    sample.slotStart('chatgpt'),
    sample.slotStart('grok'),
    sample.slotDone('claude'),
    sample.slotDone('chatgpt'),
    slotError(slot, code, `${slot} needs you`),
    sample.turnDone('t1'),
  ].map((e) => (e.type === 'slot_done' && e.slot === slot ? slotError(slot, code, `${slot} needs you`) : e))

  test('a logged_out slot_error reveals that pane in tabs mode', async () => {
    stubTurn({ send: () => sseResponse(reveal('logged_out', 'grok')) })
    mount(fakeTriplex(), { mode: 'tabs', active: 'chatgpt' }, { conversation: conv(), slotConfig: CFG })
    type('reveal')
    enter()
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('tabs:grok:'))
    await waitFor(() => expect(result('grok')).toHaveTextContent('Grok ✗ logged_out'))
    expect(result('grok').title).toBe('grok needs you')
  })

  test('challenge and blocked reveal too', async () => {
    for (const code of ['challenge', 'blocked']) {
      stubTurn({ send: () => sseResponse(reveal(code, 'claude')) })
      const { unmount } = mount(fakeTriplex(), { mode: 'tabs', active: 'chatgpt' }, { conversation: conv(), slotConfig: CFG })
      type(code)
      enter()
      await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('tabs:claude:'))
      await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
      unmount()
      vi.unstubAllGlobals()
    }
  })

  test('other failures never switch the tab, and split mode never switches', async () => {
    stubTurn({ send: () => sseResponse(reveal('send_not_found', 'claude')) })
    const first = mount(fakeTriplex(), { mode: 'tabs', active: 'chatgpt' }, { conversation: conv(), slotConfig: CFG })
    type('x')
    enter()
    await waitFor(() => expect(result('claude')).toHaveTextContent('✗ send_not_found'))
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:chatgpt:false:c1')
    first.unmount()
    vi.unstubAllGlobals()
    stubTurn({ send: () => sseResponse(reveal('logged_out', 'claude')) })
    mount(fakeTriplex(), { mode: 'split', active: 'chatgpt' }, { conversation: conv(), slotConfig: CFG })
    type('y')
    enter()
    await waitFor(() => expect(result('claude')).toHaveTextContent('✗ logged_out'))
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:c1')
  })
})

describe('PromptBar: New chat everywhere and the conversation ↔ chats link', () => {
  test('New chat everywhere creates a conversation and opens its chats exactly once', async () => {
    const fake = fakeTriplex()
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse(conv({ id: 'c9' }), 201) }])
    mount(fake, {}, { conversation: conv() })
    fireEvent.click(screen.getByTestId('prompt-newchat'))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c9'))
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(':c9'))
    await tick()
    // the conversation/loaded the create dispatched did not open the same chats a second time
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])
    expect(calls[0].body).toEqual({})
    expect(fake.newChat).not.toHaveBeenCalled()
    expect(screen.getByTestId('prompt-newchat')).toBeEnabled()
  })

  test('New chat everywhere is disabled while any stream runs', () => {
    const fake = fakeTriplex()
    stubFetch([])
    mount(fake, {}, { conversation: conv(), streams: { send: IDLE, analyze: STREAMING, fusion: IDLE } })
    expect(screen.getByTestId('prompt-newchat')).toBeDisabled()
    fireEvent.click(screen.getByTestId('prompt-newchat'))
    expect(fake.openChats).not.toHaveBeenCalled()
  })

  test('a failed create shows the banner; a rejected openChats never surfaces', async () => {
    const fake = fakeTriplex({ openChats: vi.fn(async () => { throw new Error('bad_request') }) })
    stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'boom' } }, 500) }])
    mount(fake, {}, { conversation: conv() })
    fireEvent.click(screen.getByTestId('prompt-newchat'))
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('boom'))
    expect(screen.getByTestId('prompt-newchat')).toBeEnabled()
    vi.unstubAllGlobals()
    stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse(conv({ id: 'c9' }), 201) }])
    fireEvent.click(screen.getByTestId('prompt-newchat'))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c9'))
    await tick()
    expect(screen.queryByTestId('prompt-banner')).toBeNull()
  })

  test('a conversation switch opens that conversation\'s chats once; the same id again does nothing; a clear passes null', async () => {
    const fake = fakeTriplex()
    stubFetch([])
    mount(fake, {}, { conversation: conv() })
    expect(fake.openChats).not.toHaveBeenCalled() // the first render never renavigates the panes
    act(() => store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c2' }) }))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c2'))
    act(() => store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c2', title: 'refetched' }) }))
    await tick()
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    act(() => store.dispatch({ type: 'conversation/cleared' }))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith(null))
    expect(fake.openChats).toHaveBeenCalledTimes(2)
  })
})

describe('PromptBar: bridge banner', () => {
  test('shown until onBridge reports connected, and again when it drops', () => {
    const fake = fakeTriplex()
    stubFetch([])
    mount(fake)
    expect(screen.getByTestId('bridge-banner')).toHaveTextContent(BRIDGE_BANNER_TEXT)
    expect(sendBtn()).toBeDisabled() // empty composer, not the bridge: Send is never gated on it
    act(() => fake.emit.bridge({ connected: true, since: 1758000000000 }))
    expect(screen.queryByTestId('bridge-banner')).toBeNull()
    act(() => fake.emit.bridge({ connected: false }))
    expect(screen.getByTestId('bridge-banner')).toBeInTheDocument()
    act(() => fake.emit.bridge('nonsense'))
    expect(screen.getByTestId('bridge-banner')).toBeInTheDocument()
  })

  test('unmount unsubscribes the bridge channel', () => {
    const fake = fakeTriplex()
    stubFetch([])
    const { unmount } = mount(fake)
    expect(fake.onBridge).toHaveBeenCalledTimes(1)
    unmount()
    expect(fake.unsubscribed.bridge).toBe(1)
  })
})
