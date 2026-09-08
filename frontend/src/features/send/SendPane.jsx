// W9 (send-ui). The Send pane: three live columns (claude | chatgpt | grok) plus the main
// composer. Owns the stream lifecycle for both Send and per-column solo continue:
//   no conversation -> createConversation(dispatch, {}) first
//   run('send', url, {prompt})            (continue also streams under feature key 'send')
//   then loadConversation(dispatch, id)   (the persisted thread becomes the source of truth)
//   and, after the conversation's first send, loadConversations(dispatch) (backend auto-titles).
//
// Conversation isolation: a turn belongs to the conversation it was started in (`id`). If the
// user switches / clears / deletes the conversation while its stream is open, the `slots` slice
// has already dropped the live columns (conversation/loaded|cleared) and ignores the stale
// stream's later events; here the pending prompt bubble is scoped to that conversation id, the
// post-stream refetch of `id` is skipped (it would navigate the user back), and the error banner
// is retired. The composer stays locked from submit until the refetch settles, so a second turn
// cannot start in the sse/end -> conversation/loaded gap.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useRunStream } from '../../api/runStream.js'
import { createConversation, loadConversation, loadConversations, loadModels } from '../../api/http.js'
import SlotColumn from './SlotColumn.jsx'
import { SLOT_IDS } from './slice.js'
import styles from './send.module.css'

const STREAM_KEYS = ['send', 'analyze', 'fusion']

// Shown next to the main composer while slotConfig.grounded is on (PLAN §8 Phase 5).
export const GROUNDED_HINT_TITLE =
  'Grounded mode: every Send (three calls) and every solo continue carries the OpenRouter web-search plugin, which adds a per-request search fee plus the prompt tokens of the injected results. Analyze and Fusion calls are never grounded. Toggle it in the config bar.'

export default function SendPane() {
  const dispatch = useDispatch()
  const run = useRunStream()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || { loaded: false, error: null }
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(null) // { prompt, slots, convId } while a turn is in flight
  const [inFlight, setInFlight] = useState(false) // submit -> post-stream refetch settled
  const [localError, setLocalError] = useState(null)
  // Conversation id (null = none) the current turn / banner belongs to; `undefined` = retired.
  const [bannerFor, setBannerFor] = useState(undefined)
  const currentId = conversation ? conversation.id : null
  // Latest rendered conversation id, readable after the awaits in startTurn.
  const convIdRef = useRef(null)
  convIdRef.current = currentId

  // Model catalog for the dropdowns. Rejections are swallowed: the frozen smoke test renders
  // <App/> under Node's fetch, where a relative URL rejects.
  useEffect(() => {
    if (!models.loaded && !models.error) loadModels(dispatch).catch(() => {})
  }, []) // once per mount on purpose: the catalog is global and other panes may load it too

  // A conversation switch retires the banner of the previous one for good.
  useEffect(() => {
    setBannerFor((f) => (f === currentId ? f : undefined))
  }, [currentId])

  const sendStreaming = streams.send && streams.send.status === 'streaming'
  const anyStreaming = STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')
  const locked = anyStreaming || inFlight

  const startTurn = useCallback(
    async ({ slot = null, prompt: raw }) => {
      const text = (raw || '').trim()
      if (!text) return false
      setLocalError(null)
      setBannerFor(conversation ? conversation.id : null)
      let conv = conversation
      if (!conv) {
        if (slot) return false // solo continue needs an existing conversation
        try {
          conv = await createConversation(dispatch, {})
        } catch (e) {
          setLocalError(e && e.message ? e.message : 'could not create conversation')
          return false
        }
        // createConversation dispatched conversation/loaded; the render that mirrors it into the
        // ref may not have flushed before a fast stream ends.
        convIdRef.current = conv.id
      }
      const id = conv.id
      setBannerFor(id)
      const firstSend = !slot && !(conv.turns || []).length
      const url = slot ? `/api/conversations/${id}/slots/${slot}/continue` : `/api/conversations/${id}/send`
      setPending({ prompt: text, slots: slot ? [slot] : SLOT_IDS, convId: id })
      setInFlight(true)
      let ok = true
      try {
        await run('send', url, { prompt: text })
      } catch {
        ok = false // streams.send.error carries the message (sse/end{ok:false})
      }
      try {
        if (convIdRef.current !== id) {
          // Switched / cleared / deleted mid-stream: the columns were reset already and refetching
          // `id` would silently navigate the user back to it.
          setPending(null)
        } else {
          try {
            await loadConversation(dispatch, id)
            setPending(null)
          } catch {
            if (!ok) setPending(null) // else keep the prompt bubble next to the live reply
          }
        }
        // The backend auto-titled the conversation on its first send; the list refresh does not
        // navigate, so it runs even when the user has moved on.
        if (firstSend) loadConversations(dispatch).catch(() => {})
      } finally {
        setInFlight(false)
      }
      return ok
    },
    [conversation, dispatch, run],
  )

  function submit() {
    const text = prompt.trim()
    if (!text || locked) return
    setPrompt('')
    startTurn({ prompt: text })
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const streamError = streams.send && streams.send.status === 'error' ? streams.send.error : null
  const banner = bannerFor === currentId ? localError || streamError : null
  const grounded = !!(slotConfig && slotConfig.grounded)

  return (
    <div className={styles.pane} data-testid="send-grid-root">
      <div className={styles.grid} data-testid="send-grid">
        {SLOT_IDS.map((slot) => (
          <SlotColumn
            key={slot}
            slot={slot}
            busy={locked}
            pendingPrompt={pending && pending.convId === currentId && pending.slots.includes(slot) ? pending.prompt : null}
            onContinue={(text) => startTurn({ slot, prompt: text })}
          />
        ))}
      </div>
      {banner ? (
        <div className={styles.banner} data-testid="send-error" role="alert">
          {banner}
        </div>
      ) : null}
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className={styles.composerBody}>
          {grounded ? (
            <div className={`${styles.hint} ${styles.groundedHint}`} data-testid="send-grounded-hint" title={GROUNDED_HINT_TITLE}>
              web search on
            </div>
          ) : null}
          <textarea
            data-testid="send-composer"
            aria-label="Prompt for all three models"
            placeholder={conversation ? 'Send to all three models… (Enter to send, Shift+Enter for a newline)' : 'Start a conversation: send a prompt to all three models (Enter to send)'}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={locked}
            rows={3}
          />
        </div>
        <button type="submit" className={styles.sendButton} data-testid="send-button" disabled={locked || !prompt.trim()}>
          {sendStreaming ? 'Streaming…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
