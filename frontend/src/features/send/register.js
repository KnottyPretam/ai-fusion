// Stage 2 (integrator pre-work). The ONE `registerSlice('slots', …)` call, at module scope.
// Both entry points into this feature import it — features/send/index.jsx (the web SendPane,
// mounted by App.jsx) and features/send/useSendTurn.js (the hook the desktop PromptBar uses) —
// so the slice is registered exactly once whatever the import order: an ES module evaluates once
// per graph, and neither entry point calls registerSlice itself.
import { registerSlice } from '../../state/registry.js'
import { initialSlots, slotsReducer } from './slice.js'

registerSlice('slots', slotsReducer, initialSlots)
