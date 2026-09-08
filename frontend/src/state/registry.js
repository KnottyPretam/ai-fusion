// FROZEN (W8). Slice registry: each feature registers its slice from its own index.jsx at module
// scope. Every slice receives every action (combineReducers semantics), so cross-feature events
// (e.g. the meter reacting to send/analyze/fusion streams) need no coupling between features.
const slices = new Map() // key -> { reducer, initial }
const listeners = new Set()

function initialOf(entry) {
  return typeof entry.initial === 'function' ? entry.initial() : entry.initial
}

export function registerSlice(key, reducer, initial) {
  if (typeof key !== 'string' || !key) throw new Error('registerSlice: key must be a non-empty string')
  if (typeof reducer !== 'function') throw new Error(`registerSlice(${key}): reducer must be a function`)
  slices.set(key, { reducer, initial })
  for (const l of listeners) l(key)
}

export function hasSlice(key) {
  return slices.has(key)
}

export function sliceKeys() {
  return [...slices.keys()]
}

export function onRegister(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function initialState(preloaded) {
  const s = {}
  for (const [k, entry] of slices) s[k] = initialOf(entry)
  return preloaded ? { ...s, ...preloaded } : s
}

// Root reducer: untouched slices keep their identity, so a delta for one column never re-creates
// another slice's object (feature tests assert this).
export function rootReducer(state, action) {
  let next = state
  let changed = false
  for (const [k, entry] of slices) {
    const prev = state[k] === undefined ? initialOf(entry) : state[k]
    const out = entry.reducer(prev, action)
    if (out !== prev || state[k] === undefined) {
      if (!changed) {
        next = { ...state }
        changed = true
      }
      next[k] = out
    }
  }
  return next
}

// Tests only.
export function _resetRegistryForTests() {
  slices.clear()
  listeners.clear()
}
