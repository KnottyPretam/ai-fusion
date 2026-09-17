// PaneDeck (renderer-desktop Stage 1, renderer-desktop-2 Stage 2): the deck bar (tabs, Tabs/Split
// toggle), the first-run capture notice and the three panes. Each pane is a header (health,
// session badge, Reload / New chat / Open / zoom / Inspect, then the capture switch and the turn
// phase) above an EMPTY viewport div: the site page itself is a native Electron WebContentsView
// that main positions over the viewport's rect. This component is therefore the layout reporter —
//   * `triplex.setLayout({slot: rect|null})`, rAF-throttled, from a ResizeObserver on every
//     viewport, the window `resize` event and every mode/active change (hidden panes → null);
//   * `triplex.setActive({mode, active})` whenever either changes;
//   * `triplex.onHealth` → panes/health, `triplex.onZoom` → panes/zoom, `triplex.onTurn` →
//     panes/turn (Stage 2), `triplex.onShortcut` → tab-n / toggle-mode / focus-prompt / new-chat-all.
// Stage 2 capture: `pane-<slot>-capture` is the per-site switch (off by default, plan Decision 3),
// read from main with `getCapture()` on mount (the value is main's, persisted in settings.json) and
// written with `setCapture(slot, on)` — optimistic in the slice, reverted if main rejects. The ToS
// wording sits next to every switch (title) and in `capture-notice`, shown until each of the three
// switches has been set once (`triplex.panes.captureNoticeSeen` in localStorage, slice.js). The
// switch is disabled during a send: main reads it at observe time and a flip mid-turn would change
// what that turn captures. `pane-<slot>-phase` shows the turn phase main reports over `onTurn`.
// Anything that navigates a view — new-chat-all, the per-pane Reload / New chat buttons — is
// ignored/disabled while `panes.sending` is true (the same rule as PromptBar's "New chat
// everywhere"): a navigation mid-send fails every in-flight insert with `adapter_gone`. With an
// `onNewChatAll` prop (DesktopShell passes the shared ./chats.js handler) the shortcut is a real
// "New chat everywhere" (new conversation + openChats); without it, Stage 1's newChat(all).
// Stage 3 (renderer-drawer): the hidden analyst page. `triplex.onAnalyst` → panes/analyst
// ({slot, visible, health}: main auto-reveals on challenge | logged_out, the drawer's Settings
// switch and the pane's Hide button call `showAnalyst`). While `analyst.visible` the deck shows
// `deck-tab-analyst` (click = hide) and a fourth pane `pane-analyst` — header (site, session,
// health, Hide) above `pane-analyst-viewport` — as an EXTRA pane in both modes (in tabs mode next
// to the active pane; `panes.active` only ever names a slot), reported to main under the layout
// key 'analyst' (contract §2) only while mounted: an absent key is "hidden" for main.
// Every `window.triplex` call is optional-chained: the deck renders under a partial stub and
// under the web app, where the object is absent. Renderer chrome never overlaps a viewport
// (deck bar and notice above, header above, prompt bar / drawer below — see desktop.module.css).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { LAYOUT_KEYS, rectsFor, sameLayout } from './rects.js'
import {
  CAPTURE_LABEL,
  CAPTURE_NOTICE_TEXT,
  CAPTURE_TITLE,
  SESSION_BADGES,
  SLOT_IDS,
  SLOT_LABELS,
  allCaptureTouched,
  healthLevel,
  healthText,
  healthTitle,
  initialPanes,
  isSlotId,
  loadCaptureTouched,
  needsAttention,
  persistCaptureTouched,
  phaseText,
  sessionOf,
  sessionText,
} from './slice.js'
import css from './desktop.module.css'

/** The contextBridge surface of desktop/preload/renderer.cjs, or null under the web app. */
export function desktopApi() {
  return typeof window !== 'undefined' && window.triplex ? window.triplex : null
}

/** Swallow the rejection of an IPC promise (bad_request, a closed window); the UI stays up. */
function settle(p) {
  Promise.resolve(p).catch(() => {})
}

function frame(fn) {
  if (typeof requestAnimationFrame === 'function') return { raf: requestAnimationFrame(fn) }
  return { timer: setTimeout(fn, 16) }
}

function cancelFrame(h) {
  if (!h) return
  if (h.raf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h.raf)
  if (h.timer !== undefined) clearTimeout(h.timer)
}

/**
 * Reports the viewport rects to main. One animation frame coalesces every trigger that fires
 * between two paints (three ResizeObserver entries for one window resize, a mode change and the
 * observer callbacks it causes); a map identical to the last one sent is skipped. The analyst
 * viewport (S3) is observed and reported only while its pane is mounted (`analystVisible`).
 */
function useLayoutReporter(api, mode, active, viewports, analystVisible = false) {
  const pending = useRef(false)
  const handle = useRef(null)
  const latest = useRef({ mode, active, analystVisible })
  latest.current = { mode, active, analystVisible }
  const lastSent = useRef(null)

  const report = useCallback(() => {
    const { mode: m, active: a, analystVisible: shown } = latest.current
    const layout = rectsFor(m, a, viewports.current, shown ? { analyst: viewports.current.analyst || null } : undefined)
    if (sameLayout(layout, lastSent.current)) return
    lastSent.current = layout
    api?.setLayout?.(layout)
  }, [api, viewports])

  const schedule = useCallback(() => {
    if (pending.current) return
    // The flag is set BEFORE the frame is requested: a frame callback that runs synchronously
    // (test harness) would otherwise clear it first and the assignment would re-arm it forever.
    pending.current = true
    handle.current = frame(() => {
      pending.current = false
      handle.current = null
      report()
    })
  }, [report])

  useEffect(() => {
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    // The analyst viewport exists only while its pane is mounted (the ref callback ran before
    // this effect), so re-running on `analystVisible` observes it as it appears.
    if (ro) for (const key of LAYOUT_KEYS) if (viewports.current[key]) ro.observe(viewports.current[key])
    window.addEventListener('resize', schedule)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', schedule)
      cancelFrame(handle.current)
      handle.current = null
      pending.current = false
    }
  }, [schedule, viewports, analystVisible])

  useEffect(() => {
    schedule()
  }, [schedule, mode, active, analystVisible])
}

function zoomPercent(factor) {
  return `${Math.round((Number(factor) || 1) * 100)}%`
}

export default function PaneDeck({ api = desktopApi(), info = null, version = null, promptRef = null, onNewChatAll = null }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const { mode, active, health, lastSend, zoom, sending, capture, turn } = panes
  const analyst = panes.analyst && typeof panes.analyst === 'object' ? panes.analyst : initialPanes().analyst
  const analystVisible = !!analyst.visible
  const viewports = useRef({})
  const latest = useRef({ mode, active, sending, onNewChatAll })
  latest.current = { mode, active, sending, onNewChatAll }

  useLayoutReporter(api, mode, active, viewports, analystVisible)

  useEffect(() => {
    api?.setActive?.({ mode, active })
  }, [api, mode, active])

  const activate = useCallback(
    (slot) => {
      if (!isSlotId(slot)) return
      dispatch({ type: 'panes/active', active: slot })
      // Tabs: the view becomes visible. Split: every view is visible, so move the focus instead.
      if (latest.current.mode === 'split') settle(api?.focusPane?.(slot))
    },
    [api, dispatch],
  )

  useEffect(() => {
    const off = api?.onHealth?.((slot, h) => {
      if (isSlotId(slot)) dispatch({ type: 'panes/health', slot, health: h && typeof h === 'object' ? h : null })
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch])

  useEffect(() => {
    const off = api?.onZoom?.((msg) => {
      if (msg && isSlotId(msg.slot)) dispatch({ type: 'panes/zoom', slot: msg.slot, factor: msg.factor })
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch])

  useEffect(() => {
    const off = api?.onTurn?.((msg) => {
      if (msg && isSlotId(msg.slot) && typeof msg.phase === 'string') dispatch({ type: 'panes/turn', slot: msg.slot, phase: msg.phase })
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch])

  // Stage 3: the hidden analyst view's state (only the keys main sent are merged).
  useEffect(() => {
    const off = api?.onAnalyst?.((msg) => {
      if (!msg || typeof msg !== 'object') return
      const action = { type: 'panes/analyst' }
      if ('slot' in msg) action.slot = msg.slot
      if ('visible' in msg) action.visible = msg.visible
      if ('health' in msg) action.health = msg.health
      dispatch(action)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch])

  // The switch values are main's (settings.json): read them once per mount. The preload returns a
  // promise; a stub that hands the map back synchronously is applied at once.
  useEffect(() => {
    if (!api || typeof api.getCapture !== 'function') return undefined
    let alive = true
    let reply
    try {
      reply = api.getCapture()
    } catch {
      return undefined
    }
    const apply = (map) => {
      if (alive && map && typeof map === 'object') dispatch({ type: 'panes/capture', capture: map })
    }
    if (reply && typeof reply.then === 'function') Promise.resolve(reply).then(apply).catch(() => {})
    else apply(reply)
    return () => {
      alive = false
    }
  }, [api, dispatch])

  useEffect(() => {
    const off = api?.onShortcut?.((msg) => {
      const name = msg && typeof msg === 'object' ? msg.name : msg
      const tab = /^tab-([123])$/.exec(String(name))
      if (tab) return activate(SLOT_IDS[Number(tab[1]) - 1])
      if (name === 'toggle-mode') return dispatch({ type: 'panes/mode', mode: latest.current.mode === 'tabs' ? 'split' : 'tabs' })
      if (name === 'focus-prompt') return promptRef?.current?.focus?.()
      if (name === 'new-chat-all') {
        if (latest.current.sending) return undefined
        const handler = latest.current.onNewChatAll
        return typeof handler === 'function' ? settle(handler()) : settle(api?.newChat?.([...SLOT_IDS]))
      }
      return undefined
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch, activate, promptRef])

  const zoomTo = (slot, direction) => {
    Promise.resolve(api?.zoom?.(slot, direction))
      .then((r) => {
        if (r && typeof r.factor === 'number') dispatch({ type: 'panes/zoom', slot, factor: r.factor })
      })
      .catch(() => {})
  }

  const [touched, setTouched] = useState(() => loadCaptureTouched())
  useEffect(() => {
    persistCaptureTouched(undefined, touched)
  }, [touched])
  const noticeOpen = !allCaptureTouched(touched)

  const toggleCapture = (slot, on) => {
    if (latest.current.sending) return // the switch is disabled during a send; guard the handler too
    dispatch({ type: 'panes/capture', slot, on })
    setTouched((t) => (t[slot] ? t : { ...t, [slot]: true }))
    Promise.resolve(api?.setCapture?.(slot, on)).catch(() => dispatch({ type: 'panes/capture', slot, on: !on }))
  }

  const setMode = (next) => dispatch({ type: 'panes/mode', mode: next })
  const dev = !!(info && info.dev)
  const hideAnalyst = () => settle(api?.showAnalyst?.(false))
  const analystName = analyst.slot && SLOT_LABELS[analyst.slot] ? `Analyst · ${SLOT_LABELS[analyst.slot]}` : 'Analyst'
  const analystSession = sessionOf(analyst.health)
  const analystBadge = SESSION_BADGES[analystSession]

  return (
    <div className={css.deck} data-testid="pane-deck" data-mode={mode}>
      <div className={css.deckBar}>
        <div className={css.tabs} role="tablist" aria-label="Panes">
          {SLOT_IDS.map((slot) => {
            const h = health[slot]
            const session = sessionOf(h)
            const badge = SESSION_BADGES[session]
            const hidden = mode === 'tabs' && slot !== active
            const failed = !!(lastSend[slot] && !lastSend[slot].ok)
            const attention = hidden && (needsAttention(session) || failed)
            return (
              <button
                key={slot}
                type="button"
                role="tab"
                className={css.tab}
                data-testid={`deck-tab-${slot}`}
                data-slot={slot}
                data-session={session}
                data-attention={attention ? 'true' : 'false'}
                aria-selected={slot === active}
                title={`${SLOT_LABELS[slot]} — ${healthText(h)}${mode === 'tabs' ? ' (Ctrl+' + (SLOT_IDS.indexOf(slot) + 1) + ')' : ''}`}
                onClick={() => activate(slot)}
              >
                <span className={css.dot} data-level={healthLevel(h)} aria-hidden="true" />
                <span>{SLOT_LABELS[slot]}</span>
                {badge ? (
                  <span className={css.badge} data-session={session}>
                    {badge}
                  </span>
                ) : null}
                {attention ? (
                  <span className={css.attention} title="needs attention" aria-label="needs attention">
                    !
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
        {analystVisible ? (
          <button
            type="button"
            className={css.tab}
            data-testid="deck-tab-analyst"
            data-slot="analyst"
            data-session={analystSession}
            aria-pressed="true"
            title={`${analystName} — the hidden analyst page (click to hide)`}
            onClick={hideAnalyst}
          >
            <span className={css.dot} data-level={healthLevel(analyst.health)} aria-hidden="true" />
            <span>{analystName}</span>
            {analystBadge ? (
              <span className={css.badge} data-session={analystSession}>
                {analystBadge}
              </span>
            ) : null}
          </button>
        ) : null}
        <div className={css.modes} role="group" aria-label="Layout">
          <button type="button" data-testid="deck-mode-tabs" aria-pressed={mode === 'tabs'} title="One site at a time (Ctrl+\\ toggles)" onClick={() => setMode('tabs')}>
            Tabs
          </button>
          <button type="button" data-testid="deck-mode-split" aria-pressed={mode === 'split'} title="All three side by side (Ctrl+\\ toggles)" onClick={() => setMode('split')}>
            Split
          </button>
        </div>
        {version ? <span className={css.version}>{`desktop v${version}${dev ? ' (dev)' : ''}`}</span> : null}
      </div>
      {noticeOpen ? (
        <div className={css.notice} data-testid="capture-notice" role="note" aria-label="Capture and the sites' terms of service">
          <strong>Capture reply text:</strong> {CAPTURE_NOTICE_TEXT}
        </div>
      ) : null}
      <div className={css.panes} data-mode={mode}>
        {SLOT_IDS.map((slot) => {
          const h = health[slot]
          const session = sessionOf(h)
          const badge = SESSION_BADGES[session]
          const hidden = mode === 'tabs' && slot !== active
          const phase = turn[slot]
          return (
            <section key={slot} className={css.pane} data-testid={`pane-${slot}`} data-slot={slot} data-active={slot === active} hidden={hidden} aria-label={`${SLOT_LABELS[slot]} pane`}>
              <header className={css.paneHead}>
                <div className={css.paneHeader}>
                  <span
                    data-testid={`pane-${slot}-session`}
                    data-session={session}
                    data-level={healthLevel(h)}
                    className={badge ? css.badge : css.dot}
                    title={h ? `session: ${sessionText(session)}` : 'no health event from this pane yet'}
                  >
                    {badge || ''}
                  </span>
                  <span className={css.paneName}>{SLOT_LABELS[slot]}</span>
                  <span data-testid={`pane-${slot}-health`} className={css.health} data-level={healthLevel(h)} title={healthTitle(h)}>
                    {healthText(h)}
                  </span>
                  <span className={css.actions}>
                    <button type="button" data-testid={`pane-${slot}-reload`} disabled={sending} title={sending ? 'a send is in flight' : `Reload ${SLOT_LABELS[slot]} (Ctrl+R on the active pane)`} onClick={() => settle(api?.reload?.(slot))}>
                      Reload
                    </button>
                    <button type="button" data-testid={`pane-${slot}-newchat`} disabled={sending} title={sending ? 'a send is in flight' : `Open a new ${SLOT_LABELS[slot]} chat`} onClick={() => settle(api?.newChat?.([slot]))}>
                      New chat
                    </button>
                    <button type="button" data-testid={`pane-${slot}-open`} title="Open this page in the system browser" onClick={() => settle(api?.openExternal?.(slot))}>
                      Open
                    </button>
                    <span className={css.zoom} role="group" aria-label={`${SLOT_LABELS[slot]} zoom`}>
                      <button type="button" data-testid={`pane-${slot}-zoom-out`} title="Zoom out (Ctrl+-)" aria-label="Zoom out" onClick={() => zoomTo(slot, 'out')}>
                        −
                      </button>
                      <button type="button" data-testid={`pane-${slot}-zoom-reset`} title="Reset zoom (Ctrl+0)" aria-label="Reset zoom" onClick={() => zoomTo(slot, 'reset')}>
                        {zoomPercent(zoom[slot])}
                      </button>
                      <button type="button" data-testid={`pane-${slot}-zoom-in`} title="Zoom in (Ctrl+=)" aria-label="Zoom in" onClick={() => zoomTo(slot, 'in')}>
                        +
                      </button>
                    </span>
                    {dev ? (
                      <button type="button" data-testid={`pane-${slot}-inspect`} title="Open DevTools for this page (F12 on the active pane)" onClick={() => settle(api?.inspect?.(slot))}>
                        Inspect
                      </button>
                    ) : null}
                  </span>
                </div>
                <div className={css.captureRow}>
                  <label className={css.capture} title={sending ? 'a send is in flight' : CAPTURE_TITLE}>
                    <input type="checkbox" data-testid={`pane-${slot}-capture`} checked={!!capture[slot]} disabled={sending} onChange={(e) => toggleCapture(slot, e.target.checked)} />
                    <span>{CAPTURE_LABEL}</span>
                  </label>
                  <span data-testid={`pane-${slot}-phase`} className={css.phase} data-phase={phase || 'none'} title={phase ? `turn phase: ${phase}` : 'no turn reported for this pane yet'}>
                    {phaseText(phase)}
                  </span>
                </div>
              </header>
              <div
                className={css.viewport}
                data-testid={`pane-${slot}-viewport`}
                ref={(el) => {
                  viewports.current[slot] = el
                }}
              />
            </section>
          )
        })}
        {analystVisible ? (
          <section className={css.pane} data-testid="pane-analyst" data-slot="analyst" aria-label="Analyst pane">
            <header className={css.paneHead}>
              <div className={css.paneHeader}>
                <span
                  data-testid="pane-analyst-session"
                  data-session={analystSession}
                  data-level={healthLevel(analyst.health)}
                  className={analystBadge ? css.badge : css.dot}
                  title={analyst.health ? `session: ${sessionText(analystSession)}` : 'no health event from the analyst page yet'}
                >
                  {analystBadge || ''}
                </span>
                <span className={css.paneName}>{analystName}</span>
                <span data-testid="pane-analyst-health" className={css.health} data-level={healthLevel(analyst.health)} title={healthTitle(analyst.health)}>
                  {healthText(analyst.health)}
                </span>
                <span className={css.actions}>
                  <button type="button" data-testid="pane-analyst-hide" title="Hide the analyst page (it keeps working hidden)" onClick={hideAnalyst}>
                    Hide
                  </button>
                </span>
              </div>
            </header>
            <div
              className={css.viewport}
              data-testid="pane-analyst-viewport"
              ref={(el) => {
                viewports.current.analyst = el
              }}
            />
          </section>
        ) : null}
      </div>
    </div>
  )
}
