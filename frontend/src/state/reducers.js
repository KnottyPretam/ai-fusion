// FROZEN (W8). Core slices shared by every feature. Feature-owned slices (slots, analyze, fusion,
// meter) live in features/<x>/slice.js and are registered from features/<x>/index.jsx.
//
// Frozen action names (docs/api-contract.md, "Frontend contract"):
//   sse/start {feature}   sse {feature, event}   sse/end {feature, ok, error?, status?, body?}
//   sse/abort {feature}
//   conversation/loaded {conversation}   conversation/cleared   conversation/created {summary}
//   conversation/deleted {id}   conversation/renamed {id, title}
//   conversations/list {items}
//   slotConfig/loaded {conversationId, slotConfig}   slotConfig/update {patch}
//   models/loaded {items}   models/error {error}
import { registerSlice } from './registry.js'

export const FEATURES = ['send', 'analyze', 'fusion']

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base ? base[k] : undefined, v) : v
  }
  return out
}

registerSlice(
  'conversation',
  (s = null, a) => {
    switch (a.type) {
      case 'conversation/loaded':
        return a.conversation
      case 'conversation/cleared':
        return null
      case 'conversation/deleted':
        return s && s.id === a.id ? null : s
      case 'conversation/renamed':
        return s && s.id === a.id ? { ...s, title: a.title } : s
      case 'slotConfig/loaded':
        return s && (!a.conversationId || a.conversationId === s.id) ? { ...s, slot_config: a.slotConfig } : s
      default:
        return s
    }
  },
  null,
)

registerSlice(
  'conversations',
  (s = [], a) => {
    switch (a.type) {
      case 'conversations/list':
        return a.items
      case 'conversation/created':
        return [a.summary, ...s.filter((c) => c.id !== a.summary.id)]
      case 'conversation/deleted':
        return s.filter((c) => c.id !== a.id)
      case 'conversation/renamed':
        return s.map((c) => (c.id === a.id ? { ...c, title: a.title } : c))
      default:
        return s
    }
  },
  [],
)

registerSlice(
  'slotConfig',
  (s = null, a) => {
    switch (a.type) {
      case 'conversation/loaded':
        return a.conversation ? a.conversation.slot_config : null
      case 'conversation/cleared':
        return null
      case 'slotConfig/loaded':
        return a.slotConfig
      case 'slotConfig/update':
        return s ? deepMerge(s, a.patch) : s
      default:
        return s
    }
  },
  null,
)

registerSlice(
  'models',
  (s = { items: [], byId: {}, loaded: false, error: null }, a) => {
    switch (a.type) {
      case 'models/loaded': {
        const byId = {}
        for (const m of a.items) byId[m.id] = m
        return { items: a.items, byId, loaded: true, error: null }
      }
      case 'models/error':
        return { ...s, error: a.error }
      default:
        return s
    }
  },
  { items: [], byId: {}, loaded: false, error: null },
)

function streamsInitial() {
  const s = {}
  for (const f of FEATURES) s[f] = { status: 'idle', error: null, httpStatus: null }
  return s
}

registerSlice(
  'streams',
  (s = streamsInitial(), a) => {
    switch (a.type) {
      case 'sse/start':
        return { ...s, [a.feature]: { status: 'streaming', error: null, httpStatus: null } }
      case 'sse/end':
        return {
          ...s,
          [a.feature]: { status: a.ok ? 'done' : 'error', error: a.ok ? null : a.error || 'stream failed', httpStatus: a.status ?? null },
        }
      case 'sse/abort':
        return { ...s, [a.feature]: { status: 'aborted', error: null, httpStatus: null } }
      case 'sse': {
        // A terminal `error` event marks the stream as failed even though the HTTP status was 200.
        if (a.event && a.event.type === 'error') {
          return { ...s, [a.feature]: { ...s[a.feature], status: 'error', error: a.event.message || 'error' } }
        }
        return s
      }
      default:
        return s
    }
  },
  streamsInitial,
)
