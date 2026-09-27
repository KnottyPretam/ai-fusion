// analyst.js (renderer-drawer, Stage 3) — the desktop analyst choice and the desktop SlotConfig.
//
// Plan Decision 4: the analyst is `web:<slot>:analyst` (a hidden page signed in as that site,
// default `web:chatgpt:analyst`) or `ollama:<name>` (local Ollama); `''` ("none") is still a
// legal state — Analyze is disabled with a hint and the bridge answers `analyst_not_chosen`. The
// renderer owns the MODEL-STRING mirror of the choice in localStorage (`triplex.desktop.analyst`,
// contract §5 "one owner per persisted key"); main owns `settings.analyst` (the SLOT the hidden
// view signs in as), told through `triplex.setAnalyst(slot|null)` on every change — `null` for
// Ollama and for none (`analystSlotOf`). The mirror is never pushed to main on mount: both start
// from the same default and main re-creates the hidden view on `setAnalyst`.
//
// `councilSlotConfig(council, analyst)` is the full SlotConfig a desktop conversation is created
// with (`POST /api/conversations` takes a complete SlotConfig, backend/routers/conversations.py):
// the council's slot specs — main's default council (`panes.council`, 2..5 members, each
// `web:<site>` / an OpenRouter slug / `ollama:<name>`), else the three `web:<site>` pane models at
// effort `off` (contract §6 spawn env) — the chosen analyst, and the frozen backend defaults for
// the rest (max_iterations 2, materiality medium, grounded off — `FUSION_MAX_ITERATIONS` /
// `MATERIALITY_MIN` env overrides are not mirrored). `desktopSlotConfig(analyst)` is the
// no-council alias. It is used by every desktop create path this feature owns (PromptBar's
// first-Send create, "New chat everywhere" in chats.js); the sidebar's "+ New conversation"
// (features/conversations, not a desktop file) still posts `{}` and gets the backend's session
// default (main pushes the same council there).
// Council (2026-09-27): `analystKind` gains 'openrouter' for an `org/model` slug once a key is
// configured (`{ keyConfigured: true }`); without the key such a slug is still 'other'
// (a pre-pivot conversation, or a key that was cleared) and Analyze stays disabled with the hint.
// The persisted CHOICE is judged by shape alone (`loadAnalyst` keeps an OpenRouter slug whether or
// not a key is configured right now): the key is main's state and arrives after the first render,
// and the Settings page promises "new conversations start with the choice above" — so readiness
// is decided where it is shown (the drawer's hint, the prompt bar's Pre-parse gate), never at load,
// where a rejected slug would silently become the web default on every create path.
import { SITES, SLOT_LABELS, isSiteId, normalizeCouncil } from './slice.js'

export const ANALYST_KEY = 'triplex.desktop.analyst'
export const DEFAULT_ANALYST = 'web:chatgpt:analyst'
/** The "none" state (Decision 4): the backend reads '' as no analyst. */
export const ANALYST_NONE = ''

const WEB_ANALYST = new RegExp(`^web:(${SITES.join('|')}):analyst$`)
const OLLAMA = /^ollama:\S+$/
// An OpenRouter slug: `<org>/<model>` (optionally `:variant`), no whitespace — never `web:` / `ollama:`.
const OPENROUTER = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/

/** `web:<slot>:analyst` for a slot. */
export function webAnalystId(slot) {
  return `web:${slot}:analyst`
}

export const WEB_ANALYST_IDS = SITES.map(webAnalystId)

/** Display name of a web analyst option (mirrors backend/llm/webmodels.py; the catalog wins when loaded). */
export function webAnalystName(slot) {
  return `${SLOT_LABELS[slot]} web session (hidden analyst page)`
}

/** True for an OpenRouter slug (`org/model`), whatever the key state. */
export function isOpenRouterSlug(model) {
  return typeof model === 'string' && OPENROUTER.test(model)
}

/**
 * 'web' | 'ollama' | 'openrouter' (an `org/model` slug, only with `keyConfigured`) | 'none'
 * ('' / null / undefined) | 'other' (a slug without a key, a pre-pivot conversation, junk).
 */
export function analystKind(model, { keyConfigured = false } = {}) {
  if (model === null || model === undefined || model === '') return 'none'
  if (typeof model !== 'string') return 'other'
  if (WEB_ANALYST.test(model)) return 'web'
  if (OLLAMA.test(model)) return 'ollama'
  if (keyConfigured && OPENROUTER.test(model)) return 'openrouter'
  return 'other'
}

/** True for a transport the desktop can answer with: `web:<site>:analyst`, `ollama:<name>`, or an OpenRouter slug with a key. */
export function isDesktopAnalyst(model, opts) {
  const kind = analystKind(model, opts)
  return kind === 'web' || kind === 'ollama' || kind === 'openrouter'
}

/** The slot main signs the hidden view in as: `web:<slot>:analyst` → slot; anything else → null. */
export function analystSlotOf(model) {
  const m = typeof model === 'string' ? WEB_ANALYST.exec(model) : null
  return m && isSiteId(m[1]) ? m[1] : null
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null
  } catch {
    return null
  }
}

/**
 * The persisted choice: '' (none) or a desktop analyst as stored — a web analyst, an Ollama model
 * or an OpenRouter slug, by shape (the key state is not consulted here, see the header); the
 * default when nothing valid is stored or the storage is unavailable. Never throws.
 */
export function loadAnalyst(storage = defaultStorage()) {
  if (!storage) return DEFAULT_ANALYST
  try {
    const raw = storage.getItem(ANALYST_KEY)
    if (raw === ANALYST_NONE) return ANALYST_NONE
    return isDesktopAnalyst(raw, { keyConfigured: true }) ? raw : DEFAULT_ANALYST
  } catch {
    return DEFAULT_ANALYST
  }
}

/** Write the choice ('' allowed); never throws. */
export function persistAnalyst(storage = defaultStorage(), model) {
  if (!storage || typeof model !== 'string') return
  try {
    storage.setItem(ANALYST_KEY, model)
  } catch {
    /* quota / private mode: the in-memory state is still right */
  }
}

/** The pane slot specs of the classic desktop conversation: the three sites' `web:<site>` at effort off (contract §6 spawn env). */
export function desktopSlots() {
  const slots = {}
  for (const slot of SITES) slots[slot] = { model: `web:${slot}`, effort: 'off' }
  return slots
}

/**
 * The full SlotConfig a desktop conversation is created with: the council's slots (main's default
 * spec, validated; an invalid or missing one falls back to the three web panes), the analyst
 * (defaults to the persisted choice) and the frozen backend defaults for the rest.
 */
export function councilSlotConfig(council = null, analyst = loadAnalyst()) {
  const spec = normalizeCouncil(council)
  const slots = {}
  for (const [slot, s] of Object.entries(spec ? spec.slots : desktopSlots())) slots[slot] = { model: s.model, effort: s.effort }
  return {
    slots,
    analyst_model: typeof analyst === 'string' ? analyst : ANALYST_NONE,
    max_iterations: 2,
    materiality_min: 'medium',
    grounded: false,
  }
}

/** The no-council alias: the three web panes plus the analyst (what every pre-council caller asked for). */
export function desktopSlotConfig(analyst = loadAnalyst()) {
  return councilSlotConfig(null, analyst)
}
