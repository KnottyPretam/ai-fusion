// theme.js (renderer-desktop) — the three-way theme control behind `deck-theme`.
//
// ONE SOURCE OF TRUTH. In the desktop app main's `settings.json` owns the theme: the deck button
// calls `triplex.setTheme(theme)`, main persists it, applies `nativeTheme.themeSource` (so the three
// SITE pages switch to their OWN dark themes — Triplex never injects CSS into a page it does not
// own) and reports it back on `panes:theme`; `getInfo().theme` carries the same value on mount and
// main replays `panes:theme` on did-finish-load. So the renderer APPLIES what main reports and only
// ever proposes a change. The `triplex.theme` localStorage entry is a MIRROR, not a source: it is
// read once at module scope by DesktopApp.jsx so the very first paint is not a flash of the wrong
// theme, and rewritten here after every change. Without `window.triplex` (the web app, a partial
// stub in tests) the mirror is all there is, and the button still works locally.
//
// The palette itself is the frozen index.css: `:root` is light, `:root[data-theme='dark']` is dark
// and `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme='light'])` covers
// 'system'. Hence applyThemeAttr(): 'light'/'dark' stamp `data-theme` on <html>, 'system' REMOVES
// the attribute and lets the media query decide.
import { useCallback, useEffect, useRef, useState } from 'react'

export const THEME_KEY = 'triplex.theme'
/** The cycle order of the button: light → dark → system → light. */
export const THEMES = ['light', 'dark', 'system']
/** The desktop shell's default, same as `DEFAULT_THEME` in desktop/main/settings.js. */
export const DEFAULT_THEME = 'dark'
export const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' }
export const THEME_GLYPHS = { light: '☀', dark: '☾', system: '◐' }

export function isTheme(x) {
  return THEMES.includes(x)
}

/** The next choice in the cycle; anything unknown is treated as the default. */
export function nextTheme(theme) {
  const i = THEMES.indexOf(isTheme(theme) ? theme : DEFAULT_THEME)
  return THEMES[(i + 1) % THEMES.length]
}

/** Button text: "☾ Dark". */
export function themeLabel(theme) {
  const t = isTheme(theme) ? theme : DEFAULT_THEME
  return `${THEME_GLYPHS[t]} ${THEME_LABELS[t]}`
}

/** Title / aria-label: what the theme is now and what one click does. */
export function themeTitle(theme) {
  const t = isTheme(theme) ? theme : DEFAULT_THEME
  const next = nextTheme(t)
  const what = t === 'system' ? 'Theme: System (follows the desktop)' : `Theme: ${THEME_LABELS[t]}`
  return `${what} — click for ${THEME_LABELS[next]}`
}

/**
 * Paint the choice on <html> at once: 'light'/'dark' stamp `data-theme`, 'system' removes it so
 * `prefers-color-scheme` decides again. Never throws (no document in a non-DOM test).
 */
export function applyThemeAttr(theme, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.documentElement) return
  const t = isTheme(theme) ? theme : DEFAULT_THEME
  try {
    if (t === 'system') delete doc.documentElement.dataset.theme
    else doc.documentElement.dataset.theme = t
  } catch {
    /* a detached document: the in-memory state is still right */
  }
}

function defaultStorage() {
  // Bare `localStorage`: the access itself can throw when site data is blocked.
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null
  } catch {
    return null
  }
}

/** The mirrored choice, or the default when nothing valid is stored. Never throws. */
export function loadTheme(storage = defaultStorage()) {
  if (!storage) return DEFAULT_THEME
  try {
    const raw = storage.getItem(THEME_KEY)
    return isTheme(raw) ? raw : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Write the mirror; never throws. */
export function persistTheme(storage = defaultStorage(), theme) {
  if (!storage || !isTheme(theme)) return
  try {
    storage.setItem(THEME_KEY, theme)
  } catch {
    /* quota / private mode: the in-memory state is still right */
  }
}

/**
 * useTheme(api, info) → [theme, cycle]
 *   - starts from the localStorage mirror (what DesktopApp.jsx already painted);
 *   - adopts `info.theme` (the `getInfo()` reply DesktopShell holds) and every `onTheme` event,
 *     because main's settings.json is authoritative;
 *   - `cycle()` moves to the next theme, paints it, mirrors it and proposes it to main.
 * Every `window.triplex` call is optional-chained: the button works under a partial stub and in
 * the browser, where it is a local-only toggle.
 */
export function useTheme(api, info) {
  const [theme, setTheme] = useState(() => loadTheme())
  const latest = useRef(theme)
  latest.current = theme

  useEffect(() => {
    applyThemeAttr(theme)
    persistTheme(undefined, theme)
  }, [theme])

  // main is authoritative: the getInfo reply and every later change it announces win.
  const reported = info && typeof info === 'object' ? info.theme : null
  useEffect(() => {
    if (isTheme(reported)) setTheme(reported)
  }, [reported])

  useEffect(() => {
    const off = api?.onTheme?.((msg) => {
      const t = msg && typeof msg === 'object' ? msg.theme : msg
      if (isTheme(t)) setTheme(t)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api])

  const cycle = useCallback(() => {
    const next = nextTheme(latest.current)
    latest.current = next
    applyThemeAttr(next) // before the re-render: no frame in the old palette
    setTheme(next)
    // Optimistic, like the capture switch: main echoes `panes:theme` and would correct us.
    Promise.resolve(api?.setTheme?.(next)).catch(() => {})
  }, [api])

  return [theme, cycle]
}
