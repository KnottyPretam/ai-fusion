import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import DesktopShell from './index.jsx'
import { PERSIST_KEYS } from './slice.js'
import { renderWithStore } from '../../state/testing.jsx'
import { RECTS, fakeTriplex, health, installFakeResizeObserver, pinViewportRects, syncFrames } from './fakes.js'

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
    for (const id of ['desktop-shell', 'pane-deck', 'prompt-bar', 'deck-mode-tabs', 'deck-mode-split', 'prompt-composer', 'prompt-send', 'prompt-newchat']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    for (const slot of ['claude', 'chatgpt', 'grok']) {
      for (const suffix of ['', '-viewport', '-health', '-session', '-reload', '-newchat', '-open', '-zoom-in', '-zoom-out', '-zoom-reset']) {
        expect(screen.getByTestId(`pane-${slot}${suffix}`)).toBeInTheDocument()
      }
      expect(screen.getByTestId(`deck-tab-${slot}`)).toBeInTheDocument()
      expect(screen.getByTestId(`prompt-target-${slot}`)).toBeInTheDocument()
    }
    expect(fake.getInfo).toHaveBeenCalledTimes(1)
    expect(fake.getInfo).toHaveBeenCalledWith()
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

  test('a send whose result is logged_out reveals the pane, and its header shows the session once health arrives', async () => {
    const fake = fakeTriplex({
      sendPrompt: vi.fn(async () => ({ results: { claude: { ok: false, code: 'logged_out', ms: 0 }, chatgpt: { ok: true, ms: 900, composerSelector: '#prompt-textarea' }, grok: { ok: true, ms: 1000 } } })),
    })
    mount(fake)
    fireEvent.click(screen.getByTestId('deck-mode-tabs'))
    expect(screen.getByTestId('deck-tab-chatgpt')).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByTestId('prompt-composer'), { target: { value: 'hi' } })
    fireEvent.keyDown(screen.getByTestId('prompt-composer'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('deck-tab-claude')).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByTestId('pane-claude')).toBeVisible()
    expect(screen.getByTestId('pane-chatgpt')).not.toBeVisible()
    expect(screen.getByTestId('prompt-result-claude')).toHaveTextContent('✗ logged_out')
    expect(screen.getByTestId('prompt-result-chatgpt')).toHaveTextContent('✓ 0.9 s · #prompt-textarea')
    act(() => fake.emit.health('claude', health({ session: 'logged_out', composer: false, send: false })))
    expect(screen.getByTestId('pane-claude-session')).toHaveTextContent('SIGN IN')
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
