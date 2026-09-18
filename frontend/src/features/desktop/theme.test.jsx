// theme.js + the `deck-theme` button in PaneDeck: the three-way cycle, the `data-theme` attribute
// on <html>, the localStorage mirror, `triplex.setTheme`, `triplex.onTheme` and `getInfo().theme`
// (main's settings.json is authoritative), a partial stub and the no-triplex browser fallback.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import './index.jsx' // registers the `panes` slice
import PaneDeck from './PaneDeck.jsx'
import { initialPanes } from './slice.js'
import { DEFAULT_THEME, THEME_KEY, applyThemeAttr, isTheme, loadTheme, nextTheme, persistTheme, themeLabel, themeTitle } from './theme.js'
import { renderWithStore } from '../../state/testing.jsx'
import { fakeTriplex, installFakeResizeObserver, pinViewportRects, syncFrames } from './fakes.js'

beforeEach(() => {
  localStorage.clear()
  syncFrames()
  installFakeResizeObserver()
  pinViewportRects()
  delete document.documentElement.dataset.theme
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

function mount(fake, info = null) {
  return renderWithStore(<PaneDeck api={fake} info={info} version="0.1.0" />, { preloaded: { panes: initialPanes() } })
}

const button = () => screen.getByTestId('deck-theme')
const attr = () => document.documentElement.dataset.theme
const stored = () => localStorage.getItem(THEME_KEY)

describe('theme.js: pure helpers', () => {
  test('isTheme / nextTheme cycle light → dark → system → light', () => {
    expect(['light', 'dark', 'system'].every(isTheme)).toBe(true)
    for (const bad of ['Dark', '', null, undefined, 1, {}]) expect(isTheme(bad)).toBe(false)
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
    expect(nextTheme('system')).toBe('light')
    // anything unknown is treated as the default ('dark') and moves on from there
    expect(nextTheme('nonsense')).toBe('system')
    expect(nextTheme(undefined)).toBe('system')
  })

  test('applyThemeAttr stamps light/dark and REMOVES the attribute for system (index.css media query)', () => {
    applyThemeAttr('light')
    expect(attr()).toBe('light')
    applyThemeAttr('dark')
    expect(attr()).toBe('dark')
    applyThemeAttr('system')
    expect(attr()).toBeUndefined()
    applyThemeAttr('bogus') // falls back to the default rather than leaving a stale attribute
    expect(attr()).toBe('dark')
    expect(() => applyThemeAttr('dark', null)).not.toThrow()
  })

  test('loadTheme / persistTheme: the mirror, with the default for anything invalid or unavailable', () => {
    expect(loadTheme()).toBe(DEFAULT_THEME)
    persistTheme(undefined, 'light')
    expect(stored()).toBe('light')
    expect(loadTheme()).toBe('light')
    persistTheme(undefined, 'nonsense')
    expect(stored()).toBe('light') // an invalid value is never written
    localStorage.setItem(THEME_KEY, 'chartreuse')
    expect(loadTheme()).toBe(DEFAULT_THEME)
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceeded')
      },
    }
    expect(loadTheme(broken)).toBe(DEFAULT_THEME)
    expect(() => persistTheme(broken, 'dark')).not.toThrow()
    expect(loadTheme(null)).toBe(DEFAULT_THEME)
  })

  test('label and title name the current theme and what one click does', () => {
    expect(themeLabel('dark')).toContain('Dark')
    expect(themeLabel('system')).toContain('System')
    expect(themeTitle('light')).toBe('Theme: Light — click for Dark')
    expect(themeTitle('system')).toBe('Theme: System (follows the desktop) — click for Light')
  })
})

describe('deck-theme button', () => {
  test('defaults to dark, cycles light → dark → system, applies the attribute, mirrors and calls setTheme', () => {
    const fake = fakeTriplex()
    mount(fake)
    expect(button()).toHaveAttribute('data-theme', 'dark')
    expect(button()).toHaveTextContent('Dark')
    expect(attr()).toBe('dark')
    expect(stored()).toBe('dark')

    fireEvent.click(button()) // dark → system
    expect(button()).toHaveAttribute('data-theme', 'system')
    expect(attr()).toBeUndefined()
    expect(stored()).toBe('system')
    expect(fake.setTheme).toHaveBeenLastCalledWith('system')

    fireEvent.click(button()) // system → light
    expect(button()).toHaveAttribute('data-theme', 'light')
    expect(attr()).toBe('light')
    expect(stored()).toBe('light')
    expect(fake.setTheme).toHaveBeenLastCalledWith('light')

    fireEvent.click(button()) // light → dark
    expect(button()).toHaveAttribute('data-theme', 'dark')
    expect(attr()).toBe('dark')
    expect(fake.setTheme).toHaveBeenLastCalledWith('dark')
    expect(fake.setTheme.mock.calls.map(([t]) => t)).toEqual(['system', 'light', 'dark'])
  })

  test('the label, title and aria-label name the state and the next click', () => {
    const fake = fakeTriplex()
    mount(fake)
    expect(button()).toHaveAttribute('title', 'Theme: Dark — click for System')
    expect(button()).toHaveAttribute('aria-label', 'Theme: Dark — click for System')
    fireEvent.click(button())
    expect(button()).toHaveAttribute('aria-label', 'Theme: System (follows the desktop) — click for Light')
    expect(button()).toHaveTextContent('System')
  })

  test('starts from the localStorage mirror when main has not answered yet (no flash of the wrong theme)', () => {
    localStorage.setItem(THEME_KEY, 'light')
    mount(fakeTriplex())
    expect(button()).toHaveAttribute('data-theme', 'light')
    expect(attr()).toBe('light')
  })

  test("getInfo()'s theme wins over the mirror: main's settings.json is authoritative", () => {
    localStorage.setItem(THEME_KEY, 'light')
    const fake = fakeTriplex()
    mount(fake, { dev: true, theme: 'system' })
    expect(button()).toHaveAttribute('data-theme', 'system')
    expect(attr()).toBeUndefined()
    expect(stored()).toBe('system') // the mirror follows main
    expect(fake.setTheme).not.toHaveBeenCalled() // reporting is not proposing
  })

  test('onTheme mirrors a change made anywhere else (menu, another window, a second renderer)', () => {
    const fake = fakeTriplex()
    mount(fake)
    expect(attr()).toBe('dark')
    act(() => fake.emit.theme({ theme: 'light' }))
    expect(button()).toHaveAttribute('data-theme', 'light')
    expect(attr()).toBe('light')
    expect(stored()).toBe('light')
    expect(fake.setTheme).not.toHaveBeenCalled()
    act(() => fake.emit.theme({ theme: 'system' }))
    expect(attr()).toBeUndefined()
    // a malformed event changes nothing
    act(() => fake.emit.theme({ theme: 'chartreuse' }))
    act(() => fake.emit.theme(null))
    expect(button()).toHaveAttribute('data-theme', 'system')
  })

  test('the onTheme subscription is released on unmount', () => {
    const fake = fakeTriplex()
    const view = mount(fake)
    expect(fake.onTheme).toHaveBeenCalled()
    view.unmount()
    expect(fake.unsubscribed.theme).toBeGreaterThan(0)
  })

  test('a rejected setTheme leaves the local choice in place (the UI stays up)', async () => {
    const fake = fakeTriplex({ setTheme: vi.fn(async () => Promise.reject(new Error('bad_request'))) })
    mount(fake)
    fireEvent.click(button())
    await act(async () => {})
    expect(button()).toHaveAttribute('data-theme', 'system')
    expect(attr()).toBeUndefined()
  })

  test('a partial window.triplex stub (no setTheme / onTheme) still cycles and mirrors', () => {
    mount({ version: '0.1.0' })
    expect(button()).toHaveAttribute('data-theme', 'dark')
    fireEvent.click(button())
    expect(button()).toHaveAttribute('data-theme', 'system')
    expect(stored()).toBe('system')
  })

  test('the browser fallback (no triplex at all): localStorage is the only source', () => {
    localStorage.setItem(THEME_KEY, 'light')
    mount(null)
    expect(button()).toHaveAttribute('data-theme', 'light')
    expect(attr()).toBe('light')
    fireEvent.click(button())
    expect(button()).toHaveAttribute('data-theme', 'dark')
    expect(attr()).toBe('dark')
    expect(stored()).toBe('dark')
  })
})
