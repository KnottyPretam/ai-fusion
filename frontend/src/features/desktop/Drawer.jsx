// Drawer (renderer-drawer, Stage 3): the collapsible bottom drawer of the desktop shell, below
// the prompt bar (contract §7 / plan Stage 3 row). It is renderer chrome in the flow, never an
// overlay: when open it takes its own height, the deck above shrinks and every viewport re-reports
// its rect, so the drawer never covers a site view.
//
//   desk-drawer                        the container (data-open, data-tab)
//   drawer-toggle                      open / close (`panes/drawer`; persisted as triplex.panes.drawerOpen)
//   drawer-tab-analyze|fusion|captured|settings   the tabs; clicking one opens the drawer on it
//   drawer-capture-hint                "capture is off for <slots>" when the latest send turn of the
//                                      open conversation has not_captured errors (its persisted
//                                      `errors[slot]` messages, slice.notCapturedSlots) and / or
//                                      "choose an analyst" when the effective analyst is neither
//                                      web:<slot>:analyst nor ollama:* (the conversation's
//                                      analyst_model when one is open — a pre-pivot OpenRouter
//                                      conversation shows it — else the desktop choice)
//   drawer-analyst-visible             Settings: the "show the analyst page" switch (showAnalyst)
//
// Tabs: Analyze = the unchanged features/analyze pane, Fusion = the unchanged features/fusion pane
// (their slices are registered by the index.jsx modules imported here), Captured = the web
// SendPane with `composer={false}` (the three captured threads and their solo continue boxes; the
// unified prompt bar is the composer), Settings = SlotConfigBar in desktop mode (analyst groups
// "web sessions (hidden analyst page)" / "local Ollama", grounded hidden) plus the analyst-page
// switch. All four stay mounted (hidden) so the Fusion stepper and scroll positions survive a tab
// switch; the CostMeter (desktop mode: latency / calls) is the drawer's footer.
//
// Analyst choice (./analyst.js): the select's value is the open conversation's analyst_model, or
// the desktop choice when none is open; a change persists the mirror (`triplex.desktop.analyst`),
// tells main which site the hidden page signs in as (`triplex.setAnalyst(slot|null)`, optional-
// chained) and, through SlotConfigBar, PUTs the open conversation's slot_config. The desktop
// choice is what the next created conversation gets (desktopSlotConfig).
//
// Auto-open: when the analyze stream starts (`streams.analyze` idle → streaming: the Analyze
// button, not Fusion's auto-run, which streams under 'fusion') the drawer opens on the Analyze
// tab so the report is visible where the user looks.
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import AnalyzePane from '../analyze/index.jsx'
import { latestSendTurn } from '../analyze/slice.js'
import SlotConfigBar from '../config/index.jsx'
import FusionPane from '../fusion/index.jsx'
import CostMeter from '../meter/index.jsx'
import SendPane from '../send/SendPane.jsx'
import { analystSlotOf, isDesktopAnalyst, loadAnalyst, persistAnalyst } from './analyst.js'
import { desktopApi } from './PaneDeck.jsx'
import { initialPanes, notCapturedSlots } from './slice.js'
import css from './desktop.module.css'

export const DRAWER_TABS = [
  { key: 'analyze', label: 'Analyze' },
  { key: 'fusion', label: 'Fusion' },
  { key: 'captured', label: 'Captured' },
  { key: 'settings', label: 'Settings' },
]
export const TAB_KEYS = DRAWER_TABS.map((t) => t.key)
export const CHOOSE_ANALYST_HINT = 'choose an analyst'

/** 'capture is off for claude, grok' for the latest send turn of the conversation, or null. */
export function captureHint(conversation) {
  const slots = notCapturedSlots(latestSendTurn(conversation))
  return slots.length ? `capture is off for ${slots.join(', ')}` : null
}

/** 'choose an analyst' unless the model is a desktop analyst (web:<slot>:analyst | ollama:*). */
export function analystHint(model) {
  return isDesktopAnalyst(model) ? null : CHOOSE_ANALYST_HINT
}

/** Swallow the rejection of an IPC promise (bad_request, a closed window); the UI stays up. */
function settle(p) {
  Promise.resolve(p).catch(() => {})
}

export default function Drawer({ api = desktopApi() }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const open = !!panes.drawerOpen
  const analystState = panes.analyst && typeof panes.analyst === 'object' ? panes.analyst : initialPanes().analyst
  const [tab, setTab] = useState('analyze')
  const [choice, setChoice] = useState(() => loadAnalyst())

  const analyzeStatus = streams.analyze ? streams.analyze.status : undefined
  const prevAnalyze = useRef(analyzeStatus)
  useEffect(() => {
    if (analyzeStatus === 'streaming' && prevAnalyze.current !== 'streaming') {
      setTab('analyze')
      dispatch({ type: 'panes/drawer', open: true })
    }
    prevAnalyze.current = analyzeStatus
  }, [analyzeStatus, dispatch])

  const select = (key) => {
    if (!TAB_KEYS.includes(key)) return
    setTab(key)
    if (!open) dispatch({ type: 'panes/drawer', open: true })
  }
  const toggle = () => dispatch({ type: 'panes/drawer' })

  const onAnalystChange = (model) => {
    const next = typeof model === 'string' ? model : ''
    setChoice(next)
    persistAnalyst(undefined, next)
    settle(api?.setAnalyst?.(analystSlotOf(next)))
  }

  const effectiveAnalyst = slotConfig && typeof slotConfig === 'object' ? slotConfig.analyst_model : choice
  const hints = [captureHint(conversation), analystHint(effectiveAnalyst)].filter(Boolean)

  return (
    <div className={css.drawer} data-testid="desk-drawer" data-open={open ? 'true' : 'false'} data-tab={tab}>
      <div className={css.drawerBar}>
        <button type="button" className={css.drawerToggle} data-testid="drawer-toggle" aria-expanded={open} title={open ? 'Close the drawer' : 'Open the drawer'} onClick={toggle}>
          {open ? '▾ Close' : '▴ Open'}
        </button>
        <div className={css.drawerTabs} role="tablist" aria-label="Drawer">
          {DRAWER_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" className={css.drawerTab} data-testid={`drawer-tab-${t.key}`} aria-selected={open && tab === t.key} onClick={() => select(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {hints.length ? (
          <span className={css.drawerHint} data-testid="drawer-capture-hint" role="status">
            {hints.join(' · ')}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className={css.drawerBody} data-testid="drawer-body">
          <div className={css.drawerPanel} data-testid="drawer-panel-analyze" hidden={tab !== 'analyze'}>
            <AnalyzePane />
          </div>
          <div className={css.drawerPanel} data-testid="drawer-panel-fusion" hidden={tab !== 'fusion'}>
            <FusionPane />
          </div>
          <div className={`${css.drawerPanel} ${css.captured}`} data-testid="drawer-panel-captured" hidden={tab !== 'captured'}>
            <SendPane composer={false} />
          </div>
          <div className={css.drawerPanel} data-testid="drawer-panel-settings" hidden={tab !== 'settings'}>
            <div className={css.settings}>
              <SlotConfigBar desktop analyst={choice} onAnalystChange={onAnalystChange} />
              <label className={css.settingsRow} title="Reveal the hidden analyst page as a pane (it keeps working hidden; main reveals it on its own when it needs a sign-in or a challenge)">
                <input type="checkbox" data-testid="drawer-analyst-visible" checked={!!analystState.visible} onChange={(e) => settle(api?.showAnalyst?.(e.target.checked))} />
                <span>Show the analyst page as a pane</span>
              </label>
              <p className={css.hint}>
                The analyst reads only R1/R2/R3-labelled text. A web session runs it in a hidden page signed in as that site (a fresh chat per Analyze); local Ollama needs a running server. New conversations
                start with the choice above; the open conversation is updated in place.
              </p>
            </div>
          </div>
          <div className={css.drawerFoot}>
            <CostMeter desktop />
          </div>
        </div>
      ) : null}
    </div>
  )
}
