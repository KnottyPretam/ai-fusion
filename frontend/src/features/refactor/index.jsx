// Refactor feature entry (S11). The slice is registered at module scope so it exists before the
// first render, exactly as the analyze and fusion features do.
import { registerSlice } from '../../state/registry.js'
import { initial, reducer } from './slice.js'

registerSlice('refactor', reducer, initial)

export { default } from './RefactorPane.jsx'
