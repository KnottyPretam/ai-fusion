// Desktop `panes` slice (renderer-desktop Stage 1, renderer-desktop-2 Stage 2). Registered under key
// 'panes' from ./index.jsx.
//
// Shape (docs/desktop-contract.md §7):
//   { mode: 'tabs'|'split', active: slot, targets: {slot: bool},
//     health: {slot: Health|null}, lastSend: {slot: {ok, code, message, ms, composerSelector, sendSelector}},
//     sending: bool, zoom: {slot: number}, capture: {slot: bool} (S2), bridge: {connected: bool} (S2),
//     turn: {slot: phase} (S2), drawerOpen: bool (S3), analyst: {slot: slot|null, visible, health} (S3) }
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
//   panes/bridge     {connected, since?}
//   panes/turn       {slot, phase}                phase string from triplex.onTurn
//   panes/drawer     {open?}                      boolean sets, omitted toggles
//   panes/analyst    {slot?, visible?, health?}   merges the keys present
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
// `triplex.panes.mode|active|targets` in localStorage. `loadPersistedPanes(storage)` reads them
// (used by the slice's initial-state factory in index.jsx, so the first render already has the
// restored layout) and `persistPanes(storage, panes)` writes them; both swallow storage errors
// (private mode, quota, a missing `localStorage` in the thumbnail/test sandbox). Stage 2 adds
// `triplex.panes.captureNoticeSeen` = JSON `{slot: bool}` of the capture switches touched once
// (the first-run ToS notice hides when all three are true); the switch VALUES themselves are
// main's (`settings.json`), read back through `getCapture`.

// Mirrored from features/send/slice.js (features never import across each other; state/* is frozen).
export const SLOT_IDS = ['claude', 'chatgpt', 'grok']
export const SLOT_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' }
export const MODES = ['tabs', 'split']

/** Session states that need the user (contract §3 codes = Health.session values). */
export const ATTENTION_SESSIONS = ['logged_out', 'challenge', 'blocked']
/** Badge text per attention state (plan row: "session badge SIGN IN / CHALLENGE / BLOCKED"). */
export const SESSION_BADGES = { logged_out: 'SIGN IN', challenge: 'CHALLENGE', blocked: 'BLOCKED' }

/** slot_error code minted by backend/llm/bridge.py when capture is off for the site (api-contract addendum). */
export const NOT_CAPTURED = 'not_captured'

/** The capture switch label (plan Stage 2 row, verbatim) and the ToS wording next to it / in the notice. */
export const CAPTURE_LABEL = 'Capture reply text from this page into Triplex (needed for Analyze/Fusion)'
export const CAPTURE_NOTICE_TEXT =
  'Capture is off by default for every site. Switching it on for a pane makes Triplex read that site’s reply text out of the page — the act the providers’ terms of service name: OpenAI’s terms forbid to “automatically or programmatically extract data or Output”, Anthropic’s consumer terms forbid access “through automated or non-human means”, and xAI’s forbid automated access beyond a conventional browser. Typing the prompt into the composer is unaffected; Analyze and Fusion only see captured text. Decide per site with the switch in each pane header — this notice stays until each of the three switches has been set once.'
export const CAPTURE_TITLE = 'Reads the reply out of this page, the act the site’s terms of service name. Off by default; your decision per site.'

export const PERSIST_KEYS = { mode: 'triplex.panes.mode', active: 'triplex.panes.active', targets: 'triplex.panes.targets' }
export const CAPTURE_NOTICE_KEY = 'triplex.panes.captureNoticeSeen'

/** Phase words for pane-<slot>-phase (contract §2 onTurn: idle|typing|submitted|replying|done|error). */
export const PHASE_TEXT = { idle: 'idle', typing: 'typing…', submitted: 'submitted', replying: 'replying…', done: 'done', error: 'error' }

export function isSlotId(x) {
  return SLOT_IDS.includes(x)
}

export function isMode(x) {
  return MODES.includes(x)
}

function perSlot(value) {
  const o = {}
  for (const k of SLOT_IDS) o[k] = value
  return o
}

/**
 * Initial state. `persisted` (optional) = `{mode?, active?, targets?}` as returned by
 * loadPersistedPanes; anything invalid falls back to the defaults, key by key.
 */
export function initialPanes(persisted) {
  const p = persisted && typeof persisted === 'object' ? persisted : {}
  const targets = perSlot(true)
  if (p.targets && typeof p.targets === 'object') {
    for (const k of SLOT_IDS) if (typeof p.targets[k] === 'boolean') targets[k] = p.targets[k]
  }
  return {
    mode: isMode(p.mode) ? p.mode : 'split',
    active: isSlotId(p.active) ? p.active : 'chatgpt',
    targets,
    health: perSlot(null),
    lastSend: {},
    sending: false,
    zoom: perSlot(1),
    capture: perSlot(false),
    bridge: { connected: false },
    turn: {},
    drawerOpen: false,
    analyst: { slot: null, visible: false, health: null },
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
      if (!isSlotId(a.slot)) return s
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
      return isSlotId(a.slot) && isFactor(a.factor) ? setIn(s, 'zoom', a.slot, a.factor) : s
    case 'panes/capture': {
      if (a.capture && typeof a.capture === 'object') {
        let next = s
        for (const k of SLOT_IDS) if (k in a.capture) next = setIn(next, 'capture', k, !!a.capture[k])
        return next
      }
      return isSlotId(a.slot) ? setIn(s, 'capture', a.slot, !!a.on) : s
    }
    case 'panes/bridge': {
      const connected = !!a.connected
      const since = connected && a.since != null ? a.since : undefined
      if (s.bridge.connected === connected && s.bridge.since === since) return s
      return { ...s, bridge: since === undefined ? { connected } : { connected, since } }
    }
    case 'panes/turn':
      return isSlotId(a.slot) && typeof a.phase === 'string' ? setIn(s, 'turn', a.slot, a.phase) : s
    case 'panes/drawer': {
      const open = a.open === undefined ? !s.drawerOpen : !!a.open
      return open === s.drawerOpen ? s : { ...s, drawerOpen: open }
    }
    case 'panes/analyst': {
      const next = { ...s.analyst }
      if ('slot' in a) next.slot = isSlotId(a.slot) ? a.slot : null
      if ('visible' in a) next.visible = !!a.visible
      if ('health' in a) next.health = a.health && typeof a.health === 'object' ? a.health : null
      const same = next.slot === s.analyst.slot && next.visible === s.analyst.visible && next.health === s.analyst.health
      return same ? s : { ...s, analyst: next }
    }
    case 'sse':
      // The unified prompt streams under feature key 'send' (a solo continue from the Stage 3
      // drawer too); Analyze / Fusion events never touch the per-slot send outcome.
      return a.feature === 'send' && a.event ? reduceSendEvent(s, a.event) : s
    default:
      return s
  }
}

// ---------------------------------------------------------------------------------------------
// Derivations shared by PaneDeck / PromptBar (pure)
// ---------------------------------------------------------------------------------------------

/** The slots whose target checkbox is on, in SLOT_IDS order. */
export function selectedTargets(targets) {
  return SLOT_IDS.filter((k) => !!(targets && targets[k]))
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
  return SLOT_IDS.every((k) => !!(touched && touched[k]))
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

/** Read `{mode?, active?, targets?}` from storage; invalid or missing values are omitted. */
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
  } catch {
    /* a bad value or an unavailable storage means "nothing persisted" */
  }
  return out
}

/** Write mode / active / targets; never throws. */
export function persistPanes(storage = defaultStorage(), panes) {
  if (!storage || !panes) return
  try {
    storage.setItem(PERSIST_KEYS.mode, panes.mode)
    storage.setItem(PERSIST_KEYS.active, panes.active)
    const targets = {}
    for (const k of SLOT_IDS) targets[k] = !!(panes.targets && panes.targets[k])
    storage.setItem(PERSIST_KEYS.targets, JSON.stringify(targets))
  } catch {
    /* quota / private mode: the in-memory state is still right */
  }
}

/**
 * Read which capture switches were touched once: `{claude, chatgpt, grok: bool}`. Accepts the JSON
 * map this module writes and a bare `true` (= all seen); anything else means "none yet".
 */
export function loadCaptureTouched(storage = defaultStorage()) {
  const out = perSlot(false)
  if (!storage) return out
  try {
    const raw = storage.getItem(CAPTURE_NOTICE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw)
    if (parsed === true) return perSlot(true)
    if (parsed && typeof parsed === 'object') for (const k of SLOT_IDS) if (parsed[k] === true) out[k] = true
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
    for (const k of SLOT_IDS) o[k] = !!touched[k]
    storage.setItem(CAPTURE_NOTICE_KEY, JSON.stringify(o))
  } catch {
    /* quota / private mode: the in-memory state is still right */
  }
}
