// W9 (send-ui). Registers the `slots` slice at module scope and exports the Send pane, which
// App.jsx imports by convention from features/send/index.jsx.
import { registerSlice } from '../../state/registry.js'
import { initialSlots, slotsReducer } from './slice.js'
import SendPane from './SendPane.jsx'

registerSlice('slots', slotsReducer, initialSlots)

export default SendPane
