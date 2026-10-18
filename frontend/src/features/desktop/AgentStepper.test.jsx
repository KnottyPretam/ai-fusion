// AgentStepper (2026-10-17): `−  N agents  +` in the deck bar, end to end through PaneDeck — where
// a change lands (only the default / PUT in place / a new chat), the order of the effects (PUT →
// setCouncil → POST), the 409 fallback, a refusal that changes nothing, the busy gates (a plan
// stream included), the add menu (lazy loads, keyboard, unseatable items, More options → the
// drawer's Agents tab) and the re-target of an added member.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import './index.jsx' // registers the `panes` slice
import PaneDeck from './PaneDeck.jsx'
import { MAX_TEXT, MIN_TEXT } from './stepper.js'
import { initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { CFG, CFG5, KEY_SET, conv, fakeTriplex, installFakeResizeObserver, jsonResponse, modelsState, pinViewportRects, seqOf, stubFetch, syncFrames } from './fakes.js'

beforeEach(() => {
  localStorage.clear()
  syncFrames()
  installFakeResizeObserver()
  pinViewportRects()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

const store = {}
function Probe() {
  store.panes = useSlice('panes')
  store.conversation = useSlice('conversation')
  store.conversations = useSlice('conversations')
  store.slotConfig = useSlice('slotConfig')
  store.dispatch = useDispatch()
  return null
}

const IDLE = { status: 'idle', error: null, httpStatus: null }
const STREAMING = { status: 'streaming', error: null, httpStatus: null }
const IDLE_STREAMS = { send: IDLE, analyze: IDLE, fusion: IDLE, preparse: IDLE, refactor: IDLE, plan: IDLE }
const TURN = { id: 't1', type: 'send', prompt: 'q', slot_config: CFG, responses: {}, usage: { calls: [], totals: {} } }
const web = (slot) => ({ model: `web:${slot}`, effort: 'off' })
const FOUR = { claude: web('claude'), chatgpt: web('chatgpt'), grok: web('grok'), gemini: web('gemini') }

function mount(fake, { panes = {}, ...preloaded } = {}) {
  return renderWithStore(
    <>
      <PaneDeck api={fake} info={{ dev: false }} version="0.1.0" />
      <Probe />
    </>,
    { preloaded: { panes: { ...initialPanes(), ...panes }, streams: IDLE_STREAMS, ...preloaded } },
  )
}

const stepper = () => screen.getByTestId('agents-stepper')
const removeBtn = () => screen.getByTestId('agents-stepper-remove')
const addBtn = () => screen.getByTestId('agents-stepper-add')
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

/** A fake whose setCouncil and the fetch stub write to one shared log (to pin the order of effects). */
function logged(routes, over = {}) {
  const log = []
  const fake = fakeTriplex({
    setCouncil: vi.fn(async (spec) => {
      log.push(`setCouncil ${Object.keys(spec.slots).join(',')}`)
      return spec
    }),
    ...over,
  })
  const calls = stubFetch(
    routes.map((r) => ({
      ...r,
      respond: (req) => {
        log.push(`${req.method} ${req.url}`)
        return typeof r.respond === 'function' ? r.respond(req) : r.respond
      },
    })),
  )
  return { fake, calls, log }
}

describe('AgentStepper: the bar', () => {
  test('sits in the deck bar right after the tabs; four agents by default; − names Gemini; + is capped at four; the deck alone fetches nothing', () => {
    const calls = stubFetch([])
    mount(fakeTriplex())
    const bar = screen.getByRole('tablist', { name: 'Panes' }).parentElement
    expect(screen.getByRole('tablist', { name: 'Panes' }).nextElementSibling).toBe(stepper())
    expect(bar.contains(stepper())).toBe(true)
    expect(stepper()).toHaveAttribute('role', 'group')
    expect(stepper()).toHaveAttribute('data-count', '4')
    expect(stepper()).toHaveAttribute('data-mode', 'default')
    expect(stepper()).toHaveAttribute('data-busy', 'false')
    expect(screen.getByTestId('agents-stepper-count')).toHaveTextContent('4 agents')
    expect(screen.getByTestId('agents-stepper-count')).toHaveAttribute('title', 'The agents new chats start with: Claude, ChatGPT, Grok and Gemini.')
    expect(removeBtn()).toHaveAttribute('aria-label', 'Remove Gemini')
    expect(removeBtn()).toHaveAttribute('data-slot', 'gemini')
    expect(removeBtn()).toHaveAttribute('title', 'Remove Gemini (the right-most agent). New chats then start with Claude, ChatGPT and Grok.')
    expect(removeBtn()).toBeEnabled()
    expect(addBtn()).toBeDisabled()
    expect(addBtn()).toHaveAttribute('title', MAX_TEXT)
    expect(addBtn()).toHaveAttribute('aria-haspopup', 'menu')
    expect(addBtn()).toHaveAttribute('aria-expanded', 'false')
    // no id starts with deck-tab- (councilDeck counts tabs by that prefix)
    for (const el of stepper().querySelectorAll('[data-testid]')) expect(el.getAttribute('data-testid').startsWith('deck-tab-')).toBe(false)
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
    expect(calls).toEqual([])
  })

  test('at two − is disabled with the floor’s reason; an open conversation’s mode is in the title', () => {
    stubFetch([])
    const two = { ...CFG, slots: { claude: CFG.slots.claude, grok: CFG.slots.grok } }
    mount(fakeTriplex(), { conversation: conv({ slot_config: two }), slotConfig: two })
    expect(stepper()).toHaveAttribute('data-count', '2')
    expect(stepper()).toHaveAttribute('data-mode', 'in-place')
    expect(removeBtn()).toBeDisabled()
    expect(removeBtn()).toHaveAttribute('title', MIN_TEXT)
    expect(addBtn()).toBeEnabled()
    expect(addBtn()).toHaveAttribute('title', 'Add an agent (3 of 4) to this conversation (nothing has been said yet) and to the default for new chats.')
  })

  test('a stored five renders (5 agents), + stays capped, − trims it', () => {
    stubFetch([])
    mount(fakeTriplex(), { conversation: conv({ slot_config: CFG5, turns: [TURN] }), slotConfig: CFG5 })
    expect(stepper()).toHaveAttribute('data-count', '5')
    expect(stepper()).toHaveAttribute('data-mode', 'new-chat')
    expect(addBtn()).toBeDisabled()
    expect(addBtn()).toHaveAttribute('title', 'Four agents at most. This council has 5 from before; − trims it in a new chat.')
    expect(removeBtn()).toHaveAttribute('aria-label', 'Remove Qwen')
    expect(removeBtn()).toBeEnabled()
  })

  test('both buttons are disabled while ANY stream runs (a plan stream included), while a send is in flight', () => {
    stubFetch([])
    const three = { panes: { council: { slots: CFG.slots } } }
    const { unmount } = mount(fakeTriplex(), { ...three, streams: { ...IDLE_STREAMS, plan: STREAMING } })
    expect(stepper()).toHaveAttribute('data-busy', 'true')
    expect(removeBtn()).toBeDisabled()
    expect(addBtn()).toBeDisabled()
    expect(removeBtn()).toHaveAttribute('title', 'Remove an agent: a stream is running')
    expect(addBtn()).toHaveAttribute('title', 'Add an agent: a stream is running')
    unmount()
    mount(fakeTriplex(), { panes: { council: { slots: CFG.slots }, sending: true } })
    expect(removeBtn()).toBeDisabled()
    expect(addBtn()).toBeDisabled()
    expect(addBtn()).toHaveAttribute('title', 'Add an agent: a send is in flight')
  })
})

describe('AgentStepper: where a change lands', () => {
  test('no conversation: − only changes the default (setCouncil → panes.council); no request; the Gemini pane goes', async () => {
    const { fake, calls, log } = logged([])
    mount(fake)
    expect(screen.getByTestId('pane-gemini')).toBeInTheDocument()
    fireEvent.click(removeBtn())
    await waitFor(() => expect(fake.setCouncil).toHaveBeenCalledTimes(1))
    expect(fake.setCouncil.mock.calls[0][0]).toEqual({ slots: { claude: web('claude'), chatgpt: web('chatgpt'), grok: web('grok') } })
    await waitFor(() => expect(store.panes.council).toEqual({ slots: { claude: web('claude'), chatgpt: web('chatgpt'), grok: web('grok') } }))
    expect(calls).toEqual([])
    expect(log).toEqual(['setCouncil claude,chatgpt,grok'])
    expect(fake.openChats).not.toHaveBeenCalled()
    expect(screen.queryByTestId('pane-gemini')).toBeNull()
    expect(stepper()).toHaveAttribute('data-count', '3')
    expect(removeBtn()).toHaveAttribute('aria-label', 'Remove Grok')
  })

  test('an empty conversation: + Gemini PUTs the full config in place, THEN saves the default; no POST, no openChats; the slot config lands', async () => {
    const { fake, calls, log } = logged([
      { method: 'PUT', url: '/api/conversations/c1/slot_config', respond: ({ body }) => jsonResponse(body) },
      { method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ base_url: 'http://127.0.0.1:11434/v1', loopback: true, models: [] }) },
    ])
    mount(fake, { conversation: conv({ slot_config: CFG }), slotConfig: CFG, models: modelsState(), panes: { targets: { claude: true, chatgpt: true, grok: true, gemini: false } } })
    expect(stepper()).toHaveAttribute('data-mode', 'in-place')
    fireEvent.click(addBtn())
    const menu = screen.getByTestId('agents-stepper-menu')
    expect(screen.getByTestId('agents-stepper-menu-hint')).toHaveTextContent('Add to this conversation (nothing said yet) and to the default for new chats.')
    fireEvent.click(within(menu).getByTestId('agents-stepper-add-gemini'))
    await waitFor(() => expect(fake.setCouncil).toHaveBeenCalledTimes(1))
    expect(log.filter((l) => !l.includes('ollama'))).toEqual(['PUT /api/conversations/c1/slot_config', 'setCouncil claude,chatgpt,grok,gemini'])
    const put = calls.find((c) => c.method === 'PUT')
    expect(put.body).toEqual({ ...CFG, slots: FOUR })
    await waitFor(() => expect(Object.keys(store.slotConfig.slots)).toEqual(['claude', 'chatgpt', 'grok', 'gemini']))
    expect(store.conversation.id).toBe('c1')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(fake.openChats).not.toHaveBeenCalled()
    // the added member is a Send target, whatever its checkbox said before
    expect(store.panes.targets.gemini).toBe(true)
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
    expect(screen.queryByTestId('agents-stepper-error')).toBeNull()
  })

  test('a settled conversation: − saves the default BEFORE the create, the POST carries the new spec, openChats(newId) once; the old chat stays in the sidebar', async () => {
    const { fake, calls, log } = logged([{ method: 'POST', url: '/api/conversations', respond: ({ body }) => jsonResponse(conv({ id: 'c9', slot_config: body.slot_config }), 201) }])
    const old = conv({ id: 'c1', slot_config: CFG, turns: [TURN] })
    mount(fake, { conversation: old, slotConfig: CFG, conversations: [{ id: 'c1', title: 'old', created_at: old.created_at, updated_at: old.updated_at, turn_count: 1 }] })
    expect(stepper()).toHaveAttribute('data-mode', 'new-chat')
    expect(removeBtn()).toHaveAttribute('title', 'Remove Grok (the right-most agent): starts a new chat with Claude and ChatGPT and makes them the default. This chat keeps its agents and stays in the sidebar.')
    fireEvent.click(removeBtn())
    await waitFor(() => expect(store.conversation.id).toBe('c9'))
    expect(log).toEqual(['setCouncil claude,chatgpt', 'POST /api/conversations'])
    expect(calls[0].body.slot_config.slots).toEqual({ claude: web('claude'), chatgpt: web('chatgpt') })
    expect(calls[0].body.slot_config.analyst_model).toBe('web:chatgpt:analyst')
    await tick()
    expect(fake.openChats).toHaveBeenCalledWith('c9')
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    expect(store.conversations.map((c) => c.id)).toEqual(['c9', 'c1'])
    expect(store.panes.council).toEqual({ slots: { claude: web('claude'), chatgpt: web('chatgpt') } })
  })

  test('a 409 council_changed on the PUT (a turn landed after the render) falls back to a new chat — not an error', async () => {
    const { fake, calls, log } = logged([
      { method: 'PUT', url: '/api/conversations/c1/slot_config', respond: jsonResponse({ detail: { error: 'council_changed', current: ['claude', 'chatgpt', 'grok'], requested: ['claude', 'chatgpt'] } }, 409) },
      { method: 'POST', url: '/api/conversations', respond: ({ body }) => jsonResponse(conv({ id: 'c9', slot_config: body.slot_config }), 201) },
    ])
    mount(fake, { conversation: conv({ id: 'c1', slot_config: CFG }), slotConfig: CFG })
    fireEvent.click(removeBtn())
    await waitFor(() => expect(store.conversation.id).toBe('c9'))
    expect(log).toEqual(['PUT /api/conversations/c1/slot_config', 'setCouncil claude,chatgpt', 'POST /api/conversations'])
    expect(calls[1].body.slot_config.slots).toEqual({ claude: web('claude'), chatgpt: web('chatgpt') })
    expect(screen.queryByTestId('agents-stepper-error')).toBeNull()
  })

  test('any other refusal shows the error and changes nothing else (no setCouncil, no POST); dismiss clears it', async () => {
    const { fake, calls } = logged([{ method: 'PUT', url: '/api/conversations/c1/slot_config', respond: jsonResponse({ detail: { error: 'unsupported_effort', slot: 'grok' } }, 422) }])
    mount(fake, { conversation: conv({ id: 'c1', slot_config: CFG }), slotConfig: CFG })
    fireEvent.click(removeBtn())
    const error = await screen.findByTestId('agents-stepper-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent('The agents did not change: unsupported_effort')
    expect(fake.setCouncil).not.toHaveBeenCalled()
    expect(calls.map((c) => c.method)).toEqual(['PUT'])
    expect(store.slotConfig).toEqual(CFG)
    // the error row is in the flow under the bar, before the capture notice
    const deck = screen.getByTestId('pane-deck')
    expect(deck.children[1]).toBe(error)
    fireEvent.click(screen.getByTestId('agents-stepper-error-dismiss'))
    expect(screen.queryByTestId('agents-stepper-error')).toBeNull()
  })

  test('main refusing the default stops before any create', async () => {
    const { fake, calls } = logged([], { setCouncil: vi.fn(async () => Promise.reject(new Error('bad_request'))) })
    mount(fake, { conversation: conv({ id: 'c1', slot_config: CFG, turns: [TURN] }), slotConfig: CFG })
    fireEvent.click(removeBtn())
    expect(await screen.findByTestId('agents-stepper-error')).toHaveTextContent('The default did not change: bad_request; no new chat was started')
    expect(calls).toEqual([])
    expect(fake.openChats).not.toHaveBeenCalled()
    expect(store.conversation.id).toBe('c1')
  })

  test('a create that fails says so; the new agents are already the default', async () => {
    const { fake } = logged([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'nope' } }, 500) }])
    mount(fake, { conversation: conv({ id: 'c1', slot_config: CFG, turns: [TURN] }), slotConfig: CFG })
    fireEvent.click(removeBtn())
    expect(await screen.findByTestId('agents-stepper-error')).toHaveTextContent('New chat did not start.')
    expect(fake.setCouncil).toHaveBeenCalledTimes(1)
    expect(store.conversation.id).toBe('c1')
  })
})

describe('AgentStepper: the add menu', () => {
  test('opens lazily: the catalog (when not loaded) and the Ollama probe are fetched only now; the items name their transport', async () => {
    const calls = stubFetch([
      { method: 'GET', url: '/api/models', respond: jsonResponse(modelsState().items) },
      { method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ base_url: 'http://127.0.0.1:11434/v1', loopback: true, models: ['qwen3:8b', 'hermes3'] }) },
    ])
    mount(fakeTriplex(), { panes: { council: { slots: CFG.slots }, openRouterKey: KEY_SET } })
    expect(calls).toEqual([])
    fireEvent.click(addBtn())
    expect(addBtn()).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByTestId('agents-stepper-menu')
    expect(addBtn()).toHaveAttribute('aria-controls', menu.id)
    await waitFor(() => expect(seqOf(calls).sort()).toEqual(['GET /api/models', 'GET /api/ollama/models']))
    await waitFor(() => expect(screen.getByTestId('agents-stepper-add-deepseek')).toHaveAttribute('data-seatable', 'true'))
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.getAttribute('data-testid'))
    expect(items).toEqual(['agents-stepper-add-gemini', 'agents-stepper-add-deepseek', 'agents-stepper-add-qwen', 'agents-stepper-add-mimo', 'agents-stepper-more'])
    expect(screen.getByTestId('agents-stepper-add-gemini')).toHaveTextContent('Gemini · web session (your login)')
    expect(screen.getByTestId('agents-stepper-add-gemini')).toHaveAttribute('data-group', 'web')
    expect(screen.getByTestId('agents-stepper-add-deepseek')).toHaveTextContent('DeepSeek · OpenRouter · deepseek/deepseek-r1')
    expect(screen.getByTestId('agents-stepper-add-deepseek')).toHaveAttribute('data-group', 'token')
    // the in-flow strip sits right after the bar (before the capture notice)
    expect(screen.getByTestId('pane-deck').children[1]).toBe(menu)
  })

  test('without a key, a vendor with no local model is shown disabled with its reason; a click does nothing; Qwen comes from the live Ollama list', async () => {
    const calls = stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ base_url: 'x', loopback: true, models: ['qwen3:8b'] }) }])
    const fake = fakeTriplex()
    mount(fake, { panes: { council: { slots: CFG.slots } }, models: modelsState() })
    fireEvent.click(addBtn())
    await waitFor(() => expect(screen.getByTestId('agents-stepper-add-qwen')).toHaveAttribute('data-seatable', 'true'))
    const deepseek = screen.getByTestId('agents-stepper-add-deepseek')
    expect(deepseek).toHaveAttribute('aria-disabled', 'true')
    expect(deepseek).toHaveAttribute('data-seatable', 'false')
    expect(deepseek).toHaveAttribute('title', 'DeepSeek needs an OpenRouter key or a local Ollama model named like it. Set one up on the Agents page.')
    expect(screen.getByTestId('agents-stepper-add-qwen')).toHaveTextContent('Qwen · local Ollama · ollama:qwen3:8b')
    expect(screen.getByTestId('agents-stepper-add-qwen')).toHaveAttribute('data-group', 'local')
    fireEvent.click(deepseek)
    await tick()
    expect(fake.setCouncil).not.toHaveBeenCalled()
    expect(screen.getByTestId('agents-stepper-menu')).toBeInTheDocument()
    expect(calls.map((c) => c.url)).toEqual(['/api/ollama/models']) // the catalog was loaded already
  })

  test('a failed probe means no local models; the loading text shows until it answers', async () => {
    let answer
    stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: () => new Promise((r) => (answer = r)) }])
    mount(fakeTriplex(), { panes: { council: { slots: CFG.slots } }, models: modelsState() })
    fireEvent.click(addBtn())
    expect(screen.getByTestId('agents-stepper-add-deepseek')).toHaveTextContent('loading the model catalog…')
    await waitFor(() => expect(typeof answer).toBe('function')) // the probe is in flight
    expect(screen.getByTestId('agents-stepper-add-deepseek')).toHaveAttribute('data-seatable', 'false')
    await act(async () => answer(jsonResponse({ detail: { error: 'down' } }, 500)))
    await waitFor(() => expect(screen.getByTestId('agents-stepper-add-deepseek')).toHaveTextContent('needs an OpenRouter key'))
  })

  test('keyboard: the first seatable item takes focus, the arrows walk every item (wrapping), Escape closes and hands focus back to +', async () => {
    stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ models: [] }) }])
    mount(fakeTriplex(), { panes: { council: { slots: CFG.slots } }, models: modelsState() })
    addBtn().focus()
    fireEvent.click(addBtn())
    const gemini = screen.getByTestId('agents-stepper-add-gemini')
    expect(document.activeElement).toBe(gemini)
    const menu = screen.getByTestId('agents-stepper-menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('agents-stepper-add-deepseek')) // disabled items are reachable (their reason is read)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByTestId('agents-stepper-more')) // wrapped
    fireEvent.keyDown(menu, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(gemini)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
    expect(document.activeElement).toBe(addBtn())
    // a mousedown outside closes it too; inside it does not
    fireEvent.click(addBtn())
    fireEvent.mouseDown(screen.getByTestId('agents-stepper-menu-hint'))
    expect(screen.getByTestId('agents-stepper-menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
  })

  test('choosing an item hands focus back to the stepper once the change settles: − when + is now disabled at four, + after a remove (review 2026-10-17)', async () => {
    stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ models: [] }) }])
    const fake = fakeTriplex({ setCouncil: vi.fn(async (spec) => spec) })
    mount(fake, { panes: { council: { slots: CFG.slots } }, models: modelsState() })
    addBtn().focus()
    fireEvent.click(addBtn())
    const gemini = screen.getByTestId('agents-stepper-add-gemini')
    expect(document.activeElement).toBe(gemini)
    fireEvent.click(gemini)
    await waitFor(() => expect(stepper()).toHaveAttribute('data-count', '4'))
    await waitFor(() => expect(document.activeElement).toBe(removeBtn()))
    expect(addBtn()).toBeDisabled()
    fireEvent.click(removeBtn())
    await waitFor(() => expect(stepper()).toHaveAttribute('data-count', '3'))
    await waitFor(() => expect(document.activeElement).toBe(removeBtn()))
  })

  test('More options… opens the drawer on the Agents tab and closes the menu', () => {
    stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ models: [] }) }])
    mount(fakeTriplex(), { panes: { council: { slots: CFG.slots } }, models: modelsState() })
    fireEvent.click(addBtn())
    fireEvent.click(screen.getByTestId('agents-stepper-more'))
    expect(store.panes.drawerOpen).toBe(true)
    expect(store.panes.drawerTab).toBe('agents')
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
  })

  test('another conversation, or a council change, closes the menu', () => {
    stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ models: [] }) }])
    mount(fakeTriplex(), { panes: { council: { slots: CFG.slots } }, models: modelsState() })
    fireEvent.click(addBtn())
    act(() => store.dispatch({ type: 'panes/council', council: { slots: { claude: web('claude'), grok: web('grok') } } }))
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
    fireEvent.click(addBtn())
    act(() => store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c7' }) }))
    expect(screen.queryByTestId('agents-stepper-menu')).toBeNull()
  })

  test('no conversation: adding Gemini to the classic three makes four the default; the new member is targeted', async () => {
    stubFetch([{ method: 'GET', url: '/api/ollama/models', respond: jsonResponse({ models: [] }) }])
    const fake = fakeTriplex()
    mount(fake, { panes: { council: { slots: CFG.slots }, targets: { claude: true, chatgpt: true, grok: true, gemini: false } }, models: modelsState() })
    expect(screen.queryByTestId('pane-gemini')).toBeNull()
    fireEvent.click(addBtn())
    fireEvent.click(screen.getByTestId('agents-stepper-add-gemini'))
    await waitFor(() => expect(store.panes.council).toEqual({ slots: FOUR }))
    expect(fake.setCouncil.mock.calls[0][0]).toEqual({ slots: FOUR })
    expect(store.panes.targets.gemini).toBe(true)
    expect(screen.getByTestId('pane-gemini')).toHaveAttribute('data-kind', 'site')
    expect(stepper()).toHaveAttribute('data-count', '4')
    expect(addBtn()).toBeDisabled()
  })
})
