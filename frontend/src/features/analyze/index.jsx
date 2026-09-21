// Analyze feature entry (W10). App.jsx imports the pane from here by convention; the slice is
// registered at module scope so it exists before the first render.
import { registerSlice } from '../../state/registry.js'
import { initial as refactorInitial, reducer as refactorReducer } from './refactorSlice.js'
import { initial, reducer } from './slice.js'

registerSlice('analyze', reducer, initial)
// Refactor is an option on Analyze (its button is in the Analyze toolbar), so its slice is registered
// here: one entry point, and no feature importing across to another.
registerSlice('refactor', refactorReducer, refactorInitial)

export { default } from './AnalyzePane.jsx'
