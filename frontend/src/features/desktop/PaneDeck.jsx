// PaneDeck (renderer-desktop, Stage 1): the deck bar (tabs, Tabs/Split toggle) and the three
// panes. Each pane is a header (health, session badge, Reload / New chat / Open / zoom / Inspect)
// above an EMPTY viewport div: the site page itself is a native Electron WebContentsView that main
// positions over the viewport's rect. This component is therefore the layout reporter —
//   * `triplex.setLayout({slot: rect|null})`, rAF-throttled, from a ResizeObserver on every
//     viewport, the window `resize` event and every mode/active change (hidden panes → null);
//   * `triplex.setActive({mode, active})` whenever either changes;
//   * `triplex.onHealth` → panes/health, `triplex.onZoom` → panes/zoom,
//     `triplex.onShortcut` → tab-n / toggle-mode / focus-prompt / new-chat-all.
// Anything that navigates a view — new-chat-all, the per-pane Reload / New chat buttons — is
// ignored/disabled while `panes.sending` is true (the same rule as PromptBar's "New chat
// everywhere"): a navigation mid-send fails every in-flight insert with `adapter_gone`.
// Every `window.triplex` call is optional-chained: the deck renders under a partial stub and
// under the web app, where the object is absent. Renderer chrome never overlaps a viewport
// (deck bar above, header above, prompt bar below — see desktop.module.css).
import { useCallback, useEffect, useRef } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { rectsFor, sameLayout } from './rects.js'
import { SESSION_BADGES, SLOT_IDS, SLOT_LABELS, healthLevel, healthText, healthTitle, initialPanes, isSlotId, needsAttention, sessionOf, sessionText } from './slice.js'
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
 * observer callbacks it causes); a map identical to the last one sent is skipped.
 */
function useLayoutReporter(api, mode, active, viewports) {
  const pending = useRef(false)
  const handle = useRef(null)
  const latest = useRef({ mode, active })
  latest.current = { mode, active }
  const lastSent = useRef(null)

  const report = useCallback(() => {
    const layout = rectsFor(latest.current.mode, latest.current.active, viewports.current)
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
    if (ro) for (const slot of SLOT_IDS) if (viewports.current[slot]) ro.observe(viewports.current[slot])
    window.addEventListener('resize', schedule)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', schedule)
      cancelFrame(handle.current)
      handle.current = null
      pending.current = false
    }
  }, [schedule, viewports])

  useEffect(() => {
    schedule()
  }, [schedule, mode, active])
}

function zoomPercent(factor) {
  return `${Math.round((Number(factor) || 1) * 100)}%`
}

export default function PaneDeck({ api = desktopApi(), info = null, version = null, promptRef = null }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const { mode, active, health, lastSend, zoom, sending } = panes
  const viewports = useRef({})
  const latest = useRef({ mode, active, sending })
  latest.current = { mode, active, sending }

  useLayoutReporter(api, mode, active, viewports)

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
    const off = api?.onShortcut?.((msg) => {
      const name = msg && typeof msg === 'object' ? msg.name : msg
      const tab = /^tab-([123])$/.exec(String(name))
      if (tab) return activate(SLOT_IDS[Number(tab[1]) - 1])
      if (name === 'toggle-mode') return dispatch({ type: 'panes/mode', mode: latest.current.mode === 'tabs' ? 'split' : 'tabs' })
      if (name === 'focus-prompt') return promptRef?.current?.focus?.()
      if (name === 'new-chat-all') return latest.current.sending ? undefined : settle(api?.newChat?.([...SLOT_IDS]))
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

  const setMode = (next) => dispatch({ type: 'panes/mode', mode: next })
  const dev = !!(info && info.dev)

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
      <div className={css.panes} data-mode={mode}>
        {SLOT_IDS.map((slot) => {
          const h = health[slot]
          const session = sessionOf(h)
          const badge = SESSION_BADGES[session]
          const hidden = mode === 'tabs' && slot !== active
          return (
            <section key={slot} className={css.pane} data-testid={`pane-${slot}`} data-slot={slot} data-active={slot === active} hidden={hidden} aria-label={`${SLOT_LABELS[slot]} pane`}>
              <header className={css.paneHeader}>
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
      </div>
    </div>
  )
}
