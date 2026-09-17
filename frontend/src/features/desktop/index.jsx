// Stage 0 placeholder (integrator); renderer-desktop owns features/desktop/** from Stage 1 and
// replaces this shell with PaneDeck + PromptBar (docs/desktop-contract.md §7 test ids).
// Registers the `panes` slice at module scope and exports DesktopShell, which DesktopApp.jsx
// imports by convention from features/desktop/index.jsx.
//
// `window.triplex` is the contextBridge surface of desktop/preload/renderer.cjs. Every call is
// optional-chained: the shell must render under a partial stub (tests) and under the web app,
// where the object is absent altogether.
import { useEffect, useState } from 'react'
import { registerSlice } from '../../state/registry.js'
import { initialPanes, panesReducer } from './slice.js'

registerSlice('panes', panesReducer, initialPanes)

function desktopApi() {
  return typeof window !== 'undefined' && window.triplex ? window.triplex : null
}

export default function DesktopShell() {
  const [info, setInfo] = useState(null)

  useEffect(() => {
    const api = desktopApi()
    if (!api || typeof api.getInfo !== 'function') return undefined
    let alive = true
    Promise.resolve()
      .then(() => api.getInfo())
      .then((result) => {
        if (alive && result && typeof result === 'object') setInfo(result)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const api = desktopApi()
  const version = info?.version ?? api?.version ?? null
  const slots = Array.isArray(api?.slots) ? api.slots : []

  return (
    <div className="desktop-shell" data-testid="desktop-shell" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div data-testid="pane-deck" style={{ flex: 1, minHeight: 0, padding: 12 }}>
        <div>Triplex desktop — Stage 0 placeholder</div>
        {version ? <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>desktop v{version}{info?.dev ? ' (dev)' : ''}</div> : null}
        {slots.length ? <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>panes: {slots.join(', ')}</div> : null}
      </div>
      <div data-testid="prompt-bar" style={{ flex: '0 0 auto', borderTop: '1px solid var(--border)', padding: '6px 12px', color: 'var(--fg-muted)', fontSize: 12 }}>
        unified prompt bar (Stage 1)
      </div>
    </div>
  )
}
