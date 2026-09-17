// FROZEN after Stage 0 (integrator-owned; edited only by the integrator in stage pre-work).
// Desktop root: main.jsx renders this instead of App when the Electron preload exposes
// `window.triplex`. Pure layout, like App.jsx: the shell is imported by convention from
// features/desktop/index.jsx and owns its own slice, styling and tests.
// Stage 2 (integrator pre-work): the unchanged features/conversations sidebar sits in
// <aside className="desk-sidebar" data-testid="sidebar"> before <main>.
import { StoreProvider } from './state/store.jsx'
import Sidebar from './features/conversations/index.jsx'
import DesktopShell from './features/desktop/index.jsx'
import './DesktopApp.css'

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
