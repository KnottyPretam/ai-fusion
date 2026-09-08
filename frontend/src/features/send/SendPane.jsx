// W9 (send-ui). The Send pane: three live columns (claude | chatgpt | grok) plus the main
// composer. Owns the stream lifecycle for both Send and per-column solo continue:
//   no conversation -> createConversation(dispatch, {}) first
//   run('send', url, {prompt})            (continue also streams under feature key 'send')
//   then loadConversation(dispatch, id)   (the persisted thread becomes the source of truth)
//   and, after the conversation's first send, loadConversations(dispatch) (backend auto-titles).
import { useCallback, useEffect, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { useRunStream } from '../../api/runStream.js'
import { createConversation, loadConversation, loadConversations, loadModels } from '../../api/http.js'
import SlotColumn from './SlotColumn.jsx'
import { SLOT_IDS } from './slice.js'
import styles from './send.module.css'

const STREAM_KEYS = ['send', 'analyze', 'fusion']

export default function SendPane() {
  const dispatch = useDispatch()
  const run = useRunStream()
  const conversation = useSlice('conversation')
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || { loaded: false, error: null }
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(null) // { prompt, slots } while a turn is in flight
  const [localError, setLocalError] = useState(null)

  // Model catalog for the dropdowns. Rejections are swallowed: the frozen smoke test renders
  // <App/> under Node's fetch, where a relative URL rejects.
  useEffect(() => {
    if (!models.loaded && !models.error) loadModels(dispatch).catch(() => {})
  }, []) // once per mount on purpose: the catalog is global and other panes may load it too

  const sendStreaming = streams.send && streams.send.status === 'streaming'
  const anyStreaming = STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')

  const startTurn = useCallback(
    async ({ slot = null, prompt: raw }) => {
      const text = (raw || '').trim()
      if (!text) return false
      setLocalError(null)
      let conv = conversation
      if (!conv) {
        if (slot) return false // solo continue needs an existing conversation
        try {
          conv = await createConversation(dispatch, {})
        } catch (e) {
          setLocalError(e && e.message ? e.message : 'could not create conversation')
          return false
        }
      }
      const id = conv.id
      const firstSend = !slot && !(conv.turns || []).length
      const url = slot ? `/api/conversations/${id}/slots/${slot}/continue` : `/api/conversations/${id}/send`
      setPending({ prompt: text, slots: slot ? [slot] : SLOT_IDS })
      let ok = true
      try {
        await run('send', url, { prompt: text })
      } catch {
        ok = false // streams.send.error carries the message (sse/end{ok:false})
      }
      try {
        await loadConversation(dispatch, id)
        setPending(null)
      } catch {
        if (!ok) setPending(null)
      }
      if (firstSend) loadConversations(dispatch).catch(() => {})
      return ok
    },
    [conversation, dispatch, run],
  )

  function submit() {
    const text = prompt.trim()
    if (!text || anyStreaming) return
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
  const banner = localError || streamError

  return (
    <div className={styles.pane} data-testid="send-grid-root">
      <div className={styles.grid} data-testid="send-grid">
        {SLOT_IDS.map((slot) => (
          <SlotColumn
            key={slot}
            slot={slot}
            busy={anyStreaming}
            pendingPrompt={pending && pending.slots.includes(slot) ? pending.prompt : null}
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
        <textarea
          data-testid="send-composer"
          aria-label="Prompt for all three models"
          placeholder={conversation ? 'Send to all three models… (Enter to send, Shift+Enter for a newline)' : 'Start a conversation: send a prompt to all three models (Enter to send)'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sendStreaming || anyStreaming}
          rows={3}
        />
        <button type="submit" className={styles.sendButton} data-testid="send-button" disabled={sendStreaming || anyStreaming || !prompt.trim()}>
          {sendStreaming ? 'Streaming…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
