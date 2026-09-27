// council.js (2026-09-27, "a council anyone can assemble") — the pure half of the Agents page.
//
// A council is 2..5 agents from the 7-vendor catalog, each on ONE transport: a subscription web
// session (`web:<site>`, only the three sites with a Stage-1 adapter), token based through
// OpenRouter (an `org/model` slug, one key for every vendor) or local Ollama (`ollama:<name>`).
// Transport IS the model string (backbone rule 1), so a row is {slot, transport, model, effort}
// and `specFromRows` / `rowsFromSpec` convert to and from the `{slots: {slot: {model, effort}}}`
// spec main persists (`setCouncil`) and the backend's `SlotConfig.slots` takes. Nothing here
// touches the store or the window; AgentsPage.jsx is the React half.
import { COUNCIL_MAX, COUNCIL_MIN, SITES, SLOT_IDS, SLOT_LABELS, SLOT_VENDORS, isSiteId, isSlotId, normalizeCouncil, transportOf } from './slice.js'

export const TRANSPORTS = ['web', 'openrouter', 'ollama']
export const TRANSPORT_LABELS = { web: 'Subscription (web session)', openrouter: 'Token based (OpenRouter)', ollama: 'Local (Ollama)' }
export const TRANSPORT_TITLES = {
  web: 'Your own login on the site, in a native pane; no key, no token cost. Stage 1: ChatGPT, Claude and Grok.',
  openrouter: 'Called through OpenRouter with the one key saved below; tokens and cost are metered. The only way to run the uncensored DeepSeek / Qwen / MiMo variants hosted there.',
  ollama: 'A model on the local Ollama server (ollama pull <name>); no key, no cost, your machine does the work.',
}
export const EFFORTS = ['off', 'low', 'medium', 'high']
/** The OpenRouter slug shape: `org/model`, optionally `:variant`, no whitespace. */
export const OPENROUTER_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/
export const OLLAMA_ID = /^ollama:\S+$/

/** The transports a vendor supports in Stage 1: a site has all three, the others token or local. */
export function transportsFor(slot) {
  return isSiteId(slot) ? TRANSPORTS : ['openrouter', 'ollama']
}

/** `web:<site>` — the one legal web model of a site. */
export function webModelFor(slot) {
  return `web:${slot}`
}

/**
 * Catalog entries a row may pick from, by vendor and transport: `web` → the site's own `web:<site>`
 * entry; `ollama` → every `ollama:*` entry (a local model can seat any vendor — the "uncensored"
 * variants run there); `openrouter` → the slugs under the vendor's prefix (`vendor` is the slug
 * prefix, and an entry tagged `raw.transport` must say openrouter; the web app's untagged
 * OpenRouter catalog qualifies as well). Name-sorted; never the hidden analyst pages.
 */
export function modelsFor(slot, transport, models) {
  const items = Array.isArray(models) ? models : models && Array.isArray(models.items) ? models.items : []
  const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))
  const tagged = (m) => (m.raw && typeof m.raw === 'object' && typeof m.raw.transport === 'string' ? m.raw.transport : null)
  return items
    .filter((m) => m && typeof m.id === 'string')
    .filter((m) => {
      if (transport === 'web') return m.id === webModelFor(slot)
      if (transport === 'ollama') return transportOf(m.id) === 'ollama'
      if (transport === 'openrouter') return transportOf(m.id) === 'openrouter' && m.vendor === SLOT_VENDORS[slot] && (tagged(m) === null || tagged(m) === 'openrouter')
      return false
    })
    .sort(byName)
}

/** The model a row starts with after a vendor / transport change: the site's web id, else the catalog's first, else '' (custom). */
export function defaultModelFor(slot, transport, models) {
  if (transport === 'web') return webModelFor(slot)
  const list = modelsFor(slot, transport, models)
  return list.length ? list[0].id : ''
}

/** A typed id made a model string: `ollama:` is prefixed for a local model, whitespace trimmed. */
export function customModelId(transport, raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (transport === 'ollama') return text.startsWith('ollama:') ? text : `ollama:${text}`
  return text
}

/** One row per council member, in catalog order; [] for an invalid or missing spec. */
export function rowsFromSpec(spec) {
  const council = normalizeCouncil(spec)
  if (!council) return []
  return Object.entries(council.slots).map(([slot, s]) => ({ slot, transport: transportOf(s.model) || 'openrouter', model: s.model, effort: s.effort }))
}

/** The spec (`{slots: {slot: {model, effort}}}`) of the rows, in catalog order. */
export function specFromRows(rows) {
  const slots = {}
  for (const slot of SLOT_IDS) {
    const row = (rows || []).find((r) => r && r.slot === slot)
    if (row) slots[slot] = { model: String(row.model || ''), effort: EFFORTS.includes(row.effort) ? row.effort : 'off' }
  }
  return { slots }
}

/** The rows of the classic desktop council: the three sites on their web sessions. */
export function defaultRows() {
  return SITES.map((slot) => ({ slot, transport: 'web', model: webModelFor(slot), effort: 'off' }))
}

/** The catalog vendors no row seats yet, in catalog order (what "Add an agent" and a vendor select may pick). */
export function freeSlots(rows, keep = null) {
  const used = new Set((rows || []).map((r) => r && r.slot).filter((s) => s !== keep))
  return SLOT_IDS.filter((s) => !used.has(s))
}

/**
 * Why the rows are not a council yet, in one sentence, or null when they are: 2..5 rows, each a
 * distinct known vendor with a model on a transport that vendor supports — `web:<site>` for web,
 * `ollama:<name>` for local, `org/model` for OpenRouter. Fails loudly per row, never silently
 * fixes a value.
 */
export function validateCouncil(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length < COUNCIL_MIN) return `a council needs at least ${COUNCIL_MIN} agents`
  if (list.length > COUNCIL_MAX) return `a council seats at most ${COUNCIL_MAX} agents`
  const seen = new Set()
  for (const row of list) {
    if (!row || !isSlotId(row.slot)) return `unknown agent ${row && row.slot ? `"${row.slot}"` : ''}`.trim()
    const name = SLOT_LABELS[row.slot]
    if (seen.has(row.slot)) return `${name} is seated twice`
    seen.add(row.slot)
    if (!transportsFor(row.slot).includes(row.transport)) return `${name} cannot run on ${TRANSPORT_LABELS[row.transport] || row.transport || 'that transport'}`
    const model = String(row.model || '').trim()
    if (!model) return `${name}: choose or type a model`
    if (row.transport === 'web' && model !== webModelFor(row.slot)) return `${name}: a web session is always ${webModelFor(row.slot)}`
    if (row.transport === 'ollama' && !OLLAMA_ID.test(model)) return `${name}: a local model is ollama:<name>`
    if (row.transport === 'openrouter' && !OPENROUTER_SLUG.test(model)) return `${name}: an OpenRouter model is org/model (for example ${SLOT_VENDORS[row.slot]}/…)`
    if (!EFFORTS.includes(row.effort)) return `${name}: effort must be one of ${EFFORTS.join(', ')}`
  }
  return null
}

/** True when any row is on OpenRouter (the key hint and the meter's cost columns key on this). */
export function anyOnOpenRouter(rows) {
  return (rows || []).some((r) => r && r.transport === 'openrouter')
}

/**
 * Whether the backend's catalog changed with the key: the desktop `GET /api/models` lists the
 * OpenRouter entries only while a session key has been PUSHED to it (backend/routers/models.py),
 * so the renderer refetches when the status arrives at configured+pushed from anything else — the
 * first status included, since the panes may have loaded the catalog before main's push landed —
 * and when a configured key is cleared. A key stored but not yet pushed, or the same status again,
 * changes nothing server-side. `prev`/`next` are main's status objects or null.
 */
export function catalogRefetchNeeded(prev, next) {
  const usable = (s) => !!(s && typeof s === 'object' && s.configured && s.pushed)
  const configured = (s) => !!(s && typeof s === 'object' && s.configured)
  if (usable(next)) return !usable(prev)
  return configured(prev) && !configured(next)
}

/**
 * The `agents-key-status` line from main's status object: 'not configured', or
 * 'configured · sk-or-v1-… (73 chars)' plus ' · stored, not yet pushed' while the backend has not
 * received it and ' · <error>' when main reports one. The key itself is never part of it.
 */
export function keyStatusText(status) {
  if (!status || typeof status !== 'object' || !status.configured) return 'not configured'
  const prefix = typeof status.prefix === 'string' && status.prefix ? `${status.prefix}…` : '…'
  const length = Number.isFinite(status.length) ? ` (${status.length} chars)` : ''
  let text = `configured · ${prefix}${length}`
  if (!status.pushed) text += ' · stored, not yet pushed'
  if (typeof status.error === 'string' && status.error) text += ` · ${status.error}`
  return text
}

/** "3 agents → R1…R3; labels are assigned per turn" (the summary line). */
export function summaryText(n) {
  const count = Number.isInteger(n) ? n : 0
  const last = Math.min(Math.max(count, 1), 5)
  return `${count} agent${count === 1 ? '' : 's'} → R1…R${last}; labels are assigned per turn`
}

/** 'the open conversation' | 'the default for new conversations' — which spec the rows came from. */
export function sourceText(source) {
  return source === 'conversation' ? 'Editing the open conversation’s council (Apply writes it there; Save as default keeps it for new conversations too).' : 'Editing the default council for new conversations (no conversation is open, or it has no council of its own yet).'
}
