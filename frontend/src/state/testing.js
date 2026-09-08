// FROZEN (W8). Test helpers for feature agents (vitest + @testing-library/react).
import { render } from '@testing-library/react'
import { StoreProvider } from './store.jsx'
import { initialState, rootReducer } from './registry.js'

// Pure: fold SSE events for `feature` (plus any raw actions) into a state object.
export function applyEvents(feature, events, { state, preloaded } = {}) {
  let s = state || initialState(preloaded)
  for (const ev of events) {
    const action = ev && ev.type && ev.event === undefined && ev.feature === undefined
      ? { type: 'sse', feature, event: ev }
      : ev
    s = rootReducer(s, action)
  }
  return s
}

// Render a component inside the store with optional preloaded slice state.
export function renderWithStore(ui, { preloaded } = {}) {
  return render(<StoreProvider preloaded={preloaded}>{ui}</StoreProvider>)
}

// Minimal SSE fixtures used across feature tests.
export const sample = {
  turnStart: (turn_id = 't1', feature = 'send') => ({ type: 'turn_start', turn_id, feature, slots: ['claude', 'chatgpt', 'grok'] }),
  slotStart: (slot, model = 'm', effort = 'medium') => ({ type: 'slot_start', slot, model, effort, effort_coerced: false }),
  slotDelta: (slot, text) => ({ type: 'slot_delta', slot, text }),
  slotDone: (slot, usage = {}) => ({
    type: 'slot_done',
    slot,
    usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0, cost_usd: 0.001, latency_ms: 500, model: 'm', role: slot, purpose: 'chat', ...usage },
    finish_reason: 'stop',
    truncated: false,
  }),
  slotError: (slot, message = 'boom') => ({ type: 'slot_error', slot, code: 500, error_type: 'server', message, partial: '' }),
  turnDone: (turn_id = 't1') => ({ type: 'turn_done', turn_id, usage: { calls: [], totals: { prompt_tokens: 30, completion_tokens: 60, reasoning_tokens: 0, cost_usd: 0.003, latency_ms: 800, calls: 3 } } }),
}
