// PromptBar (renderer-desktop Stage 1, renderer-desktop-2 Stage 2): the unified prompt. One
// textarea, a target checkbox per slot, Pre-parse, Send, "New chat everywhere" and one result line
// per slot.
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
// because the bridge reconnects on its own. Stage 3: the `error` main sends with a disconnected
// state (why the backend could not be spawned, e.g. port_in_use) is shown in the banner verbatim.
// "New chat everywhere" = createConversation + openChats(newId) through ./chats.js (the shell's
// instance when given, else one of our own); disabled while any stream runs.
//
// Stage 3 — the desktop create path. A desktop conversation must be created with the chosen
// analyst (`desktopSlotConfig()`, ./analyst.js), but useSendTurn's own create posts `{}` and
// `startTurn` takes no create options (the hook is integrator-owned; the change is requested).
// So when no conversation is selected this bar creates it itself — under `panes.sending`, which
// it dispatched first, so the composer is locked for the round-trip and useOpenChats classifies
// the new id as this Send's own create (adopted, Decision 12) — and QUEUES the turn: the hook's
// `startTurn` closes over the `conversation` slice, so the turn is handed to it from an effect
// that runs once the store shows the created id (the render in which the hook re-bound
// `startTurn`), never from the stale closure of the click. A failed create shows `prompt-banner`
// and restores the text like a failed turn.
//
// Pre-parse (2026-09-23) — a preview step on the text, not a send. The button between the composer
// and Send posts the composer text to `POST /api/conversations/{id}/preparse`; the analyst restates
// the question clearly and succinctly through the hidden analyst page (one call, the primitive
// Refactor uses), the backend appends its answer-format block deterministically, and the result
// REPLACES the composer text, where the user reviews or edits it and then presses Send as usual —
// Send stays byte-verbatim, and the pre-parse itself persists nothing. The wait is a real analyst
// reply (40–340 s measured), so the status line carries an elapsed counter and a Cancel:
// `abortStream('preparse')` (the frozen api/runStream.js) aborts the fetch, Starlette cancels the
// backend's inline call and the bridge tells the analyst page to stop. Undo puts the typed text back
// until the text is edited or sent — native Ctrl+Z cannot restore a programmatic value change, hence
// the button. While it runs the composer is locked exactly like a send (`busy` folds `preparsing`
// in: main focuses the hidden analyst webContents for the insert phase, the keystroke hazard the
// Send lock exists for), but `panes/sendStart` is NOT dispatched (it would clear the result lines
// and gate PaneDeck) and the text is not cleared. With no conversation selected the bar creates one
// through `chats.createAdopted()` (./chats.js): the panes keep the chats they show and the first
// Send adopts them (Decision 12). The stream's state lives in the `preparse` slice
// (./preparseSlice.js); this bar applies each `preparse_done` exactly once through an effect keyed
// on the slice's `seq`. Failures — a degrade, a terminal error, a pre-stream 409/422 — go through
// `prompt-banner` in plain words; the text is never touched. The bar gates itself against the other
// analyst streams (Analyze, Fusion, Refactor share the hidden page) and `useSendTurn.STREAM_KEYS` is
// not extended: `streams.preparse` locks nothing but this button, while AnalyzePane's `canRun`
// already disables itself on any stream.
//
// Enter sends, Shift+Enter inserts a newline, an IME composition (`isComposing` / keyCode 229) is
// never treated as a send. Every `window.triplex` call is optional-chained: the bar renders and
// sends under a partial stub (desktop-smoke.test.jsx) and under the web app.
import { useEffect, useRef, useState } from 'react'
import { createConversation } from '../../api/http.js'
import { abortStream, useRunStream } from '../../api/runStream.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useSendTurn } from '../send/useSendTurn.js'
import { desktopSlotConfig, isDesktopAnalyst, loadAnalyst } from './analyst.js'
import { useOpenChats } from './chats.js'
import { desktopApi } from './PaneDeck.jsx'
import { FEATURE as PREPARSE, initial as preparseInitial } from './preparseSlice.js'
import { NOT_CAPTURED, SLOT_IDS, SLOT_LABELS, initialPanes, selectedTargets } from './slice.js'
import css from './desktop.module.css'
import { APP_NAME } from '../../branding.js'

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

export const BRIDGE_BANNER_TEXT = `Not connected to the ${APP_NAME} backend bridge — a Send fails with bridge_unavailable until Electron reconnects (automatic).`

/** The streams that run on the hidden analyst page: a pre-parse must not queue behind (or under) one. */
export const ANALYST_STREAMS = ['analyze', 'fusion', 'refactor']
/** The status line while the analyst restates, until the backend's own narration (preparse_retry) arrives. */
export const PREPARSE_RUNNING_TEXT = 'restating the question via the analyst…'
/** Every Pre-parse control's description (the TooltipLayer reads `title`). */
export const PREPARSE_TITLES = {
  ready: 'Ask the analyst to restate the question clearly and add a short answer format; review it here, then Send',
  running: PREPARSE_RUNNING_TEXT,
  creating: 'creating the conversation…',
  empty: 'type a prompt first',
  sending: 'a send is in flight',
  stream: 'a stream is running',
  analystBusy: 'the analyst is busy (Analyze, Fusion or Refactor is running)',
  noAnalyst: 'Pre-parse needs an analyst: choose a web session or local Ollama in Settings',
  unedited: 'already pre-parsed — edit the text, or undo, to pre-parse again',
  cancel: 'Stop waiting and unlock the composer; the analyst page is told to stop',
  undo: 'Put back the text you typed',
}
/** How long "pre-parse cancelled" stays on the status line. */
export const CANCELLED_NOTICE_MS = 4000

/** Plain words for the codes a pre-parse can fail with; anything else is shown as it came. */
export function preparseFailureText(code, detail = null) {
  switch (code) {
    case 'empty_prompt':
      return 'the prompt is empty'
    case 'prompt_too_long': {
      const chars = detail && Number.isFinite(detail.chars) ? detail.chars : null
      const max = detail && Number.isFinite(detail.max) ? detail.max : null
      return chars !== null && max !== null ? `the prompt is ${chars} characters long and the analyst takes at most ${max} in one message` : 'the prompt is too long for one analyst message'
    }
    case 'analyst_not_chosen':
      return 'no analyst is chosen (Settings)'
    case 'busy':
      return 'this conversation is busy with another call'
    default:
      return code || 'error'
  }
}

/** The `prompt-banner` text of a failed pre-parse. */
export function preparseBanner(code, detail = null) {
  return `Pre-parse failed: ${preparseFailureText(code, detail)}. Your text is unchanged; you can Send it as it is.`
}

export default function PromptBar({ api = desktopApi(), composerRef = null, chats = null }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const preparse = useSlice(PREPARSE) || preparseInitial()
  const { targets: targetMap, sending, lastSend, bridge } = panes
  const { startTurn, locked, banner } = useSendTurn()
  const run = useRunStream()
  const own = useOpenChats(api, { enabled: !chats })
  const { newChatEverywhere, createAdopted, busy: creating, error: chatError, clearError: clearChatError } = chats || own
  const [text, setText] = useState('')
  const [inFlight, setInFlight] = useState(null) // targets of the send this bar started, while it runs
  const [queued, setQueued] = useState(null) // {prompt, slots, convId}: a turn waiting for its created conversation
  const [createError, setCreateError] = useState(null)
  const [preparsing, setPreparsing] = useState(false) // the click → the stream (or the create before it) settled
  const [preparsed, setPreparsed] = useState(null) // {original, prompt}: the applied result, until edited or sent
  const [preparseError, setPreparseError] = useState(null) // {code, detail} of a pre-stream failure (409/422, transport)
  const [cancelled, setCancelled] = useState(false) // "pre-parse cancelled" on the status line, for a moment
  const [elapsed, setElapsed] = useState(0) // whole seconds since the click, while preparsing
  const ownRef = useRef(null)
  const ref = composerRef || ownRef
  const alive = useRef(true)
  const sendingRef = useRef(false)
  const preparsingRef = useRef(false)
  const cancelRef = useRef(false) // Cancel was pressed during this pre-parse
  const refocusRef = useRef(false) // the Pre-parse click came from the bar: give the composer the focus back after
  const typedRef = useRef('') // the composer text at the click: what Undo puts back
  // The slice `seq` this bar has applied. Initialised to the seq at mount, not 0: a result that
  // arrived before this bar existed is not ours to put into an empty composer.
  const appliedSeq = useRef(preparse.seq)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const off = api?.onBridge?.((msg) => {
      if (msg && typeof msg === 'object') dispatch({ type: 'panes/bridge', connected: !!msg.connected, since: msg.since, error: msg.error })
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, dispatch])

  const busy = sending || locked || preparsing

  // Keyed on the lock, not on this component's Send: a `panes/sendStart` from anywhere (or a
  // stream started elsewhere) locks the composer the same way. Blur on the way in (main is about
  // to focus a site view); on the way out give the focus back only when the composer had it — a
  // user who clicked elsewhere during the send is not yanked back. A Pre-parse click lands the
  // focus on its button; the bar counts that as the composer having it (`refocusRef`).
  const hadFocus = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (busy) {
      hadFocus.current = (typeof document !== 'undefined' && document.activeElement === el) || refocusRef.current
      refocusRef.current = false
      if (typeof el.blur === 'function') el.blur()
    } else if (hadFocus.current) {
      hadFocus.current = false
      if (typeof el.focus === 'function') el.focus()
    }
  }, [busy, ref])

  // Apply each preparse_done exactly once: the composer takes the composed prompt and Undo keeps
  // the typed text. `cancelled` is cleared too — a result that beat the Cancel is still the result.
  useEffect(() => {
    if (preparse.status !== 'done' || preparse.seq === appliedSeq.current) return
    appliedSeq.current = preparse.seq
    setPreparsed({ original: typedRef.current, prompt: preparse.prompt })
    setText(preparse.prompt)
    setCancelled(false)
  }, [preparse.status, preparse.seq, preparse.prompt])

  // Once the composed prompt is in the DOM: caret and scroll to the top, so the restated question
  // is what the eye lands on (a programmatic value lands the caret at the end).
  useEffect(() => {
    const el = ref.current
    if (!preparsed || !el) return
    try {
      el.setSelectionRange(0, 0)
    } catch {
      /* not a text control in this environment */
    }
    el.scrollTop = 0
  }, [preparsed, ref])

  // The elapsed counter: wall-clock seconds since the click, once a second — the wait is a real
  // reply, 40–340 s measured, and nothing else in the bar moves meanwhile.
  useEffect(() => {
    if (!preparsing) return undefined
    const startedAt = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [preparsing])

  useEffect(() => {
    if (!cancelled) return undefined
    const timer = setTimeout(() => setCancelled(false), CANCELLED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [cancelled])

  const targets = selectedTargets(targetMap)
  const empty = text.trim() === ''
  const canSend = !busy && !empty && targets.length > 0

  // The analyst a pre-parse goes to: the open conversation's, else the desktop choice (the drawer's
  // effective-analyst rule). `loadAnalyst()` is read at render; with no conversation open a change
  // in the drawer's select re-renders only the drawer, so this button catches up on the next store
  // change or keystroke — the click reads the same value, so it can never post to a stale choice.
  const analystModel = slotConfig && typeof slotConfig === 'object' ? slotConfig.analyst_model : loadAnalyst()
  const analystChosen = isDesktopAnalyst(analystModel)
  const analystBusy = ANALYST_STREAMS.some((k) => streams[k] && streams[k].status === 'streaming')
  const unedited = !!preparsed && text === preparsed.prompt
  const canPreparse = !busy && !creating && !empty && analystChosen && !analystBusy && !unedited && typeof createAdopted === 'function'

  // The end of a send this bar started: unlock, and keep the text for a retry when the turn failed
  // before / instead of streaming (the banner says why).
  const finish = (ok, sent) => {
    sendingRef.current = false
    dispatch({ type: 'panes/sendResult', results: {} })
    if (!alive.current) return
    setInFlight(null)
    if (!ok) setText((cur) => (cur === '' ? sent : cur))
  }

  const runTurn = async (sent, list) => {
    let ok = false
    try {
      // `sendBody` posts {prompt} for all three and {prompt, slots} for a strict subset.
      ok = await startTurn({ prompt: sent, slots: list })
    } finally {
      finish(ok, sent)
    }
  }

  const send = async () => {
    if (!canSend || sendingRef.current) return
    const sent = text
    const list = targets
    sendingRef.current = true
    setText('')
    setInFlight(list)
    setCreateError(null)
    // The composer text is the prompt: Undo would now put back a text that was already sent.
    setPreparsed(null)
    setPreparseError(null)
    dispatch({ type: 'preparse/clear' })
    dispatch({ type: 'panes/sendStart', targets: list })
    if (!conversation) {
      let conv = null
      try {
        conv = await createConversation(dispatch, { slot_config: desktopSlotConfig() })
      } catch (e) {
        if (alive.current) setCreateError((e && e.message) || 'could not create conversation')
        finish(false, sent)
        return
      }
      if (alive.current) setQueued({ prompt: sent, slots: list, convId: conv.id })
      return
    }
    await runTurn(sent, list)
  }

  // The queued turn starts once the store shows the conversation the create produced: this render's
  // `startTurn` closes over it, so the hook's own create path is not taken.
  useEffect(() => {
    if (!queued || !conversation || conversation.id !== queued.convId) return
    const q = queued
    setQueued(null)
    runTurn(q.prompt, q.slots)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the created conversation lands
  }, [queued, conversation])

  const startPreparse = async (e) => {
    if (!canPreparse || preparsingRef.current) return
    const typed = text
    const active = typeof document !== 'undefined' ? document.activeElement : null
    refocusRef.current = !!active && (active === ref.current || active === (e && e.currentTarget))
    preparsingRef.current = true
    cancelRef.current = false
    typedRef.current = typed
    setPreparsing(true)
    setCancelled(false)
    setPreparseError(null)
    setCreateError(null)
    if (typeof clearChatError === 'function') clearChatError()
    dispatch({ type: 'preparse/clear' })
    try {
      let id = conversation ? conversation.id : null
      if (id === null) {
        const created = await createAdopted()
        if (!created) return // the hook's `error` is the banner; the text is untouched
        id = created.id
      }
      if (cancelRef.current) return // cancelled during the create round-trip: nothing was asked
      await run(PREPARSE, `/api/conversations/${id}/preparse`, { prompt: typed })
    } catch (err) {
      // A pre-stream failure (404, 409 busy, 422 empty_prompt / prompt_too_long) or a transport
      // error: runStream has reported sse/end{ok:false} already; the body's detail carries what the
      // plain words need (prompt_too_long's chars / max).
      if (alive.current) setPreparseError({ code: (err && err.code) || (err && err.message) || 'error', detail: (err && err.body && err.body.detail) || null })
    } finally {
      preparsingRef.current = false
      if (alive.current) {
        setPreparsing(false)
        if (cancelRef.current) setCancelled(true)
      }
    }
  }

  const cancelPreparse = () => {
    if (!preparsingRef.current) return
    cancelRef.current = true
    abortStream(PREPARSE)
  }

  const undoPreparse = () => {
    if (!preparsed || busy) return
    setText(preparsed.original)
    setPreparsed(null)
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

  const sendTitle = sending ? 'a send is in flight' : preparsing ? 'pre-parse in progress' : locked ? 'a stream is running' : empty ? 'type a prompt first' : targets.length === 0 ? 'pick at least one target' : 'Send to every checked site (Enter)'
  const newChatTitle = preparsing ? 'pre-parse in progress' : busy ? 'a stream is running' : `Start a new ${APP_NAME} conversation and a new chat in every site (Ctrl+Shift+N)`
  const preparseTitle = preparsing
    ? PREPARSE_TITLES.running
    : creating
      ? PREPARSE_TITLES.creating
      : sending
      ? PREPARSE_TITLES.sending
      : analystBusy
        ? PREPARSE_TITLES.analystBusy
        : locked
          ? PREPARSE_TITLES.stream
          : empty
            ? PREPARSE_TITLES.empty
            : !analystChosen
              ? PREPARSE_TITLES.noAnalyst
              : unedited
                ? PREPARSE_TITLES.unedited
                : PREPARSE_TITLES.ready
  const preparseState = preparsing ? 'running' : preparsed ? 'done' : cancelled ? 'cancelled' : null
  const preparseStatusText = preparsing ? `${preparse.notice || PREPARSE_RUNNING_TEXT} ${elapsed} s` : preparsed ? `Pre-parsed · ${preparsed.prompt.length} chars` : 'pre-parse cancelled'
  // A pre-stream failure (caught above, with the body's detail) or the stream's own verdict
  // (degraded / error); both clear on the next Pre-parse or Send.
  const preparseFailure = preparseError || (preparse.status === 'degraded' || preparse.status === 'error' ? { code: preparse.error, detail: null } : null)
  const preparseMessage = preparseFailure ? preparseBanner(preparseFailure.code, preparseFailure.detail) : null
  const message = banner || createError || preparseMessage || chatError || null

  return (
    <div
      className={css.promptBar}
      data-testid="prompt-bar"
      data-sending={sending ? 'true' : 'false'}
      data-locked={busy ? 'true' : 'false'}
      data-preparsing={preparsing ? 'true' : undefined}
      data-preparsed={preparsed ? 'true' : undefined}
    >
      {!bridge.connected ? (
        <div className={css.bridgeBanner} data-testid="bridge-banner" role="status">
          {BRIDGE_BANNER_TEXT}
          {bridge.error ? <span className={css.bridgeError} data-testid="bridge-banner-error">{` Backend: ${bridge.error}`}</span> : null}
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
          rows={preparsed ? 6 : 2}
          value={text}
          readOnly={busy}
          aria-busy={busy}
          onChange={(e) => {
            setText(e.target.value)
            if (preparsed) setPreparsed(null) // edited: the typed text is no longer what Undo would restore
          }}
          onKeyDown={onKeyDown}
        />
        <button type="button" className={css.preparseBtn} data-testid="prompt-preparse" disabled={!canPreparse} title={preparseTitle} onClick={startPreparse}>
          {preparsing ? 'Pre-parsing…' : 'Pre-parse'}
        </button>
        <button type="button" className={css.sendBtn} data-testid="prompt-send" disabled={!canSend} title={sendTitle} onClick={send}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className={css.promptMeta}>
        {preparseState ? (
          <span className={css.preparseStatus} data-testid="prompt-preparse-status" data-state={preparseState} role="status" aria-live="polite">
            {preparseStatusText}
          </span>
        ) : null}
        {preparsing ? (
          <button type="button" className={css.undoBtn} data-testid="prompt-preparse-cancel" title={PREPARSE_TITLES.cancel} onClick={cancelPreparse}>
            Cancel
          </button>
        ) : null}
        {preparsed ? (
          <button type="button" className={css.undoBtn} data-testid="prompt-preparse-undo" disabled={busy} title={PREPARSE_TITLES.undo} onClick={undoPreparse}>
            Undo
          </button>
        ) : null}
        <span className={css.targets} role="group" aria-label="Targets">
          {SLOT_IDS.map((slot) => (
            <label key={slot} className={css.target} data-slot={slot}>
              <input type="checkbox" data-testid={`prompt-target-${slot}`} checked={!!targetMap[slot]} onChange={(e) => dispatch({ type: 'panes/target', slot, on: e.target.checked })} />
              {SLOT_LABELS[slot]}
            </label>
          ))}
        </span>
        <button type="button" className={css.newChat} data-testid="prompt-newchat" disabled={busy || creating} title={newChatTitle} onClick={newChat}>
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
