// stepper.js (2026-10-17) — the pure half of the agents stepper (`−  N agents  +` in the deck bar;
// ./AgentStepper.jsx is the React half). Nothing here touches the store or the window.
//
// The rules, decided with the user:
//   * Min two, max four agents from the stepper (COUNCIL_EDIT_MAX). A council read from disk may
//     still hold five (every reader stays 2..5); the stepper never adds a fifth, and `−` trims one.
//   * `−` removes the RIGHT-MOST agent in catalog order (= the right-most tab), named in its title.
//     `+` adds the vendor picked from a menu: a site on its web session; any other vendor on
//     OpenRouter (key configured AND pushed, and the catalog lists the vendor) or else on a live
//     local Ollama model named like it — never an unrelated model (the desktop catalog always lists
//     `ollama:hermes3`, so "the catalog has an Ollama entry" would make every vendor look seatable).
//   * Where the change lands follows the council rule of the backend (409 `council_changed`): no
//     conversation open → only main's default changes ('default'); an EMPTY conversation → changed
//     in place and made the default ('in-place'); a conversation where something was said → a NEW
//     chat with the new set, also made the default ('new-chat'); the old chat keeps its agents.
//   * Nothing changes while any stream runs (every feature key, upstream's `reread` included) or a
//     send / create is in flight.
import { COUNCIL_EDIT_MAX, defaultRows, modelsFor, specFromRows } from './council.js'
import { COUNCIL_MIN, SLOT_IDS, SLOT_LABELS, isSiteId, isSlotId, needsAttention, normalizeCouncil, sessionOf } from './slice.js'

/** Mirror of features/send/slice.js DEFAULT_EFFORTS (features never import each other). */
const EFFORT_ORDER = ['off', 'low', 'medium', 'high']

/**
 * Model-family words per vendor, mirrored from backend/vendors.py `family_words`: what an Ollama
 * tag must contain to stand in for that vendor (`qwen3:8b` is Qwen, `hermes3` is nobody).
 */
export const FAMILY_WORDS = { claude: ['claude'], chatgpt: ['gpt'], grok: ['grok'], gemini: ['gemini'], deepseek: ['deepseek'], qwen: ['qwen', 'qwq'], mimo: ['mimo'] }

export const MIN_TEXT = 'A council needs at least two agents.'
export const MAX_TEXT = 'Four agents at most.'
export const LOADING_TEXT = 'loading the model catalog…'
export const MORE_TEXT = 'More options… (Agents page)'

/** True while any feature stream runs (send, analyze, fusion, preparse, refactor, plan, reread …). */
export function anyStreaming(streams) {
  return Object.values(streams && typeof streams === 'object' ? streams : {}).some((s) => !!(s && s.status === 'streaming'))
}

/** True once anything was said in the conversation: a turn, or a message in any thread (backend `_council_is_settled`). */
export function councilSettled(conversation) {
  if (!conversation || typeof conversation !== 'object') return false
  if (Array.isArray(conversation.turns) && conversation.turns.length > 0) return true
  const threads = conversation.threads && typeof conversation.threads === 'object' ? conversation.threads : {}
  return Object.values(threads).some((t) => Array.isArray(t) && t.length > 0)
}

/**
 * The council the stepper edits, with the deck's own precedence (PaneDeck): the open
 * conversation's config, else main's default (`panes.council`), else every site on its web
 * session. `{spec, source: 'conversation' | 'default'}`; `spec` is a normalized council.
 */
export function stepperSource({ conversation = null, slotConfig = null, council = null } = {}) {
  const own = conversation ? normalizeCouncil(slotConfig || conversation.slot_config) : null
  if (own) return { spec: own, source: 'conversation' }
  const fallback = normalizeCouncil(council)
  if (fallback) return { spec: fallback, source: 'default' }
  return { spec: specFromRows(defaultRows()), source: 'default' }
}

/** 'default' (no conversation open) | 'in-place' (open and empty) | 'new-chat' (open, something was said). */
export function stepperMode({ conversation = null } = {}) {
  if (!conversation) return 'default'
  return councilSettled(conversation) ? 'new-chat' : 'in-place'
}

/** The council's members in catalog order ([] for no spec). */
export function membersOf(spec) {
  const slots = spec && spec.slots && typeof spec.slots === 'object' ? spec.slots : {}
  return SLOT_IDS.filter((k) => k in slots)
}

/** The agent `−` removes: the right-most member in catalog order (= the right-most tab); null for none. */
export function removeTarget(spec) {
  const members = membersOf(spec)
  return members.length ? members[members.length - 1] : null
}

function catalogItems(models) {
  if (Array.isArray(models)) return models
  return models && Array.isArray(models.items) ? models.items : []
}

function catalogLoaded(models) {
  return Array.isArray(models) || !!(models && models.loaded)
}

/**
 * The effort a freshly seated model starts at: `off` when the catalog lists it for the model, else
 * the model's lowest listed effort (the mirror of send/slice.js `effortsFor` + `nearestEffort`
 * aimed at `off`). A model the catalog does not know starts at `off` — the backend rejects an
 * effort only for a model its catalog knows (422 `unsupported_effort`), which is exactly what a
 * hard-coded `off` hit for `google/gemini-2.5-pro` (low/medium/high only).
 */
export function seatEffort(models, model) {
  const meta = catalogItems(models).find((m) => m && m.id === model)
  const efforts = meta && Array.isArray(meta.efforts) && meta.efforts.length ? meta.efforts : EFFORT_ORDER
  if (efforts.includes('off')) return 'off'
  const supported = EFFORT_ORDER.filter((e) => efforts.includes(e))
  return supported.length ? supported[0] : 'off'
}

/** `ollama:<name>` of the first live local model (name-sorted) whose name carries the vendor's family word; null for none. */
export function localModelFor(slot, names) {
  const words = FAMILY_WORDS[slot] || []
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim()).sort((a, b) => a.localeCompare(b))
  const hit = list.find((n) => words.some((w) => n.toLowerCase().includes(w)))
  return hit ? `ollama:${hit}` : null
}

function keyUsable(keyStatus) {
  return !!(keyStatus && typeof keyStatus === 'object' && keyStatus.configured && keyStatus.pushed)
}

/**
 * How the stepper would seat `slot`: `{seat: {model, effort}, transport, pending: false}`, or
 * `{seat: null, reason, pending}` with the one sentence that says why not (`pending` = the catalog
 * or the Ollama probe has not answered yet). `ollama` is the probe's list of names, or null while
 * it is in flight.
 */
export function seatFor(slot, { models = null, keyStatus = null, ollama = null } = {}) {
  if (!isSlotId(slot)) return { seat: null, transport: null, reason: `unknown agent "${slot}"`, pending: false }
  if (isSiteId(slot)) return { seat: { model: `web:${slot}`, effort: 'off' }, transport: 'web', reason: null, pending: false }
  const name = SLOT_LABELS[slot]
  let pending = false
  const usable = keyUsable(keyStatus)
  if (usable) {
    if (!catalogLoaded(models)) pending = true
    else {
      const listed = modelsFor(slot, 'openrouter', catalogItems(models))
      if (listed.length) return { seat: { model: listed[0].id, effort: seatEffort(models, listed[0].id) }, transport: 'openrouter', reason: null, pending: false }
    }
  }
  if (ollama === null) pending = true
  else {
    const local = localModelFor(slot, ollama)
    if (local) return { seat: { model: local, effort: seatEffort(models, local) }, transport: 'ollama', reason: null, pending: false }
  }
  if (pending) return { seat: null, transport: null, reason: LOADING_TEXT, pending: true }
  if (usable) return { seat: null, transport: null, reason: `OpenRouter lists no ${name} model right now, and no local Ollama model is named like it.`, pending: false }
  if (keyStatus && keyStatus.configured) return { seat: null, transport: null, reason: `The OpenRouter key is stored but not yet pushed to the backend, and no local Ollama model is named like ${name}.`, pending: false }
  return { seat: null, transport: null, reason: `${name} needs an OpenRouter key or a local Ollama model named like it. Set one up on the Agents page.`, pending: false }
}

const GROUP_OF = { web: 'web', openrouter: 'token', ollama: 'local' }

/** What a site's pane needs before it can answer, per attention session: the menu detail and the title's sentence. */
export const SESSION_DETAIL = {
  logged_out: { detail: 'signed out, sign in in its pane', title: 'The pane is signed out: sign in there before sending.' },
  challenge: { detail: 'a check is waiting in its pane', title: 'The pane shows a verification check: finish it there before sending.' },
  blocked: { detail: 'the site reports it is blocked', title: 'The site reports this session is blocked: open its pane to see why.' },
}

/**
 * The `+` menu: every vendor the council does not seat — the sites first in catalog order (with
 * the pane's session state: a signed-out / challenged / blocked site is still seatable, the detail
 * says which), then the token / local vendors in catalog order. Each item is `{slot, group:
 * web|token|local, seat, transport, reason, detail, attention, pending}` (`attention` = the session
 * needing the user, else null); an item with `seat: null` is shown disabled with `reason`.
 */
export function addOptions({ spec = null, models = null, keyStatus = null, ollama = null, health = null } = {}) {
  const seated = new Set(membersOf(spec))
  const free = SLOT_IDS.filter((s) => !seated.has(s))
  const ordered = [...free.filter(isSiteId), ...free.filter((s) => !isSiteId(s))]
  return ordered.map((slot) => {
    const r = seatFor(slot, { models, keyStatus, ollama })
    const h = health && typeof health === 'object' ? health[slot] : null
    const session = sessionOf(h)
    const attention = isSiteId(slot) && needsAttention(session) && SESSION_DETAIL[session] ? session : null
    const detail = attention ? SESSION_DETAIL[attention].detail : null
    return { slot, group: GROUP_OF[r.transport] || 'token', seat: r.seat, transport: r.transport, reason: r.reason, detail, attention, pending: r.pending }
  })
}

/** The spec after the change, re-keyed in catalog order; null when the result is not a council. */
export function nextSpec(spec, op, { slot, seat = null } = {}) {
  const slots = { ...(spec && spec.slots ? spec.slots : {}) }
  if (op === 'add') {
    if (!seat || typeof seat.model !== 'string' || !seat.model) return null
    slots[slot] = { model: seat.model, effort: seat.effort || 'off' }
  } else if (op === 'remove') delete slots[slot]
  else return null
  return normalizeCouncil({ slots })
}

/**
 * Why both buttons are disabled right now, or null: the first of a running stream, a send in
 * flight, a create in flight, the stepper's own change in flight.
 */
export function busyReason({ streams = null, sending = false, creating = false, inflight = false } = {}) {
  if (anyStreaming(streams)) return 'a stream is running'
  if (sending) return 'a send is in flight'
  if (creating) return 'a new chat is being created'
  if (inflight) return 'changing the agents…'
  return null
}

/**
 * What a click does: `{kind: 'blocked', reason}` or `{kind: 'apply-in-place' | 'new-chat', spec,
 * conversationId, target, op}`. `apply-in-place` with `conversationId: null` changes only the
 * default (no conversation open). `busy` is any in-flight state the caller knows of (a send, a
 * create, its own change); a running stream is read from `streams`.
 */
export function stepperAction({ conversation = null, slotConfig = null, council = null, streams = null, busy = false, op, slot = null, seat = null } = {}) {
  if (busy || anyStreaming(streams)) return { kind: 'blocked', reason: busy ? 'busy' : 'a stream is running' }
  const { spec } = stepperSource({ conversation, slotConfig, council })
  const members = membersOf(spec)
  let target
  let next
  if (op === 'remove') {
    if (members.length <= COUNCIL_MIN) return { kind: 'blocked', reason: MIN_TEXT }
    target = removeTarget(spec)
    next = nextSpec(spec, 'remove', { slot: target })
  } else if (op === 'add') {
    if (members.length >= COUNCIL_EDIT_MAX) return { kind: 'blocked', reason: MAX_TEXT }
    if (!isSlotId(slot)) return { kind: 'blocked', reason: `unknown agent "${slot}"` }
    if (members.includes(slot)) return { kind: 'blocked', reason: `${SLOT_LABELS[slot]} is already seated` }
    if (!seat) return { kind: 'blocked', reason: `${SLOT_LABELS[slot]} cannot be seated` }
    target = slot
    next = nextSpec(spec, 'add', { slot, seat })
  } else return { kind: 'blocked', reason: `unknown change "${op}"` }
  if (!next) return { kind: 'blocked', reason: 'that change does not leave a council' }
  const mode = stepperMode({ conversation })
  if (mode === 'new-chat') return { kind: 'new-chat', spec: next, conversationId: conversation.id, target, op }
  return { kind: 'apply-in-place', spec: next, conversationId: mode === 'in-place' ? conversation.id : null, target, op }
}

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

/** "Claude", "Claude and Grok", "Claude, ChatGPT and Grok". */
export function listText(slots) {
  const names = (slots || []).map((s) => SLOT_LABELS[s] || String(s))
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** "4 agents" (the count). */
export function countText(n) {
  return `${n} agent${n === 1 ? '' : 's'}`
}

/** The count's title: whose agents these are and what − / + do to them. */
export function countTitle(mode, members) {
  const list = listText(members)
  if (mode === 'new-chat') return `This conversation's agents: ${list}. Fixed once something was said; − or + starts a new chat.`
  if (mode === 'in-place') return `This conversation's agents: ${list}.`
  return `The agents new chats start with: ${list}.`
}

/** The − title for the current mode (the button's aria-label is "Remove <name>"). */
export function removeTitle({ mode, members, busy = null }) {
  if (busy) return `Remove an agent: ${busy}`
  if (members.length <= COUNCIL_MIN) return MIN_TEXT
  const target = members[members.length - 1]
  const name = SLOT_LABELS[target]
  const rest = listText(members.slice(0, -1))
  if (mode === 'new-chat') return `Remove ${name} (the right-most agent): starts a new chat with ${rest} and makes them the default. This chat keeps its agents and stays in the sidebar.`
  if (mode === 'in-place') return `Remove ${name} (the right-most agent) from this conversation (nothing has been said yet) and make ${rest} the default for new chats.`
  return `Remove ${name} (the right-most agent). New chats then start with ${rest}.`
}

/** The + title for the current mode. */
export function addTitle({ mode, members, busy = null }) {
  if (busy) return `Add an agent: ${busy}`
  const n = members.length
  if (n > COUNCIL_EDIT_MAX) return `${MAX_TEXT} This council has ${n} from before; − trims it${mode === 'new-chat' ? ' in a new chat' : ''}.`
  if (n >= COUNCIL_EDIT_MAX) return MAX_TEXT
  const head = `Add an agent (${n + 1} of ${COUNCIL_EDIT_MAX})`
  if (mode === 'new-chat') return `${head}: starts a new chat with these agents plus the one you pick and makes them the default. This chat keeps its agents and stays in the sidebar.`
  if (mode === 'in-place') return `${head} to this conversation (nothing has been said yet) and to the default for new chats.`
  return `${head} to the agents new chats start with.`
}

/** The one line at the top of the menu. */
export function menuHint(mode) {
  if (mode === 'new-chat') return 'Adding starts a new chat with these agents plus the one you pick; this chat stays in the sidebar.'
  if (mode === 'in-place') return 'Add to this conversation (nothing said yet) and to the default for new chats.'
  return 'Add to the agents new chats start with.'
}

/** A menu item's label: "Gemini · web session (your login)", "DeepSeek · OpenRouter · deepseek/deepseek-r1", "Qwen · local Ollama · ollama:qwen3". */
export function itemText(item) {
  const name = SLOT_LABELS[item.slot]
  if (item.transport === 'web') return `${name} · web session (your login)${item.detail ? ` · ${item.detail}` : ''}`
  if (item.transport === 'openrouter') return `${name} · OpenRouter · ${item.seat.model}`
  if (item.transport === 'ollama') return `${name} · local Ollama · ${item.seat.model}`
  return `${name} · ${item.reason || 'cannot be seated'}`
}

/** A menu item's title. */
export function itemTitle(item) {
  const name = SLOT_LABELS[item.slot]
  if (!item.seat) return item.reason || `${name} cannot be seated`
  if (item.transport === 'web') return `Seat ${name} on your own login in its pane; no key, no token cost.${item.attention && SESSION_DETAIL[item.attention] ? ` ${SESSION_DETAIL[item.attention].title}` : ''}`
  if (item.transport === 'openrouter') return `Seat ${name} on OpenRouter (${item.seat.model}, effort ${item.seat.effort}); tokens and cost are metered. Pick another model on the Agents page.`
  return `Seat ${name} on the local Ollama model ${item.seat.model}; no key, no cost. Pick another model on the Agents page.`
}
