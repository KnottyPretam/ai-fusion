// SlotConfigBar (W12): the global bar — analyst model, default Fusion max_iterations, grounded
// toggle and the materiality threshold. Every change is an optimistic saveSlotConfig() PUT of
// the merged full SlotConfig (frozen loader). Per-column model/effort controls belong to the
// Send pane (W9). Uses the frozen slotConfig / models / conversation slices; no slice of its own.
import { useEffect, useState } from 'react'
import { loadModels, saveSlotConfig } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import css from './config.module.css'

export const ITERATION_OPTIONS = [1, 2, 3, 4, 5]
export const MATERIALITY_OPTIONS = ['low', 'medium', 'high']

export default function SlotConfigBar() {
  const dispatch = useDispatch()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const models = useSlice('models') || { items: [], byId: {}, loaded: false, error: null }
  const [error, setError] = useState(null)

  useEffect(() => {
    loadModels(dispatch).catch(() => {})
  }, [dispatch])

  const conversationId = conversation ? conversation.id : null
  const disabled = !conversationId || !slotConfig

  const save = (patch) => {
    if (disabled) return
    setError(null)
    saveSlotConfig(dispatch, conversationId, patch, slotConfig).catch((e) => setError((e && (e.code || e.message)) || 'save failed'))
  }

  const analyst = slotConfig ? slotConfig.analyst_model : ''
  const items = models.items || []
  const analystOptions = analyst && !items.some((m) => m.id === analyst) ? [{ id: analyst, name: analyst }, ...items] : items

  return (
    <div className={css.bar} data-testid="slot-config-bar">
      <label className={css.field}>
        <span className={css.label}>Analyst</span>
        <select data-testid="config-analyst-model" value={analyst} disabled={disabled} onChange={(e) => save({ analyst_model: e.target.value })}>
          {!analyst && <option value="">—</option>}
          {analystOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.label}>Fusion iterations</span>
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
