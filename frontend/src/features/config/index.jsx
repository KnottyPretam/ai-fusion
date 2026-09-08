// SlotConfigBar (W12): the global bar — analyst model, the DEFAULT Fusion max_iterations (the
// Fusion pane's per-run stepper starts from it), grounded toggle and the materiality threshold.
// Every change is an optimistic slotConfig/update followed by a PUT of the merged full SlotConfig
// (the same steps as the frozen saveSlotConfig loader, done here with the frozen api primitives
// so that only the LATEST save's server copy can land in the store). Per-column model/effort
// controls belong to the Send pane (W9). Uses the frozen slotConfig / models / conversation
// slices; no slice of its own.
import { useEffect, useRef, useState } from 'react'
import { api, loadModels, mergeSlotConfig } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import css from './config.module.css'

export const ITERATION_OPTIONS = [1, 2, 3, 4, 5]
export const MATERIALITY_OPTIONS = ['low', 'medium', 'high']
const EMPTY_MODELS = { items: [], byId: {}, loaded: false, error: null }

const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))

// The analyst answers in strict JSON, so models advertising structured outputs come first (the
// live catalog is the whole OpenRouter list); the rest stay available further down.
export function analystGroups(items) {
  return {
    structured: items.filter((m) => m.structured_outputs).sort(byName),
    other: items.filter((m) => !m.structured_outputs).sort(byName),
  }
}

function label(m) {
  return m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id
}

export default function SlotConfigBar() {
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const models = useSlice('models') || EMPTY_MODELS
  const [error, setError] = useState(null)
  const conversationId = conversation ? conversation.id : null
  const disabled = !conversationId || !slotConfig
  const saveSeq = useRef(0) // the latest save; only its response may land in the store
  const convRef = useRef(conversationId)
  convRef.current = conversationId

  useEffect(() => {
    // The Send pane loads the same catalog; skip when the store already has it (or a failure).
    if (!models.loaded && !models.error) loadModels(dispatch).catch(() => {})
  }, [dispatch, models.loaded, models.error])

  // Two quick changes are two in-flight PUTs: without the sequence check the earlier response
  // arriving last would revert the later change. A response for a conversation that is no
  // longer selected is dropped too (the frozen slotConfig reducer takes any slotConfig/loaded).
  const save = async (patch) => {
    if (disabled) return
    setError(null)
    const n = (saveSeq.current += 1)
    const id = conversationId
    const settle = (cfg) => {
      if (saveSeq.current === n && convRef.current === id) dispatch({ type: 'slotConfig/loaded', conversationId: id, slotConfig: cfg })
    }
    dispatch({ type: 'slotConfig/update', patch })
    try {
      settle(await api.putSlotConfig(id, mergeSlotConfig(slotConfig, patch)))
    } catch (e) {
      if (saveSeq.current !== n) return // a later save carries this change too; its outcome wins
      setError((e && (e.code || e.message)) || 'save failed')
      try {
        settle(await api.getSlotConfig(id))
      } catch {
        /* the optimistic value stays until the next conversation load */
      }
    }
  }

  const analyst = slotConfig ? slotConfig.analyst_model : ''
  const items = models.items || []
  const unknownAnalyst = Boolean(analyst) && !items.some((m) => m.id === analyst)
  const { structured, other } = analystGroups(items)
  const grouped = structured.length > 0 && other.length > 0
  const opt = (m) => (
    <option key={m.id} value={m.id}>
      {label(m)}
    </option>
  )

  return (
    <div className={css.bar} data-testid="slot-config-bar">
      <label className={css.field}>
        <span className={css.label}>Analyst</span>
        <select data-testid="config-analyst-model" value={analyst} disabled={disabled} onChange={(e) => save({ analyst_model: e.target.value })}>
          {!analyst && <option value="">—</option>}
          {unknownAnalyst && <option value={analyst}>{analyst}</option>}
          {grouped ? (
            <>
              <optgroup label="structured outputs (recommended)">{structured.map(opt)}</optgroup>
              <optgroup label="other models">{other.map(opt)}</optgroup>
            </>
          ) : (
            [...structured, ...other].map(opt)
          )}
        </select>
      </label>
      <label className={css.field} title="Default for the Fusion pane's iterations stepper; each Fusion run can override it.">
        <span className={css.label}>Fusion iterations (default)</span>
        <select
          data-testid="config-max-iterations"
          value={slotConfig ? String(slotConfig.max_iterations) : ''}
          disabled={disabled}
          onChange={(e) => save({ max_iterations: Number(e.target.value) })}
        >
          {!slotConfig && <option value="">—</option>}
          {ITERATION_OPTIONS.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.label}>Fuse materiality ≥</span>
        <select
          data-testid="config-materiality-min"
          value={slotConfig ? slotConfig.materiality_min : ''}
          disabled={disabled}
          onChange={(e) => save({ materiality_min: e.target.value })}
        >
          {!slotConfig && <option value="">—</option>}
          {MATERIALITY_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <input
          type="checkbox"
          data-testid="config-grounded"
          checked={Boolean(slotConfig && slotConfig.grounded)}
          disabled={disabled}
          onChange={(e) => save({ grounded: e.target.checked })}
        />
        <span>Grounded (web search on Send)</span>
      </label>
      {disabled && (
        <span className={css.hint} data-testid="config-hint">
          select or create a conversation to edit its settings
        </span>
      )}
      {models.error && !models.loaded && (
        <span className={css.hint} data-testid="config-models-error">
          model catalog unavailable
        </span>
      )}
      {error && (
        <span className={css.error} role="alert" data-testid="config-error">
          {error}
        </span>
      )}
    </div>
  )
}
