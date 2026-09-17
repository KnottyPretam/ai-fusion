// PromptBar (renderer-desktop, Stage 1): the unified prompt. One textarea, a target checkbox per
// slot, Send (`triplex.sendPrompt({targets, text})` over IPC; main types the text into every
// target page and submits it), "New chat everywhere" (`triplex.newChat(targets)`) and one result
// line per target from the sendPrompt results. Stage 1 reads nothing back from the sites: the
// result only says whether the submit happened (`✓ 1.2 s · #prompt-textarea`) or why not
// (`✗ send_not_found`). A result whose code is a session state (logged_out | challenge | blocked)
// reveals that pane in tabs mode so the user can act on it.
//
// Enter sends, Shift+Enter inserts a newline, an IME composition (`isComposing` / keyCode 229)
// is never treated as a send. While a send is in flight main moves the OS focus into each target
// view for the insert phase (orchestrator `focusView`), so the composer is read-only AND blurred
// for the whole `sending` window — a keystroke typed then would otherwise land in the site's
// composer between insert and submit. Main restores the renderer focus after the last insert
// and the composer takes the focus back only if it had it when the send started. It is cleared
// afterwards only when every target succeeded and the text is still exactly what was sent.
// Stage 2 routes this through features/send/useSendTurn.js.
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { desktopApi } from './PaneDeck.jsx'
import { SLOT_IDS, SLOT_LABELS, initialPanes, resultNeedsAttention, selectedTargets } from './slice.js'
import css from './desktop.module.css'

/** '✓ 1.2 s · #prompt-textarea' | '✗ send_not_found' | '' */
export function formatResult(r) {
  if (!r || typeof r !== 'object') return ''
  if (r.ok) {
    const seconds = (Number(r.ms) || 0) / 1000
    return `✓ ${seconds.toFixed(1)} s${r.composerSelector ? ` · ${r.composerSelector}` : ''}`
  }
  return `✗ ${r.code || 'error'}`
}

/** Title for a result line: the message, the send selector and the page url when present. */
export function resultTitle(r) {
  if (!r || typeof r !== 'object') return ''
  const parts = []
  if (r.message) parts.push(String(r.message))
  if (r.sendSelector) parts.push(`send: ${r.sendSelector}`)
  if (r.url) parts.push(`url: ${r.url}`)
  return parts.join('\n')
}

/** A short code for a rejected IPC call ("… Error: bad_request" → 'bad_request'). */
export function errorCode(e) {
  const msg = String(e && e.message ? e.message : e || '').trim()
  const m = /([a-z][a-z0-9_]*)$/i.exec(msg)
  return m ? m[1] : 'ipc_error'
}

export default function PromptBar({ api = desktopApi(), composerRef = null }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const { targets: targetMap, sending, lastSend, mode } = panes
  const [text, setText] = useState('')
  const ownRef = useRef(null)
  const ref = composerRef || ownRef
  const alive = useRef(true)
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Keyed on the slice, not on this component's Send: a `panes/sendStart` from anywhere locks
  // the composer the same way. Blur on the way in (main is about to focus a site view); on the
  // way out give the focus back only when the composer had it — a user who clicked elsewhere
  // during the send is not yanked back.
  const hadFocus = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (sending) {
      hadFocus.current = typeof document !== 'undefined' && document.activeElement === el
      if (typeof el.blur === 'function') el.blur()
    } else if (hadFocus.current) {
      hadFocus.current = false
      if (typeof el.focus === 'function') el.focus()
    }
  }, [sending, ref])

  const targets = selectedTargets(targetMap)
  const empty = text.trim() === ''
  const canSend = !sending && !empty && targets.length > 0

  const send = async () => {
    if (!canSend) return
    const sent = text
    const list = targets
    dispatch({ type: 'panes/sendStart', targets: list })
    let results = {}
    try {
      const res = await Promise.resolve(api?.sendPrompt?.({ targets: list, text: sent }))
      const got = res && typeof res === 'object' && res.results && typeof res.results === 'object' ? res.results : {}
      for (const slot of list) {
        const r = got[slot]
        results[slot] = r && typeof r === 'object' ? r : { ok: false, code: api?.sendPrompt ? 'no_result' : 'unavailable', message: 'no result for this target', ms: 0 }
      }
    } catch (e) {
      const code = errorCode(e)
      const message = String((e && e.message) || e || code)
      results = {}
      for (const slot of list) results[slot] = { ok: false, code, message, ms: 0 }
    }
    dispatch({ type: 'panes/sendResult', results })
    if (list.every((slot) => results[slot].ok) && alive.current) setText((cur) => (cur === sent ? '' : cur))
    if (modeRef.current === 'tabs') {
      const reveal = list.find((slot) => resultNeedsAttention(results[slot]))
      if (reveal) dispatch({ type: 'panes/active', active: reveal })
    }
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if ((e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229) return
    e.preventDefault()
    send()
  }

  const newChatEverywhere = () => {
    if (!targets.length) return
    Promise.resolve(api?.newChat?.(targets)).catch(() => {})
  }

  const sendTitle = sending ? 'a send is in flight' : empty ? 'type a prompt first' : targets.length === 0 ? 'pick at least one target' : 'Send to every checked site (Enter)'

  return (
    <div className={css.promptBar} data-testid="prompt-bar" data-sending={sending ? 'true' : 'false'}>
      <div className={css.promptRow}>
        <textarea
          ref={ref}
          className={css.composer}
          data-testid="prompt-composer"
          aria-label="Prompt for every checked site"
          placeholder="Ask all three… (Enter to send, Shift+Enter for a new line, Ctrl+L to focus)"
          rows={2}
          value={text}
          readOnly={sending}
          aria-busy={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className={css.sendBtn} data-testid="prompt-send" disabled={!canSend} title={sendTitle} onClick={send}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className={css.promptMeta}>
        <span className={css.targets} role="group" aria-label="Targets">
          {SLOT_IDS.map((slot) => (
            <label key={slot} className={css.target} data-slot={slot}>
              <input type="checkbox" data-testid={`prompt-target-${slot}`} checked={!!targetMap[slot]} onChange={(e) => dispatch({ type: 'panes/target', slot, on: e.target.checked })} />
              {SLOT_LABELS[slot]}
            </label>
          ))}
        </span>
        <button type="button" className={css.newChat} data-testid="prompt-newchat" disabled={sending || targets.length === 0} title="Start a new chat in every checked site (Ctrl+Shift+N: all three)" onClick={newChatEverywhere}>
          New chat everywhere
        </button>
        <span className={css.results} aria-live="polite">
          {SLOT_IDS.map((slot) => {
            const r = lastSend[slot]
            const pending = sending && !r && targetMap[slot]
            if (!r && !pending) return null
            return (
              <span key={slot} className={css.result} data-testid={`prompt-result-${slot}`} data-ok={pending ? 'pending' : r.ok ? 'true' : 'false'} title={pending ? 'sending…' : resultTitle(r)}>
                {`${SLOT_LABELS[slot]} ${pending ? '…' : formatResult(r)}`}
              </span>
            )
          })}
        </span>
      </div>
    </div>
  )
}
