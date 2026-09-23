// PromptBar (Stage 2): the unified prompt is a Triplex Send. Stubbed fetch (the harness of
// features/send/useSendTurn.test.jsx, shared from ./fakes.js) drives the real api/http.js +
// api/sse.js + useSendTurn.js; `window.triplex` is the fake of the Stage 2 preload surface.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import './index.jsx' // registers the `panes` slice (and, through useSendTurn, `slots`)
import PromptBar, { BRIDGE_BANNER_TEXT, CANCELLED_NOTICE_MS, PREPARSE_TITLES, formatResult, preparseBanner, preparseFailureText, resultTitle } from './PromptBar.jsx'
import { ANALYST_KEY, desktopSlotConfig } from './analyst.js'
import { NOT_CAPTURED, initialPanes } from './slice.js'
import { renderWithStore, sample } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { CFG, PREPARSE_NOTICE, conv, controlledStream, fakeTriplex, jsonResponse, preparse as pp, seqOf, sseResponse, stubFetch } from './fakes.js'

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
    expect(calls[0].body).toEqual({ slot_config: desktopSlotConfig() }) // S3: the desktop create carries the chosen analyst
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
    expect(calls[0].body).toEqual({ slot_config: desktopSlotConfig() }) // S3: the desktop create carries the chosen analyst
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

describe('PromptBar: Stage 3 (bridge error text, the desktop create body)', () => {
  const DESKTOP_SLOTS = {
    claude: { model: 'web:claude', effort: 'off' },
    chatgpt: { model: 'web:chatgpt', effort: 'off' },
    grok: { model: 'web:grok', effort: 'off' },
  }

  test('the bridge banner shows the error main sends with a disconnected state, and drops it once connected', () => {
    const fake = fakeTriplex()
    stubFetch([])
    mount(fake)
    expect(screen.getByTestId('bridge-banner')).toHaveTextContent(BRIDGE_BANNER_TEXT)
    expect(screen.queryByTestId('bridge-banner-error')).toBeNull()
    act(() => fake.emit.bridge({ connected: false, error: 'port_in_use' }))
    expect(screen.getByTestId('bridge-banner')).toHaveTextContent('port_in_use')
    expect(screen.getByTestId('bridge-banner-error')).toHaveTextContent('Backend: port_in_use')
    act(() => fake.emit.bridge({ connected: true, since: 1 }))
    expect(screen.queryByTestId('bridge-banner')).toBeNull()
    act(() => fake.emit.bridge({ connected: false }))
    expect(screen.getByTestId('bridge-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('bridge-banner-error')).toBeNull()
  })

  test('a first Send creates the conversation with the persisted analyst choice in slot_config (web:* panes at effort off), then streams into it', async () => {
    localStorage.setItem(ANALYST_KEY, 'ollama:hermes3')
    try {
      const fake = fakeTriplex()
      const calls = stubFetch([
        { method: 'POST', url: '/api/conversations', respond: jsonResponse(conv(), 201) },
        { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
        { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(conv()) },
        { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
      ])
      mount(fake)
      type('hi')
      enter()
      expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'true')
      expect(composer()).toHaveAttribute('readonly') // locked for the create round-trip too
      await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
      expect(calls[0].body).toEqual({ slot_config: { slots: DESKTOP_SLOTS, analyst_model: 'ollama:hermes3', max_iterations: 2, materiality_min: 'medium', grounded: false } })
      expect(calls[1].body).toEqual({ prompt: 'hi' })
      await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
      expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-locked', 'false')
      expect(composer()).toHaveValue('')
      for (const slot of ['claude', 'chatgpt', 'grok']) expect(result(slot)).toHaveTextContent('sent ✓ captured')
      // the created id was this Send's own: the panes are adopted, never renavigated (Decision 12)
      expect(fake.openChats).not.toHaveBeenCalled()
    } finally {
      localStorage.removeItem(ANALYST_KEY)
    }
  })

  test('a second Enter during the create round-trip never creates a second conversation or a second turn', async () => {
    let release
    const created = new Promise((r) => {
      release = r
    })
    const calls = stubFetch([
      {
        method: 'POST',
        url: '/api/conversations',
        respond: async () => {
          await created
          return jsonResponse(conv(), 201)
        },
      },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(conv()) },
      { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
    ])
    const fake = fakeTriplex()
    mount(fake)
    type('hi')
    enter()
    enter()
    enter()
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/conversations')).toHaveLength(1)
    expect(calls.filter((c) => c.url === '/api/conversations/c1/send')).toHaveLength(1)
  })

  test('a failed desktop create shows the banner, restores the text and unlocks; no turn is posted', async () => {
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'disk_full' } }, 500) }])
    const fake = fakeTriplex()
    mount(fake)
    type('keep me')
    enter()
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('disk_full'))
    expect(composer()).toHaveValue('keep me')
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false')
    expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-locked', 'false')
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])
    expect(screen.queryByTestId('prompt-result-claude')).toBeNull()
  })

  test('with a conversation selected the create path is skipped: the turn posts straight away', async () => {
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(conv({ turns: [{ id: 't0', type: 'send', prompt: 'earlier', responses: {}, errors: {} }] })) },
    ])
    const fake = fakeTriplex()
    mount(fake, {}, { conversation: conv({ turns: [{ id: 't0', type: 'send', prompt: 'earlier', responses: {}, errors: {} }] }), slotConfig: CFG })
    type('more')
    enter()
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1']))
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
  })
})

// Pre-parse (2026-09-23): a preview step on the composer text — `POST /api/conversations/{id}/preparse`
// through the same runStream as every feature, the result applied to the composer, Send unchanged.
describe('PromptBar: Pre-parse', () => {
  const PREPARSE_URL = '/api/conversations/c1/preparse'
  const preparseBtn = () => screen.getByTestId('prompt-preparse')
  const status = () => screen.getByTestId('prompt-preparse-status')
  const bar = () => screen.getByTestId('prompt-bar')
  const withConv = { conversation: conv(), slotConfig: CFG }
  const preparseRoute = (respond, url = PREPARSE_URL) => ({ method: 'POST', url, respond })
  const RESTATED = { question: 'What is the capital of Australia?', original: 'draft' }
  const DONE_PROMPT = pp.done(RESTATED).prompt

  /** The preparse slice and the preparse stream, read from outside the bar. */
  function PreparseProbe() {
    const p = useSlice('preparse')
    const st = useSlice('streams') || {}
    return <div data-testid="preparse-probe">{`${p.status}:${p.seq}:${st.preparse ? st.preparse.status : 'none'}`}</div>
  }
  function mountPre(fake, over = {}, preloaded = {}) {
    return renderWithStore(
      <>
        <PromptBar api={fake} />
        <Probe />
        <PreparseProbe />
      </>,
      { preloaded: { panes: { ...initialPanes(), ...over }, ...preloaded } },
    )
  }
  const settled = () => waitFor(() => expect(bar()).not.toHaveAttribute('data-preparsing'))

  test('pure helpers: plain words for the failure codes, the rest verbatim; the banner sentence', () => {
    expect(preparseFailureText('empty_prompt')).toBe('the prompt is empty')
    expect(preparseFailureText('prompt_too_long', { error: 'prompt_too_long', chars: 6001, max: 6000 })).toBe('the prompt is 6001 characters long and the analyst takes at most 6000 in one message')
    expect(preparseFailureText('prompt_too_long')).toBe('the prompt is too long for one analyst message')
    expect(preparseFailureText('analyst_not_chosen')).toBe('no analyst is chosen (Settings)')
    expect(preparseFailureText('busy')).toBe('this conversation is busy with another call')
    expect(preparseFailureText('cost_cap_exceeded')).toBe('cost_cap_exceeded')
    expect(preparseFailureText(undefined)).toBe('error')
    expect(preparseBanner('busy')).toBe('Pre-parse failed: this conversation is busy with another call. Your text is unchanged; you can Send it as it is.')
  })

  test('the button sits between the composer and Send; disabled while empty, enabled with text, each with its title; nothing else shown at rest', () => {
    stubFetch([])
    mountPre(fakeTriplex(), {}, withConv)
    const row = composer().parentElement
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual(['prompt-composer', 'prompt-preparse', 'prompt-send'])
    expect(preparseBtn()).toHaveTextContent('Pre-parse')
    expect(preparseBtn()).toBeDisabled()
    expect(preparseBtn().title).toBe('type a prompt first')
    type('   ')
    expect(preparseBtn()).toBeDisabled()
    type('draft')
    expect(preparseBtn()).toBeEnabled()
    expect(preparseBtn().title).toBe('Ask the analyst to restate the question clearly and add a short answer format; review it here, then Send')
    expect(preparseBtn().title).toBe(PREPARSE_TITLES.ready)
    expect(screen.queryByTestId('prompt-preparse-status')).toBeNull()
    expect(screen.queryByTestId('prompt-preparse-cancel')).toBeNull()
    expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
    expect(bar()).not.toHaveAttribute('data-preparsing')
    expect(bar()).not.toHaveAttribute('data-preparsed')
    expect(composer()).toHaveAttribute('rows', '2')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test('click → exactly POST …/preparse {prompt}, no /send, no refetch; done → the composer holds ev.prompt with the caret at 0, six rows, Undo shown, focus back, unlocked, Pre-parse disabled until edited', async () => {
    const fake = fakeTriplex()
    const calls = stubFetch([preparseRoute(() => sseResponse(pp.stream(RESTATED)))])
    mountPre(fake, {}, withConv)
    type('draft')
    act(() => composer().focus())
    fireEvent.click(preparseBtn())
    expect(bar()).toHaveAttribute('data-sending', 'false') // a pre-parse is not a send: panes/sendStart is never dispatched
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
    await settled()
    expect(seqOf(calls)).toEqual([`POST ${PREPARSE_URL}`])
    expect(calls[0].body).toEqual({ prompt: 'draft' })
    expect(bar()).toHaveAttribute('data-preparsed', 'true')
    expect(bar()).toHaveAttribute('data-locked', 'false')
    expect(bar()).toHaveAttribute('data-sending', 'false')
    expect(composer()).not.toHaveAttribute('readonly')
    expect(composer()).toHaveAttribute('rows', '6')
    expect(composer().selectionStart).toBe(0)
    expect(composer().selectionEnd).toBe(0)
    expect(document.activeElement).toBe(composer())
    expect(screen.getByTestId('prompt-preparse-undo')).toBeEnabled()
    expect(screen.getByTestId('prompt-preparse-undo').title).toBe('Put back the text you typed')
    expect(screen.queryByTestId('prompt-preparse-cancel')).toBeNull()
    expect(status()).toHaveAttribute('data-state', 'done')
    expect(status()).toHaveTextContent(`Pre-parsed · ${DONE_PROMPT.length} chars`)
    expect(screen.getByTestId('preparse-probe')).toHaveTextContent('done:1:done')
    expect(preparseBtn()).toBeDisabled()
    expect(preparseBtn().title).toBe('already pre-parsed — edit the text, or undo, to pre-parse again')
    expect(sendBtn()).toBeEnabled()
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:c1')
    expect(fake.openChats).not.toHaveBeenCalled()
    expect(screen.queryByTestId('prompt-banner')).toBeNull()
  })

  test('while it runs: data-preparsing, composer read-only and blurred with its text kept, Send / New chat disabled with their titles, Enter posts nothing, the status line then the notice, the elapsed counter ticks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const stream = controlledStream()
      const calls = stubFetch([preparseRoute(() => stream.response)])
      mountPre(fakeTriplex(), {}, withConv)
      type('draft')
      act(() => composer().focus())
      fireEvent.click(preparseBtn())
      await waitFor(() => expect(seqOf(calls)).toEqual([`POST ${PREPARSE_URL}`]))
      expect(bar()).toHaveAttribute('data-preparsing', 'true')
      expect(bar()).toHaveAttribute('data-locked', 'true')
      expect(bar()).toHaveAttribute('data-sending', 'false')
      expect(bar()).not.toHaveAttribute('data-preparsed')
      expect(composer()).toHaveAttribute('readonly')
      expect(composer()).toHaveAttribute('aria-busy', 'true')
      expect(document.activeElement).not.toBe(composer())
      expect(composer()).toHaveValue('draft')
      expect(preparseBtn()).toBeDisabled()
      expect(preparseBtn()).toHaveTextContent('Pre-parsing…')
      expect(preparseBtn().title).toBe('restating the question via the analyst…')
      expect(sendBtn()).toBeDisabled()
      expect(sendBtn().title).toBe('pre-parse in progress')
      expect(screen.getByTestId('prompt-newchat')).toBeDisabled()
      expect(screen.getByTestId('prompt-newchat').title).toBe('pre-parse in progress')
      expect(screen.getByTestId('prompt-preparse-cancel').title).toBe('Stop waiting and unlock the composer; the analyst page is told to stop')
      expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
      expect(status()).toHaveAttribute('data-state', 'running')
      expect(status()).toHaveAttribute('role', 'status')
      expect(status()).toHaveAttribute('aria-live', 'polite')
      expect(status().textContent).toMatch(/^restating the question via the analyst… \d+ s$/)
      expect(status().parentElement.firstElementChild).toBe(status()) // first in .promptMeta
      // Enter during a pre-parse is ignored; so is a second click
      enter()
      fireEvent.click(preparseBtn())
      expect(seqOf(calls)).toEqual([`POST ${PREPARSE_URL}`])
      // the counter is wall-clock seconds since the click
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(Number(/(\d+) s$/.exec(status().textContent)[1])).toBeGreaterThanOrEqual(2)
      stream.push([pp.start(), pp.retry()])
      await waitFor(() => expect(status().textContent).toMatch(new RegExp(`^${PREPARSE_NOTICE} \\d+ s$`)))
      expect(screen.getByTestId('preparse-probe')).toHaveTextContent('working:0:streaming')
      expect(composer()).toHaveValue('draft')
      stream.push([pp.done(RESTATED)])
      stream.end()
      await settled()
      expect(composer()).toHaveValue(DONE_PROMPT)
      expect(composer()).not.toHaveAttribute('readonly')
      expect(document.activeElement).toBe(composer())
      expect(status()).toHaveAttribute('data-state', 'done')
      expect(sendBtn()).toBeEnabled()
      expect(screen.getByTestId('prompt-newchat')).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  test('Undo puts the typed text back and goes away; an edit hides Undo and re-enables Pre-parse; a Send clears it and posts the composer text verbatim', async () => {
    const calls = stubFetch([
      preparseRoute(() => sseResponse(pp.stream(RESTATED))),
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(afterSend(DONE_PROMPT)) },
      { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
    ])
    mountPre(fakeTriplex(), {}, withConv)
    type('draft')
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
    await settled()
    // Undo
    fireEvent.click(screen.getByTestId('prompt-preparse-undo'))
    expect(composer()).toHaveValue('draft')
    expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
    expect(screen.queryByTestId('prompt-preparse-status')).toBeNull()
    expect(bar()).not.toHaveAttribute('data-preparsed')
    expect(composer()).toHaveAttribute('rows', '2')
    expect(preparseBtn()).toBeEnabled()
    expect(preparseBtn().title).toBe(PREPARSE_TITLES.ready)
    // again, then an edit
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
    await settled()
    expect(preparseBtn()).toBeDisabled()
    type(`${DONE_PROMPT} plus my edit`)
    expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
    expect(bar()).not.toHaveAttribute('data-preparsed')
    expect(preparseBtn()).toBeEnabled()
    expect(preparseBtn().title).toBe(PREPARSE_TITLES.ready)
    // a third time (the edited text is what is posted), then Send: the body is the composer text, byte for byte
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
    await settled()
    const preparses = calls.filter((c) => c.url === PREPARSE_URL)
    expect(preparses).toHaveLength(3)
    expect(preparses.map((c) => c.body)).toEqual([{ prompt: 'draft' }, { prompt: 'draft' }, { prompt: `${DONE_PROMPT} plus my edit` }])
    enter()
    expect(composer()).toHaveValue('')
    expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
    expect(screen.queryByTestId('prompt-preparse-status')).toBeNull()
    expect(bar()).not.toHaveAttribute('data-preparsed')
    await waitFor(() => expect(seqOf(calls).slice(-3)).toEqual(['POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(calls.find((c) => c.url === '/api/conversations/c1/send').body).toEqual({ prompt: DONE_PROMPT })
    await waitFor(() => expect(bar()).toHaveAttribute('data-sending', 'false'))
    expect(screen.getByTestId('preparse-probe')).toHaveTextContent('idle:3:done') // cleared at submit, seq kept
    expect(screen.queryByTestId('prompt-banner')).toBeNull()
  })

  test('with no conversation the bar creates one that adopts the panes: POST /api/conversations with desktopSlotConfig(), openChats never called, sending never true; the Send that follows posts into it without a second create', async () => {
    const fake = fakeTriplex()
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations', respond: jsonResponse(conv(), 201) },
      preparseRoute(() => sseResponse(pp.stream(RESTATED))),
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(afterSend(DONE_PROMPT)) },
      { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
    ])
    mountPre(fake)
    type('draft')
    fireEvent.click(preparseBtn())
    expect(bar()).toHaveAttribute('data-preparsing', 'true') // locked for the create round-trip too
    expect(bar()).toHaveAttribute('data-sending', 'false')
    expect(composer()).toHaveAttribute('readonly')
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
    await settled()
    expect(seqOf(calls)).toEqual(['POST /api/conversations', `POST ${PREPARSE_URL}`])
    expect(calls[0].body).toEqual({ slot_config: desktopSlotConfig() })
    expect(calls[1].body).toEqual({ prompt: 'draft' })
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:c1')
    await tick()
    expect(fake.openChats).not.toHaveBeenCalled() // the panes keep their chats; the first Send adopts them
    enter()
    expect(bar()).toHaveAttribute('data-sending', 'true')
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', `POST ${PREPARSE_URL}`, 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(calls[2].body).toEqual({ prompt: DONE_PROMPT })
    await waitFor(() => expect(bar()).toHaveAttribute('data-sending', 'false'))
    await tick()
    expect(fake.openChats).not.toHaveBeenCalled()
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(result(slot)).toHaveTextContent('sent ✓ captured')
  })

  test("with the shell's chats instance the create goes through its createAdopted", async () => {
    const calls = stubFetch([preparseRoute(() => sseResponse(pp.stream(RESTATED)), '/api/conversations/c5/preparse')])
    const chats = { newChatEverywhere: vi.fn(), createAdopted: vi.fn(async () => conv({ id: 'c5' })), busy: false, error: null, clearError: vi.fn() }
    renderWithStore(<PromptBar api={fakeTriplex()} chats={chats} />, { preloaded: { panes: initialPanes() } })
    type('draft')
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations/c5/preparse']))
    expect(chats.createAdopted).toHaveBeenCalledTimes(1)
    expect(chats.newChatEverywhere).not.toHaveBeenCalled()
    expect(chats.clearError).toHaveBeenCalled()
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
  })

  test('a failed create shows the banner and keeps the text; nothing else is posted', async () => {
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'disk_full' } }, 500) }])
    mountPre(fakeTriplex())
    type('draft')
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('disk_full'))
    await settled()
    expect(composer()).toHaveValue('draft')
    expect(composer()).not.toHaveAttribute('readonly')
    expect(bar()).toHaveAttribute('data-locked', 'false')
    expect(bar()).not.toHaveAttribute('data-preparsed')
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])
    expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
    expect(screen.queryByTestId('prompt-preparse-status')).toBeNull()
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:none')
    expect(preparseBtn()).toBeEnabled()
  })

  test('a degrade, a terminal error and a pre-stream 409 / 422 each show the banner in plain words and leave the text alone: no Undo, no result, a retry allowed', async () => {
    const tail = 'Your text is unchanged; you can Send it as it is.'
    const cases = [
      {
        name: 'degraded',
        respond: () => sseResponse([pp.start(), pp.retry(), pp.degraded({ error: 'the analyst returned an empty restatement', original: 'draft', raw_attempts: ['{"question": "  "}'] })]),
        text: `Pre-parse failed: the analyst returned an empty restatement. ${tail}`,
        probe: 'degraded:0:done',
      },
      { name: 'error event', respond: () => sseResponse([pp.start(), { type: 'error', message: 'boom' }]), text: `Pre-parse failed: boom. ${tail}`, probe: 'error:0:error' },
      { name: '409 busy', respond: jsonResponse({ detail: { error: 'busy' } }, 409), text: `Pre-parse failed: this conversation is busy with another call. ${tail}`, probe: 'error:0:error' },
      {
        name: '422 prompt_too_long',
        respond: jsonResponse({ detail: { error: 'prompt_too_long', chars: 6001, max: 6000 } }, 422),
        text: `Pre-parse failed: the prompt is 6001 characters long and the analyst takes at most 6000 in one message. ${tail}`,
        probe: 'error:0:error',
      },
      { name: '422 empty_prompt', respond: jsonResponse({ detail: { error: 'empty_prompt' } }, 422), text: `Pre-parse failed: the prompt is empty. ${tail}`, probe: 'error:0:error' },
      { name: '404', respond: jsonResponse({ detail: { error: 'not_found', what: 'conversation' } }, 404), text: `Pre-parse failed: not_found. ${tail}`, probe: 'error:0:error' },
      {
        name: 'analyst_not_chosen (degraded)',
        respond: () => sseResponse([pp.start(), pp.retry(), pp.degraded({ error: 'analyst_not_chosen', original: 'draft', raw_attempts: [''] })]),
        text: `Pre-parse failed: no analyst is chosen (Settings). ${tail}`,
        probe: 'degraded:0:done',
      },
      { name: 'malformed done', respond: () => sseResponse([pp.start(), { type: 'preparse_done', prompt: '', original: 'draft', question: '' }]), text: `Pre-parse failed: malformed preparse_done. ${tail}`, probe: 'error:0:done' },
    ]
    for (const c of cases) {
      stubFetch([preparseRoute(c.respond)])
      const { unmount } = mountPre(fakeTriplex(), {}, withConv)
      type('draft')
      fireEvent.click(preparseBtn())
      await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('Pre-parse failed'))
      await settled()
      expect(screen.getByTestId('prompt-banner').textContent, c.name).toBe(c.text)
      expect(composer(), c.name).toHaveValue('draft')
      expect(composer()).not.toHaveAttribute('readonly')
      expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
      expect(screen.queryByTestId('prompt-preparse-status')).toBeNull()
      expect(bar()).not.toHaveAttribute('data-preparsed')
      expect(sendBtn()).toBeEnabled()
      expect(preparseBtn()).toBeEnabled()
      expect(screen.getByTestId('preparse-probe'), c.name).toHaveTextContent(c.probe)
      unmount()
      vi.unstubAllGlobals()
    }
  })

  test('the failure banner clears on the next Pre-parse click and on a Send', async () => {
    const calls = stubFetch([
      preparseRoute(({ body }) => (body.prompt === 'draft' ? jsonResponse({ detail: { error: 'busy' } }, 409) : sseResponse(pp.stream(RESTATED)))),
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(afterSend('x')) },
      { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
    ])
    mountPre(fakeTriplex(), {}, withConv)
    type('draft')
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('busy'))
    await settled()
    type('draft two')
    fireEvent.click(preparseBtn())
    expect(screen.queryByTestId('prompt-banner')).toBeNull()
    await waitFor(() => expect(composer()).toHaveValue(DONE_PROMPT))
    await settled()
    // a failure, then a Send
    expect(calls.filter((c) => c.url === PREPARSE_URL)).toHaveLength(2)
    vi.unstubAllGlobals()
    stubFetch([
      preparseRoute(jsonResponse({ detail: { error: 'busy' } }, 409)),
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(fullStream('t1')) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(afterSend('x')) },
      { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
    ])
    type('draft three')
    fireEvent.click(preparseBtn())
    await waitFor(() => expect(screen.getByTestId('prompt-banner')).toHaveTextContent('busy'))
    await settled()
    enter()
    expect(screen.queryByTestId('prompt-banner')).toBeNull()
    await waitFor(() => expect(bar()).toHaveAttribute('data-sending', 'false'))
    expect(screen.queryByTestId('prompt-banner')).toBeNull()
  })

  test('Cancel aborts the stream (sse/abort): idle, text unchanged, unlocked, "pre-parse cancelled" on the status line for a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const stream = controlledStream()
      const calls = stubFetch([
        preparseRoute(({ signal }) => {
          stream.bind(signal)
          return stream.response
        }),
      ])
      mountPre(fakeTriplex(), {}, withConv)
      type('draft')
      fireEvent.click(preparseBtn())
      await waitFor(() => expect(seqOf(calls)).toEqual([`POST ${PREPARSE_URL}`]))
      stream.push([pp.start(), pp.retry()])
      await waitFor(() => expect(screen.getByTestId('preparse-probe')).toHaveTextContent('working:0:streaming'))
      fireEvent.click(screen.getByTestId('prompt-preparse-cancel'))
      await settled()
      expect(screen.getByTestId('preparse-probe')).toHaveTextContent('idle:0:aborted')
      expect(composer()).toHaveValue('draft')
      expect(composer()).not.toHaveAttribute('readonly')
      expect(bar()).toHaveAttribute('data-locked', 'false')
      expect(bar()).not.toHaveAttribute('data-preparsed')
      expect(status()).toHaveAttribute('data-state', 'cancelled')
      expect(status()).toHaveTextContent('pre-parse cancelled')
      expect(screen.queryByTestId('prompt-preparse-cancel')).toBeNull()
      expect(screen.queryByTestId('prompt-preparse-undo')).toBeNull()
      expect(screen.queryByTestId('prompt-banner')).toBeNull()
      expect(preparseBtn()).toBeEnabled()
      expect(sendBtn()).toBeEnabled()
      act(() => {
        vi.advanceTimersByTime(CANCELLED_NOTICE_MS + 50)
      })
      expect(screen.queryByTestId('prompt-preparse-status')).toBeNull()
      expect(seqOf(calls)).toEqual([`POST ${PREPARSE_URL}`]) // nothing else was asked
    } finally {
      vi.useRealTimers()
    }
  })

  test('Cancel during the create round-trip: the conversation is created but no pre-parse is asked; the text stays', async () => {
    let release
    const created = new Promise((r) => {
      release = r
    })
    const calls = stubFetch([
      {
        method: 'POST',
        url: '/api/conversations',
        respond: async () => {
          await created
          return jsonResponse(conv(), 201)
        },
      },
      preparseRoute(() => sseResponse(pp.stream(RESTATED))),
    ])
    mountPre(fakeTriplex())
    type('draft')
    fireEvent.click(preparseBtn())
    expect(bar()).toHaveAttribute('data-preparsing', 'true')
    fireEvent.click(screen.getByTestId('prompt-preparse-cancel'))
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await settled()
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])
    expect(composer()).toHaveValue('draft')
    expect(status()).toHaveAttribute('data-state', 'cancelled')
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt:false:c1')
  })

  test('disabled with the matching title while a send is in flight, while send / analyze / fusion / refactor stream, and with no analyst (the conversation\'s, or the desktop choice with none open)', () => {
    stubFetch([])
    const cases = [
      { over: { sending: true }, preloaded: withConv, title: 'a send is in flight' },
      { over: {}, preloaded: { ...withConv, streams: { send: STREAMING, analyze: IDLE, fusion: IDLE } }, title: 'a stream is running' },
      { over: {}, preloaded: { ...withConv, streams: { send: IDLE, analyze: STREAMING, fusion: IDLE } }, title: 'the analyst is busy (Analyze, Fusion or Refactor is running)' },
      { over: {}, preloaded: { ...withConv, streams: { send: IDLE, analyze: IDLE, fusion: STREAMING } }, title: 'the analyst is busy (Analyze, Fusion or Refactor is running)' },
      { over: {}, preloaded: { ...withConv, streams: { send: IDLE, analyze: IDLE, fusion: IDLE, refactor: STREAMING } }, title: 'the analyst is busy (Analyze, Fusion or Refactor is running)' },
      { over: {}, preloaded: { conversation: conv({ slot_config: { ...CFG, analyst_model: '' } }), slotConfig: { ...CFG, analyst_model: '' } }, title: 'Pre-parse needs an analyst: choose a web session or local Ollama in Settings' },
      { over: {}, preloaded: { conversation: conv({ slot_config: { ...CFG, analyst_model: 'openai/gpt-5' } }), slotConfig: { ...CFG, analyst_model: 'openai/gpt-5' } }, title: 'Pre-parse needs an analyst: choose a web session or local Ollama in Settings' },
    ]
    for (const c of cases) {
      const { unmount } = mountPre(fakeTriplex(), c.over, c.preloaded)
      type('draft')
      expect(preparseBtn(), c.title).toBeDisabled()
      expect(preparseBtn().title, c.title).toBe(c.title)
      fireEvent.click(preparseBtn())
      unmount()
    }
    // a refactor stream locks nothing else (useSendTurn ignores it) — only this button
    const refactoring = mountPre(fakeTriplex(), {}, { ...withConv, streams: { send: IDLE, analyze: IDLE, fusion: IDLE, refactor: STREAMING } })
    type('draft')
    expect(composer()).not.toHaveAttribute('readonly')
    expect(sendBtn()).toBeEnabled()
    refactoring.unmount()
    // no conversation: the desktop choice decides
    localStorage.setItem(ANALYST_KEY, '')
    try {
      mountPre(fakeTriplex())
      type('draft')
      expect(preparseBtn()).toBeDisabled()
      expect(preparseBtn().title).toBe(PREPARSE_TITLES.noAnalyst)
      fireEvent.click(preparseBtn())
    } finally {
      localStorage.removeItem(ANALYST_KEY)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
