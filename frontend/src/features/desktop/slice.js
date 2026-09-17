// Desktop `panes` slice (renderer-desktop, Stage 1). Registered under key 'panes' from ./index.jsx.
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
//   panes/sendResult {results}                    sending = false; lastSend[slot] = results[slot] (triplex.sendPrompt shape:
//                                                 {ok, code?, message?, ms, url?, composerSelector?, sendSelector?})
//   panes/zoom       {slot, factor}               from triplex.onZoom / the zoom() reply
//   panes/capture    {capture} | {slot, on}       whole map (getCapture) or one switch (setCapture)
//   panes/bridge     {connected, since?}
//   panes/turn       {slot, phase}                phase string from triplex.onTurn
//   panes/drawer     {open?}                      boolean sets, omitted toggles
//   panes/analyst    {slot?, visible?, health?}   merges the keys present
//
// Convention (state/reducers.js, features/send/slice.js): an action that changes nothing returns
// the SAME object, so untouched slices keep identity across the root reducer. Unknown slots and
// malformed payloads are ignored, never thrown.
//
// Persistence (contract §5, "one owner per persisted key"): the renderer owns
// `triplex.panes.mode|active|targets` in localStorage. `loadPersistedPanes(storage)` reads them
// (used by the slice's initial-state factory in index.jsx, so the first render already has the
// restored layout) and `persistPanes(storage, panes)` writes them; both swallow storage errors
// (private mode, quota, a missing `localStorage` in the thumbnail/test sandbox).

// Mirrored from features/send/slice.js (features never import across each other; state/* is frozen).
export const SLOT_IDS = ['claude', 'chatgpt', 'grok']
export const SLOT_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' }
export const MODES = ['tabs', 'split']

/** Session states that need the user (contract §3 codes = Health.session values). */
export const ATTENTION_SESSIONS = ['logged_out', 'challenge', 'blocked']
/** Badge text per attention state (plan row: "session badge SIGN IN / CHALLENGE / BLOCKED"). */
export const SESSION_BADGES = { logged_out: 'SIGN IN', challenge: 'CHALLENGE', blocked: 'BLOCKED' }

export const PERSIST_KEYS = { mode: 'triplex.panes.mode', active: 'triplex.panes.active', targets: 'triplex.panes.targets' }

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
      let lastSend = s.lastSend
      for (const k of list) {
        if (k in lastSend) {
          if (lastSend === s.lastSend) lastSend = { ...lastSend }
          delete lastSend[k]
        }
      }
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

/** A sendPrompt result whose code is a session state also means the pane needs the user. */
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
