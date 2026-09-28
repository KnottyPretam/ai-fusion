// W11 (fusion-ui). Registers the `fusion` slice at module scope and exports the pane that App.jsx
// imports by convention. Plan (2026-09-27): the `plan` slice — one agent's executable procedure made
// from the Fusion report, rendered inside this pane under the final report — is registered here too.
import { registerSlice } from '../../state/registry.js'
import { fusionReducer, initialFusion } from './slice.js'
import { initial as initialPlan, reducer as planReducer } from './planSlice.js'
import FusionPane from './FusionPane.jsx'

registerSlice('fusion', fusionReducer, initialFusion)
registerSlice('plan', planReducer, initialPlan)

export default FusionPane
