// DesktopShell (renderer-desktop Stage 1, renderer-desktop-2 Stage 2). Registers the `panes` slice
// at module scope and exports the shell that DesktopApp.jsx imports by convention: PaneDeck (deck
// bar + first-run capture notice + three panes, the layout reporter) above PromptBar (the unified
// prompt, a Triplex Send from Stage 2). Test ids desktop-shell / pane-deck / prompt-bar are the
// Stage 0 ones (contract §7; desktop-smoke.test.jsx mounts this with a stub).
//
// `window.triplex` is the contextBridge surface of desktop/preload/renderer.cjs. Every call is
// optional-chained: the shell must render under a partial stub (tests) and under the web app,
// where the object is absent altogether. `getInfo()` supplies the version line and `dev` (the
// Inspect buttons). The renderer owns the persisted layout keys (`triplex.panes.mode|active|
// targets`, contract §5): the slice starts from localStorage and every change is written back.
// Stage 2: ONE ./chats.js instance per shell keeps the panes on the open conversation's chats
// (`openChats(id)` on every id change) and implements "New chat everywhere", shared by the
// prompt-bar button and the Ctrl+Shift+N shortcut handled in PaneDeck.
import { useEffect, useRef, useState } from 'react'
import { registerSlice } from '../../state/registry.js'
import { useSlice } from '../../state/store.jsx'
import { useOpenChats } from './chats.js'
import PaneDeck, { desktopApi } from './PaneDeck.jsx'
import PromptBar from './PromptBar.jsx'
import { initialPanes, loadPersistedPanes, panesReducer, persistPanes } from './slice.js'
import css from './desktop.module.css'

registerSlice('panes', panesReducer, () => initialPanes(loadPersistedPanes()))

export default function DesktopShell() {
  const api = desktopApi()
  const panes = useSlice('panes')
  const [info, setInfo] = useState(null)
  const promptRef = useRef(null)
  const chats = useOpenChats(api)

  useEffect(() => {
    if (!api || typeof api.getInfo !== 'function') return undefined
    let alive = true
    let reply
    try {
      reply = api.getInfo()
    } catch {
      return undefined
    }
    Promise.resolve(reply)
      .then((result) => {
        if (alive && result && typeof result === 'object') setInfo(result)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [api])

  const mode = panes ? panes.mode : undefined
  const active = panes ? panes.active : undefined
  const targets = panes ? panes.targets : undefined
  useEffect(() => {
    if (panes) persistPanes(undefined, panes)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the persisted keys matter
  }, [mode, active, targets])

  const version = (info && info.version) || (api && api.version) || null

  return (
    <div className={css.shell} data-testid="desktop-shell">
      <PaneDeck api={api} info={info} version={version} promptRef={promptRef} onNewChatAll={chats.newChatEverywhere} />
      <PromptBar api={api} composerRef={promptRef} chats={chats} />
    </div>
  )
}
