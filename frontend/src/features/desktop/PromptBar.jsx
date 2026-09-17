// PromptBar (renderer-desktop Stage 1, renderer-desktop-2 Stage 2): the unified prompt. One
// textarea, a target checkbox per slot, Send, "New chat everywhere" and one result line per slot.
//
// Stage 2: Send is a Triplex Send through features/send/useSendTurn.js (the SendPane.startTurn
// extraction): a conversation is created when none is selected, `POST /api/conversations/{id}/send`
// carries `{prompt}` when all three targets are checked and `{prompt, slots}` for a strict subset
// (`sendBody`), the persisted conversation is refetched afterwards with the hook's `isCurrent`
// guard and the sidebar list refreshed after a first send. The backend routes each `web:<slot>`
// model over the bridge to Electron, which types the text into that site's page. The Stage 1
// `triplex.sendPrompt` IPC path is gone (removed from the preload at the S6 merge).
//
// Locking: `panes.sending` is dispatched around the turn (`panes/sendStart{targets}` before
// `startTurn`, `panes/sendResult{}` when it settles — after the create round-trip, the stream and
// the refetch) so PaneDeck's Reload / New chat / new-chat-all gating is unchanged from Stage 1;
// the hook's `locked` (any feature stream, or a turn of this hook in flight) is honoured as well —
// "locked while streams.send streams", also for a stream started elsewhere. While either holds the
// composer is read-only AND blurred (main moves the OS focus into each site view for the insert
// phase; a keystroke typed then would land in the site's composer between insert and submit); the
// focus comes back only if the composer had it when the send started. The composer is cleared at
// submit (the text is the persisted turn's prompt) and restored when the turn fails before it
// streamed (a pre-stream 409/422, a failed create) so the user can retry.
//
// Per-slot result line: `panes.lastSend[slot]`, recorded by the slice from the send stream's
// slot_done / slot_error events (`sent ✓ captured` | `sent ✓ not captured` | `✗ <code>`, see
// slice.js); "…" while this bar's send is in flight and the slot has no outcome yet. The tabs-mode
// auto-reveal of a `logged_out | challenge | blocked` slot happens in the reducer.
//
// `bridge-banner` mirrors `triplex.onBridge` (`panes/bridge`): shown until Electron reports its
// WebSocket to the backend connected (the initial state is disconnected, contract §7), and again
// whenever it drops — a Send then fails per slot with `bridge_unavailable`; Send stays enabled
// because the bridge reconnects on its own. "New chat everywhere" = createConversation +
// openChats(newId) through ./chats.js (the shell's instance when given, else one of our own);
// disabled while any stream runs.
//
// Enter sends, Shift+Enter inserts a newline, an IME composition (`isComposing` / keyCode 229) is
// never treated as a send. Every `window.triplex` call is optional-chained: the bar renders and
// sends under a partial stub (desktop-smoke.test.jsx) and under the web app.
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useSendTurn } from '../send/useSendTurn.js'
import { useOpenChats } from './chats.js'
import { desktopApi } from './PaneDeck.jsx'
import { NOT_CAPTURED, SLOT_IDS, SLOT_LABELS, initialPanes, selectedTargets } from './slice.js'
import css from './desktop.module.css'

/** 'sent ✓ captured · 1.2 s' | 'sent ✓ not captured' | '✗ send_not_found' | '' */
export function formatResult(r) {
  if (!r || typeof r !== 'object') return ''
  if (r.ok) {
    const seconds = (Number(r.ms) || 0) / 1000
    const tail = seconds > 0 ? ` · ${seconds.toFixed(1)} s` : ''
    return `${r.code === NOT_CAPTURED ? 'sent ✓ not captured' : 'sent ✓ captured'}${tail}`
  }
  return `✗ ${r.code || 'error'}`
}

/** Title for a result line: the message (and, for Stage 1 shaped results, the selectors / url). */
export function resultTitle(r) {
  if (!r || typeof r !== 'object') return ''
  const parts = []
  if (r.message) parts.push(String(r.message))
  if (r.sendSelector) parts.push(`send: ${r.sendSelector}`)
  if (r.url) parts.push(`url: ${r.url}`)
  return parts.join('\n')
}

export const BRIDGE_BANNER_TEXT = 'Not connected to the Triplex backend bridge — a Send fails with bridge_unavailable until Electron reconnects (automatic).'

export default function PromptBar({ api = desktopApi(), composerRef = null, chats = null }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const { targets: targetMap, sending, lastSend, bridge } = panes
  const { startTurn, locked, banner } = useSendTurn()
  const own = useOpenChats(api, { enabled: !chats })
  const { newChatEverywhere, busy: creating, error: chatError } = chats || own
  const [text, setText] = useState('')
  const [inFlight, setInFlight] = useState(null) // targets of the send this bar started, while it runs
  const ownRef = useRef(null)
  const ref = composerRef || ownRef
  const alive = useRef(true)
  const sendingRef = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const off = api?.onBridge?.((msg) => {
      if (msg && typeof msg === 'object') dispatch({ type: 'panes/bridge', connected: !!msg.connected, since: msg.since })
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch])

  const busy = sending || locked

  // Keyed on the lock, not on this component's Send: a `panes/sendStart` from anywhere (or a
  // stream started elsewhere) locks the composer the same way. Blur on the way in (main is about
  // to focus a site view); on the way out give the focus back only when the composer had it — a
  // user who clicked elsewhere during the send is not yanked back.
  const hadFocus = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (busy) {
      hadFocus.current = typeof document !== 'undefined' && document.activeElement === el
      if (typeof el.blur === 'function') el.blur()
    } else if (hadFocus.current) {
      hadFocus.current = false
      if (typeof el.focus === 'function') el.focus()
    }
  }, [busy, ref])

  const targets = selectedTargets(targetMap)
  const empty = text.trim() === ''
  const canSend = !busy && !empty && targets.length > 0

  const send = async () => {
    if (!canSend || sendingRef.current) return
    const sent = text
    const list = targets
    sendingRef.current = true
    setText('')
    setInFlight(list)
    dispatch({ type: 'panes/sendStart', targets: list })
    let ok = false
    try {
      // `sendBody` posts {prompt} for all three and {prompt, slots} for a strict subset.
      ok = await startTurn({ prompt: sent, slots: list })
    } finally {
      sendingRef.current = false
      dispatch({ type: 'panes/sendResult', results: {} })
      if (alive.current) setInFlight(null)
    }
    // Failed before / instead of streaming (the banner says why): keep the text for a retry.
    if (!ok && alive.current) setText((cur) => (cur === '' ? sent : cur))
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if ((e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229) return
    e.preventDefault()
    send()
  }

  const newChat = () => {
    if (busy || creating) return
    newChatEverywhere()
  }

  const sendTitle = sending ? 'a send is in flight' : locked ? 'a stream is running' : empty ? 'type a prompt first' : targets.length === 0 ? 'pick at least one target' : 'Send to every checked site (Enter)'
  const message = banner || chatError || null

  return (
    <div className={css.promptBar} data-testid="prompt-bar" data-sending={sending ? 'true' : 'false'} data-locked={busy ? 'true' : 'false'}>
      {!bridge.connected ? (
        <div className={css.bridgeBanner} data-testid="bridge-banner" role="status">
          {BRIDGE_BANNER_TEXT}
        </div>
      ) : null}
      {message ? (
        <div className={css.banner} data-testid="prompt-banner" role="alert">
          {message}
        </div>
      ) : null}
      <div className={css.promptRow}>
        <textarea
          ref={ref}
          className={css.composer}
          data-testid="prompt-composer"
          aria-label="Prompt for every checked site"
          placeholder="Ask all three… (Enter to send, Shift+Enter for a new line, Ctrl+L to focus)"
          rows={2}
          value={text}
          readOnly={busy}
          aria-busy={busy}
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
        <button
          type="button"
          className={css.newChat}
          data-testid="prompt-newchat"
          disabled={busy || creating}
          title={busy ? 'a stream is running' : 'Start a new Triplex conversation and a new chat in every site (Ctrl+Shift+N)'}
          onClick={newChat}
        >
          New chat everywhere
        </button>
        <span className={css.results} aria-live="polite">
          {SLOT_IDS.map((slot) => {
            const r = lastSend[slot]
            const pending = !r && !!inFlight && inFlight.includes(slot)
            if (!r && !pending) return null
            return (
              <span
                key={slot}
                className={css.result}
                data-testid={`prompt-result-${slot}`}
                data-ok={pending ? 'pending' : r.ok ? 'true' : 'false'}
                data-code={pending ? undefined : r.code || undefined}
                title={pending ? 'sending…' : resultTitle(r)}
              >
                {`${SLOT_LABELS[slot]} ${pending ? '…' : formatResult(r)}`}
              </span>
            )
          })}
        </span>
      </div>
    </div>
  )
}
