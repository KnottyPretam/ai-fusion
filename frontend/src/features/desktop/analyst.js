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
// `desktopSlotConfig(analyst)` is the full SlotConfig a desktop conversation is created with
// (`POST /api/conversations` takes a complete SlotConfig, backend/routers/conversations.py):
// the three `web:<slot>` pane models at effort `off` (contract §6 spawn env), the chosen analyst,
// and the frozen backend defaults for the rest (max_iterations 2, materiality medium, grounded
// off — `FUSION_MAX_ITERATIONS` / `MATERIALITY_MIN` env overrides are not mirrored). It is used by
// every desktop create path this feature owns (PromptBar's first-Send create, "New chat
// everywhere" in chats.js); the sidebar's "+ New conversation" (features/conversations, not a
// desktop file) still posts `{}` and gets the backend's spawn-time default.
import { SLOT_IDS, SLOT_LABELS, isSlotId } from './slice.js'

export const ANALYST_KEY = 'triplex.desktop.analyst'
export const DEFAULT_ANALYST = 'web:chatgpt:analyst'
/** The "none" state (Decision 4): the backend reads '' as no analyst. */
export const ANALYST_NONE = ''

const WEB_ANALYST = /^web:(claude|chatgpt|grok):analyst$/
const OLLAMA = /^ollama:\S+$/

/** `web:<slot>:analyst` for a slot. */
export function webAnalystId(slot) {
  return `web:${slot}:analyst`
}

export const WEB_ANALYST_IDS = SLOT_IDS.map(webAnalystId)

/** Display name of a web analyst option (mirrors backend/llm/webmodels.py; the catalog wins when loaded). */
export function webAnalystName(slot) {
  return `${SLOT_LABELS[slot]} web session (hidden analyst page)`
}

/** 'web' | 'ollama' | 'none' ('' / null / undefined) | 'other' (an OpenRouter slug, a pre-pivot conversation). */
export function analystKind(model) {
  if (model === null || model === undefined || model === '') return 'none'
  if (typeof model !== 'string') return 'other'
  if (WEB_ANALYST.test(model)) return 'web'
  if (OLLAMA.test(model)) return 'ollama'
  return 'other'
}

/** True for the two desktop transports (`web:<slot>:analyst`, `ollama:<name>`). */
export function isDesktopAnalyst(model) {
  const kind = analystKind(model)
  return kind === 'web' || kind === 'ollama'
}

/** The slot main signs the hidden view in as: `web:<slot>:analyst` → slot; anything else → null. */
export function analystSlotOf(model) {
  const m = typeof model === 'string' ? WEB_ANALYST.exec(model) : null
  return m && isSlotId(m[1]) ? m[1] : null
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null
  } catch {
    return null
  }
}

/**
 * The persisted choice: '' (none) or a desktop analyst as stored; the default when nothing valid
 * is stored or the storage is unavailable. Never throws.
 */
export function loadAnalyst(storage = defaultStorage()) {
  if (!storage) return DEFAULT_ANALYST
  try {
    const raw = storage.getItem(ANALYST_KEY)
    if (raw === ANALYST_NONE) return ANALYST_NONE
    return isDesktopAnalyst(raw) ? raw : DEFAULT_ANALYST
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

/** The pane slot specs of a desktop conversation (contract §6 spawn env). */
export function desktopSlots() {
  const slots = {}
  for (const slot of SLOT_IDS) slots[slot] = { model: `web:${slot}`, effort: 'off' }
  return slots
}

/** The full SlotConfig a desktop conversation is created with; `analyst` defaults to the persisted choice. */
export function desktopSlotConfig(analyst = loadAnalyst()) {
  return {
    slots: desktopSlots(),
    analyst_model: typeof analyst === 'string' ? analyst : ANALYST_NONE,
    max_iterations: 2,
    materiality_min: 'medium',
    grounded: false,
  }
}
