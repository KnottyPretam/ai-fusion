import { APP_NAME } from '../../branding.js'
// Desktop `panes` slice (renderer-desktop Stage 1, renderer-desktop-2 Stage 2). Registered under key
// 'panes' from ./index.jsx.
//
// Shape (docs/desktop-contract.md §7):
//   { mode: 'tabs'|'split', active: slot, targets: {slot: bool},
//     health: {site: Health|null}, lastSend: {slot: {ok, code, message, ms, composerSelector, sendSelector}},
//     sending: bool, zoom: {site: number}, capture: {site: bool} (S2), bridge: {connected: bool} (S2),
//     turn: {site: phase} (S2), drawerOpen: bool (S3), analyst: {slot: site|null, visible, health} (S3),
//     council: {slots: {slot: {model, effort}}} | null (2026-09-27), openRouterKey: KeyStatus | null (2026-09-27) }
//
// Council (2026-09-27, "a council anyone can assemble"): a conversation seats 2..5 of the 7-vendor
// catalog (`SLOT_IDS`); only the three SITES have a native view, so `health` / `zoom` / `capture` /
// `turn` stay PER-SITE maps (the frozen desktop-smoke.test.jsx pins their three-key literals),
// while `active` and `targets` range over the whole catalog — a token/local member is a renderer
// column that can be the active tab and a Send target. `targets[k] !== false` means ON, so a
// member the map has never seen (a freshly seated Qwen) is targeted by default; `selectedTargets`
// intersects with the council. `council` is main's DEFAULT for new conversations (`getCouncil`,
// replayed on `panes:council`), stored as the spec main hands over and validated here (2..5 known
// slots, each with a string model); `openRouterKey` is main's key STATUS ({configured, prefix,
// length, pushed, error?}) — the key itself never reaches the renderer.
//
// Health is the object `site.cjs` publishes over 'panes:health' (contract §3):
//   { composer: bool, send: bool, reply, stop, session: 'ok'|'logged_out'|'challenge'|'blocked'|'unknown',
//     matched: {composer: selector|null, send: selector|null, reply, stop, error}, url, host, title, ts }
//
// Actions (§7) and the payloads this reducer reads:
//   panes/mode       {mode}                       'tabs' | 'split'
//   panes/active     {active}                     a slot id
//   panes/target     {slot, on}                   one target checkbox
//   panes/health     {slot, health}               Health object or null (from triplex.onHealth)
//   panes/sendStart  {targets?}                   sending = true; clears lastSend for the targets (all when omitted)
//   panes/sendResult {results}                    sending = false; lastSend[slot] = results[slot] (per-slot outcome
//                                                 objects in the lastSend shape; `{}` just ends the send)
//   panes/zoom       {slot, factor}               from triplex.onZoom / the zoom() reply
//   panes/capture    {capture} | {slot, on}       whole map (getCapture) or one switch (setCapture)
//   panes/bridge     {connected, since?, error?}   `error` (S3) is kept only while disconnected: main
//                                                 names why a backend could not be spawned (port_in_use)
//   panes/turn       {slot, phase}                phase string from triplex.onTurn
//   panes/drawer     {open?}                      boolean sets, omitted toggles
//   panes/analyst    {slot?, visible?, health?}   merges the keys present
//   panes/council    {council}                    main's default council spec (validated; null clears)
//   panes/openRouterKey {status}                  main's key status object (null clears)
//
// Stage 2 — the unified prompt is a Triplex Send (`POST /api/conversations/{id}/send` through
// features/send/useSendTurn.js) and the per-slot outcome comes from that stream, so this slice also
// reads the frozen `sse {feature:'send', event}` action (every slice gets every action, the same way
// the meter slice books other features' streams):
//   turn_start{slots}          clears lastSend for the listed slots (a subset send or a solo continue)
//   slot_done{slot, usage}     lastSend[slot] = {ok:true, ms: usage.latency_ms}            → "sent ✓ captured"
//   slot_error{slot, code, …}  code 'not_captured' (capture is off for that site; the reply stayed
//                              in the pane, docs/api-contract.md addendum) → {ok:true, code, message}
//                              → "sent ✓ not captured"; any other code → {ok:false, code, message}
//                              → "✗ <code>". In tabs mode a logged_out | challenge | blocked error
//                              also activates that pane (auto-reveal, plan Decision 7).
// Why here and not in a component effect: the `slots` slice is reset by the post-stream refetch
// (`conversation/loaded`), React batches the dispatches of one chunk into one render, and the
// persisted SendTurn keeps only the error MESSAGE — so a reducer that sees every event is the only
// place where the outcome (with its code) is recorded exactly once and kept until the next send.
// `lastSend` therefore describes the last unified send, whatever conversation is open (as in
// Stage 1); a switch does not clear it, the next send / turn_start does.
//
// Convention (state/reducers.js, features/send/slice.js): an action that changes nothing returns
// the SAME object, so untouched slices keep identity across the root reducer. Unknown slots and
// malformed payloads are ignored, never thrown.
//
// Persistence (contract §5, "one owner per persisted key"): the renderer owns
// `triplex.panes.mode|active|targets` (+ `triplex.panes.drawerOpen` from Stage 3) in localStorage.
// `loadPersistedPanes(storage)` reads them (used by the slice's initial-state factory in index.jsx,
// so the first render already has the restored layout) and `persistPanes(storage, panes)` writes
// them; both swallow storage errors
// (private mode, quota, a missing `localStorage` in the thumbnail/test sandbox). Stage 2 adds
// `triplex.panes.captureNoticeSeen` = JSON `{slot: bool}` of the capture switches touched once
// (the first-run ToS notice hides when every site's is true); the switch VALUES themselves are
// main's (`settings.json`), read back through `getCapture`.

// Mirrored from features/send/slice.js (features never import across each other; state/* is frozen):
// the 7-vendor catalog in backend/schemas.py SLOT_IDS order, the classic three first.
export const SLOT_IDS = ['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'qwen', 'mimo']
export const DEFAULT_COUNCIL = SLOT_IDS.slice(0, 3)
export const COUNCIL_MIN = 2
export const COUNCIL_MAX = 5
export const SLOT_VENDORS = { claude: 'anthropic', chatgpt: 'openai', grok: 'x-ai', gemini: 'google', deepseek: 'deepseek', qwen: 'qwen', mimo: 'xiaomi' }
export const SLOT_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', gemini: 'Gemini', deepseek: 'DeepSeek', qwen: 'Qwen', mimo: 'MiMo' }
/** The sites with a native WebContentsView and a Stage-1 adapter (= the preload's `sites`). */
export const SITES = ['claude', 'chatgpt', 'grok']
export const MODES = ['tabs', 'split']

/** Session states that need the user (contract §3 codes = Health.session values). */
export const ATTENTION_SESSIONS = ['logged_out', 'challenge', 'blocked']
/** Badge text per attention state (plan row: "session badge SIGN IN / CHALLENGE / BLOCKED"). */
export const SESSION_BADGES = { logged_out: 'SIGN IN', challenge: 'CHALLENGE', blocked: 'BLOCKED' }

/** slot_error code minted by backend/llm/bridge.py when capture is off for the site (api-contract addendum). */
export const NOT_CAPTURED = 'not_captured'

/** The capture switch label (plan Stage 2 row, verbatim) and the ToS wording next to it / in the notice. */
export const CAPTURE_LABEL = `Capture reply text from this page into ${APP_NAME} (needed for Analyze/Fusion)`
export const CAPTURE_NOTICE_TEXT =
  'Capture is off by default for every site. Switching it on for a pane makes ' + APP_NAME + ' read that site’s reply text out of the page — the act the providers’ terms of service name: OpenAI’s terms forbid to “automatically or programmatically extract data or Output”, Anthropic’s consumer terms forbid access “through automated or non-human means”, and xAI’s forbid automated access beyond a conventional browser. Typing the prompt into the composer is unaffected; Analyze and Fusion only see captured text. Decide per site with the switch in each pane header — this notice stays until each of the three switches has been set once.'
export const CAPTURE_TITLE = 'Reads the reply out of this page, the act the site’s terms of service name. Off by default; your decision per site.'

export const PERSIST_KEYS = { mode: 'triplex.panes.mode', active: 'triplex.panes.active', targets: 'triplex.panes.targets', drawerOpen: 'triplex.panes.drawerOpen' }

/**
 * Message prefix of the `not_captured` slot error minted by backend/llm/bridge.py
 * ("capture is off for <slot>; the reply is in the site pane"). The persisted SendTurn keeps only
 * the error MESSAGE (`errors[slot]`), never the code, so this prefix is the persisted signal
 * that a slot's reply stayed in its pane (the drawer's capture hint).
 */
export const NOT_CAPTURED_MESSAGE_PREFIX = 'capture is off for '
export const CAPTURE_NOTICE_KEY = 'triplex.panes.captureNoticeSeen'

/** Phase words for pane-<slot>-phase (contract §2 onTurn: idle|typing|submitted|replying|done|error). */
export const PHASE_TEXT = { idle: 'idle', typing: 'typing…', submitted: 'submitted', replying: 'replying…', done: 'done', error: 'error' }

export function isSlotId(x) {
  return SLOT_IDS.includes(x)
}

export function isSiteId(x) {
  return SITES.includes(x)
}

export function isMode(x) {
  return MODES.includes(x)
}

/** 'web' | 'openrouter' | 'ollama' for a model string; null for '' / null / a non-string. */
export function transportOf(model) {
  if (typeof model !== 'string' || !model) return null
  if (model.startsWith('web:')) return 'web'
  if (model.startsWith('ollama:')) return 'ollama'
  return 'openrouter'
}

/** Inline `--slot-color` for a slot (the palette tokens `--claude` … `--mimo` are in the frozen index.css). */
export function slotStyle(slot) {
  return { '--slot-color': isSlotId(slot) ? `var(--${slot})` : 'var(--border)' }
}

/**
 * The council a config seats, in catalog order; null without one. Works on the frozen `slotConfig`
 * slice, a turn's `slot_config` and main's council spec alike (all are `{slots: {<slot>: …}}`).
 */
export function councilOf(spec) {
  const slots = spec && typeof spec === 'object' && spec.slots && typeof spec.slots === 'object' ? spec.slots : null
  if (!slots) return null
  const list = SLOT_IDS.filter((s) => s in slots)
  return list.length ? list : null
}

/**
 * A council spec as main hands it over (`getCouncil` / `panes:council`), validated and re-keyed in
 * catalog order: `{slots: {<slot>: {model: string, effort: string}}}` with 2..5 known slots. Null
 * for anything else (an unknown slot, a missing model, one member, six).
 */
export function normalizeCouncil(spec) {
  const slots = spec && typeof spec === 'object' && spec.slots && typeof spec.slots === 'object' ? spec.slots : null
  if (!slots) return null
  const keys = Object.keys(slots)
  if (keys.length < COUNCIL_MIN || keys.length > COUNCIL_MAX || !keys.every(isSlotId)) return null
  const out = {}
  for (const k of SLOT_IDS) {
    if (!(k in slots)) continue
    const spec1 = slots[k]
    if (!spec1 || typeof spec1 !== 'object' || typeof spec1.model !== 'string' || !spec1.model) return null
    out[k] = { model: spec1.model, effort: typeof spec1.effort === 'string' && spec1.effort ? spec1.effort : 'off' }
  }
  return { slots: out }
}

/** Main's key status, or null: `{configured, prefix, length, pushed, error?}` (never the key). */
export function normalizeKeyStatus(status) {
  if (!status || typeof status !== 'object') return null
  const out = {
    configured: !!status.configured,
    prefix: typeof status.prefix === 'string' ? status.prefix : '',
    length: Number.isFinite(status.length) ? status.length : 0,
    pushed: !!status.pushed,
  }
  if (typeof status.error === 'string' && status.error) out.error = status.error
  return out
}

function perSite(value) {
  const o = {}
  for (const k of SITES) o[k] = value
  return o
}

/**
 * Initial state. `persisted` (optional) = `{mode?, active?, targets?, drawerOpen?}` as returned by
 * loadPersistedPanes; anything invalid falls back to the defaults, key by key.
 */
export function initialPanes(persisted) {
  const p = persisted && typeof persisted === 'object' ? persisted : {}
  // Targets start with the three sites ON (the persisted shape of Stage 1/2); a non-site member is
  // absent from the map until switched, and `selectedTargets` reads absent as on.
  const targets = perSite(true)
  if (p.targets && typeof p.targets === 'object') {
    for (const k of SLOT_IDS) if (typeof p.targets[k] === 'boolean') targets[k] = p.targets[k]
  }
  return {
    mode: isMode(p.mode) ? p.mode : 'split',
    active: isSlotId(p.active) ? p.active : 'chatgpt',
    targets,
    health: perSite(null),
    lastSend: {},
    sending: false,
    zoom: perSite(1),
    capture: perSite(false),
    bridge: { connected: false },
    turn: {},
    drawerOpen: typeof p.drawerOpen === 'boolean' ? p.drawerOpen : false,
    analyst: { slot: null, visible: false, health: null },
    council: null,
    openRouterKey: null,
  }
}

function setIn(s, key, slot, value) {
  if (s[key][slot] === value) return s
  return { ...s, [key]: { ...s[key], [slot]: value } }
}

function isFactor(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0
}

/** lastSend without the given slots (same object when none of them was present). */
function withoutSlots(lastSend, list) {
  let out = lastSend
  for (const k of list) {
    if (k in out) {
      if (out === lastSend) out = { ...out }
      delete out[k]
    }
  }
  return out
}

/**
 * The lastSend entry for one terminal per-slot Send event (`slot_done` / `slot_error`), or null
 * for any other event. `ms` is the call latency stamped in `slot_done.usage.latency_ms` (the web
 * transport reports zero tokens and cost; latency is real). `not_captured` is an `ok` outcome with
 * the code: the site answered, the text stayed in the pane.
 */
export function sendOutcome(ev) {
  if (!ev || typeof ev !== 'object' || !isSlotId(ev.slot)) return null
  if (ev.type === 'slot_done') {
    const ms = ev.usage && typeof ev.usage === 'object' ? Number(ev.usage.latency_ms) || 0 : 0
    return { ok: true, ms }
  }
  if (ev.type === 'slot_error') {
    const code = ev.code === undefined || ev.code === null || ev.code === '' ? 'error' : String(ev.code)
    const message = typeof ev.message === 'string' ? ev.message : ''
    return { ok: code === NOT_CAPTURED, code, message, ms: 0 }
  }
  return null
}

function reduceSendEvent(s, ev) {
  if (!ev || typeof ev !== 'object') return s
  if (ev.type === 'turn_start') {
    const list = Array.isArray(ev.slots) ? ev.slots.filter(isSlotId) : SLOT_IDS
    const lastSend = withoutSlots(s.lastSend, list)
    return lastSend === s.lastSend ? s : { ...s, lastSend }
  }
  const outcome = sendOutcome(ev)
  if (!outcome) return s
  const next = { ...s, lastSend: { ...s.lastSend, [ev.slot]: outcome } }
  // Auto-reveal: a rejection that needs the user (sign in, solve a challenge, an "unusual
  // activity" block) switches to that pane in tabs mode; split mode shows every pane already.
  if (s.mode === 'tabs' && s.active !== ev.slot && resultNeedsAttention(outcome)) next.active = ev.slot
  return next
}

export function panesReducer(s = initialPanes(), a) {
  switch (a.type) {
    case 'panes/mode':
      return isMode(a.mode) && a.mode !== s.mode ? { ...s, mode: a.mode } : s
    case 'panes/active':
      return isSlotId(a.active) && a.active !== s.active ? { ...s, active: a.active } : s
    case 'panes/target':
      return isSlotId(a.slot) ? setIn(s, 'targets', a.slot, !!a.on) : s
    case 'panes/health': {
      if (!isSiteId(a.slot)) return s
      const health = a.health && typeof a.health === 'object' ? a.health : null
      return setIn(s, 'health', a.slot, health)
    }
    case 'panes/sendStart': {
      const list = Array.isArray(a.targets) ? a.targets.filter(isSlotId) : SLOT_IDS
      const lastSend = withoutSlots(s.lastSend, list)
      if (s.sending && lastSend === s.lastSend) return s
      return { ...s, sending: true, lastSend }
    }
    case 'panes/sendResult': {
      const results = a.results && typeof a.results === 'object' ? a.results : {}
      let lastSend = s.lastSend
      for (const [k, v] of Object.entries(results)) {
        if (!isSlotId(k) || !v || typeof v !== 'object' || lastSend[k] === v) continue
        if (lastSend === s.lastSend) lastSend = { ...lastSend }
        lastSend[k] = v
      }
      if (!s.sending && lastSend === s.lastSend) return s
      return { ...s, sending: false, lastSend }
    }
    case 'panes/zoom':
      return isSiteId(a.slot) && isFactor(a.factor) ? setIn(s, 'zoom', a.slot, a.factor) : s
    case 'panes/capture': {
      if (a.capture && typeof a.capture === 'object') {
        let next = s
        for (const k of SITES) if (k in a.capture) next = setIn(next, 'capture', k, !!a.capture[k])
        return next
      }
      return isSiteId(a.slot) ? setIn(s, 'capture', a.slot, !!a.on) : s
    }
    case 'panes/bridge': {
      const connected = !!a.connected
      const since = connected && a.since != null ? a.since : undefined
      const error = !connected && typeof a.error === 'string' && a.error ? a.error : undefined
      if (s.bridge.connected === connected && s.bridge.since === since && s.bridge.error === error) return s
      const bridge = { connected }
      if (since !== undefined) bridge.since = since
      if (error !== undefined) bridge.error = error
      return { ...s, bridge }
    }
    case 'panes/turn':
      return isSiteId(a.slot) && typeof a.phase === 'string' ? setIn(s, 'turn', a.slot, a.phase) : s
    case 'panes/drawer': {
      const open = a.open === undefined ? !s.drawerOpen : !!a.open
      return open === s.drawerOpen ? s : { ...s, drawerOpen: open }
    }
    case 'panes/analyst': {
      const next = { ...s.analyst }
      if ('slot' in a) next.slot = isSiteId(a.slot) ? a.slot : null
      if ('visible' in a) next.visible = !!a.visible
      if ('health' in a) next.health = a.health && typeof a.health === 'object' ? a.health : null
      const same = next.slot === s.analyst.slot && next.visible === s.analyst.visible && next.health === s.analyst.health
      return same ? s : { ...s, analyst: next }
    }
    case 'panes/council': {
      // An invalid spec is ignored (the state keeps the last good default); `null` clears it.
      if (a.council === null) return s.council === null ? s : { ...s, council: null }
      const council = normalizeCouncil(a.council)
      if (!council) return s
      return sameCouncil(council, s.council) ? s : { ...s, council }
    }
    case 'panes/openRouterKey': {
      const status = normalizeKeyStatus(a.status)
      if (status === null) return s.openRouterKey === null ? s : { ...s, openRouterKey: null }
      return sameKeyStatus(status, s.openRouterKey) ? s : { ...s, openRouterKey: status }
    }
    case 'sse':
      // The unified prompt streams under feature key 'send' (a solo continue from the Stage 3
      // drawer too); Analyze / Fusion events never touch the per-slot send outcome.
      return a.feature === 'send' && a.event ? reduceSendEvent(s, a.event) : s
    default:
      return s
  }
}

function sameCouncil(a, b) {
  if (!a || !b) return a === b
  const ka = Object.keys(a.slots)
  const kb = Object.keys(b.slots)
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a.slots[k].model === b.slots[k].model && a.slots[k].effort === b.slots[k].effort)
}

function sameKeyStatus(a, b) {
  if (!a || !b) return a === b
  return a.configured === b.configured && a.prefix === b.prefix && a.length === b.length && a.pushed === b.pushed && a.error === b.error
}

// ---------------------------------------------------------------------------------------------
// Derivations shared by PaneDeck / PromptBar (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The council members whose target checkbox is on, in council (= catalog) order. A member the map
 * does not name is ON (`targets[k] !== false`): only an explicit `false` unchecks it.
 */
export function selectedTargets(targets, council = DEFAULT_COUNCIL) {
  return council.filter((k) => !(targets && targets[k] === false))
}

/** Health.session or 'unknown' when the pane has not reported yet. */
export function sessionOf(health) {
  const s = health && typeof health === 'object' ? health.session : null
  return typeof s === 'string' ? s : 'unknown'
}

export function needsAttention(session) {
  return ATTENTION_SESSIONS.includes(session)
}

/** A send outcome whose code is a session state also means the pane needs the user. */
export function resultNeedsAttention(result) {
  return !!(result && typeof result === 'object' && !result.ok && ATTENTION_SESSIONS.includes(result.code))
}

/**
 * Health dot level: 'none' (no health yet) | 'bad' (session needs attention, or no composer) |
 * 'warn' (composer but no send button) | 'ok'.
 */
export function healthLevel(health) {
  if (!health || typeof health !== 'object') return 'none'
  if (needsAttention(sessionOf(health))) return 'bad'
  if (!health.composer) return 'bad'
  if (!health.send) return 'warn'
  return 'ok'
}

const SESSION_WORDS = { ok: 'signed in', logged_out: 'signed out', challenge: 'challenge', blocked: 'blocked', unknown: 'unknown' }

/** Human text for the session state (health text suffix). */
export function sessionText(session) {
  return SESSION_WORDS[session] || 'unknown'
}

/** 'composer ✓ send ✓ · signed in' (or 'no health yet' before the first health event). */
export function healthText(health) {
  if (!health || typeof health !== 'object') return 'no health yet'
  const tick = (v) => (v ? '✓' : '✗')
  return `composer ${tick(health.composer)} send ${tick(health.send)} · ${sessionText(sessionOf(health))}`
}

/** Title attribute for the health text: the matched selectors (or "none") and the page. */
export function healthTitle(health) {
  if (!health || typeof health !== 'object') return 'no health event from this pane yet'
  const m = health.matched && typeof health.matched === 'object' ? health.matched : {}
  const parts = [`composer: ${m.composer || 'none'}`, `send: ${m.send || 'none'}`]
  if (m.error) parts.push(`error: ${m.error}`)
  if (health.url) parts.push(`url: ${health.url}`)
  return parts.join('\n')
}

/** Text for pane-<slot>-phase: the phase word ('' before the first onTurn event; unknown phases verbatim). */
export function phaseText(phase) {
  if (typeof phase !== 'string' || !phase) return ''
  return PHASE_TEXT[phase] || phase
}

/** True when every capture switch has been set at least once (the first-run notice hides). */
export function allCaptureTouched(touched) {
  return SITES.every((k) => !!(touched && touched[k]))
}

/**
 * The slots of a persisted send turn whose reply stayed in the pane because capture was off
 * (`errors[slot]` carries the bridge's not_captured message), in SLOT_IDS order; [] for anything
 * that is not a send turn.
 */
export function notCapturedSlots(turn) {
  if (!turn || typeof turn !== 'object' || turn.type !== 'send') return []
  const errors = turn.errors && typeof turn.errors === 'object' ? turn.errors : {}
  return SLOT_IDS.filter((k) => typeof errors[k] === 'string' && errors[k].startsWith(NOT_CAPTURED_MESSAGE_PREFIX))
}

// ---------------------------------------------------------------------------------------------
// localStorage persistence (renderer-owned keys, contract §5)
// ---------------------------------------------------------------------------------------------

function defaultStorage() {
  // Bare `localStorage` (globalThis) rather than `window.localStorage`: the access itself can throw
  // (a SecurityError when site data is blocked), and tests inject a stub via vi.stubGlobal.
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null
  } catch {
    return null
  }
}

/** Read `{mode?, active?, targets?, drawerOpen?}` from storage; invalid or missing values are omitted. */
export function loadPersistedPanes(storage = defaultStorage()) {
  const out = {}
  if (!storage) return out
  try {
    const mode = storage.getItem(PERSIST_KEYS.mode)
    if (isMode(mode)) out.mode = mode
    const active = storage.getItem(PERSIST_KEYS.active)
    if (isSlotId(active)) out.active = active
    const raw = storage.getItem(PERSIST_KEYS.targets)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const targets = {}
        for (const k of SLOT_IDS) if (typeof parsed[k] === 'boolean') targets[k] = parsed[k]
        out.targets = targets
      }
    }
    const drawer = storage.getItem(PERSIST_KEYS.drawerOpen)
    if (drawer === 'true' || drawer === 'false') out.drawerOpen = drawer === 'true'
  } catch {
    /* a bad value or an unavailable storage means "nothing persisted" */
  }
  return out
}

/** Write mode / active / targets / drawerOpen; never throws. */
export function persistPanes(storage = defaultStorage(), panes) {
  if (!storage || !panes) return
  try {
    storage.setItem(PERSIST_KEYS.mode, panes.mode)
    storage.setItem(PERSIST_KEYS.active, panes.active)
    // Only the keys the map holds are written: an absent member stays "on by default" (never
    // frozen into `false` by a write that predates its seating).
    const targets = {}
    for (const k of SLOT_IDS) if (panes.targets && typeof panes.targets[k] === 'boolean') targets[k] = panes.targets[k]
    storage.setItem(PERSIST_KEYS.targets, JSON.stringify(targets))
    storage.setItem(PERSIST_KEYS.drawerOpen, panes.drawerOpen ? 'true' : 'false')
  } catch {
    /* quota / private mode: the in-memory state is still right */
  }
}

/**
 * Read which capture switches were touched once: `{claude, chatgpt, grok: bool}`. Accepts the JSON
 * map this module writes and a bare `true` (= all seen); anything else means "none yet".
 */
export function loadCaptureTouched(storage = defaultStorage()) {
  const out = perSite(false)
  if (!storage) return out
  try {
    const raw = storage.getItem(CAPTURE_NOTICE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw)
    if (parsed === true) return perSite(true)
    if (parsed && typeof parsed === 'object') for (const k of SITES) if (parsed[k] === true) out[k] = true
  } catch {
    /* a bad value or an unavailable storage means "nothing persisted" */
  }
  return out
}

/** Write the touched map; never throws. */
export function persistCaptureTouched(storage = defaultStorage(), touched) {
  if (!storage || !touched) return
  try {
    const o = {}
    for (const k of SITES) o[k] = !!touched[k]
    storage.setItem(CAPTURE_NOTICE_KEY, JSON.stringify(o))
  } catch {
    /* quota / private mode: the in-memory state is still right */
  }
}
