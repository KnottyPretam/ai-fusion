// Council (2026-09-27) through the desktop components: the mixed PaneDeck (site panes and renderer
// columns, tabs for every member, Ctrl+1..5), the PromptBar's targets / results / create over the
// council, the Drawer's Agents tab and the OpenRouter analyst, and the shell's getCouncil /
// onCouncil / getOpenRouterKey / onOpenRouterKey mirror. The three-site cases stay in
// PaneDeck.test.jsx / PromptBar.test.jsx / Drawer.test.jsx / DesktopShell.test.jsx.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import DesktopShell from './index.jsx'
import Drawer, { ANALYZE_BLOCKED_HINT, councilAnswersText } from './Drawer.jsx'
import PaneDeck from './PaneDeck.jsx'
import PromptBar from './PromptBar.jsx'
import { initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { CFG, CFG2, CFG5, DESKTOP_CATALOG, KEY_SET, KEY_UNSET, RECTS, conv, fakeTriplex, health, installFakeResizeObserver, jsonResponse, modelsState, pinViewportRects, stubFetch, syncFrames } from './fakes.js'

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

const store = { dispatch: null, panes: null }
function Probe() {
  store.panes = useSlice('panes')
  store.dispatch = useDispatch()
  return null
}

function mountDeck(fake, { panes = {}, ...preloaded } = {}) {
  return renderWithStore(
    <>
      <PaneDeck api={fake} info={{ dev: true }} version="0.1.0" />
      <Probe />
    </>,
    { preloaded: { panes: { ...initialPanes(), ...panes }, models: modelsState(), ...preloaded } },
  )
}
const lastLayout = (fake) => fake.setLayout.mock.calls.at(-1)[0]
const paneSlots = () => [...screen.getByTestId('pane-deck').querySelectorAll('section[data-testid^="pane-"]')].map((el) => el.getAttribute('data-slot'))
const tabSlots = () => [...screen.getByTestId('pane-deck').querySelectorAll('[data-testid^="deck-tab-"]')].map((el) => el.getAttribute('data-slot'))

describe('PaneDeck: a mixed council', () => {
  test('five members: three site panes and two renderer columns in catalog order; the layout carries only the sites; a column wraps SlotColumn without its Continue box', () => {
    const fake = fakeTriplex()
    mountDeck(fake, { conversation: conv({ slot_config: CFG5 }), slotConfig: CFG5 })
    expect(paneSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    expect(tabSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    expect(screen.getByTestId('pane-deck').querySelector('[data-council-size]')).toHaveAttribute('data-council-size', '5')
    for (const s of ['claude', 'chatgpt', 'grok']) expect(screen.getByTestId(`pane-${s}`)).toHaveAttribute('data-kind', 'site')
    for (const s of ['gemini', 'qwen']) {
      expect(screen.getByTestId(`pane-${s}`)).toHaveAttribute('data-kind', 'column')
      expect(screen.getByTestId(`pane-${s}`).style.getPropertyValue('--slot-color')).toBe(`var(--${s})`)
      expect(within(screen.getByTestId(`pane-${s}`)).getByTestId(`slot-${s}`)).toBeInTheDocument()
      expect(screen.queryByTestId(`slot-${s}-composer`)).toBeNull()
      expect(screen.queryByTestId(`pane-${s}-viewport`)).toBeNull()
      expect(screen.queryByTestId(`pane-${s}-capture`)).toBeNull()
    }
    expect(screen.getByTestId('slot-gemini-transport')).toHaveTextContent('OpenRouter')
    expect(screen.getByTestId('slot-qwen-transport')).toHaveTextContent('local')
    expect(screen.getByTestId('deck-tab-gemini')).toHaveAttribute('data-kind', 'column')
    expect(screen.getByTestId('deck-tab-gemini')).toHaveAttribute('title', 'Gemini — OpenRouter agent')
    expect(screen.getByTestId('deck-tab-qwen')).toHaveAttribute('title', 'Qwen — local Ollama agent')
    expect(Object.keys(lastLayout(fake)).sort()).toEqual(['chatgpt', 'claude', 'grok'])
    expect(lastLayout(fake)).toEqual(RECTS)
  })

  test('two web sites: the third site is not rendered and its rect is null (main hides the view)', () => {
    const cfg = { ...CFG, slots: { claude: CFG.slots.claude, grok: CFG.slots.grok } }
    const fake = fakeTriplex()
    mountDeck(fake, { conversation: conv({ slot_config: cfg }), slotConfig: cfg })
    expect(paneSlots()).toEqual(['claude', 'grok'])
    expect(screen.queryByTestId('pane-chatgpt')).toBeNull()
    expect(lastLayout(fake)).toEqual({ claude: RECTS.claude, chatgpt: null, grok: RECTS.grok })
    // the persisted active (chatgpt) is outside this council: it moves to the first member
    expect(store.panes.active).toBe('claude')
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'split', active: 'claude' })
  })

  test('no site at all: two columns, every site rect null, a column is the active tab', () => {
    const fake = fakeTriplex()
    mountDeck(fake, { panes: { mode: 'tabs', active: 'qwen' }, conversation: conv({ slot_config: CFG2 }), slotConfig: CFG2 })
    expect(paneSlots()).toEqual(['chatgpt', 'qwen'])
    expect(screen.getByTestId('pane-chatgpt')).toHaveAttribute('data-kind', 'column') // ChatGPT on OpenRouter is a column too
    expect(screen.getByTestId('pane-qwen')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('pane-chatgpt')).toHaveAttribute('hidden')
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: null, grok: null })
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'tabs', active: 'qwen' })
  })

  test('tabs mode with a column active hides every site view; Ctrl+4 / Ctrl+5 reach the 4th and 5th member; tab-5 on a three-council is a no-op', () => {
    const fake = fakeTriplex()
    mountDeck(fake, { panes: { mode: 'tabs', active: 'chatgpt' }, conversation: conv({ slot_config: CFG5 }), slotConfig: CFG5 })
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: RECTS.chatgpt, grok: null })
    expect(screen.getByTestId('deck-tab-gemini')).toHaveAttribute('title', 'Gemini — OpenRouter agent (Ctrl+4)')
    act(() => fake.emit.shortcut('tab-4'))
    expect(store.panes.active).toBe('gemini')
    expect(screen.getByTestId('deck-tab-gemini')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('pane-gemini')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('pane-chatgpt')).toHaveAttribute('hidden')
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: null, grok: null })
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'tabs', active: 'gemini' })
    act(() => fake.emit.shortcut({ name: 'tab-5' }))
    expect(store.panes.active).toBe('qwen')
    act(() => fake.emit.shortcut('tab-1'))
    expect(store.panes.active).toBe('claude')
    expect(lastLayout(fake)).toEqual({ claude: RECTS.claude, chatgpt: null, grok: null })
    // split mode: clicking a column tab activates it but focuses no view
    fireEvent.click(screen.getByTestId('deck-mode-split'))
    fake.focusPane.mockClear()
    fireEvent.click(screen.getByTestId('deck-tab-qwen'))
    expect(store.panes.active).toBe('qwen')
    expect(fake.focusPane).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('deck-tab-grok'))
    expect(fake.focusPane).toHaveBeenCalledWith('grok')
    // a number past a three-council does nothing
    act(() => store.dispatch({ type: 'conversation/loaded', conversation: conv({ id: 'c3', slot_config: CFG }) }))
    act(() => store.dispatch({ type: 'panes/active', active: 'claude' }))
    act(() => fake.emit.shortcut('tab-5'))
    expect(store.panes.active).toBe('claude')
  })

  test('without a conversation the deck follows main’s default council (panes.council); health for a site outside it is ignored', () => {
    const fake = fakeTriplex()
    mountDeck(fake, { panes: { council: { slots: CFG2.slots } } })
    expect(paneSlots()).toEqual(['chatgpt', 'qwen'])
    act(() => fake.emit.health('claude', health()))
    expect(store.panes.health.claude).toEqual(health()) // the slice keeps the map; the deck just does not show it
    expect(screen.queryByTestId('pane-claude')).toBeNull()
    // the default's arrival re-observes: a new council with three sites brings the three viewports back
    act(() => store.dispatch({ type: 'panes/council', council: { slots: CFG5.slots } }))
    expect(paneSlots()).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    expect(lastLayout(fake)).toEqual(RECTS)
  })
})

describe('PromptBar over a council', () => {
  const IDLE = { status: 'idle', error: null, httpStatus: null }
  function mountBar(fake, { panes = {}, ...preloaded } = {}) {
    return renderWithStore(
      <>
        <PromptBar api={fake} />
        <Probe />
      </>,
      { preloaded: { panes: { ...initialPanes(), ...panes }, streams: { send: IDLE, analyze: IDLE, fusion: IDLE, preparse: IDLE }, ...preloaded } },
    )
  }

  test('one target checkbox per council member (a never-seen member is checked), the composer names the count, results range over the council', async () => {
    const fake = fakeTriplex()
    mountBar(fake, { conversation: conv({ slot_config: CFG5 }), slotConfig: CFG5 })
    const targets = [...screen.getByTestId('prompt-bar').querySelectorAll('[data-testid^="prompt-target-"]')].map((el) => el.getAttribute('data-testid').replace('prompt-target-', ''))
    expect(targets).toEqual(['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
    expect(screen.getByTestId('prompt-target-gemini')).toBeChecked()
    expect(screen.getByTestId('prompt-composer')).toHaveAttribute('placeholder', 'Ask all five… (Enter to send, Shift+Enter for a new line, Ctrl+L to focus)')
    fireEvent.click(screen.getByTestId('prompt-target-gemini'))
    expect(store.panes.targets.gemini).toBe(false)
    expect(screen.getByTestId('prompt-target-gemini')).not.toBeChecked()
    // a result line for a column member too
    act(() => store.dispatch({ type: 'sse', feature: 'send', event: { type: 'slot_done', slot: 'qwen', usage: { latency_ms: 1500 } } }))
    expect(screen.getByTestId('prompt-result-qwen')).toHaveTextContent('Qwen sent ✓ captured · 1.5 s')
  })

  test('a Send to a subset of a five-council posts {prompt, slots} judged against THAT council', async () => {
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations/c1/send', respond: jsonResponse({ detail: { error: 'busy' } }, 409) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(conv({ slot_config: CFG5 })) },
    ])
    const fake = fakeTriplex()
    mountBar(fake, { panes: { targets: { claude: true, chatgpt: true, grok: true, gemini: false } }, conversation: conv({ slot_config: CFG5 }), slotConfig: CFG5 })
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('prompt-send'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/conversations/c1/send')).toBe(true))
    expect(calls.find((c) => c.url === '/api/conversations/c1/send').body).toEqual({ prompt: 'hello', slots: ['claude', 'chatgpt', 'grok', 'qwen'] })
  })

  test('a first Send creates the conversation with main’s default council (councilSlotConfig(panes.council))', async () => {
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'nope' } }, 500) }])
    const fake = fakeTriplex()
    localStorage.setItem('triplex.desktop.analyst', 'ollama:hermes3')
    mountBar(fake, { panes: { council: { slots: CFG2.slots } } })
    expect(screen.getByTestId('prompt-composer')).toHaveAttribute('placeholder', 'Ask both… (Enter to send, Shift+Enter for a new line, Ctrl+L to focus)')
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('prompt-send'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toEqual({ slot_config: { slots: CFG2.slots, analyst_model: 'ollama:hermes3', max_iterations: 2, materiality_min: 'medium', grounded: false } })
  })

  test('a persisted OpenRouter analyst survives loadAnalyst: the first Send creates the conversation with it and Pre-parse counts it as chosen with a key', async () => {
    const calls = stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse({ detail: { error: 'nope' } }, 500) }])
    localStorage.setItem('triplex.desktop.analyst', 'openai/gpt-5')
    mountBar(fakeTriplex(), { panes: { openRouterKey: KEY_SET } })
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hello' } })
    expect(screen.getByTestId('prompt-preparse')).toBeEnabled()
    fireEvent.click(screen.getByTestId('prompt-send'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body.slot_config.analyst_model).toBe('openai/gpt-5')
  })

  test('Pre-parse counts an OpenRouter analyst as chosen only once the key is configured', () => {
    const cfg = { ...CFG, analyst_model: 'openai/gpt-5' }
    const fake = fakeTriplex()
    const { unmount } = mountBar(fake, { conversation: conv({ slot_config: cfg }), slotConfig: cfg })
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hello' } })
    expect(screen.getByTestId('prompt-preparse')).toBeDisabled()
    unmount()
    mountBar(fake, { panes: { openRouterKey: KEY_SET }, conversation: conv({ slot_config: cfg }), slotConfig: cfg })
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hello' } })
    expect(screen.getByTestId('prompt-preparse')).toBeEnabled()
  })
})

describe('Drawer: the Agents tab and the OpenRouter analyst', () => {
  function mountDrawer(fake, { panes = {}, ...preloaded } = {}) {
    return renderWithStore(
      <>
        <Drawer api={fake} />
        <Probe />
      </>,
      { preloaded: { panes: { ...initialPanes(), drawerOpen: true, ...panes }, models: modelsState(), ...preloaded } },
    )
  }

  test('the Agents tab sits before Settings and opens the Agents page', () => {
    mountDrawer(fakeTriplex())
    const tabs = [...screen.getByTestId('desk-drawer').querySelectorAll('[data-testid^="drawer-tab-"]')].map((el) => el.getAttribute('data-testid'))
    expect(tabs).toEqual(['drawer-tab-analyze', 'drawer-tab-fusion', 'drawer-tab-captured', 'drawer-tab-agents', 'drawer-tab-settings'])
    fireEvent.click(screen.getByTestId('drawer-tab-agents'))
    expect(screen.getByTestId('desk-drawer')).toHaveAttribute('data-tab', 'agents')
    expect(screen.getByTestId('drawer-panel-agents')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('agents-page')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-panel-settings')).toHaveAttribute('hidden')
  })

  test('an OpenRouter analyst blocks Analyze without a key and is ready with one; the Settings hint reads the council size', () => {
    const cfg = { ...CFG5, analyst_model: 'openai/gpt-5' }
    const { unmount } = mountDrawer(fakeTriplex(), { conversation: conv({ slot_config: cfg }), slotConfig: cfg })
    expect(screen.getByTestId('drawer-analyze-blocked')).toHaveTextContent(ANALYZE_BLOCKED_HINT)
    expect(screen.getByTestId('drawer-capture-hint')).toHaveTextContent('choose an analyst')
    fireEvent.click(screen.getByTestId('drawer-tab-settings'))
    expect(screen.getByTestId('drawer-panel-settings')).toHaveTextContent('labels the five answers R1/R2/R3/R4/R5 and never names the sites')
    unmount()
    mountDrawer(fakeTriplex(), { panes: { openRouterKey: KEY_SET }, conversation: conv({ slot_config: cfg }), slotConfig: cfg })
    expect(screen.queryByTestId('drawer-analyze-blocked')).toBeNull()
    expect(screen.getByTestId('analyze')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-capture-hint')).toBeNull()
    // and the Settings analyst picker lists the OpenRouter models, structured outputs first
    fireEvent.click(screen.getByTestId('drawer-tab-settings'))
    const groups = [...screen.getByTestId('config-analyst-model').querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))
    expect(groups).toEqual(['web sessions (hidden analyst page)', 'local Ollama', 'OpenRouter — structured outputs (recommended)', 'OpenRouter — other models'])
    expect(councilAnswersText(3)).toBe('the three answers R1/R2/R3')
    expect(councilAnswersText(2)).toBe('the two answers R1/R2')
  })

  test('a persisted OpenRouter analyst is the picker’s choice with no conversation open; readiness still follows the key', () => {
    localStorage.setItem('triplex.desktop.analyst', 'openai/gpt-5')
    const { unmount } = mountDrawer(fakeTriplex(), { panes: { openRouterKey: KEY_SET } })
    fireEvent.click(screen.getByTestId('drawer-tab-settings'))
    expect(screen.getByTestId('config-analyst-model')).toHaveValue('openai/gpt-5')
    expect(screen.getByTestId('drawer-panel-analyze')).toHaveAttribute('data-blocked', 'false')
    unmount()
    mountDrawer(fakeTriplex(), { panes: { openRouterKey: KEY_UNSET } })
    fireEvent.click(screen.getByTestId('drawer-tab-settings'))
    expect(screen.getByTestId('drawer-panel-analyze')).toHaveAttribute('data-blocked', 'true')
    expect(localStorage.getItem('triplex.desktop.analyst')).toBe('openai/gpt-5') // the choice is kept, not overwritten
  })
})

describe('DesktopShell: the council and key mirrors', () => {
  test('a key pushed to the backend refetches the catalog: the OpenRouter models reach the Agents rows and the analyst picker; clearing it refetches again', async () => {
    const noKey = DESKTOP_CATALOG.filter((m) => m.raw.transport !== 'openrouter')
    let served = noKey
    const calls = stubFetch([{ method: 'GET', url: '/api/models', respond: () => jsonResponse(served) }])
    const models = () => calls.filter((c) => c.url === '/api/models').length
    const fake = fakeTriplex({ getCouncil: vi.fn(async () => ({ slots: CFG5.slots })) })
    vi.stubGlobal('triplex', fake)
    renderWithStore(
      <>
        <DesktopShell />
        <Probe />
      </>,
    )
    await waitFor(() => expect(store.panes.openRouterKey).toEqual(KEY_UNSET))
    expect(models()).toBe(0) // the deck alone loads nothing; the drawer's panels do
    fireEvent.click(screen.getByTestId('drawer-tab-agents')) // opens the drawer: Captured / Agents / Settings share ONE load
    await waitFor(() => expect(models()).toBe(1))
    await waitFor(() => expect(screen.getByTestId('agents-row-gemini')).toBeInTheDocument())
    expect(screen.getByTestId('agents-model-gemini')).toHaveValue('') // 'google/gemini-2.5-pro' is not in the no-key catalog
    // stored but not yet pushed: the backend still serves the no-key catalog, so nothing to fetch
    act(() => fake.emit.openRouterKey({ ...KEY_SET, pushed: false }))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(models()).toBe(1)
    served = DESKTOP_CATALOG
    act(() => fake.emit.openRouterKey(KEY_SET))
    await waitFor(() => expect(models()).toBe(2))
    await waitFor(() => expect(screen.getByTestId('agents-model-gemini')).toHaveValue('google/gemini-2.5-pro'))
    fireEvent.click(screen.getByTestId('drawer-tab-settings'))
    const groups = () => [...screen.getByTestId('config-analyst-model').querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))
    expect(groups()).toEqual(['web sessions (hidden analyst page)', 'local Ollama', 'OpenRouter — structured outputs (recommended)', 'OpenRouter — other models'])
    // the same status again is not a change
    act(() => fake.emit.openRouterKey({ ...KEY_SET }))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(models()).toBe(2)
    // cleared: the backend drops the OpenRouter entries, so the renderer fetches once more
    served = noKey
    act(() => fake.emit.openRouterKey(KEY_UNSET))
    await waitFor(() => expect(models()).toBe(3))
    await waitFor(() => expect(groups()).toEqual(['web sessions (hidden analyst page)', 'local Ollama']))
  })


  test('getCouncil / getOpenRouterKey seed panes.council / panes.openRouterKey; onCouncil / onOpenRouterKey follow main', async () => {
    const fake = fakeTriplex({
      getCouncil: vi.fn(async () => ({ slots: CFG5.slots })),
      getOpenRouterKey: vi.fn(async () => KEY_SET),
    })
    vi.stubGlobal('triplex', fake)
    renderWithStore(
      <>
        <DesktopShell />
        <Probe />
      </>,
    )
    await waitFor(() => expect(store.panes.council).toEqual({ slots: CFG5.slots }))
    await waitFor(() => expect(store.panes.openRouterKey).toEqual(KEY_SET))
    // the deck followed the default: five members
    await waitFor(() => expect(screen.getByTestId('pane-qwen')).toBeInTheDocument())
    act(() => fake.emit.council({ slots: CFG2.slots }))
    expect(store.panes.council).toEqual({ slots: CFG2.slots })
    expect(screen.queryByTestId('pane-claude')).toBeNull()
    act(() => fake.emit.council({ council: { slots: CFG.slots } })) // the wrapped form is accepted too
    expect(store.panes.council).toEqual({ slots: CFG.slots })
    act(() => fake.emit.openRouterKey({ configured: false, prefix: '', length: 0, pushed: false }))
    expect(store.panes.openRouterKey).toEqual({ configured: false, prefix: '', length: 0, pushed: false })
    act(() => fake.emit.council({ slots: { claude: { model: 'web:claude' } } })) // invalid: ignored
    expect(store.panes.council).toEqual({ slots: CFG.slots })
  })

  test('a getCouncil that rejects leaves the default null and the classic three on screen', async () => {
    const fake = fakeTriplex({ getCouncil: vi.fn(async () => Promise.reject(new Error('bad_request'))), getOpenRouterKey: vi.fn(() => { throw new Error('no') }) })
    vi.stubGlobal('triplex', fake)
    renderWithStore(
      <>
        <DesktopShell />
        <Probe />
      </>,
    )
    await waitFor(() => expect(fake.getCouncil).toHaveBeenCalled())
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(store.panes.council).toBeNull()
    expect(paneSlots()).toEqual(['claude', 'chatgpt', 'grok'])
  })
})
