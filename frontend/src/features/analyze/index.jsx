// Analyze feature entry (W10). App.jsx imports the pane from here by convention; the slice is
// registered at module scope so it exists before the first render.
import { registerSlice } from '../../state/registry.js'
import { initial, reducer } from './slice.js'

registerSlice('analyze', reducer, initial)

export { default } from './AnalyzePane.jsx'
