// desktop/main/council.js — the council main keeps as the DEFAULT for new conversations (plan
// "A council anyone can assemble", Part C; contract §5 `settings.council`).
//
// A council is `{slots: {[slot]: {model, effort}}}`: 2..5 members of the 7-vendor catalog
// (COUNCIL_SLOTS, catalog order — the same order as the backend's SLOT_IDS, which is load-bearing
// for subset sends and every R-label assignment), each on ONE transport that is read off the model
// string exactly as the backend reads it (`transport_kind`):
//
//   web:<site>      a subscription session in a native view — only for a site with an adapter
//                   (WEB_SITES = sites.js SLOTS: claude, chatgpt, grok and, since 2026-10-17,
//                   gemini), and only under ITS OWN slot key
//                   (`{qwen: {model: 'web:chatgpt'}}` is a mismatch the backend would 422)
//   ollama:<name>   a local Ollama model
//   <org>/<model>   an OpenRouter slug (token based; the key lives in openrouter-key.js)
//
// `web:<site>:analyst` is NOT a pane model (it names the hidden analyst page) and is refused here.
// Two readers: `parseCouncil` is STRICT (the IPC boundary — anything off is a bad_request, nothing
// is coerced) and `sanitizeCouncil` is TOLERANT (settings.json — a malformed member is dropped,
// and fewer than COUNCIL_MIN survivors, or more than COUNCIL_MAX, fall back to the default council
// rather than to a truncated one). Both READ 2..5 on purpose (2026-10-17): the editors cap a new
// council at four, but five-member councils exist on disk and must keep loading. Pure module: no
// electron import, no I/O.

import { SLOTS } from './sites.js'

/** The 7-vendor catalog in backend `SLOT_IDS` order — the classic three FIRST. */
export const COUNCIL_SLOTS = Object.freeze(['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'qwen', 'mimo'])
/** The sites with a native view and an adapter (= `window.triplex.sites`); the only `web:` targets. */
export const WEB_SITES = SLOTS
export const EFFORTS = Object.freeze(['off', 'low', 'medium', 'high'])
export const COUNCIL_MIN = 2
export const COUNCIL_MAX = 5
export const TRANSPORTS = Object.freeze(['web', 'ollama', 'openrouter'])
/** The effort a web pane is seated at (the site's own settings decide; contract §6 SLOT_*_EFFORT=off). */
export const WEB_EFFORT = 'off'

const OLLAMA_RE = /^ollama:(\S+)$/
/** `<org>/<model>`: one slash, no whitespace, ASCII only (OpenRouter slugs are `org/name[:variant]`). */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * A fresh copy of the default council: EVERY site with a native view, each on its own web session at
 * effort off. 2026-10-17: that is four (claude, chatgpt, grok, gemini) since gemini became a site —
 * the user asked for new chats to start with all four web sites, so this loops WEB_SITES and is NOT
 * pinned to the classic three (the backend's schemas.DEFAULT_COUNCIL, the web app's default, stays three).
 */
export function DEFAULT_COUNCIL() {
  const slots = {}
  for (const slot of WEB_SITES) slots[slot] = { model: `web:${slot}`, effort: WEB_EFFORT }
  return { slots }
}

/** The classic three web sites in catalog order — what DEFAULT_COUNCIL() was before gemini joined. */
export const LEGACY_SITES = Object.freeze(['claude', 'chatgpt', 'grok'])

/**
 * A fresh copy of the council DEFAULT_COUNCIL() produced before 2026-10-17 (the classic three on
 * their web sessions at effort off). settings.js compares a stored council against it ONCE, to move
 * a profile that only ever held the old default onto the new one (the `council-four-sites` migration).
 */
export function LEGACY_COUNCIL() {
  const slots = {}
  for (const slot of LEGACY_SITES) slots[slot] = { model: `web:${slot}`, effort: WEB_EFFORT }
  return { slots }
}

/**
 * sameCouncil(a, b) → true when both are `{slots}` councils with the same member set and, per member,
 * the same model and effort (an absent effort reads as 'medium', as parseAgent does). Key order is
 * irrelevant; anything that is not a council compares unequal to everything, itself included.
 */
export function sameCouncil(a, b) {
  if (!isPlainObject(a) || !isPlainObject(a.slots) || !isPlainObject(b) || !isPlainObject(b.slots)) return false
  const ka = Object.keys(a.slots).sort()
  const kb = Object.keys(b.slots).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  const effort = (m) => (m.effort === undefined ? 'medium' : m.effort)
  return ka.every((k) => {
    const x = a.slots[k]
    const y = b.slots[k]
    return isPlainObject(x) && isPlainObject(y) && x.model === y.model && effort(x) === effort(y)
  })
}

/**
 * transportOf(model) → 'web' | 'ollama' | 'openrouter' | null. STRICT: `web:` counts only for a site
 * with an adapter (`web:deepseek` → null, no such site; `web:chatgpt:analyst` → null, it is not a pane
 * model; `web:gemini` is a site since 2026-10-17), `ollama:<name>` needs a name, and everything else
 * must look like an `org/model` slug.
 */
export function transportOf(model) {
  if (typeof model !== 'string' || model === '') return null
  if (model.startsWith('web:')) return WEB_SITES.includes(model.slice(4)) ? 'web' : null
  if (model.startsWith('ollama:')) return OLLAMA_RE.test(model) ? 'ollama' : null
  return SLUG_RE.test(model) ? 'openrouter' : null
}

/**
 * parseAgent(slot, spec) → {model, effort} or null. A member is valid when `slot` is a catalog id,
 * `spec.model` has a transport, a `web:` model names THIS slot's own site, and `spec.effort` (default
 * 'medium', as the backend's SlotSpec) is one of EFFORTS. Nothing is coerced.
 */
export function parseAgent(slot, spec) {
  if (!COUNCIL_SLOTS.includes(slot) || !isPlainObject(spec)) return null
  const transport = transportOf(spec.model)
  if (transport === null) return null
  if (transport === 'web' && spec.model !== `web:${slot}`) return null
  const effort = spec.effort === undefined ? 'medium' : spec.effort
  if (!EFFORTS.includes(effort)) return null
  return { model: spec.model, effort }
}

/**
 * parseCouncil(spec) → {slots} re-keyed in catalog order, or null when anything is off: not a
 * `{slots: {...}}` object, a key outside the catalog, fewer than COUNCIL_MIN or more than COUNCIL_MAX
 * members, or a member `parseAgent` refuses. The IPC boundary turns null into `bad_request`.
 */
export function parseCouncil(spec) {
  if (!isPlainObject(spec) || !isPlainObject(spec.slots)) return null
  const keys = Object.keys(spec.slots)
  if (keys.length < COUNCIL_MIN || keys.length > COUNCIL_MAX) return null
  const slots = {}
  for (const slot of COUNCIL_SLOTS) {
    if (!(slot in spec.slots)) continue
    const agent = parseAgent(slot, spec.slots[slot])
    if (agent === null) return null
    slots[slot] = agent
  }
  if (Object.keys(slots).length !== keys.length) return null // a key outside the catalog
  return { slots }
}

/**
 * sanitizeCouncilReport(raw) → {council, dropped, fallback}: a council that is always valid — the
 * members of `raw.slots` that parse, in catalog order; when fewer than COUNCIL_MIN survive (or more
 * than COUNCIL_MAX did — never a silently truncated council) the default council — plus what it cost:
 * `dropped` names every key of `raw.slots` that is not in the result (malformed or unknown), and
 * `fallback` is null or why the default was substituted ('not_a_council' | 'too_few' | 'too_many').
 * Tolerant on purpose (settings.json only), loud on purpose: the caller logs what disappeared.
 */
export function sanitizeCouncilReport(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.slots)) return { council: DEFAULT_COUNCIL(), dropped: [], fallback: 'not_a_council' }
  const slots = {}
  for (const slot of COUNCIL_SLOTS) {
    const agent = slot in raw.slots ? parseAgent(slot, raw.slots[slot]) : null
    if (agent !== null) slots[slot] = agent
  }
  const dropped = Object.keys(raw.slots).filter((slot) => !(slot in slots))
  const n = Object.keys(slots).length
  if (n < COUNCIL_MIN) return { council: DEFAULT_COUNCIL(), dropped, fallback: 'too_few' }
  if (n > COUNCIL_MAX) return { council: DEFAULT_COUNCIL(), dropped, fallback: 'too_many' }
  return { council: { slots }, dropped, fallback: null }
}

/** sanitizeCouncilReport's council alone. */
export function sanitizeCouncil(raw) {
  return sanitizeCouncilReport(raw).council
}

/** The member slots of a (valid) council in catalog order. */
export function councilSlots(council) {
  if (!isPlainObject(council) || !isPlainObject(council.slots)) return []
  return COUNCIL_SLOTS.filter((slot) => slot in council.slots)
}

/** The members seated on a web session, in SLOTS order — the native panes a council shows. */
export function councilSites(council) {
  if (!isPlainObject(council) || !isPlainObject(council.slots)) return []
  return WEB_SITES.filter((slot) => isPlainObject(council.slots[slot]) && transportOf(council.slots[slot].model) === 'web')
}

/** True when `id` is a catalog member (a pane OR a renderer column may be the active tab). */
export function isCouncilSlot(id) {
  return typeof id === 'string' && COUNCIL_SLOTS.includes(id)
}
