// useOpenChats (Stage 2): the conversation ↔ site-chat link, driven directly through a harness so
// the rule is pinned independently of PromptBar: a conversation id change opens that conversation's
// chats exactly once — EXCEPT the id a Send's own create produces. PromptBar dispatches
// `panes/sendStart` before `startTurn`, so that create lands under `panes.sending`; the bridge
// requests of that very Send are already in flight and main must not navigate the panes under them
// (Decision 12: the send adopts whatever chat each pane shows). `window.triplex` is the fake of the
// Stage 2 preload surface (./fakes.js).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import './index.jsx' // registers the `panes` slice
import { desktopSlotConfig } from './analyst.js'
import { useOpenChats } from './chats.js'
import { initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { conv, fakeTriplex, jsonResponse, seqOf, stubFetch } from './fakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The store's dispatch and the hook's return, captured so a test drives the slices from outside. */
const store = { dispatch: null, chats: null }

function Harness({ api, enabled }) {
  const c = useSlice('conversation')
  const p = useSlice('panes')
  store.dispatch = useDispatch()
  store.chats = useOpenChats(api, enabled === undefined ? {} : { enabled })
  return <div data-testid="probe">{`${p.sending}:${c ? c.id : 'none'}`}</div>
}

function mount(fake, preloaded = {}, { enabled } = {}) {
  return renderWithStore(<Harness api={fake} enabled={enabled} />, { preloaded: { panes: initialPanes(), ...preloaded } })
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))
const loaded = (over) => act(() => store.dispatch({ type: 'conversation/loaded', conversation: conv(over) }))
const sendStart = () => act(() => store.dispatch({ type: 'panes/sendStart', targets: ['claude', 'chatgpt', 'grok'] }))
const sendResult = () => act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))

describe("useOpenChats: a Send's own create is adopted, a switch is opened", () => {
  test('under panes.sending an id change (null → id: the first Send\'s create) does NOT call openChats; a later manual switch to that conversation still does', async () => {
    const fake = fakeTriplex()
    mount(fake)
    expect(fake.openChats).not.toHaveBeenCalled() // the first render never renavigates the panes
    sendStart() // PromptBar: panes/sendStart precedes startTurn, whose create lands under it
    loaded({ id: 'c1' })
    expect(screen.getByTestId('probe')).toHaveTextContent('true:c1')
    await tick()
    expect(fake.openChats).not.toHaveBeenCalled()
    // the turn settles; the refetch re-dispatches the same id: still nothing
    sendResult()
    loaded({ id: 'c1', title: 'refetched' })
    await tick()
    expect(screen.getByTestId('probe')).toHaveTextContent('false:c1')
    expect(fake.openChats).not.toHaveBeenCalled()
    // a manual sidebar switch away is a switch, and so is one back to the Send-created conversation
    loaded({ id: 'c2' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c2'))
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    loaded({ id: 'c1' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c1'))
    expect(fake.openChats).toHaveBeenCalledTimes(2)
  })

  test('a fast turn collapsed into one render (id change and sendResult together, React batching) is still the Send\'s own create: no openChats; the next manual switch opens', async () => {
    const fake = fakeTriplex()
    mount(fake)
    sendStart()
    expect(screen.getByTestId('probe')).toHaveTextContent('true:none')
    // the stubbed create → stream → refetch → sendResult chain lands in a single render
    act(() => {
      store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c1' }) })
      store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c1', title: 'refetched' }) })
      store.dispatch({ type: 'panes/sendResult', results: {} })
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('false:c1')
    await tick()
    expect(fake.openChats).not.toHaveBeenCalled()
    loaded({ id: 'c2' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c2'))
    expect(fake.openChats).toHaveBeenCalledTimes(1)
  })

  test('a Send in an existing conversation marks nothing: once it has ended, a manual switch opens the chats', async () => {
    const fake = fakeTriplex()
    mount(fake, { conversation: conv({ id: 'c1' }) })
    sendStart()
    loaded({ id: 'c1', title: 'refetched' })
    sendResult()
    await tick()
    expect(fake.openChats).not.toHaveBeenCalled()
    loaded({ id: 'c2' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c2'))
    expect(fake.openChats).toHaveBeenCalledTimes(1)
  })

  test('with sending false the same id change opens the chats exactly once (a repeat of the id does nothing)', async () => {
    const fake = fakeTriplex()
    mount(fake)
    expect(screen.getByTestId('probe')).toHaveTextContent('false:none')
    loaded({ id: 'c1' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c1'))
    loaded({ id: 'c1', title: 'again' })
    await tick()
    expect(fake.openChats).toHaveBeenCalledTimes(1)
  })

  test('a switch from one conversation to another opens the chats even when the panes are otherwise idle; a repeat is ignored', async () => {
    const fake = fakeTriplex()
    mount(fake, { conversation: conv({ id: 'c1' }) })
    expect(fake.openChats).not.toHaveBeenCalled()
    loaded({ id: 'c2' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c2'))
    loaded({ id: 'c2' })
    await tick()
    expect(fake.openChats).toHaveBeenCalledTimes(1)
  })

  test('a clear (id → null) still reaches main as openChats(null), sending or not', async () => {
    const fake = fakeTriplex()
    mount(fake, { conversation: conv({ id: 'c1' }) })
    sendStart()
    act(() => store.dispatch({ type: 'conversation/cleared' }))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith(null))
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    sendResult()
    loaded({ id: 'c3' })
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c3'))
    act(() => store.dispatch({ type: 'conversation/cleared' }))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledTimes(3))
    expect(fake.openChats).toHaveBeenLastCalledWith(null)
  })

  test('New chat everywhere is unchanged: createConversation + openChats(newId) once; the loaded it dispatches does not repeat it', async () => {
    const fake = fakeTriplex()
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse(conv({ id: 'c9' }), 201) }])
    mount(fake, { conversation: conv({ id: 'c1' }) })
    let result
    await act(async () => {
      result = await store.chats.newChatEverywhere()
    })
    expect(result && result.id).toBe('c9')
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(':c9'))
    await tick()
    expect(fake.openChats).toHaveBeenCalledWith('c9')
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    expect(seqOf(calls)).toEqual(['POST /api/conversations'])
    expect(calls[0].body).toEqual({ slot_config: desktopSlotConfig() }) // S3: the desktop create carries the chosen analyst
    expect(store.chats.busy).toBe(false)
    expect(store.chats.error).toBeNull()
  })

  test('enabled: false never opens chats (a second instance must not double-navigate)', async () => {
    const fake = fakeTriplex()
    mount(fake, {}, { enabled: false })
    loaded({ id: 'c1' })
    loaded({ id: 'c2' })
    await tick()
    expect(fake.openChats).not.toHaveBeenCalled()
  })

  test('works under a partial api without openChats', async () => {
    const fake = fakeTriplex({ openChats: undefined })
    mount(fake)
    loaded({ id: 'c1' })
    await tick()
    expect(screen.getByTestId('probe')).toHaveTextContent('false:c1')
  })
})
