// W9 (send-ui). The Send pane: three live columns (claude | chatgpt | grok) plus the main
// composer. The stream lifecycle for both Send and per-column solo continue — create a
// conversation when none, run('send', …), the isCurrent-guarded refetch, the first-send list
// refresh, the conversation-scoped pending prompt / banner and the composer lock from submit
// (including the create round-trip of a first send) until the refetch settles — lives in
// useSendTurn.js (Stage 2: shared with the desktop PromptBar); this pane is its consumer.
// Stage 3 (renderer-drawer): `composer={false}` renders the three columns (and the banner) without
// the main composer form — the desktop drawer's Captured tab, where the unified prompt bar is the
// composer; the default (`true`) is the web pane exactly as before.
import { useEffect, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { loadModels } from '../../api/http.js'
import SlotColumn from './SlotColumn.jsx'
import { SLOT_IDS } from './slice.js'
import { useSendTurn } from './useSendTurn.js'
import styles from './send.module.css'

// Shown next to the main composer while slotConfig.grounded is on (PLAN §8 Phase 5).
export const GROUNDED_HINT_TITLE =
  'Grounded mode: every Send (three calls) and every solo continue carries the OpenRouter web-search plugin, which adds a per-request search fee plus the prompt tokens of the injected results. Analyze and Fusion calls are never grounded. Toggle it in the config bar.'

export default function SendPane({ composer = true }) {
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || { loaded: false, error: null }
  const [prompt, setPrompt] = useState('')
  const currentId = conversation ? conversation.id : null

  // Model catalog for the dropdowns. Rejections are swallowed: the frozen smoke test renders
  // <App/> under Node's fetch, where a relative URL rejects.
  useEffect(() => {
    if (!models.loaded && !models.error) loadModels(dispatch).catch(() => {})
  }, []) // once per mount on purpose: the catalog is global and other panes may load it too

  const { startTurn, locked, pending, banner } = useSendTurn()
  const sendStreaming = streams.send && streams.send.status === 'streaming'

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
      {composer ? (
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
      ) : null}
    </div>
  )
}
