// W11 (fusion-ui). Registers the `fusion` slice at module scope and exports the pane that App.jsx
// imports by convention.
import { registerSlice } from '../../state/registry.js'
import { fusionReducer, initialFusion } from './slice.js'
import FusionPane from './FusionPane.jsx'

registerSlice('fusion', fusionReducer, initialFusion)

export default FusionPane
