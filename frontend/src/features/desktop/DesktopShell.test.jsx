import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import DesktopShell from './index.jsx'
import { CAPTURE_NOTICE_KEY, PERSIST_KEYS } from './slice.js'
import { renderWithStore, sample } from '../../state/testing.jsx'
import { RECTS, conv, fakeTriplex, health, installFakeResizeObserver, jsonResponse, pinViewportRects, seqOf, sseResponse, stubFetch, syncFrames } from './fakes.js'

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

function mount(fake = fakeTriplex()) {
  vi.stubGlobal('triplex', fake)
  const utils = renderWithStore(<DesktopShell />)
  return { fake, ...utils }
}

describe('DesktopShell: composition', () => {
  test('keeps the Stage 0 test ids, shows the version from getInfo and the Inspect buttons when dev', async () => {
    const { fake } = mount()
    for (const id of ['desktop-shell', 'pane-deck', 'prompt-bar', 'deck-mode-tabs', 'deck-mode-split', 'prompt-composer', 'prompt-send', 'prompt-newchat', 'capture-notice', 'bridge-banner']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      for (const suffix of ['', '-viewport', '-health', '-session', '-reload', '-newchat', '-open', '-zoom-in', '-zoom-out', '-zoom-reset', '-capture', '-phase']) {
        expect(screen.getByTestId(`pane-${slot}${suffix}`)).toBeInTheDocument()
      }
      expect(screen.getByTestId(`deck-tab-${slot}`)).toBeInTheDocument()
      expect(screen.getByTestId(`prompt-target-${slot}`)).toBeInTheDocument()
    }
    expect(fake.getInfo).toHaveBeenCalledTimes(1)
    expect(fake.getInfo).toHaveBeenCalledWith()
    expect(fake.getCapture).toHaveBeenCalledTimes(1)
    // every channel is subscribed exactly once across the composed shell
    for (const ch of ['onHealth', 'onShortcut', 'onZoom', 'onBridge', 'onTurn']) expect(fake[ch]).toHaveBeenCalledTimes(1)
    // the first render never renavigates the panes
    expect(fake.openChats).not.toHaveBeenCalled()
    expect(await screen.findByText('desktop v0.1.0 (dev)')).toBeInTheDocument()
    expect(screen.getByTestId('pane-claude-inspect')).toBeInTheDocument()
    // the frozen smoke test's assertion text is still present (once) but visually hidden
    // the layout and active state reached main
    expect(fake.setLayout.mock.calls.at(-1)[0]).toEqual(RECTS)
    expect(fake.setActive).toHaveBeenLastCalledWith({ mode: 'split', active: 'chatgpt' })
  })

  test('renders under a partial stub and without window.triplex (web app)', () => {
    vi.stubGlobal('triplex', {})
    expect(() => renderWithStore(<DesktopShell />)).not.toThrow()
    expect(screen.getByTestId('desktop-shell')).toBeInTheDocument()
    expect(screen.queryByText(/desktop v/)).toBeNull()
    expect(screen.queryByTestId('pane-claude-inspect')).toBeNull()
    vi.unstubAllGlobals()
    delete window.triplex
    const { unmount } = renderWithStore(<DesktopShell />)
    expect(screen.getAllByTestId('desktop-shell').length).toBe(2)
    unmount()
  })

  test('a non-dev getInfo hides Inspect; a rejected getInfo falls back to the preload version', async () => {
    const { unmount } = mount(fakeTriplex({ getInfo: vi.fn(async () => ({ version: '9.9.9', dev: false, sites: {}, backend: null, layout: null })) }))
    expect(await screen.findByText('desktop v9.9.9')).toBeInTheDocument()
    expect(screen.queryByTestId('pane-claude-inspect')).toBeNull()
    unmount()
    vi.unstubAllGlobals()
    mount(fakeTriplex({ getInfo: vi.fn(async () => { throw new Error('nope') }) }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('desktop v0.1.0')).toBeInTheDocument()
  })

  test('the prompt bar sits below the deck; chrome order is deck bar, panes, prompt bar', () => {
    mount()
    const shell = screen.getByTestId('desktop-shell')
    const deck = screen.getByTestId('pane-deck')
    const bar = screen.getByTestId('prompt-bar')
    expect(shell.firstElementChild).toBe(deck)
    expect(deck.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // header above viewport inside every pane
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      const pane = screen.getByTestId(`pane-${slot}`)
      expect(pane.lastElementChild).toBe(screen.getByTestId(`pane-${slot}-viewport`))
      expect(pane.firstElementChild.tagName).toBe('HEADER')
    }
  })
})

describe('DesktopShell: shortcuts through the composed shell', () => {
  test('focus-prompt focuses the composer; tab-2 and toggle-mode drive the deck', () => {
    const { fake } = mount()
    expect(document.activeElement).not.toBe(screen.getByTestId('prompt-composer'))
    act(() => fake.emit.shortcut('focus-prompt'))
    expect(document.activeElement).toBe(screen.getByTestId('prompt-composer'))
    act(() => fake.emit.shortcut('toggle-mode'))
    expect(screen.getByTestId('deck-mode-tabs')).toHaveAttribute('aria-pressed', 'true')
    act(() => fake.emit.shortcut('tab-2'))
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('aria-selected', 'true')
    act(() => fake.emit.shortcut('tab-1'))
    expect(screen.getByTestId('deck-tab-claude')).toHaveAttribute('aria-selected', 'true')
    expect(fake.setLayout.mock.calls.at(-1)[0]).toEqual({ claude: RECTS.claude, chatgpt: null, grok: null })
  })

  test('a Send whose grok slot is rejected logged_out reveals that pane in tabs mode; the header shows the session once health arrives', async () => {
    const stream = [
      sample.turnStart('t1'),
      sample.slotStart('claude', 'web:claude', 'off'),
      sample.slotStart('chatgpt', 'web:chatgpt', 'off'),
      sample.slotStart('grok', 'web:grok', 'off'),
      sample.slotDone('claude', { latency_ms: 900 }),
      sample.slotDone('chatgpt', { latency_ms: 1000 }),
      { type: 'slot_error', slot: 'grok', code: 'logged_out', error_type: 'site', message: 'grok is signed out; sign in from the pane', partial: '' },
      sample.turnDone('t1'),
    ]
    const calls = stubFetch([
      { method: 'POST', url: '/api/conversations', respond: jsonResponse(conv(), 201) },
      { method: 'POST', url: '/api/conversations/c1/send', respond: () => sseResponse(stream) },
      { method: 'GET', url: '/api/conversations/c1', respond: jsonResponse(conv()) },
      { method: 'GET', url: '/api/conversations', respond: jsonResponse([]) },
    ])
    const { fake } = mount()
    fireEvent.click(screen.getByTestId('deck-mode-tabs'))
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hi' } })
    fireEvent.keyDown(screen.getByTestId('prompt-composer'), { key: 'Enter' })
    await waitFor(() => expect(seqOf(calls)).toEqual(['POST /api/conversations', 'POST /api/conversations/c1/send', 'GET /api/conversations/c1', 'GET /api/conversations']))
    expect(calls[1].body).toEqual({ prompt: 'hi' })
    await waitFor(() => expect(screen.getByTestId('deck-tab-grok')).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByTestId('pane-grok')).toBeVisible()
    expect(screen.getByTestId('pane-chatgpt')).not.toBeVisible()
    expect(screen.getByTestId('prompt-result-grok')).toHaveTextContent('✗ logged_out')
    expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent('sent ✓ captured · 0.9 s')
    // the conversation created by the first Send is what the panes are pointed at, once
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c1'))
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    act(() => fake.emit.health('grok', health({ session: 'logged_out', composer: false, send: false })))
    expect(screen.getByTestId('pane-grok-session')).toHaveTextContent('SIGN IN')
    await waitFor(() => expect(screen.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'false'))
  })

  test('Ctrl+Shift+N (new-chat-all) through the shell creates a conversation and opens its chats exactly once, like the button', async () => {
    stubFetch([{ method: 'POST', url: '/api/conversations', respond: jsonResponse(conv({ id: 'c9' }), 201) }])
    const { fake } = mount()
    act(() => fake.emit.shortcut('new-chat-all'))
    await waitFor(() => expect(fake.openChats).toHaveBeenCalledWith('c9'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(fake.openChats).toHaveBeenCalledTimes(1)
    expect(fake.newChat).not.toHaveBeenCalled()
  })

  test('the bridge banner and the turn phase reach the shell from the preload channels; unmount unsubscribes every channel', () => {
    const { fake, unmount } = mount()
    expect(screen.getByTestId('bridge-banner')).toBeInTheDocument()
    act(() => fake.emit.bridge({ connected: true, since: 1 }))
    expect(screen.queryByTestId('bridge-banner')).toBeNull()
    act(() => fake.emit.turn({ slot: 'claude', phase: 'replying' }))
    expect(screen.getByTestId('pane-claude-phase')).toHaveTextContent('replying…')
    unmount()
    expect(fake.unsubscribed).toEqual({ health: 1, shortcut: 1, zoom: 1, bridge: 1, turn: 1 })
  })
})

describe('DesktopShell: localStorage persistence', () => {
  test('restores mode / active / targets from the renderer-owned keys on mount', () => {
    localStorage.setItem(PERSIST_KEYS.mode, 'tabs')
    localStorage.setItem(PERSIST_KEYS.active, 'grok')
    localStorage.setItem(PERSIST_KEYS.targets, JSON.stringify({ claude: false, chatgpt: true, grok: true }))
    const { fake } = mount()
    expect(screen.getByTestId('deck-mode-tabs')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('deck-tab-grok')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('prompt-target-claude')).not.toBeChecked()
    expect(screen.getByTestId('prompt-target-chatgpt')).toBeChecked()
    // the very first layout report already reflects the restored state (no split flash)
    expect(fake.setLayout.mock.calls[0][0]).toEqual({ claude: null, chatgpt: null, grok: RECTS.grok })
    expect(fake.setActive.mock.calls[0][0]).toEqual({ mode: 'tabs', active: 'grok' })
  })

  test('writes every change back', () => {
    mount()
    expect(localStorage.getItem(PERSIST_KEYS.mode)).toBe('split')
    expect(localStorage.getItem(PERSIST_KEYS.active)).toBe('chatgpt')
    fireEvent.click(screen.getByTestId('deck-mode-tabs'))
    expect(localStorage.getItem(PERSIST_KEYS.mode)).toBe('tabs')
    fireEvent.click(screen.getByTestId('deck-tab-claude'))
    expect(localStorage.getItem(PERSIST_KEYS.active)).toBe('claude')
    fireEvent.click(screen.getByTestId('prompt-target-grok'))
    expect(JSON.parse(localStorage.getItem(PERSIST_KEYS.targets))).toEqual({ claude: true, chatgpt: true, grok: false })
    fireEvent.click(screen.getByTestId('pane-claude-capture'))
    expect(JSON.parse(localStorage.getItem(CAPTURE_NOTICE_KEY))).toEqual({ claude: true, chatgpt: false, grok: false })
  })

  test('invalid stored values fall back to the defaults', () => {
    localStorage.setItem(PERSIST_KEYS.mode, 'cinema')
    localStorage.setItem(PERSIST_KEYS.active, 'gemini')
    localStorage.setItem(PERSIST_KEYS.targets, 'not json')
    mount()
    expect(screen.getByTestId('deck-mode-split')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('aria-selected', 'true')
    for (const slot of ['claude', 'chatgpt', 'grok']) expect(screen.getByTestId(`prompt-target-${slot}`)).toBeChecked()
  })

  test('a localStorage that throws never breaks the shell', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
      clear() {},
    })
    const fake = fakeTriplex()
    vi.stubGlobal('triplex', fake)
    expect(() => renderWithStore(<DesktopShell />)).not.toThrow()
    expect(() => fireEvent.click(screen.getByTestId('deck-mode-tabs'))).not.toThrow()
    expect(screen.getByTestId('deck-mode-tabs')).toHaveAttribute('aria-pressed', 'true')
  })
})
