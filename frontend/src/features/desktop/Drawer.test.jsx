// Drawer (Stage 3): the bottom drawer of the desktop shell — the unchanged Analyze / Fusion panes,
// the web SendPane without its composer (Captured), SlotConfigBar in desktop mode plus the analyst
// choice (Settings), the capture / analyst hints, the auto-open on an Analyze run, the desktop
// CostMeter, and the drawerOpen persistence through the shell. `window.triplex` is the fake of the
// Stage 3 preload surface (setAnalyst / showAnalyst / onAnalyst); fetch is stubbed like the other
// desktop specs.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import DesktopShell from './index.jsx' // registers the `panes` slice (+ slots / analyze / fusion / meter through the drawer)
import Drawer, { CHOOSE_ANALYST_HINT, DRAWER_TABS, analystHint, captureHint } from './Drawer.jsx'
import CostMeter from '../meter/index.jsx'
import { emptyRow, initialMeter } from '../meter/slice.js'
import { ANALYST_KEY, DEFAULT_ANALYST } from './analyst.js'
import { PERSIST_KEYS, initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { CFG, RECTS, conv, fakeTriplex, installFakeResizeObserver, jsonResponse, pinViewportRects, seqOf, stubFetch, syncFrames } from './fakes.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})
beforeEach(() => {
  localStorage.clear()
})

// The desktop catalog (contract §6 / backend/llm/webmodels.py) as GET /api/models returns it under TRIPLEX_DESKTOP=1.
const DESKTOP_MODELS = [
  { id: 'web:claude', name: 'Claude (web session)', vendor: 'anthropic', efforts: ['off'], structured_outputs: false },
  { id: 'web:chatgpt', name: 'ChatGPT (web session)', vendor: 'openai', efforts: ['off'], structured_outputs: false },
  { id: 'web:grok', name: 'Grok (web session)', vendor: 'x-ai', efforts: ['off'], structured_outputs: false },
  { id: 'web:claude:analyst', name: 'Claude web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false },
  { id: 'web:chatgpt:analyst', name: 'ChatGPT web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false },
  { id: 'web:grok:analyst', name: 'Grok web session (hidden analyst page)', vendor: 'triplex-analyst', efforts: ['off'], structured_outputs: false },
  { id: 'ollama:hermes3', name: 'hermes3', vendor: 'ollama', efforts: ['off'], structured_outputs: false },
]
function modelsState(items = DESKTOP_MODELS) {
  const byId = {}
  for (const m of items) byId[m.id] = m
  return { items, byId, loaded: true, error: null }
}

const NOT_CAPTURED_MSG = (slot) => `capture is off for ${slot}; the reply is in the site pane`
const msg = (role, content, turn_id) => ({ role, content, kind: 'chat', turn_id, ts: '2026-09-16T00:00:00.000Z', meta: null })

/** A persisted send turn; `notCaptured` slots carry the bridge's not_captured message and no response. */
function sendTurn(id, prompt, notCaptured = []) {
  const responses = {}
  const errors = {}
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    if (notCaptured.includes(slot)) {
      responses[slot] = null
      errors[slot] = NOT_CAPTURED_MSG(slot)
    } else responses[slot] = `${slot} says ${prompt}`
  }
  return { id, type: 'send', ts: '2026-09-16T00:00:00.000Z', prompt, responses, errors, partial: {}, reasoning: {}, slot_config: CFG, usage: { calls: [], totals: { ...emptyRow(), latency_ms: 700, calls: 3 } } }
}

/** A conversation whose threads hold the captured replies of `turns`. */
function convWith(turns, over = {}) {
  const threads = { claude: [], chatgpt: [], grok: [] }
  for (const t of turns) {
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      if (t.responses[slot] == null) continue
      threads[slot].push(msg('user', t.prompt, t.id), msg('assistant', t.responses[slot], t.id))
    }
  }
  return conv({ turns, threads, ...over })
}

const store = { dispatch: null }
function Probe() {
  const p = useSlice('panes')
  store.dispatch = useDispatch()
  return <div data-testid="probe">{`${p.drawerOpen}`}</div>
}

function mount(fake, preloaded = {}) {
  return renderWithStore(
    <>
      <Drawer api={fake} />
      <Probe />
    </>,
    { preloaded: { panes: initialPanes(), models: modelsState(), ...preloaded } },
  )
}

const drawer = () => screen.getByTestId('desk-drawer')
const tab = (key) => screen.getByTestId(`drawer-tab-${key}`)
const hint = () => screen.queryByTestId('drawer-capture-hint')

describe('Drawer: pure helpers', () => {
  test('captureHint lists the not_captured slots of the LATEST send turn; analystHint keys on the desktop transports', () => {
    expect(captureHint(convWith([sendTurn('t1', 'a', ['grok']), sendTurn('t2', 'b', ['claude', 'grok'])]))).toBe('capture is off for claude, grok')
    expect(captureHint(convWith([sendTurn('t1', 'a', ['grok']), sendTurn('t2', 'b')]))).toBeNull()
    expect(captureHint(convWith([]))).toBeNull()
    expect(captureHint(null)).toBeNull()
    expect(analystHint('web:chatgpt:analyst')).toBeNull()
    expect(analystHint('ollama:hermes3')).toBeNull()
    expect(analystHint('')).toBe(CHOOSE_ANALYST_HINT)
    expect(analystHint(undefined)).toBe(CHOOSE_ANALYST_HINT)
    expect(analystHint('openai/gpt-5.6-luna')).toBe(CHOOSE_ANALYST_HINT)
    expect(DRAWER_TABS.map((t) => t.key)).toEqual(['analyze', 'fusion', 'captured', 'settings'])
  })
})

describe('Drawer: tabs and panes', () => {
  test('closed by default with its toggle and four tabs; the toggle opens it on Analyze and mounts every pane by its test id, plus the desktop meter; the toggle closes it again', () => {
    const fake = fakeTriplex()
    mount(fake, { conversation: convWith([sendTurn('t1', 'q')]), slotConfig: CFG })
    expect(drawer()).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('drawer-toggle')).toHaveAttribute('aria-expanded', 'false')
    for (const key of ['analyze', 'fusion', 'captured', 'settings']) expect(tab(key)).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByTestId('drawer-body')).toBeNull()
    expect(screen.queryByTestId('analyze')).toBeNull()

    fireEvent.click(screen.getByTestId('drawer-toggle'))
    expect(drawer()).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('probe')).toHaveTextContent('true')
    expect(tab('analyze')).toHaveAttribute('aria-selected', 'true')
    // the unchanged panes, by their own test ids
    expect(screen.getByTestId('analyze')).toBeInTheDocument()
    expect(screen.getByTestId('analyze-run')).toBeInTheDocument()
    expect(screen.getByTestId('fusion-root')).toBeInTheDocument()
    expect(screen.getByTestId('fusion-run')).toBeInTheDocument()
    expect(screen.getByTestId('send-grid-root')).toBeInTheDocument()
    expect(screen.getByTestId('slot-config-bar')).toBeInTheDocument()
    expect(screen.getByTestId('meter')).toHaveAttribute('data-mode', 'desktop')
    // only the selected tab's panel is shown
    expect(screen.getByTestId('drawer-panel-analyze')).not.toHaveAttribute('hidden')
    for (const key of ['fusion', 'captured', 'settings']) expect(screen.getByTestId(`drawer-panel-${key}`)).toHaveAttribute('hidden')

    fireEvent.click(screen.getByTestId('drawer-toggle'))
    expect(drawer()).toHaveAttribute('data-open', 'false')
    expect(screen.queryByTestId('drawer-body')).toBeNull()
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })

  test('clicking a tab opens the drawer on it; Captured shows the captured threads (slot-<slot>-message) without the web composer', () => {
    const fake = fakeTriplex()
    mount(fake, { conversation: convWith([sendTurn('t1', 'what is 2+2', ['grok'])]), slotConfig: CFG })
    fireEvent.click(tab('captured'))
    expect(drawer()).toHaveAttribute('data-open', 'true')
    expect(drawer()).toHaveAttribute('data-tab', 'captured')
    expect(tab('captured')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('drawer-panel-captured')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('drawer-panel-analyze')).toHaveAttribute('hidden')
    const captured = within(screen.getByTestId('drawer-panel-captured'))
    expect(captured.getAllByTestId('slot-claude-message')).toHaveLength(2)
    expect(captured.getAllByTestId('slot-chatgpt-message')).toHaveLength(2)
    const [claudeUser, claudeReply] = captured.getAllByTestId('slot-claude-message')
    expect(claudeUser).toHaveAttribute('data-role', 'user')
    expect(claudeReply).toHaveAttribute('data-role', 'assistant')
    expect(claudeReply).toHaveTextContent('claude says what is 2+2')
    expect(captured.queryByTestId('slot-grok-message')).toBeNull() // not captured: nothing in its thread
    expect(captured.getByTestId('slot-grok-persisted-error')).toHaveTextContent(/capture is off for grok/)
    // the web composer is gone; the per-column solo continue boxes stay
    expect(screen.queryByTestId('send-composer')).toBeNull()
    expect(screen.queryByTestId('send-button')).toBeNull()
    expect(screen.queryByTestId('send-grounded-hint')).toBeNull()
    expect(captured.getByTestId('slot-claude-composer')).toBeInTheDocument()
    // the selects list the desktop catalog's pane models
    expect(captured.getByTestId('slot-claude-model')).toHaveValue('web:claude')
    fireEvent.click(tab('fusion'))
    expect(drawer()).toHaveAttribute('data-tab', 'fusion')
    expect(screen.getByTestId('drawer-panel-fusion')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('drawer-panel-captured')).toHaveAttribute('hidden')
  })

  test('without a conversation the drawer still opens: Analyze / Fusion render nothing, Captured shows the empty columns, Settings is usable', () => {
    const fake = fakeTriplex()
    mount(fake)
    fireEvent.click(tab('settings'))
    expect(screen.getByTestId('drawer-body')).toBeInTheDocument()
    expect(screen.queryByTestId('analyze')).toBeNull()
    expect(screen.queryByTestId('fusion-root')).toBeNull()
    expect(screen.getByTestId('send-grid')).toBeInTheDocument()
    expect(screen.getByTestId('config-analyst-model')).toBeEnabled()
    expect(screen.getByTestId('config-max-iterations')).toBeDisabled()
  })
})

describe('Drawer: hints', () => {
  test('the capture hint lists exactly the not_captured slots of the latest send turn, and nothing when it was fully captured', () => {
    const fake = fakeTriplex()
    const { unmount } = mount(fake, { conversation: convWith([sendTurn('t1', 'a', ['chatgpt']), sendTurn('t2', 'b', ['claude', 'grok'])]), slotConfig: CFG })
    expect(hint()).toHaveTextContent('capture is off for claude, grok')
    expect(hint()).not.toHaveTextContent('chatgpt')
    expect(hint()).not.toHaveTextContent(CHOOSE_ANALYST_HINT)
    unmount()
    mount(fake, { conversation: convWith([sendTurn('t1', 'a', ['grok']), sendTurn('t2', 'b')]), slotConfig: CFG })
    expect(hint()).toBeNull()
  })

  test('the analyst hint shows when the open conversation has no desktop analyst (unset or an OpenRouter slug), combined with the capture hint', () => {
    const fake = fakeTriplex()
    const { unmount } = mount(fake, { conversation: convWith([sendTurn('t1', 'a', ['grok'])], { slot_config: { ...CFG, analyst_model: '' } }), slotConfig: { ...CFG, analyst_model: '' } })
    expect(hint()).toHaveTextContent('capture is off for grok · choose an analyst')
    unmount()
    const { unmount: unmount2 } = mount(fake, { conversation: convWith([sendTurn('t1', 'a')]), slotConfig: { ...CFG, analyst_model: 'openai/gpt-5.6-luna' } })
    expect(hint()).toHaveTextContent(CHOOSE_ANALYST_HINT)
    unmount2()
    mount(fake, { conversation: convWith([sendTurn('t1', 'a')]), slotConfig: { ...CFG, analyst_model: 'ollama:hermes3' } })
    expect(hint()).toBeNull()
  })

  test('without a conversation the desktop choice decides: "" (none) shows the hint, the default does not', () => {
    const fake = fakeTriplex()
    localStorage.setItem(ANALYST_KEY, '')
    const { unmount } = mount(fake)
    expect(hint()).toHaveTextContent(CHOOSE_ANALYST_HINT)
    unmount()
    localStorage.clear()
    mount(fake)
    expect(hint()).toBeNull()
  })
})

describe('Drawer: Settings and the analyst choice', () => {
  test('the analyst select lists the desktop groups (web sessions / local Ollama from the catalog), hides grounded, persists the choice, calls setAnalyst(slot|null) and PUTs the open conversation', async () => {
    const fake = fakeTriplex()
    const calls = stubFetch([{ method: 'PUT', url: '/api/conversations/c1/slot_config', respond: ({ body }) => jsonResponse(body) }])
    mount(fake, { conversation: convWith([sendTurn('t1', 'a')]), slotConfig: CFG })
    fireEvent.click(tab('settings'))
    const bar = screen.getByTestId('slot-config-bar')
    expect(bar).toHaveAttribute('data-mode', 'desktop')
    const select = screen.getByTestId('config-analyst-model')
    expect(select).toHaveValue('web:chatgpt:analyst') // the open conversation's analyst_model
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label)
    expect(groups).toEqual(['web sessions (hidden analyst page)', 'local Ollama'])
    const web = [...select.querySelectorAll('optgroup')][0]
    expect([...web.querySelectorAll('option')].map((o) => o.value)).toEqual(['web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst'])
    expect(web.querySelector('option[value="web:claude:analyst"]')).toHaveTextContent('Claude web session (hidden analyst page)')
    const ollama = [...select.querySelectorAll('optgroup')][1]
    expect([...ollama.querySelectorAll('option')].map((o) => o.value)).toEqual(['ollama:hermes3'])
    expect(select.querySelector('option[value=""]')).toHaveTextContent('none')
    expect(screen.queryByTestId('config-grounded')).toBeNull()
    expect(screen.queryByTestId('config-grounded-label')).toBeNull()
    // the other controls are the web bar's
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('2')
    expect(screen.getByTestId('config-materiality-min')).toHaveValue('medium')

    fireEvent.change(select, { target: { value: 'web:claude:analyst' } })
    expect(localStorage.getItem(ANALYST_KEY)).toBe('web:claude:analyst')
    expect(fake.setAnalyst).toHaveBeenLastCalledWith('claude')
    expect(select).toHaveValue('web:claude:analyst') // optimistic slotConfig/update
    await waitFor(() => expect(seqOf(calls)).toEqual(['PUT /api/conversations/c1/slot_config']))
    expect(calls[0].body).toEqual({ ...CFG, analyst_model: 'web:claude:analyst' })

    fireEvent.change(select, { target: { value: 'ollama:hermes3' } })
    expect(localStorage.getItem(ANALYST_KEY)).toBe('ollama:hermes3')
    expect(fake.setAnalyst).toHaveBeenLastCalledWith(null)
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].body).toMatchObject({ analyst_model: 'ollama:hermes3' })
    expect(hint()).toBeNull()

    fireEvent.change(select, { target: { value: '' } })
    expect(localStorage.getItem(ANALYST_KEY)).toBe('')
    expect(fake.setAnalyst).toHaveBeenLastCalledWith(null)
    expect(fake.setAnalyst).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2].body).toMatchObject({ analyst_model: '' })
    expect(hint()).toHaveTextContent(CHOOSE_ANALYST_HINT)
  })

  test('without a conversation the select is enabled, shows the persisted choice, persists and calls setAnalyst; nothing is PUT; a pre-pivot slug is listed until changed', () => {
    const fake = fakeTriplex()
    const calls = stubFetch([])
    localStorage.setItem(ANALYST_KEY, 'web:grok:analyst')
    const { unmount } = mount(fake)
    fireEvent.click(tab('settings'))
    const select = screen.getByTestId('config-analyst-model')
    expect(select).toBeEnabled()
    expect(select).toHaveValue('web:grok:analyst')
    fireEvent.change(select, { target: { value: 'ollama:hermes3' } })
    expect(localStorage.getItem(ANALYST_KEY)).toBe('ollama:hermes3')
    expect(fake.setAnalyst).toHaveBeenCalledWith(null)
    expect(select).toHaveValue('ollama:hermes3')
    expect(calls).toHaveLength(0)
    unmount()
    // an open pre-pivot conversation: its OpenRouter analyst is listed so the select is truthful
    mount(fake, { conversation: convWith([]), slotConfig: { ...CFG, analyst_model: 'openai/gpt-5.6-luna' } })
    fireEvent.click(tab('settings'))
    const select2 = screen.getByTestId('config-analyst-model')
    expect(select2).toHaveValue('openai/gpt-5.6-luna')
    expect(select2.querySelector('option[value="openai/gpt-5.6-luna"]')).not.toBeNull()
  })

  test('the analyst-page switch calls showAnalyst and mirrors panes.analyst.visible; a partial stub never throws', () => {
    const fake = fakeTriplex()
    stubFetch([])
    const { unmount } = mount(fake)
    fireEvent.click(tab('settings'))
    const box = screen.getByTestId('drawer-analyst-visible')
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    expect(fake.showAnalyst).toHaveBeenCalledWith(true)
    expect(box).not.toBeChecked() // main decides: the slice follows onAnalyst
    act(() => store.dispatch({ type: 'panes/analyst', visible: true }))
    expect(screen.getByTestId('drawer-analyst-visible')).toBeChecked()
    fireEvent.click(screen.getByTestId('drawer-analyst-visible'))
    expect(fake.showAnalyst).toHaveBeenLastCalledWith(false)
    unmount()
    vi.unstubAllGlobals()
    renderWithStore(<Drawer api={{}} />, { preloaded: { panes: { ...initialPanes(), drawerOpen: true }, models: modelsState() } })
    fireEvent.click(screen.getByTestId('drawer-tab-settings'))
    expect(() => fireEvent.click(screen.getByTestId('drawer-analyst-visible'))).not.toThrow()
    expect(() => fireEvent.change(screen.getByTestId('config-analyst-model'), { target: { value: 'web:claude:analyst' } })).not.toThrow()
    expect(localStorage.getItem(ANALYST_KEY)).toBe('web:claude:analyst')
  })

  test('the Settings select falls back to the three fixed web analysts when the catalog is not loaded', () => {
    const fake = fakeTriplex()
    stubFetch([{ method: 'GET', url: '/api/models', respond: jsonResponse({ detail: { error: 'nope' } }, 500) }])
    mount(fake, { models: { items: [], byId: {}, loaded: false, error: 'down' } })
    fireEvent.click(tab('settings'))
    const select = screen.getByTestId('config-analyst-model')
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['web sessions (hidden analyst page)'])
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst'])
    expect(select).toHaveValue(DEFAULT_ANALYST)
  })
})

describe('Drawer: auto-open on an Analyze run', () => {
  test('the analyze stream starting opens the drawer on the Analyze tab; a fusion stream (which auto-runs Analyze) does not', () => {
    const fake = fakeTriplex()
    stubFetch([])
    mount(fake, { conversation: convWith([sendTurn('t1', 'a')]), slotConfig: CFG })
    fireEvent.click(tab('settings'))
    fireEvent.click(screen.getByTestId('drawer-toggle'))
    expect(drawer()).toHaveAttribute('data-open', 'false')
    expect(drawer()).toHaveAttribute('data-tab', 'settings')
    act(() => store.dispatch({ type: 'sse/start', feature: 'fusion' }))
    expect(drawer()).toHaveAttribute('data-open', 'false')
    act(() => store.dispatch({ type: 'sse/end', feature: 'fusion', ok: true }))
    act(() => store.dispatch({ type: 'sse/start', feature: 'analyze' }))
    expect(drawer()).toHaveAttribute('data-open', 'true')
    expect(drawer()).toHaveAttribute('data-tab', 'analyze')
    expect(tab('analyze')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-status', 'idle')
    // the user may move on while it streams; the end of the stream does not yank the tab back
    fireEvent.click(tab('captured'))
    act(() => store.dispatch({ type: 'sse/end', feature: 'analyze', ok: true }))
    expect(drawer()).toHaveAttribute('data-tab', 'captured')
    // a second run re-opens on Analyze after the drawer was closed
    fireEvent.click(screen.getByTestId('drawer-toggle'))
    act(() => store.dispatch({ type: 'sse/start', feature: 'analyze' }))
    expect(drawer()).toHaveAttribute('data-open', 'true')
    expect(drawer()).toHaveAttribute('data-tab', 'analyze')
  })
})

describe('CostMeter: desktop mode', () => {
  const meterState = () => ({
    ...initialMeter(),
    send: { ...emptyRow(), prompt_tokens: 60, completion_tokens: 120, cost_usd: 0.006, latency_ms: 1600, calls: 6, truncated: 1 },
    analyze: { ...emptyRow(), latency_ms: 2000, calls: 1 },
    total: { ...emptyRow(), prompt_tokens: 60, completion_tokens: 120, cost_usd: 0.006, latency_ms: 3600, calls: 7, truncated: 1 },
    last: { send: { ...emptyRow(), prompt_tokens: 30, completion_tokens: 60, cost_usd: 0.003, latency_ms: 800, calls: 3 }, analyze: { ...emptyRow(), latency_ms: 2000, calls: 1 }, fusion: emptyRow() },
    costCapExceeded: true,
  })

  test('the desktop prop shows latency / calls only: no tokens, cost, multiplier, truncation count or cost-cap warning', () => {
    renderWithStore(<CostMeter desktop />, { preloaded: { meter: meterState() } })
    const meter = screen.getByTestId('meter')
    expect(meter).toHaveAttribute('data-mode', 'desktop')
    expect(screen.getByTestId('meter-group-last')).toHaveAttribute('colspan', '2')
    expect(screen.getByTestId('meter-group-conv')).toHaveAttribute('colspan', '2')
    expect(screen.getByTestId('meter-send-latency')).toHaveTextContent('800 ms')
    expect(screen.getByTestId('meter-send-calls')).toHaveTextContent('3')
    expect(screen.getByTestId('meter-send-conv-latency')).toHaveTextContent('1.6 s')
    expect(screen.getByTestId('meter-send-conv-calls')).toHaveTextContent('6')
    expect(screen.getByTestId('meter-analyze-latency')).toHaveTextContent('2.0 s')
    expect(screen.getByTestId('meter-total-conv-calls')).toHaveTextContent('7')
    expect(screen.getByTestId('meter-total-conv-latency')).toHaveTextContent('3.6 s')
    for (const id of ['meter-send-tokens', 'meter-send-cost', 'meter-send-conv-tokens', 'meter-send-conv-cost', 'meter-total-conv-cost', 'meter-fusion-multiplier', 'meter-truncated', 'meter-cost-cap']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(meter).not.toHaveTextContent('tokens in / out')
    expect(meter).not.toHaveTextContent('$')
    const heads = [...meter.querySelectorAll('thead tr')[1].querySelectorAll('th')].map((th) => th.textContent)
    expect(heads).toEqual(['feature', 'latency', 'calls', 'latency', 'calls'])
  })

  test('the default follows window.triplex: desktop columns under the Electron preload, the web columns otherwise', () => {
    vi.stubGlobal('triplex', {})
    const { unmount } = renderWithStore(<CostMeter />, { preloaded: { meter: meterState() } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-mode', 'desktop')
    expect(screen.queryByTestId('meter-send-tokens')).toBeNull()
    unmount()
    vi.unstubAllGlobals()
    renderWithStore(<CostMeter />, { preloaded: { meter: meterState() } })
    expect(screen.getByTestId('meter')).toHaveAttribute('data-mode', 'web')
    expect(screen.getByTestId('meter-send-tokens')).toHaveTextContent('30 / 60')
    expect(screen.getByTestId('meter-send-cost')).toHaveTextContent('$0.00300')
    expect(screen.getByTestId('meter-truncated')).toHaveTextContent('truncated replies: 1')
    expect(screen.getByTestId('meter-cost-cap')).toBeInTheDocument()
  })
})

describe('Drawer through the shell', () => {
  let ro
  beforeEach(() => {
    syncFrames()
    ro = installFakeResizeObserver()
    pinViewportRects()
  })

  test('sits below the prompt bar; drawerOpen is restored from localStorage and written back; opening it makes the viewports re-report', () => {
    localStorage.setItem(PERSIST_KEYS.drawerOpen, 'true')
    const fake = fakeTriplex()
    vi.stubGlobal('triplex', fake)
    stubFetch([])
    renderWithStore(<DesktopShell />, { preloaded: { models: modelsState() } })
    const shell = screen.getByTestId('desktop-shell')
    expect([...shell.children].map((c) => c.getAttribute('data-testid'))).toEqual(['pane-deck', 'prompt-bar', 'desk-drawer'])
    expect(drawer()).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('drawer-body')).toBeInTheDocument()
    expect(fake.setLayout.mock.calls.at(-1)[0]).toEqual(RECTS)
    // the deck shrank under the open drawer: the observers fire and the new rects reach main
    vi.restoreAllMocks()
    const smaller = { claude: { ...RECTS.claude, height: 300 }, chatgpt: { ...RECTS.chatgpt, height: 300 }, grok: { ...RECTS.grok, height: 300 } }
    pinViewportRects(smaller)
    act(() => ro.triggerResize())
    expect(fake.setLayout.mock.calls.at(-1)[0]).toEqual(smaller)
    fireEvent.click(screen.getByTestId('drawer-toggle'))
    expect(drawer()).toHaveAttribute('data-open', 'false')
    expect(localStorage.getItem(PERSIST_KEYS.drawerOpen)).toBe('false')
    fireEvent.click(screen.getByTestId('drawer-tab-fusion'))
    expect(drawer()).toHaveAttribute('data-open', 'true')
    expect(localStorage.getItem(PERSIST_KEYS.drawerOpen)).toBe('true')
  })

  test('a junk drawerOpen value and a partial window.triplex keep the drawer closed and working', () => {
    localStorage.setItem(PERSIST_KEYS.drawerOpen, 'maybe')
    vi.stubGlobal('triplex', {})
    stubFetch([])
    expect(() => renderWithStore(<DesktopShell />, { preloaded: { models: modelsState() } })).not.toThrow()
    expect(drawer()).toHaveAttribute('data-open', 'false')
    fireEvent.click(screen.getByTestId('drawer-toggle'))
    expect(screen.getByTestId('drawer-body')).toBeInTheDocument()
  })
})
