// Sidebar (W12): conversation list. Loads the list on mount, creates / selects / renames /
// deletes through the frozen loaders / primitives in api/http.js, and renders state.conversation
// (title, turn count, updated_at) for the selected row (the backend auto-titles a conversation on
// its first Send and W9 refreshes the list afterwards; later streams only refetch the
// conversation). New / select / delete are disabled while ANY feature stream is running: the
// pane that opened the stream refetches the conversation it captured when the stream ends, so a
// switch mid-stream would snap back and book the in-flight usage into the wrong conversation.
// Uses the frozen conversation / conversations / streams slices; no slice of its own.
import { useEffect, useRef, useState } from 'react'
import { api, createConversation, deleteConversation, loadConversations, renameConversation } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import css from './conversations.module.css'
import { APP_NAME } from '../../branding.js'
import logoUrl from '../../assets/logo.png'

export const STREAM_FEATURES = ['send', 'analyze', 'fusion']
const CREATING = Symbol('creating')

export function fmtWhen(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function errorText(e) {
  return (e && (e.code || e.message)) || 'request failed'
}

export default function Sidebar() {
  const dispatch = useDispatch()
  const conversations = useSlice('conversations') || []
  const current = useSlice('conversation')
  const streams = useSlice('streams') || {}
  const busy = STREAM_FEATURES.some((k) => streams[k] && streams[k].status === 'streaming')
  const [listLoaded, setListLoaded] = useState(false) // first list request settled (ok or not)
  const [editing, setEditing] = useState(null) // {id, title} while renaming
  const [confirming, setConfirming] = useState(null) // id awaiting delete confirmation
  const [error, setError] = useState(null)
  const editingRef = useRef(null)
  editingRef.current = editing
  // The user's latest selection intent: set synchronously by the handlers (so an in-flight
  // request can tell it was superseded) and synced from the store when the selection changes
  // elsewhere (the Send composer creating a conversation).
  const selectedRef = useRef(current ? current.id : null)
  const selectSeq = useRef(0)
  useEffect(() => {
    selectedRef.current = current ? current.id : null
  }, [current])

  useEffect(() => {
    loadConversations(dispatch)
      .catch(() => {})
      .then(() => setListLoaded(true))
  }, [dispatch])

  const run = (p) => {
    setError(null)
    return p.catch((e) => setError(errorText(e)))
  }

  const onNew = () => {
    selectSeq.current += 1 // supersedes any in-flight select
    selectedRef.current = CREATING
    return run(createConversation(dispatch, {}))
  }
  // Only the most recent click lands in the store: two quick selects issue two GETs and the
  // frozen loader would apply whichever response arrives last.
  const onSelect = (id) => {
    const n = (selectSeq.current += 1)
    selectedRef.current = id
    const fresh = () => selectSeq.current === n
    return run(
      api.getConversation(id).then(
        (conversation) => {
          if (fresh()) dispatch({ type: 'conversation/loaded', conversation })
        },
        (e) => {
          if (fresh()) throw e
        },
      ),
    )
  }
  const onDelete = (id) => {
    setConfirming(null)
    const wasCurrent = Boolean(current && current.id === id)
    return run(
      deleteConversation(dispatch, id).then(() => {
        // The frozen loader only dispatches conversation/deleted, which the frozen slotConfig
        // reducer (and the send / analyze slices) ignore: drop the selection explicitly so the
        // deleted document's config and buffers do not linger — unless the user has already
        // moved on to another conversation meanwhile.
        const sel = selectedRef.current
        if (wasCurrent && (sel === id || sel === null)) dispatch({ type: 'conversation/cleared' })
      }),
    )
  }

  const startRename = (c) => {
    setConfirming(null)
    setEditing({ id: c.id, title: current && current.id === c.id ? current.title : c.title })
  }
  const cancelRename = () => setEditing(null)
  const commitRename = (original) => {
    const ed = editingRef.current
    if (!ed) return
    setEditing(null)
    const title = ed.title.trim()
    if (!title || title === original) return
    run(renameConversation(dispatch, ed.id, title))
  }

  return (
    <div className={css.sidebar} data-testid="conversations">
      <div className={css.header}>
        <span className={css.brand}>{APP_NAME}</span>
        <button type="button" className={css.newBtn} data-testid="conv-new" onClick={onNew} disabled={busy} title="Start an empty conversation with its own three threads. Disabled while a stream is running.">
          + New conversation
        </button>
      </div>
      {busy && (
        <div className={css.hint} data-testid="conv-busy-hint">
          a stream is running
        </div>
      )}
      {error && (
        <div className={css.error} role="alert" data-testid="conv-error">
          {error}
        </div>
      )}
      {conversations.length > 0 ? (
        <ul className={css.list} data-testid="conv-list">
          {conversations.map((c) => {
            const selected = Boolean(current && current.id === c.id)
            const title = selected ? current.title : c.title
            // The selected conversation is refetched after every stream; the list summary only
            // after the first Send, so the live document is the fresher source for its row.
            const n = selected && Array.isArray(current.turns) ? current.turns.length : (c.turn_count ?? 0)
            const when = selected && current.updated_at ? current.updated_at : c.updated_at
            const isEditing = editing && editing.id === c.id
            const isConfirming = confirming === c.id
            return (
              <li
                key={c.id}
                className={selected ? `${css.row} ${css.selected}` : css.row}
                data-testid="conv-row"
                data-id={c.id}
                data-selected={selected ? 'true' : 'false'}
                aria-current={selected ? 'true' : undefined}
              >
                {isEditing ? (
                  <input
                    className={css.rename}
                    data-testid="conv-rename-input"
                    autoFocus
                    value={editing.title}
                    onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(title)
                      else if (e.key === 'Escape') cancelRename()
                    }}
                    onBlur={() => commitRename(title)}
                  />
                ) : isConfirming ? (
                  <div className={css.confirm} data-testid="conv-delete-prompt">
                    <span>Delete?</span>
                    <button type="button" className={css.danger} data-testid="conv-delete-confirm" onClick={() => onDelete(c.id)} disabled={busy} title="Delete this conversation, its three threads and every report on it. This cannot be undone.">
                      Delete
                    </button>
                    <button type="button" data-testid="conv-delete-cancel" onClick={() => setConfirming(null)} title="Keep it.">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" className={css.select} data-testid="conv-select" onClick={() => onSelect(c.id)} title={title} disabled={busy}>
                    <span className={css.title} data-testid="conv-title">
                      {title}
                    </span>
                    <span className={css.meta} data-testid="conv-meta">
                      {fmtWhen(when)} · {n} {n === 1 ? 'turn' : 'turns'}
                    </span>
                  </button>
                )}
                {!isEditing && !isConfirming && (
                  <div className={css.actions}>
                    <button type="button" data-testid="conv-rename" onClick={() => startRename(c)} title="Rename it. Enter saves, Escape cancels; the first prompt named it.">
                      Rename
                    </button>
                    <button type="button" data-testid="conv-delete" onClick={() => setConfirming(c.id)} disabled={busy} title="Delete this conversation. You are asked to confirm first.">
                      Delete
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      ) : listLoaded ? (
        <div className={css.empty} data-testid="conv-empty">
          No conversations yet. Create one, or type a prompt and Send.
        </div>
      ) : (
        <div className={css.empty} data-testid="conv-loading" aria-busy="true">
          loading…
        </div>
      )}
      {/* The mark, in the bottom-left corner of the window (user request). It sits in the sidebar
          footer rather than floating: the site views are native surfaces painted OVER the renderer,
          so anything overlapping a pane would be behind a page. The sidebar is never under one. */}
      <footer className={css.mark} data-testid="brand-mark" title={`${APP_NAME} — three model subscriptions in one window`}>
        <img src={logoUrl} alt="" width="28" height="28" />
        <span>{APP_NAME}</span>
      </footer>
    </div>
  )
}
