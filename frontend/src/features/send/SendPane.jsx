// W9 (send-ui). The Send pane: one live column per council member (2..5 of the catalog, in catalog
// order) plus the main composer. The stream lifecycle for both Send and per-column solo continue — create a
// conversation when none, run('send', …), the isCurrent-guarded refetch, the first-send list
// refresh, the conversation-scoped pending prompt / banner and the composer lock from submit
// (including the create round-trip of a first send) until the refetch settles — lives in
// useSendTurn.js (Stage 2: shared with the desktop PromptBar); this pane is its consumer.
// Stage 3 (renderer-drawer): `composer={false}` renders the columns (and the banner) without
// the main composer form — the desktop drawer's Captured tab, where the unified prompt bar is the
// composer; the default (`true`) is the web pane exactly as before.
// Council (2026-09-27): `council` (optional, an ordered list of slot ids) names the columns; without
// it the pane derives them — the open conversation's `slotConfig`, else the desktop default in
// `panes.council` (a slice read by KEY, absent under the web app), else DEFAULT_COUNCIL. The grid
// reports `data-council-size`; the CSS lays the columns out by count, not by a fixed three.
import { useEffect, useState } from 'react'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { loadModels } from '../../api/http.js'
import ExportControl from '../export/ExportControl.jsx'
import { latestChatTurn } from '../export/formats.js'
import SlotColumn from './SlotColumn.jsx'
import { DEFAULT_COUNCIL, councilOf } from './slice.js'
import { useSendTurn } from './useSendTurn.js'
import styles from './send.module.css'

// Shown next to the main composer while slotConfig.grounded is on (PLAN §8 Phase 5).
export const GROUNDED_HINT_TITLE =
  'Grounded mode: every Send (one call per agent) and every solo continue carries the OpenRouter web-search plugin, which adds a per-request search fee plus the prompt tokens of the injected results. Analyze and Fusion calls are never grounded. Toggle it in the config bar.'

/** Composer wording for a council of n: "all three models" reads the count, never a fixed three. */
export function councilWords(n) {
  const words = { 2: 'both', 3: 'all three', 4: 'all four', 5: 'all five' }
  return words[n] || `all ${n}`
}

export default function SendPane({ composer = true, council: councilProp = null }) {
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || { loaded: false, error: null }
  const panes = useSlice('panes') // desktop only (read by key; never imported)
  const [prompt, setPrompt] = useState('')
  const currentId = conversation ? conversation.id : null
  const council = (Array.isArray(councilProp) && councilProp.length ? councilProp : null) || councilOf(slotConfig) || councilOf(panes && panes.council) || DEFAULT_COUNCIL
  const all = councilWords(council.length)

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
  // Export writes out the newest chat step these columns are showing: the latest Send turn, or the
  // solo Continue after it. Derived from the loaded conversation, no extra fetch.
  const latestChat = latestChatTurn(conversation)

  return (
    <div className={styles.pane} data-testid="send-grid-root">
      <div className={styles.grid} data-testid="send-grid" data-council-size={council.length}>
        {council.map((slot) => (
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
      <div className={styles.toolbar}>
        <ExportControl
          feature="send"
          conversationId={currentId}
          turnId={latestChat ? latestChat.id : null}
          turnType={latestChat ? latestChat.type : null}
          title={conversation ? conversation.title : ''}
          busy={locked}
        />
      </div>
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
              aria-label={`Prompt for ${all} models`}
              placeholder={conversation ? `Send to ${all} models… (Enter to send, Shift+Enter for a newline)` : `Start a conversation: send a prompt to ${all} models (Enter to send)`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={locked}
              rows={3}
            />
          </div>
          <button type="submit" className={styles.sendButton} data-testid="send-button" disabled={locked || !prompt.trim()} title={`Send this prompt to ${all} models at once. Each answers in its own thread, with its own history.`}>
            {sendStreaming ? 'Streaming…' : 'Send'}
          </button>
        </form>
      ) : null}
    </div>
  )
}
