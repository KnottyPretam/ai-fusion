// FROZEN (W8). Slot-keyed store: useReducer + context over the slice registry.
import { createContext, useContext, useEffect, useMemo, useReducer } from 'react'
import { initialState, onRegister, rootReducer } from './registry.js'
import './reducers.js'

const StoreCtx = createContext(null)

export function StoreProvider({ children, preloaded }) {
  const [state, dispatch] = useReducer(rootReducer, preloaded, (p) => initialState(p))
  // A feature module that registers its slice after the provider mounted gets initialised here.
  useEffect(() => onRegister(() => dispatch({ type: '@@slice/registered' })), [])
  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore() {
  const ctx = useContext(StoreCtx)
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>')
  return ctx
}

export function useSlice(key) {
  return useStore().state[key]
}

export function useDispatch() {
  return useStore().dispatch
}
