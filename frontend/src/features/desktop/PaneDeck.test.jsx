import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import './index.jsx' // registers the `panes` slice
import PaneDeck from './PaneDeck.jsx'
import { CAPTURE_LABEL, CAPTURE_NOTICE_KEY, CAPTURE_NOTICE_TEXT, initialPanes } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { RECTS, conv, fakeTriplex, health, installFakeResizeObserver, pinViewportRects, syncFrames } from './fakes.js'

let ro
beforeEach(() => {
  localStorage.clear()
  syncFrames()
  ro = installFakeResizeObserver()
  pinViewportRects()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function panes(over = {}) {
  return { ...initialPanes(), ...over }
}

/** The store's dispatch, captured by the Probe so a test can drive the slice from outside PaneDeck. */
const store = { dispatch: null }

function Probe() {
  const p = useSlice('panes')
  store.dispatch = useDispatch()
  return <div data-testid="probe">{`${p.mode}:${p.active}:${JSON.stringify(p.zoom)}`}</div>
}

function mount(fake, over = {}, props = {}) {
  return renderWithStore(
    <>
      <PaneDeck api={fake} info={{ dev: true }} version="0.1.0" {...props} />
      <Probe />
    </>,
    { preloaded: { panes: panes(over) } },
  )
}

const lastLayout = (fake) => fake.setLayout.mock.calls.at(-1)[0]

describe('PaneDeck: layout reporting', () => {
  test('split → setLayout with rects for all three; setActive with the mode', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split', active: 'chatgpt' })
    expect(fake.setLayout).toHaveBeenCalled()
    expect(lastLayout(fake)).toEqual(RECTS)
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'split', active: 'chatgpt' })
    // a ResizeObserver watches every viewport
    expect(ro.instances.length).toBeGreaterThan(0)
    const observed = new Set()
    for (const inst of ro.instances) for (const t of inst.targets) observed.add(t.getAttribute('data-testid'))
    expect(observed).toEqual(new Set(['pane-claude-viewport', 'pane-chatgpt-viewport', 'pane-grok-viewport']))
  })

  test('tabs → one rect and nulls; the inactive panes are hidden', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'tabs', active: 'chatgpt' })
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: RECTS.chatgpt, grok: null })
    expect(screen.getByTestId('pane-claude')).not.toBeVisible()
    expect(screen.getByTestId('pane-chatgpt')).toBeVisible()
    expect(screen.getByTestId('pane-grok')).not.toBeVisible()
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('deck-mode-tabs')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('deck-mode-split')).toHaveAttribute('aria-pressed', 'false')
  })

  test('an active switch re-sends the layout and setActive', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'tabs', active: 'chatgpt' })
    const before = fake.setLayout.mock.calls.length
    fireEvent.click(screen.getByTestId('deck-tab-grok'))
    expect(fake.setLayout.mock.calls.length).toBeGreaterThan(before)
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: null, grok: RECTS.grok })
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'tabs', active: 'grok' })
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:grok')
    // in tabs mode a tab click does not move the focus (the view becomes visible instead)
    expect(fake.focusPane).not.toHaveBeenCalled()
  })

  test('a mode switch re-sends: tabs → split shows all three, split → tabs hides two', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'tabs', active: 'claude' })
    fireEvent.click(screen.getByTestId('deck-mode-split'))
    expect(lastLayout(fake)).toEqual(RECTS)
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'split', active: 'claude' })
    fireEvent.click(screen.getByTestId('deck-mode-tabs'))
    expect(lastLayout(fake)).toEqual({ claude: RECTS.claude, chatgpt: null, grok: null })
  })

  test('a viewport resize or window resize re-sends; an identical layout is not re-sent', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    const calls = fake.setLayout.mock.calls.length
    ro.triggerResize()
    fireEvent(window, new Event('resize'))
    expect(fake.setLayout.mock.calls.length).toBe(calls) // same rects → skipped
    const moved = { ...RECTS, grok: { x: 1000, y: 40, width: 700, height: 600 } }
    pinViewportRects(moved)
    ro.triggerResize()
    expect(fake.setLayout.mock.calls.length).toBe(calls + 1)
    expect(lastLayout(fake)).toEqual(moved)
    pinViewportRects({ ...moved, claude: { x: 0, y: 40, width: 400, height: 600 } })
    fireEvent(window, new Event('resize'))
    expect(fake.setLayout.mock.calls.length).toBe(calls + 2)
    expect(lastLayout(fake).claude.width).toBe(400)
  })

  test('the deck tab click in split mode activates and focuses the pane', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split', active: 'chatgpt' })
    fireEvent.click(screen.getByTestId('deck-tab-claude'))
    expect(fake.focusPane).toHaveBeenCalledWith('claude')
    expect(screen.getByTestId('probe')).toHaveTextContent('split:claude')
  })

  test('unmount disconnects the observer and unsubscribes every channel', () => {
    const fake = fakeTriplex()
    const { unmount } = mount(fake)
    unmount()
    expect(ro.instances.every((i) => !i.alive)).toBe(true)
    expect(fake.unsubscribed).toEqual({ health: 1, shortcut: 1, zoom: 1, bridge: 0, turn: 1 })
  })

  test('renders without any window.triplex and under a partial stub', () => {
    expect(() => mount(null)).not.toThrow()
    expect(screen.getAllByTestId('pane-deck').length).toBe(1)
    expect(() => renderWithStore(<PaneDeck api={{}} />)).not.toThrow()
  })
})

describe('PaneDeck: health and session', () => {
  test('a health event renders the dot, the health text with the selectors in the title, and the session', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    expect(screen.getByTestId('pane-chatgpt-health')).toHaveTextContent('no health yet')
    expect(screen.getByTestId('pane-chatgpt-session')).toHaveAttribute('data-session', 'unknown')
    act(() => fake.emit.health('chatgpt', health()))
    const text = screen.getByTestId('pane-chatgpt-health')
    expect(text).toHaveTextContent('composer ✓ send ✓ · signed in')
    expect(text).toHaveAttribute('data-level', 'ok')
    expect(text.title).toContain('composer: #prompt-textarea')
    expect(text.title).toContain("send: button[data-testid='send-button']")
    const session = screen.getByTestId('pane-chatgpt-session')
    expect(session).toHaveAttribute('data-session', 'ok')
    expect(session).toHaveAttribute('data-level', 'ok')
    expect(session).toHaveTextContent('')
    const tab = screen.getByTestId('deck-tab-chatgpt')
    expect(tab).toHaveAttribute('data-session', 'ok')
    expect(tab.querySelector('[data-level]')).toHaveAttribute('data-level', 'ok')
    expect(tab.title).toContain('composer ✓ send ✓ · signed in')
    // the other panes are untouched
    expect(screen.getByTestId('pane-claude-health')).toHaveTextContent('no health yet')
  })

  test('session badges SIGN IN / CHALLENGE / BLOCKED on the pane header and the deck tab', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    act(() => fake.emit.health('claude', health({ session: 'logged_out', composer: false, send: false, matched: { composer: null, send: null } })))
    act(() => fake.emit.health('chatgpt', health({ session: 'challenge' })))
    act(() => fake.emit.health('grok', health({ session: 'blocked' })))
    expect(screen.getByTestId('pane-claude-session')).toHaveTextContent('SIGN IN')
    expect(screen.getByTestId('pane-claude-session')).toHaveAttribute('data-session', 'logged_out')
    expect(screen.getByTestId('pane-claude-health')).toHaveTextContent('composer ✗ send ✗ · signed out')
    expect(screen.getByTestId('pane-claude-health')).toHaveAttribute('data-level', 'bad')
    expect(screen.getByTestId('pane-chatgpt-session')).toHaveTextContent('CHALLENGE')
    expect(screen.getByTestId('pane-chatgpt-health')).toHaveTextContent('· challenge')
    expect(screen.getByTestId('pane-grok-session')).toHaveTextContent('BLOCKED')
    expect(within(screen.getByTestId('deck-tab-claude')).getByText('SIGN IN')).toBeInTheDocument()
    expect(within(screen.getByTestId('deck-tab-chatgpt')).getByText('CHALLENGE')).toBeInTheDocument()
    expect(within(screen.getByTestId('deck-tab-grok')).getByText('BLOCKED')).toBeInTheDocument()
    // a composer without a send button is a warning, not a failure
    act(() => fake.emit.health('grok', health({ session: 'ok', send: false })))
    expect(screen.getByTestId('pane-grok-health')).toHaveAttribute('data-level', 'warn')
    expect(screen.getByTestId('pane-grok-session')).toHaveTextContent('')
  })

  test('a hidden pane that needs attention marks its deck tab (tabs mode only)', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'tabs', active: 'chatgpt' })
    act(() => fake.emit.health('grok', health({ session: 'logged_out' })))
    const grokTab = screen.getByTestId('deck-tab-grok')
    expect(grokTab).toHaveAttribute('data-attention', 'true')
    expect(within(grokTab).getByLabelText('needs attention')).toBeInTheDocument()
    // the active pane never carries the hidden-attention marker even when it needs the user
    act(() => fake.emit.health('chatgpt', health({ session: 'challenge' })))
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('data-attention', 'false')
    // a healthy hidden pane is not marked
    act(() => fake.emit.health('claude', health()))
    expect(screen.getByTestId('deck-tab-claude')).toHaveAttribute('data-attention', 'false')
    // split mode: nothing is hidden, so no marker
    fireEvent.click(screen.getByTestId('deck-mode-split'))
    expect(screen.getByTestId('deck-tab-grok')).toHaveAttribute('data-attention', 'false')
  })

  test('a failed send on a hidden pane also marks its tab', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'tabs', active: 'chatgpt', lastSend: { grok: { ok: false, code: 'send_not_found', ms: 0 } } })
    expect(screen.getByTestId('deck-tab-grok')).toHaveAttribute('data-attention', 'true')
    expect(screen.getByTestId('deck-tab-claude')).toHaveAttribute('data-attention', 'false')
  })

  test('unknown slots and non-object health payloads are ignored', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    act(() => fake.emit.health('gemini', health()))
    act(() => fake.emit.health('claude', 'nope'))
    expect(screen.getByTestId('pane-claude-health')).toHaveTextContent('no health yet')
  })
})

describe('PaneDeck: header actions call the API with the slot', () => {
  test('Reload / New chat / Open / Inspect', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    fireEvent.click(screen.getByTestId('pane-claude-reload'))
    expect(fake.reload).toHaveBeenCalledWith('claude')
    fireEvent.click(screen.getByTestId('pane-grok-newchat'))
    expect(fake.newChat).toHaveBeenCalledWith(['grok'])
    fireEvent.click(screen.getByTestId('pane-chatgpt-open'))
    expect(fake.openExternal).toHaveBeenCalledWith('chatgpt')
    fireEvent.click(screen.getByTestId('pane-chatgpt-inspect'))
    expect(fake.inspect).toHaveBeenCalledWith('chatgpt')
  })

  test('Reload and New chat are disabled while a send is in flight; Open / zoom / Inspect are not', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split', sending: true })
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      expect(screen.getByTestId(`pane-${slot}-reload`)).toBeDisabled()
      expect(screen.getByTestId(`pane-${slot}-newchat`)).toBeDisabled()
      expect(screen.getByTestId(`pane-${slot}-reload`).title).toMatch(/send is in flight/)
      expect(screen.getByTestId(`pane-${slot}-open`)).toBeEnabled()
      expect(screen.getByTestId(`pane-${slot}-zoom-in`)).toBeEnabled()
      expect(screen.getByTestId(`pane-${slot}-inspect`)).toBeEnabled()
    }
    fireEvent.click(screen.getByTestId('pane-claude-reload'))
    fireEvent.click(screen.getByTestId('pane-grok-newchat'))
    expect(fake.reload).not.toHaveBeenCalled()
    expect(fake.newChat).not.toHaveBeenCalled()
    act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))
    expect(screen.getByTestId('pane-claude-reload')).toBeEnabled()
    expect(screen.getByTestId('pane-claude-reload').title).toMatch(/Reload Claude/)
    fireEvent.click(screen.getByTestId('pane-claude-reload'))
    expect(fake.reload).toHaveBeenCalledWith('claude')
  })

  test('Inspect only when info.dev', () => {
    const fake = fakeTriplex()
    renderWithStore(<PaneDeck api={fake} info={{ dev: false }} />, { preloaded: { panes: panes() } })
    expect(screen.queryByTestId('pane-claude-inspect')).toBeNull()
    expect(screen.queryByText('Inspect')).toBeNull()
  })

  test('zoom −/+/reset call zoom(slot, direction) and mirror the returned factor', async () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    expect(screen.getByTestId('pane-claude-zoom-reset')).toHaveTextContent('100%')
    fireEvent.click(screen.getByTestId('pane-claude-zoom-in'))
    expect(fake.zoom).toHaveBeenCalledWith('claude', 'in')
    await waitFor(() => expect(screen.getByTestId('pane-claude-zoom-reset')).toHaveTextContent('110%'))
    fireEvent.click(screen.getByTestId('pane-claude-zoom-out'))
    expect(fake.zoom).toHaveBeenCalledWith('claude', 'out')
    await waitFor(() => expect(screen.getByTestId('pane-claude-zoom-reset')).toHaveTextContent('90%'))
    fireEvent.click(screen.getByTestId('pane-claude-zoom-reset'))
    expect(fake.zoom).toHaveBeenCalledWith('claude', 'reset')
    await waitFor(() => expect(screen.getByTestId('pane-claude-zoom-reset')).toHaveTextContent('100%'))
    expect(screen.getByTestId('probe')).toHaveTextContent('"claude":1,"chatgpt":1,"grok":1')
  })

  test('onZoom (a shortcut applied in main) mirrors into the slice', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    act(() => fake.emit.zoom({ slot: 'grok', factor: 1.3 }))
    expect(screen.getByTestId('pane-grok-zoom-reset')).toHaveTextContent('130%')
    act(() => fake.emit.zoom({ slot: 'gemini', factor: 2 }))
    act(() => fake.emit.zoom({ slot: 'grok', factor: 'x' }))
    expect(screen.getByTestId('pane-grok-zoom-reset')).toHaveTextContent('130%')
  })

  test('a rejected IPC call never surfaces', async () => {
    const fake = fakeTriplex({ reload: vi.fn(async () => { throw new Error('bad_request') }), zoom: vi.fn(async () => { throw new Error('bad_request') }) })
    mount(fake, { mode: 'split' })
    fireEvent.click(screen.getByTestId('pane-claude-reload'))
    fireEvent.click(screen.getByTestId('pane-claude-zoom-in'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('pane-claude-zoom-reset')).toHaveTextContent('100%')
  })
})

describe('PaneDeck: shortcuts', () => {
  test("onShortcut('tab-2') activates chatgpt; tab-1/tab-3 the others; split mode also focuses", () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'tabs', active: 'claude' })
    act(() => fake.emit.shortcut('tab-2'))
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:chatgpt')
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('aria-selected', 'true')
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: RECTS.chatgpt, grok: null })
    expect(fake.focusPane).not.toHaveBeenCalled()
    act(() => fake.emit.shortcut({ name: 'tab-3' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:grok')
    act(() => fake.emit.shortcut('toggle-mode'))
    act(() => fake.emit.shortcut('tab-1'))
    expect(screen.getByTestId('probe')).toHaveTextContent('split:claude')
    expect(fake.focusPane).toHaveBeenCalledWith('claude')
  })

  test('toggle-mode flips tabs ↔ split and re-sends the layout', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split', active: 'chatgpt' })
    act(() => fake.emit.shortcut('toggle-mode'))
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:chatgpt')
    expect(lastLayout(fake)).toEqual({ claude: null, chatgpt: RECTS.chatgpt, grok: null })
    act(() => fake.emit.shortcut('toggle-mode'))
    expect(screen.getByTestId('probe')).toHaveTextContent('split:chatgpt')
    expect(lastLayout(fake)).toEqual(RECTS)
  })

  test('focus-prompt focuses the composer ref; new-chat-all opens a new chat in all three', () => {
    const fake = fakeTriplex()
    const promptRef = { current: { focus: vi.fn() } }
    mount(fake, { mode: 'split' }, { promptRef })
    act(() => fake.emit.shortcut('focus-prompt'))
    expect(promptRef.current.focus).toHaveBeenCalledTimes(1)
    act(() => fake.emit.shortcut('new-chat-all'))
    expect(fake.newChat).toHaveBeenCalledWith(['claude', 'chatgpt', 'grok'])
    // unknown names are ignored
    expect(() => act(() => fake.emit.shortcut('tab-9'))).not.toThrow()
    expect(() => act(() => fake.emit.shortcut(null))).not.toThrow()
  })

  test('new-chat-all calls onNewChatAll (the shared "New chat everywhere") when provided, instead of newChat(all); still gated on sending', () => {
    const fake = fakeTriplex()
    const onNewChatAll = vi.fn(async () => conv({ id: 'c9' }))
    mount(fake, { mode: 'split' }, { onNewChatAll })
    act(() => fake.emit.shortcut('new-chat-all'))
    expect(onNewChatAll).toHaveBeenCalledTimes(1)
    expect(fake.newChat).not.toHaveBeenCalled()
    act(() => store.dispatch({ type: 'panes/sendStart' }))
    act(() => fake.emit.shortcut('new-chat-all'))
    expect(onNewChatAll).toHaveBeenCalledTimes(1)
    // a rejected handler never surfaces
    act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))
    onNewChatAll.mockImplementation(async () => { throw new Error('nope') })
    expect(() => act(() => fake.emit.shortcut('new-chat-all'))).not.toThrow()
    expect(onNewChatAll).toHaveBeenCalledTimes(2)
  })

  test('new-chat-all is ignored while a send is in flight (the same rule as the New chat everywhere button)', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split', sending: true })
    act(() => fake.emit.shortcut('new-chat-all'))
    expect(fake.newChat).not.toHaveBeenCalled()
    // the other shortcuts keep working during a send
    act(() => fake.emit.shortcut('toggle-mode'))
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:chatgpt')
    act(() => fake.emit.shortcut('tab-3'))
    expect(screen.getByTestId('probe')).toHaveTextContent('tabs:grok')
    // once the send settles the shortcut is live again, with the latest `sending` (no stale closure)
    act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))
    act(() => fake.emit.shortcut('new-chat-all'))
    expect(fake.newChat).toHaveBeenCalledTimes(1)
    expect(fake.newChat).toHaveBeenCalledWith(['claude', 'chatgpt', 'grok'])
    act(() => store.dispatch({ type: 'panes/sendStart' }))
    act(() => fake.emit.shortcut('new-chat-all'))
    expect(fake.newChat).toHaveBeenCalledTimes(1)
  })
})

describe('PaneDeck: capture switches, the first-run notice and the turn phase (Stage 2)', () => {
  const capture = (slot) => screen.getByTestId(`pane-${slot}-capture`)

  test('reads getCapture on mount and reflects it; a click calls setCapture(slot, on) and updates the slice', async () => {
    const fake = fakeTriplex({ getCapture: vi.fn(async () => ({ claude: true, chatgpt: false, grok: false })) })
    mount(fake, { mode: 'split' })
    expect(fake.getCapture).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(capture('claude')).toBeChecked())
    expect(capture('chatgpt')).not.toBeChecked()
    expect(capture('grok')).not.toBeChecked()
    // the label is the plan's wording, once per pane
    expect(screen.getAllByText(CAPTURE_LABEL)).toHaveLength(3)
    expect(screen.getByLabelText(CAPTURE_LABEL, { selector: '[data-testid="pane-chatgpt-capture"]' })).toBe(capture('chatgpt'))
    fireEvent.click(capture('chatgpt'))
    expect(fake.setCapture).toHaveBeenCalledWith('chatgpt', true)
    expect(capture('chatgpt')).toBeChecked()
    fireEvent.click(capture('chatgpt'))
    expect(fake.setCapture).toHaveBeenLastCalledWith('chatgpt', false)
    expect(capture('chatgpt')).not.toBeChecked()
    expect(fake.setCapture).toHaveBeenCalledTimes(2)
  })

  test('a rejected setCapture reverts the switch; a partial stub keeps the optimistic value', async () => {
    const fake = fakeTriplex({ setCapture: vi.fn(async () => { throw new Error('bad_request') }) })
    const first = mount(fake, { mode: 'split' })
    fireEvent.click(capture('grok'))
    expect(capture('grok')).toBeChecked()
    await waitFor(() => expect(capture('grok')).not.toBeChecked())
    first.unmount()
    renderWithStore(<PaneDeck api={{}} />, { preloaded: { panes: panes() } })
    fireEvent.click(capture('claude'))
    expect(capture('claude')).toBeChecked()
  })

  test('the notice shows the terms-of-service wording until all three switches have been touched once, and remembers that in localStorage', () => {
    const fake = fakeTriplex()
    const { unmount } = mount(fake, { mode: 'split' })
    const notice = screen.getByTestId('capture-notice')
    expect(notice).toHaveTextContent(CAPTURE_NOTICE_TEXT)
    expect(notice).toHaveTextContent(/terms of service/)
    expect(notice).toHaveTextContent(/programmatically extract/)
    expect(notice).toHaveTextContent(/automated or non-human means/)
    // the notice sits above the panes in the flow (never over a view)
    expect(screen.getByTestId('pane-deck').children[1]).toBe(notice)
    fireEvent.click(capture('claude'))
    expect(screen.getByTestId('capture-notice')).toBeInTheDocument()
    fireEvent.click(capture('chatgpt'))
    fireEvent.click(capture('chatgpt')) // touching the same switch twice does not count for another
    expect(screen.getByTestId('capture-notice')).toBeInTheDocument()
    fireEvent.click(capture('grok'))
    expect(screen.queryByTestId('capture-notice')).toBeNull()
    expect(JSON.parse(localStorage.getItem(CAPTURE_NOTICE_KEY))).toEqual({ claude: true, chatgpt: true, grok: true })
    unmount()
    mount(fakeTriplex(), { mode: 'split' })
    expect(screen.queryByTestId('capture-notice')).toBeNull()
  })

  test('a partial or invalid stored map keeps the notice; a bare true hides it; a throwing storage never breaks the deck', () => {
    localStorage.setItem(CAPTURE_NOTICE_KEY, JSON.stringify({ claude: true, grok: true }))
    const first = mount(fakeTriplex(), { mode: 'split' })
    expect(screen.getByTestId('capture-notice')).toBeInTheDocument()
    fireEvent.click(capture('chatgpt'))
    expect(screen.queryByTestId('capture-notice')).toBeNull()
    first.unmount()
    localStorage.setItem(CAPTURE_NOTICE_KEY, 'not json')
    const second = mount(fakeTriplex(), { mode: 'split' })
    expect(screen.getByTestId('capture-notice')).toBeInTheDocument()
    second.unmount()
    localStorage.setItem(CAPTURE_NOTICE_KEY, 'true')
    const third = mount(fakeTriplex(), { mode: 'split' })
    expect(screen.queryByTestId('capture-notice')).toBeNull()
    third.unmount()
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
      clear() {},
    })
    expect(() => mount(fakeTriplex(), { mode: 'split' })).not.toThrow()
    expect(() => fireEvent.click(capture('claude'))).not.toThrow()
    expect(screen.getByTestId('capture-notice')).toBeInTheDocument()
  })

  test('the switches are disabled while a send is in flight (main reads them at observe time)', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split', sending: true })
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(capture(slot)).toBeDisabled()
    fireEvent.click(capture('claude'))
    expect(fake.setCapture).not.toHaveBeenCalled()
    act(() => store.dispatch({ type: 'panes/sendResult', results: {} }))
    expect(capture('claude')).toBeEnabled()
  })

  test('pane-<slot>-phase renders the onTurn phase', () => {
    const fake = fakeTriplex()
    mount(fake, { mode: 'split' })
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      expect(screen.getByTestId(`pane-${slot}-phase`)).toHaveTextContent('')
      expect(screen.getByTestId(`pane-${slot}-phase`)).toHaveAttribute('data-phase', 'none')
    }
    act(() => fake.emit.turn({ slot: 'grok', phase: 'typing' }))
    expect(screen.getByTestId('pane-grok-phase')).toHaveTextContent('typing…')
    expect(screen.getByTestId('pane-grok-phase')).toHaveAttribute('data-phase', 'typing')
    act(() => fake.emit.turn({ slot: 'grok', phase: 'replying', code: undefined }))
    expect(screen.getByTestId('pane-grok-phase')).toHaveTextContent('replying…')
    act(() => fake.emit.turn({ slot: 'grok', phase: 'done' }))
    expect(screen.getByTestId('pane-grok-phase')).toHaveTextContent('done')
    act(() => fake.emit.turn({ slot: 'claude', phase: 'error', code: 'logged_out' }))
    expect(screen.getByTestId('pane-claude-phase')).toHaveTextContent('error')
    expect(screen.getByTestId('pane-claude-phase')).toHaveAttribute('data-phase', 'error')
    // unknown slots / non-string phases are ignored; an unknown phase word is shown verbatim
    act(() => fake.emit.turn({ slot: 'gemini', phase: 'typing' }))
    act(() => fake.emit.turn({ slot: 'chatgpt', phase: 7 }))
    expect(screen.getByTestId('pane-chatgpt-phase')).toHaveTextContent('')
    act(() => fake.emit.turn({ slot: 'chatgpt', phase: 'observing' }))
    expect(screen.getByTestId('pane-chatgpt-phase')).toHaveTextContent('observing')
  })

  test('the capture row is part of the header, above the viewport', () => {
    mount(fakeTriplex(), { mode: 'split' })
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      const pane = screen.getByTestId(`pane-${slot}`)
      expect(pane.firstElementChild.tagName).toBe('HEADER')
      expect(pane.firstElementChild.contains(capture(slot))).toBe(true)
      expect(pane.firstElementChild.contains(screen.getByTestId(`pane-${slot}-phase`))).toBe(true)
      expect(pane.lastElementChild).toBe(screen.getByTestId(`pane-${slot}-viewport`))
    }
  })
})
