// Drawer (renderer-drawer, Stage 3): the collapsible bottom drawer of the desktop shell, below
// the prompt bar (contract §7 / plan Stage 3 row). It is renderer chrome in the flow, never an
// overlay: when open it takes its own height, the deck above shrinks and every viewport re-reports
// its rect, so the drawer never covers a site view.
//
//   desk-drawer                        the container (data-open, data-tab)
//   drawer-toggle                      open / close (`panes/drawer`; persisted as triplex.panes.drawerOpen)
//   drawer-tab-refactor|analyze|fusion|captured|settings   the tabs; clicking one opens the drawer on it
//   drawer-capture-hint                "capture is off for <slots>" when the latest send turn of the
//                                      open conversation has not_captured errors (its persisted
//                                      `errors[slot]` messages, slice.notCapturedSlots) and / or
//                                      "choose an analyst" when the effective analyst is neither
//                                      web:<slot>:analyst nor ollama:* (the conversation's
//                                      analyst_model when one is open — a pre-pivot OpenRouter
//                                      conversation shows it — else the desktop choice)
//   drawer-analyst-visible             Settings: the "show the analyst page" switch (showAnalyst)
//   drawer-analyst-state               Settings: which login main's hidden analyst page is actually
//                                      on (`panes.analyst.slot`, main's own truth) plus, when this
//                                      conversation asks for a different one, that it is being
//                                      switched over
//   drawer-analyze-blocked             the Analyze tab with no analyst that can answer: the hint
//                                      takes the pane's place, so there is no run to click at all
//
// Tabs: Analyze = the unchanged features/analyze pane, Fusion = the unchanged features/fusion pane
// (their slices are registered by the index.jsx modules imported here), Captured = the web
// SendPane with `composer={false}` (the three captured threads and their solo continue boxes; the
// unified prompt bar is the composer), Settings = SlotConfigBar in desktop mode (analyst groups
// "web sessions (hidden analyst page)" / "local Ollama", grounded hidden) plus the analyst-page
// switch. All four stay mounted (hidden) so the Fusion stepper and scroll positions survive a tab
// switch; the CostMeter (desktop mode: tokens / latency / calls, no cost) is the drawer's footer.
//
// Analyst choice (./analyst.js): the select's value is the open conversation's analyst_model, or
// the desktop choice when none is open; a change persists the mirror (`triplex.desktop.analyst`),
// tells main which site the hidden page signs in as (`triplex.setAnalyst(slot|null)`, optional-
// chained) and, through SlotConfigBar, PUTs the open conversation's slot_config. The desktop
// choice is what the next created conversation gets (desktopSlotConfig).
//
// Three stores hold that choice — the conversation's `slot_config.analyst_model` (what Analyze
// asks the bridge for), the renderer's localStorage mirror and main's `settings.analyst` (the
// login the hidden page is signed in as) — and a request whose slot is not main's is answered
// `analyst_not_chosen`. So the drawer keeps them together instead of letting them drift: it prints
// what main reports (`drawer-analyst-state`) and pushes the effective `web:<slot>:analyst` to main
// whenever main is on another slot (once per choice: a conversation created through the sidebar
// carries the backend's spawn-time analyst, and the localStorage mirror is not shared with main).
// With no analyst that can answer at all, the Analyze tab shows that hint in place of the pane
// (Decision 4: "Analyze disabled with a hint"), so no run burns a send turn into a degraded state.
//
// Auto-open: when the analyze stream starts (`streams.analyze` idle → streaming: the Analyze
// button, not Fusion's auto-run, which streams under 'fusion') the drawer opens on the Analyze
// tab so the report is visible where the user looks.
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import AnalyzePane from '../analyze/index.jsx'
import RefactorPane from '../refactor/index.jsx'
import { latestSendTurn } from '../analyze/slice.js'
import SlotConfigBar from '../config/index.jsx'
import FusionPane from '../fusion/index.jsx'
import CostMeter from '../meter/index.jsx'
import SendPane from '../send/SendPane.jsx'
import { analystSlotOf, isDesktopAnalyst, loadAnalyst, persistAnalyst } from './analyst.js'
import { desktopApi } from './PaneDeck.jsx'
import { SLOT_LABELS, initialPanes, isSlotId, notCapturedSlots } from './slice.js'
import css from './desktop.module.css'
import { APP_NAME } from '../../branding.js'

export const DRAWER_TABS = [
  { key: 'refactor', label: 'Refactor', tip: 'Map what the question is about, restate it concisely, and reduce all three answers to their substance. Analyze then compares this version.' },
  { key: 'analyze', label: 'Analyze', tip: 'What the three answers agree on and where they differ, labelled R1/R2/R3. Needs captured replies.' },
  { key: 'fusion', label: 'Fusion', tip: 'Put each difference back to the models that hold it, round by round, and report what converged and what still stands.' },
  { key: 'captured', label: 'Captured', tip: 'The reply text read out of each site, as stored: this is exactly what Analyze and Fusion see.' },
  { key: 'settings', label: 'Settings', tip: 'Which page answers as the analyst, how many Fusion rounds, and the materiality floor for fusing a difference.' },
]
export const TAB_KEYS = DRAWER_TABS.map((t) => t.key)
export const CHOOSE_ANALYST_HINT = 'choose an analyst'
/** Shown instead of the Analyze pane while no analyst can answer (Decision 4: Analyze disabled). */
export const ANALYZE_BLOCKED_HINT = 'Analyze needs an analyst: choose a web session or local Ollama in Settings.'
/** The same rule for Refactor, which is analyst work too. */
export const REFACTOR_BLOCKED_HINT = 'Refactor needs an analyst: choose a web session or local Ollama in Settings.'
/** Every pane returns null without a selected conversation, which left the drawer a blank slab. */
export const NO_CONVERSATION_HINT = 'No conversation selected. Send a prompt, or pick one in the sidebar, and its Analyze, Fusion and captured replies appear here.'

/** 'capture is off for claude, grok' for the latest send turn of the conversation, or null. */
export function captureHint(conversation) {
  const slots = notCapturedSlots(latestSendTurn(conversation))
  return slots.length ? `capture is off for ${slots.join(', ')}` : null
}

/** 'choose an analyst' unless the model is a desktop analyst (web:<slot>:analyst | ollama:*). */
export function analystHint(model) {
  return isDesktopAnalyst(model) ? null : CHOOSE_ANALYST_HINT
}

/**
 * What main reports its hidden analyst page is on (`panes.analyst.slot`), and — when `model` asks
 * for a different web session — that the page is being switched over to it. Main's state is the
 * one that decides whether a bridge analyst request is answered at all.
 */
export function analystPageText(pageSlot, model) {
  const on = isSlotId(pageSlot) ? `signed in as ${SLOT_LABELS[pageSlot]}` : 'not open'
  const wanted = analystSlotOf(model)
  const drift = wanted && wanted !== pageSlot ? ` This conversation asks for ${SLOT_LABELS[wanted]}, so the hidden page is being switched over.` : ''
  return `Hidden analyst page: ${on}.${drift}`
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

  const pushedSlot = useRef(null)
  const onAnalystChange = (model) => {
    const next = typeof model === 'string' ? model : ''
    setChoice(next)
    persistAnalyst(undefined, next)
    pushedSlot.current = analystSlotOf(next)
    settle(api?.setAnalyst?.(analystSlotOf(next)))
  }

  const effectiveAnalyst = slotConfig && typeof slotConfig === 'object' ? slotConfig.analyst_model : choice
  const analystReady = isDesktopAnalyst(effectiveAnalyst)
  const hints = [captureHint(conversation), analystHint(effectiveAnalyst)].filter(Boolean)
  const wantedSlot = analystSlotOf(effectiveAnalyst)
  const pageSlot = isSlotId(analystState.slot) ? analystState.slot : null

  // Main's hidden page must be the login this conversation's analyst_model names, or the bridge
  // answers analyst_not_chosen: push the choice once (mount included — main never sees the
  // localStorage mirror, and a conversation created in the sidebar carries the spawn-time analyst).
  // Once per choice, so a main that lands somewhere else is reported rather than fought over.
  useEffect(() => {
    if (wantedSlot === null || wantedSlot === pageSlot || pushedSlot.current === wantedSlot) return
    pushedSlot.current = wantedSlot
    settle(api?.setAnalyst?.(wantedSlot))
  }, [api, wantedSlot, pageSlot])

  return (
    <div className={css.drawer} data-testid="desk-drawer" data-open={open ? 'true' : 'false'} data-tab={tab}>
      <div className={css.drawerBar}>
        <button type="button" className={css.drawerToggle} data-testid="drawer-toggle" aria-expanded={open} title={open ? 'Close the drawer' : 'Open the drawer'} onClick={toggle}>
          {open ? '▾ Close' : '▴ Open'}
        </button>
        <div className={css.drawerTabs} role="tablist" aria-label="Drawer">
          {DRAWER_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" className={css.drawerTab} data-testid={`drawer-tab-${t.key}`} aria-selected={open && tab === t.key} onClick={() => select(t.key)} title={t.tip}>
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
          <div className={css.drawerPanel} data-testid="drawer-panel-refactor" data-blocked={analystReady ? 'false' : 'true'} hidden={tab !== 'refactor'}>
            {!conversation ? (
              <p className={css.blockedHint} data-testid="drawer-no-conversation-refactor" role="status">
                {NO_CONVERSATION_HINT}
              </p>
            ) : analystReady ? (
              <RefactorPane />
            ) : (
              // Refactor is analyst work too, so the same Decision 4 rule applies: with no analyst
              // that can answer, the pane is not rendered at all rather than shown disabled.
              <p className={css.blockedHint} data-testid="drawer-refactor-blocked" role="status">
                {REFACTOR_BLOCKED_HINT}
              </p>
            )}
          </div>
          <div className={css.drawerPanel} data-testid="drawer-panel-analyze" data-blocked={analystReady ? 'false' : 'true'} hidden={tab !== 'analyze'}>
            {!conversation ? (
              <p className={css.blockedHint} data-testid="drawer-no-conversation" role="status">
                {NO_CONVERSATION_HINT}
              </p>
            ) : analystReady ? (
              <AnalyzePane />
            ) : (
              // The pane is not rendered at all: a disabled button would still be clickable from a
              // test (and a `fieldset` only disables what the browser considers a form control),
              // while Decision 4 wants the run to be impossible, not merely discouraged. An earlier
              // report comes straight back with the analyst — the analyze slice hydrates from the
              // persisted turn.
              <p className={css.blockedHint} data-testid="drawer-analyze-blocked" role="status">
                {ANALYZE_BLOCKED_HINT}
              </p>
            )}
          </div>
          <div className={css.drawerPanel} data-testid="drawer-panel-fusion" hidden={tab !== 'fusion'}>
            {conversation ? (
              <FusionPane />
            ) : (
              <p className={css.blockedHint} data-testid="drawer-no-conversation-fusion" role="status">
                {NO_CONVERSATION_HINT}
              </p>
            )}
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
              <p className={css.hint} data-testid="drawer-analyst-state" role="status">
                {analystPageText(pageSlot, effectiveAnalyst)}
              </p>
              <p className={css.hint}>
                {APP_NAME} labels the three answers R1/R2/R3 and never names the sites, but it quotes them verbatim — a reply that names its own maker still identifies it. A web session runs the analyst in a
                hidden page signed in as that site (a fresh chat per Analyze); local Ollama needs a running server. New conversations start with the choice above; the open conversation is updated in place.
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
