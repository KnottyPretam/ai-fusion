// AgentsPage (2026-09-27): the council editor end to end — rows from the open conversation or
// main's default, vendor / transport / model / effort edits, add / remove, Apply (PUT the full
// slot_config; 409 council_changed once the conversation has turns), Save as default
// (triplex.setCouncil → panes/council), and the key row (triplex.setOpenRouterKey → main's status;
// the key itself never lands anywhere the renderer keeps).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import './index.jsx' // registers the `panes` slice
import AgentsPage, { APPLY_TITLES, KEY_HINT } from './AgentsPage.jsx'
import { initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { CFG, CFG2, CFG5, KEY_SET, KEY_UNSET, conv, fakeTriplex, jsonResponse, modelsState, stubFetch } from './fakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const store = { dispatch: null, panes: null, slotConfig: null }
function Probe() {
  store.panes = useSlice('panes')
  store.slotConfig = useSlice('slotConfig')
  store.dispatch = useDispatch()
  return null
}

function mount(fake, { panes = {}, ...preloaded } = {}) {
  return renderWithStore(
    <>
      <AgentsPage api={fake} />
      <Probe />
    </>,
    { preloaded: { panes: { ...initialPanes(), ...panes }, models: modelsState(), ...preloaded } },
  )
}

const rowSlots = () => [...screen.getByTestId('agents-page').querySelectorAll('[data-testid^="agents-row-"]')].map((el) => el.getAttribute('data-slot'))
const select = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })

describe('AgentsPage: rows and their source', () => {
  test('with no conversation the rows come from main’s default (panes.council), else the classic three web panes', () => {
    const { unmount } = mount(fakeTriplex())
    expect(screen.getByTestId('agents-page')).toHaveAttribute('data-source', 'default')
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok'])
    for (const s of ['claude', 'chatgpt', 'grok']) expect(screen.getByTestId(`agents-transport-${s}-web`)).toBeChecked()
    expect(screen.getByTestId('agents-summary')).toHaveTextContent('3 agents → R1…R3; labels are assigned per turn')
    expect(screen.getByTestId('agents-apply')).toBeDisabled()
    expect(screen.getByTestId('agents-apply')).toHaveAttribute('title', APPLY_TITLES.noConversation)
    unmount()
    mount(fakeTriplex(), { panes: { council: { slots: CFG5.slots } } })
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    expect(screen.getByTestId('agents-transport-gemini-openrouter')).toBeChecked()
    expect(screen.getByTestId('agents-model-gemini')).toHaveValue('google/gemini-2.5-pro')
    expect(screen.getByTestId('agents-effort-gemini')).toHaveValue('medium')
    expect(screen.getByTestId('agents-transport-qwen-ollama')).toBeChecked()
    expect(screen.getByTestId('agents-model-qwen')).toHaveValue('ollama:qwen3')
    expect(screen.getByTestId('agents-add')).toBeDisabled() // five seated
  })

  test('with a conversation open the rows are ITS council and Apply is enabled on an empty one', () => {
    mount(fakeTriplex(), { conversation: conv({ slot_config: CFG2 }), slotConfig: CFG2 })
    expect(screen.getByTestId('agents-page')).toHaveAttribute('data-source', 'conversation')
    expect(rowSlots()).toEqual(['chatgpt', 'qwen'])
    expect(screen.getByTestId('agents-remove-chatgpt')).toBeDisabled() // two is the floor
    expect(screen.getByTestId('agents-apply')).toBeEnabled()
    expect(screen.getByTestId('agents-apply')).toHaveAttribute('title', APPLY_TITLES.ready)
    expect(screen.queryByTestId('agents-error')).toBeNull()
  })

  test('the rows re-seed when the conversation changes', () => {
    mount(fakeTriplex(), { conversation: conv({ slot_config: CFG2 }), slotConfig: CFG2 })
    expect(rowSlots()).toEqual(['chatgpt', 'qwen'])
    act(() => store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c2', slot_config: CFG5 }) }))
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    act(() => store.dispatch({ type: 'conversation/cleared' }))
    expect(screen.getByTestId('agents-page')).toHaveAttribute('data-source', 'default')
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok'])
  })
})

describe('AgentsPage: editing', () => {
  test('a vendor select lists this row’s vendor plus every unseated one; changing it moves the seat and resets transport / model', () => {
    mount(fakeTriplex())
    const vendor = screen.getByTestId('agents-vendor-grok')
    expect([...vendor.querySelectorAll('option')].map((o) => o.value)).toEqual(['grok', 'gemini', 'deepseek', 'qwen', 'mimo'])
    select('agents-vendor-grok', 'qwen')
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'qwen'])
    // Qwen has no web session: the transport fell to OpenRouter with the catalog's first Qwen slug
    expect(screen.queryByTestId('agents-transport-qwen-web')).toBeNull()
    expect(screen.getByTestId('agents-transport-qwen-openrouter')).toBeChecked()
    expect(screen.getByTestId('agents-model-qwen')).toHaveValue('qwen/qwen3-235b-a22b')
    expect(screen.getByTestId('agents-summary')).toHaveTextContent('3 agents → R1…R3')
    // and the key hint appears: an OpenRouter row, no key
    expect(screen.getByTestId('agents-key-hint')).toHaveTextContent(KEY_HINT)
  })

  test('transport radios switch the model list; the custom field types an unlisted id (ollama: auto-prefixed)', () => {
    mount(fakeTriplex())
    expect(screen.queryByTestId('agents-model-custom-claude')).toBeNull() // a web session is the site itself
    fireEvent.click(screen.getByTestId('agents-transport-claude-ollama'))
    expect(screen.getByTestId('agents-model-claude')).toHaveValue('ollama:hermes3')
    const custom = screen.getByTestId('agents-model-custom-claude')
    fireEvent.change(custom, { target: { value: 'qwen3:8b' } })
    fireEvent.blur(custom)
    expect(screen.getByTestId('agents-row-claude')).toHaveAttribute('data-transport', 'ollama')
    expect(within(screen.getByTestId('agents-row-claude')).getByText('custom: ollama:qwen3:8b')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('agents-transport-claude-openrouter'))
    expect(screen.getByTestId('agents-model-claude')).toHaveValue('anthropic/claude-sonnet-4.5')
    fireEvent.click(screen.getByTestId('agents-transport-claude-web'))
    expect(screen.getByTestId('agents-model-claude')).toHaveValue('web:claude')
  })

  test('add seats the next unseated vendor up to five; remove unseats down to two; the error names the first invalid row', () => {
    mount(fakeTriplex())
    fireEvent.click(screen.getByTestId('agents-add'))
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini'])
    fireEvent.click(screen.getByTestId('agents-add'))
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'deepseek'])
    expect(screen.getByTestId('agents-add')).toBeDisabled()
    expect(screen.getByTestId('agents-summary')).toHaveTextContent('5 agents → R1…R5')
    fireEvent.click(screen.getByTestId('agents-remove-claude'))
    fireEvent.click(screen.getByTestId('agents-remove-chatgpt'))
    fireEvent.click(screen.getByTestId('agents-remove-grok'))
    expect(rowSlots()).toEqual(['gemini', 'deepseek'])
    expect(screen.getByTestId('agents-remove-gemini')).toBeDisabled()
    // an empty custom model on an OpenRouter row is a loud error, never a silent default
    const custom = screen.getByTestId('agents-model-custom-gemini')
    select('agents-model-gemini', '')
    fireEvent.change(custom, { target: { value: '' } })
    fireEvent.blur(custom)
    expect(screen.getByTestId('agents-error')).toHaveTextContent('Gemini: choose or type a model')
    expect(screen.getByTestId('agents-default')).toBeDisabled()
  })
})

describe('AgentsPage: Apply, Save as default, the key', () => {
  test('Apply PUTs the FULL slot_config of the open conversation and lands the stored copy in the store', async () => {
    const calls = stubFetch([{ method: 'PUT', url: '/api/conversations/c1/slot_config', respond: ({ body }) => jsonResponse(body) }])
    mount(fakeTriplex(), { conversation: conv({ slot_config: CFG }), slotConfig: CFG })
    fireEvent.click(screen.getByTestId('agents-add')) // + Gemini on OpenRouter
    fireEvent.click(screen.getByTestId('agents-apply'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toEqual({
      ...CFG,
      slots: { ...CFG.slots, gemini: { model: 'google/gemini-2.5-pro', effort: 'off' } },
    })
    await waitFor(() => expect(Object.keys(store.slotConfig.slots)).toEqual(['claude', 'chatgpt', 'grok', 'gemini']))
    expect(screen.queryByTestId('agents-error')).toBeNull()
  })

  test('once the conversation has turns Apply is disabled with the council_changed title; a 409 from the backend is shown in words', async () => {
    const withTurns = conv({ slot_config: CFG, turns: [{ id: 't1', type: 'send', prompt: 'q', slot_config: CFG, responses: {}, usage: { calls: [], totals: {} } }] })
    const { unmount } = mount(fakeTriplex(), { conversation: withTurns, slotConfig: CFG })
    expect(screen.getByTestId('agents-apply')).toBeDisabled()
    expect(screen.getByTestId('agents-apply')).toHaveAttribute('title', APPLY_TITLES.hasTurns)
    unmount()
    // the backend's own refusal (a turn landed between the render and the click)
    stubFetch([{ method: 'PUT', url: '/api/conversations/c1/slot_config', respond: jsonResponse({ detail: { error: 'council_changed', current: ['claude', 'chatgpt', 'grok'], requested: ['claude', 'chatgpt'] } }, 409) }])
    mount(fakeTriplex(), { conversation: conv({ slot_config: CFG }), slotConfig: CFG })
    fireEvent.click(screen.getByTestId('agents-remove-grok'))
    fireEvent.click(screen.getByTestId('agents-apply'))
    await screen.findByTestId('agents-error')
    expect(screen.getByTestId('agents-error')).toHaveTextContent('council_changed')
    expect(store.slotConfig).toEqual(CFG) // nothing landed
  })

  test('Apply is disabled while any stream runs', () => {
    mount(fakeTriplex(), { conversation: conv({ slot_config: CFG }), slotConfig: CFG, streams: { send: { status: 'streaming', error: null, httpStatus: null } } })
    expect(screen.getByTestId('agents-apply')).toBeDisabled()
    expect(screen.getByTestId('agents-apply')).toHaveAttribute('title', APPLY_TITLES.streaming)
  })

  test('Save as default hands the spec to main (setCouncil) and mirrors the reply into panes.council', async () => {
    const fake = fakeTriplex()
    mount(fake)
    fireEvent.click(screen.getByTestId('agents-remove-grok'))
    fireEvent.click(screen.getByTestId('agents-default'))
    await waitFor(() => expect(fake.setCouncil).toHaveBeenCalledTimes(1))
    expect(fake.setCouncil.mock.calls[0][0]).toEqual({ slots: { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' } } })
    await waitFor(() => expect(store.panes.council).toEqual({ slots: { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' } } }))
    // main's own push (another window, a restart) replaces the default too
    act(() => store.dispatch({ type: 'panes/council', council: CFG5 }))
    expect(rowSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
  })

  test('the key row: save hands the key to main once and shows main’s status; the field is emptied; clear reverts; the key never reaches the store', async () => {
    const fake = fakeTriplex()
    mount(fake, { panes: { council: { slots: CFG5.slots } } })
    expect(screen.getByTestId('agents-key-status')).toHaveTextContent('not configured')
    expect(screen.getByTestId('agents-key-status')).toHaveAttribute('data-configured', 'false')
    expect(screen.getByTestId('agents-key-hint')).toBeInTheDocument()
    expect(screen.getByTestId('agents-key-clear')).toBeDisabled()
    expect(screen.getByTestId('agents-key-save')).toBeDisabled()
    const input = screen.getByTestId('agents-key')
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'sk-or-v1-' + 'a'.repeat(64) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(fake.setOpenRouterKey).toHaveBeenCalledWith('sk-or-v1-' + 'a'.repeat(64)))
    await waitFor(() => expect(screen.getByTestId('agents-key-status')).toHaveTextContent('configured · sk-or-v1-… (73 chars)'))
    expect(screen.getByTestId('agents-key-status')).toHaveAttribute('data-configured', 'true')
    expect(input).toHaveValue('')
    expect(screen.queryByTestId('agents-key-hint')).toBeNull()
    expect(store.panes.openRouterKey).toEqual(KEY_SET)
    expect(JSON.stringify(store.panes)).not.toContain('aaaa')
    fireEvent.click(screen.getByTestId('agents-key-clear'))
    await waitFor(() => expect(fake.setOpenRouterKey).toHaveBeenLastCalledWith(null))
    await waitFor(() => expect(screen.getByTestId('agents-key-status')).toHaveTextContent('not configured'))
    expect(store.panes.openRouterKey).toEqual(KEY_UNSET)
  })

  test('a refused key shows agents-key-error and leaves the status as it was', async () => {
    const fake = fakeTriplex({ setOpenRouterKey: vi.fn(async () => Promise.reject(new Error('encryption_unavailable'))) })
    mount(fake)
    fireEvent.change(screen.getByTestId('agents-key'), { target: { value: 'sk-or-v1-x' } })
    fireEvent.click(screen.getByTestId('agents-key-save'))
    await screen.findByTestId('agents-key-error')
    expect(screen.getByTestId('agents-key-error')).toHaveTextContent('encryption_unavailable')
    expect(screen.getByTestId('agents-key-status')).toHaveTextContent('not configured')
  })

  test('renders and stays inert under a partial window.triplex stub (no setCouncil / setOpenRouterKey)', () => {
    mount({})
    expect(screen.getByTestId('agents-page')).toBeInTheDocument()
    expect(screen.getByTestId('agents-default')).toBeDisabled()
    fireEvent.change(screen.getByTestId('agents-key'), { target: { value: 'sk-or-v1-x' } })
    fireEvent.click(screen.getByTestId('agents-key-save')) // no throw
    expect(screen.getByTestId('agents-key-status')).toHaveTextContent('not configured')
  })
})
