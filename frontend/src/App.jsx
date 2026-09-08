// FROZEN after Stage 0. Pure layout: each pane is imported by convention from
// src/features/<x>/index.jsx and owns its own state slice, styling and tests.
import { StoreProvider } from './state/store.jsx'
import Sidebar from './features/conversations/index.jsx'
import SlotConfigBar from './features/config/index.jsx'
import SendPane from './features/send/index.jsx'
import AnalyzePane from './features/analyze/index.jsx'
import FusionPane from './features/fusion/index.jsx'
import CostMeter from './features/meter/index.jsx'
import './App.css'

export default function App() {
  return (
    <StoreProvider>
      <div className="app">
        <aside className="app-sidebar" data-testid="sidebar">
          <Sidebar />
        </aside>
        <main className="app-main">
          <header className="app-config" data-testid="config-bar">
            <SlotConfigBar />
          </header>
          <section className="app-send" data-testid="send-pane">
            <SendPane />
          </section>
          <section className="app-analyze" data-testid="analyze-pane">
            <AnalyzePane />
          </section>
          <section className="app-fusion" data-testid="fusion-pane">
            <FusionPane />
          </section>
          <footer className="app-meter" data-testid="cost-meter">
            <CostMeter />
          </footer>
        </main>
      </div>
    </StoreProvider>
  )
}
