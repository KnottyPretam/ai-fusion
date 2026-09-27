// AgentsPage (2026-09-27, "a council anyone can assemble"): the drawer's Agents tab. Assemble a
// council of 2..5 agents from the 7-vendor catalog — each on ONE transport (subscription web
// session / token based through OpenRouter / local Ollama) with a model and an effort — apply it to
// the open conversation, save it as main's default for new conversations, and hold the one
// OpenRouter key.
//
//   agents-page                          the container (data-source: 'conversation' | 'default')
//   agents-source                        which spec the rows came from (see sourceText)
//   agents-row-<slot>                    one row per member, in catalog order
//   agents-vendor-<slot>                 the vendor select (this row's vendor plus every unseated one)
//   agents-transport-<slot>-<web|openrouter|ollama>   transport radios (only what the vendor supports in Stage 1)
//   agents-model-<slot>                  model select from GET /api/models, filtered by vendor + transport
//   agents-model-custom-<slot>           an unlisted OpenRouter slug / Ollama name (`ollama:` auto-prefixed)
//   agents-effort-<slot>                 effort select
//   agents-remove-<slot>                 drop the row (disabled at two)
//   agents-add                           seat the next unseated vendor (disabled at five)
//   agents-summary                       "n agents → R1…Rn; labels are assigned per turn"
//   agents-error                         the first validation failure, or the server's refusal
//   agents-apply                         PUT the FULL slot_config to the open conversation — disabled
//                                        while any stream runs, without a conversation, with invalid
//                                        rows, and once the conversation has turns (the backend
//                                        answers 409 council_changed then; the title says so)
//   agents-default                       triplex.setCouncil(spec) → panes/council (main persists it)
//   agents-key / agents-key-save / agents-key-clear / agents-key-status / agents-key-hint
//                                        the key row: a password field, main's status line (the key
//                                        itself never comes back), and a hint when a row is on
//                                        OpenRouter without a key
//
// Sources and precedence: the rows start from the open conversation's `slotConfig` when one is
// selected (its council is what Apply edits), else from main's default (`panes.council`), else the
// classic three web panes; they re-seed whenever that source changes (a conversation switch, a
// council pushed by main) — local edits are a draft, never persisted on their own. The catalog is
// the desktop `GET /api/models` (`raw.transport`); an unlisted id goes through the custom field.
// Every `window.triplex` call is optional-chained: the page renders under a partial stub.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api as http, loadModels } from '../../api/http.js'
import { useDispatch, useSlice } from '../../state/store.jsx'
import {
  EFFORTS,
  TRANSPORT_LABELS,
  TRANSPORT_TITLES,
  anyOnOpenRouter,
  customModelId,
  defaultModelFor,
  defaultRows,
  freeSlots,
  keyStatusText,
  modelsFor,
  rowsFromSpec,
  sourceText,
  specFromRows,
  summaryText,
  transportsFor,
  validateCouncil,
} from './council.js'
import { desktopApi } from './PaneDeck.jsx'
import { COUNCIL_MAX, COUNCIL_MIN, SLOT_LABELS, initialPanes, slotStyle } from './slice.js'
import css from './desktop.module.css'

export const STREAM_KEYS = ['send', 'analyze', 'fusion', 'preparse', 'refactor']
export const APPLY_TITLES = {
  noConversation: 'Open or start a conversation to apply a council to it (Save as default covers new ones)',
  hasTurns: 'This conversation already has turns; its council is fixed (the backend answers council_changed). Start a new conversation for a different council.',
  streaming: 'a stream is running',
  invalid: 'fix the rows first',
  ready: 'Write this council to the open conversation (PUT slot_config, the full config)',
}
export const KEY_HINT = 'An agent is on OpenRouter but no key is saved: its column reports missing_api_key until one is.'
export const KEY_TITLE = 'One OpenRouter key for every token-based agent. Encrypted by Electron (safeStorage), pushed to the backend over the bridge token, never written to .env or shown again.'
/** The 409 the backend answers once a conversation has turns (backend/store/conversations.py). */
export const COUNCIL_CHANGED = 'council_changed'

/** The rows' identity for the re-seed effect: a source change, not a re-render, resets the draft. */
function sourceKey(source, spec) {
  return `${source}:${JSON.stringify(spec && spec.slots ? spec.slots : null)}`
}

function Row({ row, rows, models, onChange, onRemove, canRemove }) {
  const { slot, transport, model, effort } = row
  const vendors = freeSlots(rows, slot) // this row's vendor plus every unseated one, catalog order
  const transports = transportsFor(slot)
  const listed = modelsFor(slot, transport, models)
  const inList = listed.some((m) => m.id === model)
  const [custom, setCustom] = useState(inList ? '' : model)
  // A model that arrived from the spec but is not in the catalog shows in the custom field.
  useEffect(() => {
    setCustom(inList ? '' : model)
  }, [model, inList])
  const customAllowed = transport !== 'web'
  const setTransport = (t) => onChange({ ...row, transport: t, model: defaultModelFor(slot, t, models) })
  const setVendor = (next) => {
    const t = transportsFor(next).includes(transport) ? transport : transportsFor(next)[0]
    onChange({ ...row, slot: next, transport: t, model: defaultModelFor(next, t, models) })
  }
  return (
    <div className={css.agentsRow} data-testid={`agents-row-${slot}`} data-slot={slot} data-transport={transport} style={slotStyle(slot)}>
      <span className={css.agentsDot} aria-hidden="true" />
      <select className={css.agentsVendor} data-testid={`agents-vendor-${slot}`} aria-label="Agent" value={slot} onChange={(e) => setVendor(e.target.value)} title="Which vendor sits in this seat">
        {vendors.map((s) => (
          <option key={s} value={s}>
            {SLOT_LABELS[s]}
          </option>
        ))}
      </select>
      <span className={css.agentsTransports} role="radiogroup" aria-label={`${SLOT_LABELS[slot]} transport`}>
        {transports.map((t) => (
          <label key={t} className={css.agentsTransport} title={TRANSPORT_TITLES[t]}>
            <input type="radio" name={`agents-transport-${slot}`} data-testid={`agents-transport-${slot}-${t}`} value={t} checked={transport === t} onChange={() => setTransport(t)} />
            {TRANSPORT_LABELS[t]}
          </label>
        ))}
      </span>
      <select
        className={css.agentsModel}
        data-testid={`agents-model-${slot}`}
        aria-label={`${SLOT_LABELS[slot]} model`}
        value={inList ? model : ''}
        disabled={transport === 'web' && listed.length === 0}
        onChange={(e) => onChange({ ...row, model: e.target.value })}
        title={transport === 'web' ? 'A web session is the site itself' : 'Models of this vendor on this transport, from the catalog'}
      >
        {!inList ? <option value="">{customAllowed ? (model ? `custom: ${model}` : '— pick or type below —') : model || '—'}</option> : null}
        {listed.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
          </option>
        ))}
      </select>
      {customAllowed ? (
        <input
          className={css.agentsCustom}
          data-testid={`agents-model-custom-${slot}`}
          aria-label={`${SLOT_LABELS[slot]} custom model id`}
          placeholder={transport === 'ollama' ? 'or an Ollama name (ollama: is added)' : 'or an unlisted org/model slug'}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => {
            const id = customModelId(transport, custom)
            if (id && id !== model) onChange({ ...row, model: id })
          }}
          title={transport === 'ollama' ? 'A model pulled into the local Ollama server; the ollama: prefix is added for you' : 'Any OpenRouter slug, listed or not'}
        />
      ) : null}
      <select className={css.agentsEffort} data-testid={`agents-effort-${slot}`} aria-label={`${SLOT_LABELS[slot]} effort`} value={effort} onChange={(e) => onChange({ ...row, effort: e.target.value })} title="Reasoning effort (a web session ignores it: the site decides)">
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
      <button type="button" className={css.agentsRemove} data-testid={`agents-remove-${slot}`} disabled={!canRemove} onClick={onRemove} title={canRemove ? `Unseat ${SLOT_LABELS[slot]}` : `A council needs at least ${COUNCIL_MIN} agents`}>
        Remove
      </button>
    </div>
  )
}

export default function AgentsPage({ api = desktopApi() }) {
  const dispatch = useDispatch()
  const panes = useSlice('panes') || initialPanes()
  const conversation = useSlice('conversation')
  const slotConfig = useSlice('slotConfig')
  const streams = useSlice('streams') || {}
  const models = useSlice('models') || { items: [], byId: {}, loaded: false, error: null }
  const keyStatus = panes.openRouterKey || null

  useEffect(() => {
    if (!models.loaded && !models.error) loadModels(dispatch).catch(() => {})
  }, [dispatch, models.loaded, models.error])

  // The source of the draft: the open conversation's config, else main's default, else the three.
  const source = conversation && slotConfig && slotConfig.slots ? 'conversation' : 'default'
  const sourceSpec = source === 'conversation' ? slotConfig : panes.council
  const seed = useMemo(() => {
    const rows = rowsFromSpec(sourceSpec)
    return rows.length ? rows : defaultRows()
  }, [sourceSpec])
  const [rows, setRows] = useState(seed)
  const seededFrom = useRef(sourceKey(source, sourceSpec))
  useEffect(() => {
    const key = sourceKey(source, sourceSpec)
    if (key === seededFrom.current) return
    seededFrom.current = key
    setRows(seed)
    setError(null)
  }, [source, sourceSpec, seed])

  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const invalid = validateCouncil(rows)
  const streaming = STREAM_KEYS.some((k) => streams[k] && streams[k].status === 'streaming')
  const hasTurns = !!(conversation && Array.isArray(conversation.turns) && conversation.turns.length)
  const applyWhy = !conversation || !slotConfig ? 'noConversation' : hasTurns ? 'hasTurns' : streaming ? 'streaming' : invalid ? 'invalid' : null
  const canApply = applyWhy === null && !busy
  const canDefault = !invalid && !busy && typeof api?.setCouncil === 'function'
  const free = freeSlots(rows)
  const canAdd = rows.length < COUNCIL_MAX && free.length > 0
  const keyConfigured = !!(keyStatus && keyStatus.configured)

  const update = (index, next) => setRows((cur) => cur.map((r, i) => (i === index ? next : r)))
  const remove = (index) => setRows((cur) => (cur.length > COUNCIL_MIN ? cur.filter((_, i) => i !== index) : cur))
  const add = () => {
    if (!canAdd) return
    const slot = free[0]
    const transport = transportsFor(slot)[0]
    setRows((cur) => [...cur, { slot, transport, model: defaultModelFor(slot, transport, models), effort: 'off' }])
  }

  // The full config, never a partial patch: the backend replaces the stored SlotConfig on PUT and
  // a changed council on an empty conversation re-stamps its threads and anon map.
  const apply = async () => {
    if (!canApply) return
    const id = conversation.id
    const cfg = { ...slotConfig, slots: specFromRows(rows).slots }
    setBusy(true)
    setError(null)
    try {
      const stored = await http.putSlotConfig(id, cfg)
      if (alive.current) dispatch({ type: 'slotConfig/loaded', conversationId: id, slotConfig: stored })
    } catch (e) {
      if (!alive.current) return
      const code = e && e.code
      setError(code === COUNCIL_CHANGED ? 'the backend refused: this conversation already has turns, so its council cannot change (council_changed)' : (e && (e.message || code)) || 'could not apply the council')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const saveDefault = async () => {
    if (!canDefault) return
    const spec = specFromRows(rows)
    setBusy(true)
    setError(null)
    try {
      const reply = await api.setCouncil(spec)
      if (alive.current) dispatch({ type: 'panes/council', council: reply && typeof reply === 'object' && reply.slots ? reply : spec })
    } catch (e) {
      if (alive.current) setError((e && e.message) || 'main refused the council')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const applyKeyStatus = (status) => {
    if (alive.current && status && typeof status === 'object') dispatch({ type: 'panes/openRouterKey', status })
  }
  const saveKey = async () => {
    const key = keyDraft.trim()
    if (!key || keyBusy || typeof api?.setOpenRouterKey !== 'function') return
    setKeyBusy(true)
    setKeyError(null)
    try {
      applyKeyStatus(await api.setOpenRouterKey(key))
      if (alive.current) setKeyDraft('') // the key is main's now; the field never keeps it
    } catch (e) {
      if (alive.current) setKeyError((e && e.message) || 'could not save the key')
    } finally {
      if (alive.current) setKeyBusy(false)
    }
  }
  const clearKey = async () => {
    if (keyBusy || typeof api?.setOpenRouterKey !== 'function') return
    setKeyBusy(true)
    setKeyError(null)
    try {
      applyKeyStatus(await api.setOpenRouterKey(null))
      if (alive.current) setKeyDraft('')
    } catch (e) {
      if (alive.current) setKeyError((e && e.message) || 'could not clear the key')
    } finally {
      if (alive.current) setKeyBusy(false)
    }
  }

  return (
    <div className={css.agents} data-testid="agents-page" data-source={source}>
      <p className={css.hint} data-testid="agents-source">
        {sourceText(source)}
      </p>
      <div className={css.agentsRows}>
        {rows.map((row, i) => (
          <Row key={row.slot} row={row} rows={rows} models={models} onChange={(next) => update(i, next)} onRemove={() => remove(i)} canRemove={rows.length > COUNCIL_MIN} />
        ))}
      </div>
      <div className={css.agentsBar}>
        <button type="button" className={css.agentsBtn} data-testid="agents-add" disabled={!canAdd} onClick={add} title={canAdd ? `Seat ${SLOT_LABELS[free[0]]} (${rows.length + 1} of ${COUNCIL_MAX})` : `A council seats at most ${COUNCIL_MAX} agents`}>
          + Add an agent
        </button>
        <span className={css.agentsSummary} data-testid="agents-summary">
          {summaryText(rows.length)}
        </span>
        <button type="button" className={css.agentsBtn} data-testid="agents-apply" disabled={!canApply} onClick={apply} title={applyWhy ? APPLY_TITLES[applyWhy] : APPLY_TITLES.ready}>
          Apply to this conversation
        </button>
        <button type="button" className={css.agentsBtn} data-testid="agents-default" disabled={!canDefault} onClick={saveDefault} title="Make this the council every new conversation starts with (main persists it and pushes it to the backend)">
          Save as default
        </button>
      </div>
      {error || invalid ? (
        <p className={css.agentsError} data-testid="agents-error" role="alert">
          {error || invalid}
        </p>
      ) : null}
      <div className={css.agentsKey} data-testid="agents-key-row">
        <label className={css.agentsKeyLabel} title={KEY_TITLE}>
          <span>OpenRouter key</span>
          <input
            type="password"
            className={css.agentsKeyInput}
            data-testid="agents-key"
            autoComplete="off"
            placeholder={keyConfigured ? 'replace the saved key…' : 'sk-or-v1-…'}
            value={keyDraft}
            disabled={keyBusy}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                saveKey()
              }
            }}
          />
        </label>
        <button type="button" className={css.agentsBtn} data-testid="agents-key-save" disabled={keyBusy || !keyDraft.trim()} onClick={saveKey} title="Encrypt and store the key in Electron, then push it to the backend">
          Save key
        </button>
        <button type="button" className={css.agentsBtn} data-testid="agents-key-clear" disabled={keyBusy || !keyConfigured} onClick={clearKey} title="Forget the key: Electron drops the ciphertext and the backend its copy">
          Clear
        </button>
        <span className={css.agentsKeyStatus} data-testid="agents-key-status" data-configured={keyConfigured ? 'true' : 'false'} role="status">
          {keyStatusText(keyStatus)}
        </span>
      </div>
      {keyError ? (
        <p className={css.agentsError} data-testid="agents-key-error" role="alert">
          {keyError}
        </p>
      ) : null}
      {anyOnOpenRouter(rows) && !keyConfigured ? (
        <p className={css.agentsHint} data-testid="agents-key-hint" role="status">
          {KEY_HINT}
        </p>
      ) : null}
    </div>
  )
}
