// DesktopShell (renderer-desktop Stage 1, renderer-desktop-2 Stage 2, renderer-drawer Stage 3).
// Registers the `panes` slice at module scope and exports the shell that DesktopApp.jsx imports by
// convention: PaneDeck (deck bar + first-run capture notice + one pane per council member + the analyst pane, the
// layout reporter) above PromptBar (the unified prompt, a Triplex Send from Stage 2) above Drawer
// (Stage 3: Analyze / Fusion / Captured / Settings, collapsible; when open the deck shrinks and the
// viewports re-report, so the drawer never overlaps a view rect). Test ids desktop-shell /
// pane-deck / prompt-bar are the Stage 0 ones (contract §7; desktop-smoke.test.jsx mounts this
// with a stub); `drawerOpen` is persisted with the other renderer-owned keys.
//
// `window.triplex` is the contextBridge surface of desktop/preload/renderer.cjs. Every call is
// optional-chained: the shell must render under a partial stub (tests) and under the web app,
// where the object is absent altogether. `getInfo()` supplies the version line and `dev` (the
// Inspect buttons). The renderer owns the persisted layout keys (`triplex.panes.mode|active|
// targets`, contract §5): the slice starts from localStorage and every change is written back.
// Stage 2: ONE ./chats.js instance per shell keeps the panes on the open conversation's chats
// (`openChats(id)` on every id change except the one a Send's own create produces, which the panes
// adopt — Decision 12) and implements "New chat everywhere", shared by the prompt-bar button and
// the Ctrl+Shift+N shortcut handled in PaneDeck. Pre-parse (2026-09-23): the `preparse` slice
// (./preparseSlice.js) is registered here beside `panes` — a slice of its own, so the frozen
// desktop-smoke.test.jsx (which checks `panes` sub-shapes only) never sees it.
// Council (2026-09-27): the shell reads main's default council (`getCouncil()` → `panes/council`)
// and the OpenRouter key status (`getOpenRouterKey()` → `panes/openRouterKey`) once per mount and
// follows `onCouncil` / `onOpenRouterKey` afterwards — main is the one owner of both; the renderer
// only mirrors. Every call is optional-chained and a rejection is swallowed (a partial stub, the
// web app). The model catalog follows the key: the desktop `GET /api/models` lists the OpenRouter
// entries only while a pushed session key exists, and every pane's loader is guarded by
// `models.loaded` (the frozen `loadModels` has no force path), so the shell is the one place that
// refetches it — through the frozen `api.listModels()` + `models/loaded` — whenever
// `catalogRefetchNeeded(prev, next)` says the key status changed the catalog (./council.js). A
// sequence counter lets only the latest refetch land; a loader already in flight when the push
// lands could still answer last with the no-key catalog (accepted: the next status change refetches).
import { useEffect, useRef, useState } from 'react'
import { api as http } from '../../api/http.js'
import { registerSlice } from '../../state/registry.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useOpenChats } from './chats.js'
import { catalogRefetchNeeded } from './council.js'
import Drawer from './Drawer.jsx'
import PaneDeck, { desktopApi } from './PaneDeck.jsx'
import { FEATURE as PREPARSE, initial as preparseInitial, reducer as preparseReducer } from './preparseSlice.js'
import PromptBar from './PromptBar.jsx'
import { initialPanes, loadPersistedPanes, panesReducer, persistPanes } from './slice.js'
import css from './desktop.module.css'

registerSlice('panes', panesReducer, () => initialPanes(loadPersistedPanes()))
registerSlice(PREPARSE, preparseReducer, preparseInitial)

export default function DesktopShell() {
  const api = desktopApi()
  const dispatch = useDispatch()
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
  const drawerOpen = panes ? panes.drawerOpen : undefined
  useEffect(() => {
    if (panes) persistPanes(undefined, panes)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the persisted keys matter
  }, [mode, active, targets, drawerOpen])

  // Main's default council and key status: read once, then followed.
  useEffect(() => {
    if (!api) return undefined
    let alive = true
    const dispatchCouncil = (council) => {
      if (alive) dispatch({ type: 'panes/council', council: council && typeof council === 'object' ? council : null })
    }
    const dispatchKey = (status) => {
      if (alive) dispatch({ type: 'panes/openRouterKey', status: status && typeof status === 'object' ? status : null })
    }
    try {
      if (typeof api.getCouncil === 'function') Promise.resolve(api.getCouncil()).then(dispatchCouncil).catch(() => {})
      if (typeof api.getOpenRouterKey === 'function') Promise.resolve(api.getOpenRouterKey()).then(dispatchKey).catch(() => {})
    } catch {
      /* a stub that throws: nothing to mirror */
    }
    const offCouncil = typeof api.onCouncil === 'function' ? api.onCouncil((msg) => dispatchCouncil(msg && msg.council !== undefined ? msg.council : msg)) : null
    const offKey = typeof api.onOpenRouterKey === 'function' ? api.onOpenRouterKey(dispatchKey) : null
    return () => {
      alive = false
      if (typeof offCouncil === 'function') offCouncil()
      if (typeof offKey === 'function') offKey()
    }
  }, [api, dispatch])

  // The catalog follows the key (see the header): refetch on the status transitions that change
  // what the backend serves. The previous status is a ref so a re-run with the same status (a
  // StrictMode double-invoke, a repeat from main) is not a transition.
  const keyStatus = panes ? panes.openRouterKey : null
  const prevKeyStatus = useRef(null)
  const refetchSeq = useRef(0)
  useEffect(() => {
    const prev = prevKeyStatus.current
    prevKeyStatus.current = keyStatus
    if (!catalogRefetchNeeded(prev, keyStatus)) return
    const seq = (refetchSeq.current += 1)
    const latest = () => refetchSeq.current === seq
    Promise.resolve()
      .then(() => http.listModels())
      .then((items) => {
        if (latest() && Array.isArray(items)) dispatch({ type: 'models/loaded', items })
      })
      .catch((e) => {
        if (latest()) dispatch({ type: 'models/error', error: (e && e.message) || 'catalog refetch failed' })
      })
  }, [keyStatus, dispatch])

  const version = (info && info.version) || (api && api.version) || null

  return (
    <div className={css.shell} data-testid="desktop-shell">
      <PaneDeck api={api} info={info} version={version} promptRef={promptRef} onNewChatAll={chats.newChatEverywhere} />
      <PromptBar api={api} composerRef={promptRef} chats={chats} />
      <Drawer api={api} />
    </div>
  )
}
