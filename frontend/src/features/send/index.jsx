// W9 (send-ui). Exports the Send pane, which App.jsx imports by convention from
// features/send/index.jsx. The `slots` slice is registered by ./register.js (Stage 2: shared with
// useSendTurn.js, so importing either entry point registers it exactly once).
// Council (2026-09-27): `SlotColumn` is exported by name too — the desktop feature is the
// composition layer (its Drawer already imports four features' entry points) and draws a
// token/local council member as a renderer column with it (PaneDeck's ColumnPane).
import './register.js'
import SendPane from './SendPane.jsx'
import SlotColumn from './SlotColumn.jsx'

export { SlotColumn }
export default SendPane
