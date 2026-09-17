// W9 (send-ui). Exports the Send pane, which App.jsx imports by convention from
// features/send/index.jsx. The `slots` slice is registered by ./register.js (Stage 2: shared with
// useSendTurn.js, so importing either entry point registers it exactly once).
import './register.js'
import SendPane from './SendPane.jsx'

export default SendPane
