// The Export control: one trigger + one in-flow menu, used by all three panes (Send, Analyze,
// Fusion) with nothing but the turn it should write out.
//
// Shape decisions:
//  - The menu is IN FLOW, directly under the trigger: it can never overlay a site view in the
//    desktop shell and can never be clipped by the drawer's `overflow` (an absolutely positioned
//    popover would be, in the Captured tab). It opens downward inside the pane and the pane's own
//    content moves down by its height.
//  - Real buttons throughout: Tab reaches the trigger, Enter/Space opens, the first item takes
//    focus, ArrowUp/ArrowDown walk the items, Escape closes and hands focus back to the trigger.
//  - PDF is offered only in the desktop shell (Electron renders it); in the browser the item is
//    absent and the menu's title says why, rather than showing an option that cannot work.
//  - One result line: the files written, nothing at all after a cancelled save dialog, the error
//    code when it failed.
//
// Test ids: export-<feature> (trigger), export-menu-<feature>, export-format-md|html|pdf|all,
// export-<feature>-result.
import { useCallback, useEffect, useRef, useState } from 'react'
import { FEATURE_TURN_LABEL, FORMAT_LABELS, FORMAT_TIPS, allLabel, availableFormats, defaultBaseName, formatsFor } from './formats.js'
import { isDesktop, resultLine, runExport } from './runExport.js'
import css from './export.module.css'
import { APP_NAME } from '../../branding.js'

const MENU_TITLE_DESKTOP = 'One save dialog each time, with a default file name. "All three" asks once for a base path and writes the .md, .html and .pdf beside each other.'
const MENU_TITLE_BROWSER = `PDF is not available in the browser: the ${APP_NAME} desktop app renders it. Markdown and HTML download here.`

export default function ExportControl({ feature, conversationId, turnId, title, turnType = null, busy = false, busyReason = null }) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const wrapRef = useRef(null)
  const desktop = isDesktop()
  // The turn this control is currently pointed at; a result that lands after the pane moved on
  // (a new turn, a conversation switch) is dropped instead of describing a document off screen.
  const atRef = useRef(null)
  atRef.current = `${conversationId || ''}|${turnId || ''}`

  const disabled = !conversationId || !turnId || busy || running
  // A result line belongs to the turn it was produced for: a new turn (or a conversation switch)
  // clears it instead of describing a document that is no longer on screen.
  useEffect(() => {
    setOutcome(null)
    setOpen(false)
  }, [conversationId, turnId])

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus && triggerRef.current) triggerRef.current.focus()
  }, [])

  // Opening the menu moves focus into it (keyboard reachable without a pointer).
  useEffect(() => {
    if (!open || !menuRef.current) return
    const first = menuRef.current.querySelector('button:not([disabled])')
    if (first) first.focus()
  }, [open])

  // A click anywhere else closes the menu (and so opening another pane's menu closes this one).
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onKeyDown(e) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      close()
      return
    }
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    const items = menuRef.current ? [...menuRef.current.querySelectorAll('button:not([disabled])')] : []
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1
    items[next].focus()
  }

  async function choose(choice) {
    close()
    const at = atRef.current
    const formats = formatsFor(choice, desktop)
    setRunning(true)
    setOutcome(null)
    // `title` / `turnType` are what the desktop names the file from; `baseName` is the browser's
    // fallback when the endpoint suggests no name of its own.
    const step = turnType || feature
    const result = await runExport({ conversationId, turnId, formats, title, turnType: step, baseName: defaultBaseName({ title, feature: step, turnId }) })
    setRunning(false)
    if (atRef.current !== at) return
    setOutcome(result)
  }

  const formats = availableFormats(desktop)
  const line = running ? 'Exporting…' : resultLine(outcome)
  const why = !conversationId || !turnId ? `no ${FEATURE_TURN_LABEL[feature] || 'turn'} to export yet` : busyReason || (busy ? 'a stream is running' : null)

  return (
    <span className={css.wrap} ref={wrapRef} onKeyDown={onKeyDown}>
      <span className={css.row}>
        <button
          type="button"
          ref={triggerRef}
          className={css.trigger}
          data-testid={`export-${feature}`}
          data-open={open ? 'true' : 'false'}
          aria-haspopup="menu"
          aria-expanded={open ? 'true' : 'false'}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          title={disabled ? `Export: ${why || 'unavailable'}` : `Export this ${FEATURE_TURN_LABEL[feature] || 'turn'} as ${desktop ? 'Markdown, HTML, PDF or all three' : 'Markdown or HTML'}`}
        >
          Export{running ? '…' : ' ▾'}
        </button>
        {line ? (
          <span className={`${css.result} ${outcome && outcome.state === 'error' ? css.resultError : ''}`} data-testid={`export-${feature}-result`} role="status" title={outcome && outcome.paths ? outcome.paths.join('\n') : undefined}>
            {line}
          </span>
        ) : null}
      </span>
      {open ? (
        <span className={css.menu} ref={menuRef} role="menu" aria-label={`Export the ${FEATURE_TURN_LABEL[feature] || 'turn'}`} data-testid={`export-menu-${feature}`} title={desktop ? MENU_TITLE_DESKTOP : MENU_TITLE_BROWSER}>
          {formats.map((f) => (
            <button key={f} type="button" role="menuitem" className={css.item} data-testid={`export-format-${f}`} data-feature={feature} data-format={f} onClick={() => choose(f)} title={FORMAT_TIPS[f]}>
              {FORMAT_LABELS[f]}
            </button>
          ))}
          <button type="button" role="menuitem" className={`${css.item} ${css.itemAll}`} data-testid="export-format-all" data-feature={feature} data-format="all" onClick={() => choose('all')} title="Every format at once, from ONE save dialog: the files land side by side under the name you give.">
            {allLabel(desktop)}
          </button>
          {desktop ? null : (
            <span className={css.note} data-testid={`export-note-${feature}`}>
              PDF needs the desktop app
            </span>
          )}
        </span>
      ) : null}
    </span>
  )
}
