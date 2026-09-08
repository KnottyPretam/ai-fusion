// Sidebar (W12): conversation list. Loads the list on mount, creates / selects / renames /
// deletes through the frozen loaders in api/http.js, and renders state.conversation.title for
// the selected row (the backend auto-titles a conversation on its first Send and W9 refreshes
// the list afterwards). Uses the frozen conversation / conversations slices; no slice of its own.
import { useEffect, useRef, useState } from 'react'
import { createConversation, deleteConversation, loadConversation, loadConversations, renameConversation } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import css from './conversations.module.css'

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
  const [editing, setEditing] = useState(null) // {id, title} while renaming
  const [confirming, setConfirming] = useState(null) // id awaiting delete confirmation
  const [error, setError] = useState(null)
  const editingRef = useRef(null)
  editingRef.current = editing

  useEffect(() => {
    loadConversations(dispatch).catch(() => {})
  }, [dispatch])

  const run = (p) => {
    setError(null)
    return p.catch((e) => setError(errorText(e)))
  }

  const onNew = () => run(createConversation(dispatch, {}))
  const onSelect = (id) => run(loadConversation(dispatch, id))
  const onDelete = (id) => {
    setConfirming(null)
    return run(deleteConversation(dispatch, id))
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
        <span className={css.brand}>Triplex</span>
        <button type="button" className={css.newBtn} data-testid="conv-new" onClick={onNew}>
          + New conversation
        </button>
      </div>
      {error && (
        <div className={css.error} role="alert" data-testid="conv-error">
          {error}
        </div>
      )}
      {conversations.length === 0 ? (
        <div className={css.empty} data-testid="conv-empty">
          No conversations yet. Create one, or type a prompt and Send.
        </div>
      ) : (
        <ul className={css.list} data-testid="conv-list">
          {conversations.map((c) => {
            const selected = Boolean(current && current.id === c.id)
            const title = selected ? current.title : c.title
            const n = c.turn_count ?? 0
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
                    <button type="button" className={css.danger} data-testid="conv-delete-confirm" onClick={() => onDelete(c.id)}>
                      Delete
                    </button>
                    <button type="button" data-testid="conv-delete-cancel" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" className={css.select} data-testid="conv-select" onClick={() => onSelect(c.id)} title={title}>
                    <span className={css.title} data-testid="conv-title">
                      {title}
                    </span>
                    <span className={css.meta} data-testid="conv-meta">
                      {fmtWhen(c.updated_at)} · {n} {n === 1 ? 'turn' : 'turns'}
                    </span>
                  </button>
                )}
                {!isEditing && !isConfirming && (
                  <div className={css.actions}>
                    <button type="button" data-testid="conv-rename" onClick={() => startRename(c)}>
                      Rename
                    </button>
                    <button type="button" data-testid="conv-delete" onClick={() => setConfirming(c.id)}>
                      Delete
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
