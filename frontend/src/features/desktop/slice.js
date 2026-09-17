// Desktop `panes` slice (Stage 0 placeholder by the integrator; features/desktop/** is owned by
// renderer-desktop from Stage 1). Registered under key 'panes' from ./index.jsx.
//
// Shape (docs/desktop-contract.md §7):
//   { mode: 'tabs'|'split', active: slot, targets: {slot: bool},
//     health: {slot: Health|null}, lastSend: {slot: {ok, code, message, ms, composerSelector, sendSelector}},
//     sending: bool, zoom: {slot: number}, capture: {slot: bool} (S2), bridge: {connected: bool} (S2),
//     turn: {slot: phase} (S2), drawerOpen: bool (S3), analyst: {slot: slot|null, visible, health} (S3) }
//
// Actions (§7) and the payloads this reducer reads:
//   panes/mode       {mode}                       'tabs' | 'split'
//   panes/active     {active}                     a slot id
//   panes/target     {slot, on}                   one target checkbox
//   panes/health     {slot, health}               Health object or null (from triplex.onHealth)
//   panes/sendStart  {targets?}                   sending = true; clears lastSend for the targets (all when omitted)
//   panes/sendResult {results}                    sending = false; lastSend[slot] = results[slot] (triplex.sendPrompt shape)
//   panes/zoom       {slot, factor}               from triplex.onZoom / zoom()
//   panes/capture    {capture} | {slot, on}       whole map (getCapture) or one switch (setCapture)
//   panes/bridge     {connected, since?}
//   panes/turn       {slot, phase}                phase string from triplex.onTurn
//   panes/drawer     {open?}                      boolean sets, omitted toggles
//   panes/analyst    {slot?, visible?, health?}   merges the keys present
//
// Convention (state/reducers.js, features/send/slice.js): an action that changes nothing returns
// the SAME object, so untouched slices keep identity across the root reducer. Unknown slots and
// malformed payloads are ignored, never thrown.

// Mirrored from features/send/slice.js (features never import across each other; state/* is frozen).
export const SLOT_IDS = ['claude', 'chatgpt', 'grok']
export const MODES = ['tabs', 'split']

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

export function initialPanes() {
  return {
    mode: 'split',
    active: 'chatgpt',
    targets: perSlot(true),
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
