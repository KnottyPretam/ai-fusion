// Plan slice (2026-09-27). Registered under key 'plan' from ./index.jsx.
//
// "Refactor the Fusion into an executable plan or procedure, with ONE agent": after a Fusion report
// the user asks one model — by default their own subscription typed into THIS conversation's chat
// through the first site's pane (`web:claude`), or `anthropic/claude-opus-5.5` on OpenRouter in the
// web app — for a structured procedure: objective, prerequisites, numbered steps with a verify for
// each, decision points for what Fusion left standing, risks, done-when. One call, one PlanTurn,
// cached per fusion turn. The section lives INSIDE the Fusion pane (App.jsx is frozen with six
// regions; the S11 precedent is Refactor inside the Analyze pane), so this slice lives in
// features/fusion too, beside the fusion slice it is keyed on.
//
// Shape: { status:   'idle'|'running'|'working'|'done'|'degraded'|'error',
//          turn:     PlanTurn exactly as plan_done / plan_degraded sent it (or null),
//          cached:   plan_done.cached,
//          notice:   the latest plan_retry{error} narration while working — progress and the one
//                    correction attempt, not a failure, which is why it is not `error`,
//          error:    the terminal message on 'error', turn.error on 'degraded',
//          ofFusion: the fusion turn id this state belongs to,
//          model:    the model plan_start announced (the resolved one, stamped on the turn too) }
//
// The same shape and rules as analyze/refactorSlice.js (its template), keyed on the fusion turn
// instead of the send turn. Nothing else auto-runs Plan, so a `plan_*` event only ever arrives on
// the plan stream; `error` / `sse/end{ok:false}` count on the plan stream, or on any stream while
// a run is in flight, exactly as the refactor slice does.
import { anyStreaming } from './derive.js'
import { newestFusionTurn } from './slice.js'

export { newestFusionTurn }

/** localStorage key of the picked model (one owner: this slice's helpers). */
export const PLAN_MODEL_KEY = 'triplex.plan.model'
/** localStorage key prefix of the ticked steps, per plan turn. */
export const PLAN_CHECKED_PREFIX = 'triplex.plan.checked.'
/** The desktop default: typed into this conversation's chat through the pane (the site's own model setting applies). */
export const DEFAULT_MODEL_DESKTOP = 'web:claude'
/** The web-app default: OpenRouter, on the key in `.env` (verified live 2026-09-27). */
export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5'

// The three sites with a native pane and a Stage-1 adapter (backend/llm/bridge_protocol.py
// BRIDGE_SLOTS). Mirrored per feature — features never import each other's internals — the way
// config/index.jsx and desktop/slice.js carry their own copies. Display data for the picker only;
// no Triplex-authored string that reaches a model is built here.
export const SITES = ['claude', 'chatgpt', 'grok']
export const SITE_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' }

export const WEB_PANE_GROUP = "your web sessions (typed into this conversation's chat)"
export const WEB_ANALYST_GROUP = 'hidden analyst pages'
export const OLLAMA_GROUP = 'local (Ollama)'
export const OPENROUTER_GROUP = 'OpenRouter'
export const STRUCTURED_GROUP = 'structured outputs (recommended)'
export const OTHER_GROUP = 'other models'
export const DEFAULT_GROUP = 'default'

export function initial() {
  return { status: 'idle', turn: null, cached: false, notice: null, error: null, ofFusion: null, model: null }
}

/** Newest plan turn with status 'ok' for the given fusion turn id (what the backend's cache replays). */
export function newestOkPlanTurn(conversation, ofFusion) {
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t && t.type === 'plan' && t.of_fusion === ofFusion && t.status === 'ok') return t
  }
  return null
}

/**
 * The "Make a plan" button rule: a persisted fusion report is on screen (status done, a turn id,
 * no notice) and no stream is running — the plan stream included, since runStream registers it
 * under `streams.plan` like any other feature.
 */
export function planGate({ fusion, streams }) {
  if (!fusion || fusion.status !== 'done' || !fusion.turnId || fusion.notice) return { enabled: false, reason: 'no fusion report yet' }
  if (anyStreaming(streams)) return { enabled: false, reason: 'a stream is running' }
  return { enabled: true, reason: null }
}

export function defaultPlanModel(desktop) {
  return desktop ? DEFAULT_MODEL_DESKTOP : DEFAULT_MODEL
}

function usable(model) {
  return typeof model === 'string' && model.trim() !== '' && !/\s/.test(model)
}

/** The persisted choice, else the shell's default. Never throws (a private window, a blocked storage). */
export function loadPlanModel(storage, desktop) {
  if (!storage) return defaultPlanModel(desktop)
  try {
    const raw = storage.getItem(PLAN_MODEL_KEY)
    return usable(raw) ? raw : defaultPlanModel(desktop)
  } catch {
    return defaultPlanModel(desktop)
  }
}

/** Remember the choice; never throws. */
export function persistPlanModel(storage, model) {
  if (!storage || !usable(model)) return
  try {
    storage.setItem(PLAN_MODEL_KEY, model)
  } catch {
    /* quota / private mode: the in-memory choice is still right */
  }
}

const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))
// The plan is strict JSON, so models advertising structured outputs come first (as the analyst picker orders them).
const structuredFirst = (a, b) => (b.structured_outputs ? 1 : 0) - (a.structured_outputs ? 1 : 0) || byName(a, b)

function opt(m) {
  return { id: m.id, name: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id }
}

function isSlug(id) {
  return typeof id === 'string' && !id.startsWith('web:') && !id.startsWith('ollama:')
}

/**
 * The picker's `<optgroup>`s: `[{label, options: [{id, name}]}]`, empty groups dropped.
 *
 * Desktop: the three web panes FIRST (the plan is typed into this conversation's chat for that
 * site), then the hidden analyst pages, local Ollama models (`raw.transport === 'ollama'`) and — only
 * with a configured key — the OpenRouter entries the desktop catalog carries (`raw.transport ===
 * 'openrouter'`, structured outputs first). Browser: the OpenRouter catalog, structured first, with
 * the default id present even when the catalog lacks it (or is not loaded yet).
 */
export function planModelOptions({ items = [], desktop = false, keyConfigured = false } = {}) {
  const list = (items || []).filter((m) => m && typeof m.id === 'string')
  const byId = {}
  for (const m of list) byId[m.id] = m
  const groups = []
  const push = (label, options) => {
    if (options.length) groups.push({ label, options })
  }
  if (desktop) {
    push(
      WEB_PANE_GROUP,
      SITES.map((s) => ({ id: `web:${s}`, name: `${SITE_LABELS[s]} — this conversation's chat` })),
    )
    push(
      WEB_ANALYST_GROUP,
      SITES.map((s) => {
        const id = `web:${s}:analyst`
        return byId[id] ? opt(byId[id]) : { id, name: `${SITE_LABELS[s]} web session (hidden analyst page)` }
      }),
    )
    push(
      OLLAMA_GROUP,
      list
        .filter((m) => m.id.startsWith('ollama:') || (m.raw && m.raw.transport === 'ollama'))
        .sort(byName)
        .map(opt),
    )
    if (keyConfigured) {
      push(
        OPENROUTER_GROUP,
        list
          .filter((m) => isSlug(m.id) && m.raw && m.raw.transport === 'openrouter')
          .sort(structuredFirst)
          .map(opt),
      )
    }
    return groups
  }
  const slugs = list.filter((m) => isSlug(m.id))
  if (!slugs.some((m) => m.id === DEFAULT_MODEL)) push(DEFAULT_GROUP, [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }])
  push(STRUCTURED_GROUP, slugs.filter((m) => m.structured_outputs).sort(byName).map(opt))
  push(OTHER_GROUP, slugs.filter((m) => !m.structured_outputs).sort(byName).map(opt))
  return groups
}

/** True when `model` is one of the picker's options. */
export function hasOption(groups, model) {
  return (groups || []).some((g) => g.options.some((o) => o.id === model))
}

function checkedKey(turnId) {
  return `${PLAN_CHECKED_PREFIX}${turnId}`
}

/** The step numbers ticked for a plan turn (this browser only); [] when nothing is stored or storage is unavailable. */
export function checkedSteps(storage, turnId) {
  if (!storage || !turnId) return []
  try {
    const arr = JSON.parse(storage.getItem(checkedKey(turnId)) || '[]')
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

/** Flip step `n` and persist; returns the new list. Never throws. */
export function toggleStep(storage, turnId, n) {
  const current = checkedSteps(storage, turnId)
  const next = current.includes(n) ? current.filter((x) => x !== n) : [...current, n].sort((a, b) => a - b)
  if (storage && turnId) {
    try {
      storage.setItem(checkedKey(turnId), JSON.stringify(next))
    } catch {
      /* the in-memory tick is still right */
    }
  }
  return next
}

function inFlight(s) {
  return s.status === 'running' || s.status === 'working'
}

function isInitial(s) {
  return s.status === 'idle' && s.turn === null && s.error === null && s.ofFusion === null && s.cached === false && s.model === null
}

export function reducer(s = initial(), a) {
  switch (a.type) {
    case 'sse': {
      const ev = a.event
      if (!ev || typeof ev.type !== 'string') return s
      switch (ev.type) {
        case 'plan_start':
          return { status: 'running', turn: null, cached: false, notice: null, error: null, ofFusion: ev.of_fusion ?? null, model: ev.model ?? null }
        case 'plan_retry':
          // Progress, not a failure: the narration while the agent writes, and the one correction attempt.
          return { ...s, status: 'working', notice: ev.error ?? null }
        case 'plan_done': {
          const turn = ev.turn ?? null
          return { status: 'done', turn, cached: !!ev.cached, notice: null, error: null, ofFusion: (turn && turn.of_fusion) ?? s.ofFusion, model: (turn && turn.model) ?? s.model }
        }
        case 'plan_degraded': {
          const turn = ev.turn ?? null
          return { status: 'degraded', turn, cached: false, notice: null, error: (turn && turn.error) ?? null, ofFusion: (turn && turn.of_fusion) ?? s.ofFusion, model: (turn && turn.model) ?? s.model }
        }
        case 'error':
          if (a.feature === 'plan' || inFlight(s)) return { ...s, status: 'error', notice: null, error: ev.message || 'error' }
          return s
        default:
          return s
      }
    }
    case 'sse/end':
      // Pre-stream failures (409 busy / no_fusion_turn, 404, 422 plan_input_too_large) emit no plan_*
      // event at all: runStream reports them as sse/end{ok:false, error:<code>}.
      if (!a.ok && (a.feature === 'plan' || inFlight(s))) return { ...s, status: 'error', notice: null, error: a.error || 'stream failed' }
      return s
    case 'sse/abort':
      return inFlight(s) ? initial() : s
    case 'conversation/loaded': {
      const fusion = newestFusionTurn(a.conversation)
      if (!fusion) return isInitial(s) ? s : initial()
      if (s.ofFusion === fusion.id && s.status !== 'idle') return s
      const ok = newestOkPlanTurn(a.conversation, fusion.id)
      if (ok) return { status: 'done', turn: ok, cached: false, notice: null, error: null, ofFusion: fusion.id, model: ok.model ?? null }
      return isInitial(s) ? s : initial()
    }
    case 'conversation/cleared':
      return isInitial(s) ? s : initial()
    default:
      return s
  }
}
