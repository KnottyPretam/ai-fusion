// FROZEN after Stage 0 (integrator-owned; edited only by the integrator in stage pre-work).
// Desktop root: main.jsx renders this instead of App when the Electron preload exposes
// `window.triplex`. Pure layout, like App.jsx: the shell is imported by convention from
// features/desktop/index.jsx and owns its own slice, styling and tests.
// Stage 2 adds <aside className="desk-sidebar" data-testid="sidebar"><Sidebar /></aside>
// before <main> (the unchanged features/conversations sidebar).
import { StoreProvider } from './state/store.jsx'
import DesktopShell from './features/desktop/index.jsx'
import './DesktopApp.css'

export default function DesktopApp() {
  return (
    <StoreProvider>
      <div className="desk">
        <main className="desk-main">
          <DesktopShell />
        </main>
      </div>
    </StoreProvider>
  )
}
