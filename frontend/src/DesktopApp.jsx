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
import './DesktopApp.css'

const THEME_KEY = 'triplex.theme'

function applyTheme() {
  if (typeof document === 'undefined') return
  let stored = null
  try {
    stored = window.localStorage.getItem(THEME_KEY)
  } catch (_e) {
    /* private window / blocked storage: fall back to the default */
  }
  const theme = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark'
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
applyTheme()

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
