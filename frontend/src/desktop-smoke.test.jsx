// Mirrors smoke.test.jsx for the desktop root: with `window.triplex` stubbed the way the Electron
// preload (desktop/preload/renderer.cjs) exposes it, DesktopApp renders the shell; the web App
// still renders its six regions in the same process, so both roots coexist (main.jsx switches).
import { render, screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import App from './App.jsx'
import DesktopApp from './DesktopApp.jsx'
import { hasSlice, initialState } from './state/registry.js'

function fakeTriplex() {
  return {
    version: '0.0.0',
    slots: ['claude', 'chatgpt', 'grok'],
    getInfo: async () => ({ version: '0.0.0', dev: true, sites: {}, backend: null, layout: null }),
    setLayout() {},
    setActive() {},
    onHealth() {
      return () => {}
    },
    onShortcut() {
      return () => {}
    },
    onZoom() {
      return () => {}
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

test('desktop app renders the shell, the pane deck and the prompt bar', async () => {
  vi.stubGlobal('triplex', fakeTriplex())
  render(<DesktopApp />)
  for (const id of ['desktop-shell', 'pane-deck', 'prompt-bar']) {
    expect(screen.getByTestId(id)).toBeInTheDocument()
  }
  // getInfo() resolved in the effect and its version string is shown.
  expect(await screen.findByText(/desktop v0\.0\.0/)).toBeInTheDocument()
})

test('desktop app renders under a partial window.triplex stub', () => {
  vi.stubGlobal('triplex', {})
  render(<DesktopApp />)
  expect(screen.getByTestId('desktop-shell')).toBeInTheDocument()
  expect(screen.getByTestId('pane-deck')).toBeInTheDocument()
  expect(screen.getByTestId('prompt-bar')).toBeInTheDocument()
})

test('desktop shell registers the panes slice with the contract shape', () => {
  expect(hasSlice('panes')).toBe(true)
  const panes = initialState().panes
  expect(panes.mode).toBe('split')
  expect(panes.active).toBe('chatgpt')
  expect(panes.targets).toEqual({ claude: true, chatgpt: true, grok: true })
  expect(panes.health).toEqual({ claude: null, chatgpt: null, grok: null })
  expect(panes.lastSend).toEqual({})
  expect(panes.sending).toBe(false)
  expect(panes.zoom).toEqual({ claude: 1, chatgpt: 1, grok: 1 })
  expect(panes.capture).toEqual({ claude: false, chatgpt: false, grok: false })
  expect(panes.bridge).toEqual({ connected: false })
  expect(panes.turn).toEqual({})
  expect(panes.drawerOpen).toBe(false)
  expect(panes.analyst).toEqual({ slot: null, visible: false, health: null })
})

test('web app still renders the six pane slots alongside the desktop root', () => {
  render(<App />)
  for (const id of ['sidebar', 'config-bar', 'send-pane', 'analyze-pane', 'fusion-pane', 'cost-meter']) {
    expect(screen.getByTestId(id)).toBeInTheDocument()
  }
})
