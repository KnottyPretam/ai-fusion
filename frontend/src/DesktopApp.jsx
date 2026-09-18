// FROZEN after Stage 0 (integrator-owned; edited only by the integrator in stage pre-work).
// Desktop root: main.jsx renders this instead of App when the Electron preload exposes
// `window.triplex`. Pure layout, like App.jsx: the shell is imported by convention from
// features/desktop/index.jsx and owns its own slice, styling and tests.
// Stage 2 (integrator pre-work): the unchanged features/conversations sidebar sits in
// <aside className="desk-sidebar" data-testid="sidebar"> before <main>.
// Theme (integrator, S7): the palette in index.css switches on `data-theme` on <html>. The desktop
// shell defaults to DARK and remembers an explicit choice; the site views follow separately through
// Electron's nativeTheme, so ChatGPT / Claude / Grok use their own dark themes and Triplex never
// injects CSS into a page it does not own. A theme button in the deck replaces this default later.
import { StoreProvider } from './state/store.jsx'
import Sidebar from './features/conversations/index.jsx'
import DesktopShell from './features/desktop/index.jsx'
import { applyThemeAttr, loadTheme } from './features/desktop/theme.js'
import './DesktopApp.css'

// First paint only. main.jsx imports this module unconditionally (the `window.triplex` test there
// picks the component, it does not gate the import), so this side effect MUST check for the desktop
// itself: in a browser there is no theme control to get back from, and stamping `data-theme` would
// override `prefers-color-scheme` for a web user who never asked for it.
// `settings.json.theme` in main stays authoritative — `useTheme` adopts `getInfo()`/`onTheme` and
// corrects whatever this painted. The helpers are imported, not re-implemented, so the rule lives
// in one place (features/desktop/theme.js).
if (typeof window !== 'undefined' && window.triplex) applyThemeAttr(loadTheme())

export default function DesktopApp() {
  return (
    <StoreProvider>
      <div className="desk">
        <aside className="desk-sidebar" data-testid="sidebar">
          <Sidebar />
        </aside>
        <main className="desk-main">
          <DesktopShell />
        </main>
      </div>
    </StoreProvider>
  )
}
