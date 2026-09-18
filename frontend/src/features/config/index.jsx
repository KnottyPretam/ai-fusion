// SlotConfigBar (W12): the global bar — analyst model, the DEFAULT Fusion max_iterations (the
// Fusion pane's per-run stepper starts from it), grounded toggle and the materiality threshold.
// Every change is an optimistic slotConfig/update followed by a PUT of the merged full SlotConfig
// (the same steps as the frozen saveSlotConfig loader, done here with the frozen api primitives
// so that only the LATEST save's server copy can land in the store). Per-column model/effort
// controls belong to the Send pane (W9). Uses the frozen slotConfig / models / conversation
// slices; no slice of its own.
//
// Stage 3 (renderer-drawer): desktop mode. `desktop` groups the analyst picker as "web sessions
// (hidden analyst page)" — the three fixed `web:<slot>:analyst` ids (names from the desktop
// catalog when loaded, contract §6) — and "local Ollama" — every `ollama:<name>` the catalog
// lists — with a "none" option (plan Decision 4), and hides the grounded toggle (OpenRouter web
// search never applies to a web session). `analyst` + `onAnalystChange(model)` make the picker the
// DESKTOP CHOICE control: it is enabled without a conversation (its value is then `analyst`, the
// renderer's persisted choice), shows the open conversation's analyst_model when one is selected,
// and a change reports the new model to the caller (which mirrors it to localStorage and to
// Electron) AND PUTs it to the open conversation as before. Without these props (the web app)
// nothing changes.
import { useEffect, useRef, useState } from 'react'
import { api, loadModels, mergeSlotConfig } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import css from './config.module.css'

export const ITERATION_OPTIONS = [1, 2, 3, 4, 5]
export const MATERIALITY_OPTIONS = ['low', 'medium', 'high']
const EMPTY_MODELS = { items: [], byId: {}, loaded: false, error: null }

// PLAN §2 R6 / §8 Phase 5. Pricing wording follows docs/openrouter-notes.md "Web search": a
// per-request search fee (engine-dependent, roughly $0.001-$0.015; native search is billed by
// the provider) plus the prompt tokens of the injected results, on every grounded call.
export const GROUNDED_LABEL = 'Grounded (web search on Send)'
export const GROUNDED_TITLE =
  'Adds the OpenRouter web-search plugin to every Send (three calls) and every solo continue; never to Analyze or Fusion. ' +
  'Costs extra: each grounded call pays a per-request search fee (engine-dependent, roughly $0.001-$0.015; native search is billed by the provider) ' +
  'plus the prompt tokens of the injected results, on top of the model\'s own usage. Replies carry url citations.'

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

// Desktop (contract §6): the three web analysts are fixed ids whatever the catalog holds (offline
// the picker still works); Ollama entries come only from GET /api/models. Mirrored from
// backend/llm/webmodels.py (features never import across each other).
const DESKTOP_SLOTS = ['claude', 'chatgpt', 'grok']
const DESKTOP_SITE = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' }
export const WEB_ANALYST_GROUP = 'web sessions (hidden analyst page)'
export const OLLAMA_GROUP = 'local Ollama'
export const ANALYST_NONE_LABEL = '— none (Analyze disabled) —'

export function desktopAnalystGroups(items) {
  const byId = {}
  for (const m of items || []) if (m && typeof m.id === 'string') byId[m.id] = m
  const web = DESKTOP_SLOTS.map((slot) => {
    const id = `web:${slot}:analyst`
    return byId[id] || { id, name: `${DESKTOP_SITE[slot]} web session (hidden analyst page)` }
  })
  const ollama = (items || []).filter((m) => m && typeof m.id === 'string' && m.id.startsWith('ollama:')).sort(byName)
  return { web, ollama }
}

export default function SlotConfigBar({ desktop = false, analyst: analystChoice, onAnalystChange = null }) {
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

  const controlled = typeof onAnalystChange === 'function'
  const analyst = slotConfig ? slotConfig.analyst_model : controlled && typeof analystChoice === 'string' ? analystChoice : ''
  const items = models.items || []
  const opt = (m) => (
    <option key={m.id} value={m.id}>
      {label(m)}
    </option>
  )
  const onAnalyst = (e) => {
    const value = e.target.value
    if (controlled) onAnalystChange(value)
    save({ analyst_model: value }) // a no-op without a conversation
  }
  let analystSelect
  if (desktop) {
    const { web, ollama } = desktopAnalystGroups(items)
    const known = analyst === '' || web.some((m) => m.id === analyst) || ollama.some((m) => m.id === analyst)
    analystSelect = (
      <select data-testid="config-analyst-model" value={analyst || ''} disabled={controlled ? false : disabled} onChange={onAnalyst}>
        <option value="">{ANALYST_NONE_LABEL}</option>
        {!known && <option value={analyst}>{analyst}</option>}
        <optgroup label={WEB_ANALYST_GROUP}>{web.map(opt)}</optgroup>
        {ollama.length > 0 && <optgroup label={OLLAMA_GROUP}>{ollama.map(opt)}</optgroup>}
      </select>
    )
  } else {
    const unknownAnalyst = Boolean(analyst) && !items.some((m) => m.id === analyst)
    const { structured, other } = analystGroups(items)
    const grouped = structured.length > 0 && other.length > 0
    analystSelect = (
      <select data-testid="config-analyst-model" value={analyst} disabled={controlled ? false : disabled} onChange={onAnalyst}>
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
    )
  }

  return (
    <div className={css.bar} data-testid="slot-config-bar" data-mode={desktop ? 'desktop' : 'web'}>
      <label className={css.field}>
        <span className={css.label}>Analyst</span>
        {analystSelect}
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
      {desktop ? null : (
        <label className={css.field} title={GROUNDED_TITLE} data-testid="config-grounded-label">
          <input
            type="checkbox"
            data-testid="config-grounded"
            checked={Boolean(slotConfig && slotConfig.grounded)}
            disabled={disabled}
            onChange={(e) => save({ grounded: e.target.checked })}
          />
          <span>{GROUNDED_LABEL}</span>
        </label>
      )}
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
