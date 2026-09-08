// FROZEN (W8). Plain JSON HTTP primitive + loaders that dispatch the frozen action names.
// Same-origin by default (the Vite dev server proxies /api to the backend).
export const BASE = (import.meta.env && import.meta.env.VITE_API_BASE) || ''

export class ApiError extends Error {
  constructor(status, body) {
    const detail = body && (body.detail ?? body.error)
    let msg
    if (Array.isArray(detail)) {
      // FastAPI request-validation errors: {detail: [{loc, msg, type}, ...]}
      msg = detail.map((d) => (d && d.msg ? `${(d.loc || []).slice(1).join('.') || 'body'}: ${d.msg}` : String(d))).join('; ')
    } else if (detail && typeof detail === 'object') msg = detail.error || detail.message
    else if (typeof detail === 'string') msg = detail
    super(msg || `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.code = Array.isArray(detail) ? 'validation_error' : detail && typeof detail === 'object' ? detail.error : undefined
  }
}

export async function safeJson(r) {
  try {
    return await r.json()
  } catch {
    return null
  }
}

export async function request(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new ApiError(r.status, await safeJson(r))
  if (r.status === 204) return null
  return safeJson(r)
}

export const api = {
  listConversations: () => request('GET', '/api/conversations'),
  createConversation: (body = {}) => request('POST', '/api/conversations', body),
  getConversation: (id) => request('GET', `/api/conversations/${id}`),
  deleteConversation: (id) => request('DELETE', `/api/conversations/${id}`),
  renameConversation: (id, title) => request('PATCH', `/api/conversations/${id}/title`, { title }),
  getSlotConfig: (id) => request('GET', `/api/conversations/${id}/slot_config`),
  putSlotConfig: (id, slotConfig) => request('PUT', `/api/conversations/${id}/slot_config`, slotConfig),
  listModels: () => request('GET', '/api/models'),
}

// Loaders: fetch + dispatch. Features call these instead of duplicating fetch logic.
export async function loadConversations(dispatch) {
  const items = await api.listConversations()
  dispatch({ type: 'conversations/list', items })
  return items
}

// `isCurrent(conversation)` (optional) lets a caller drop a response that arrived after the user
// moved on (two quick selects, a stream that ended after a conversation switch).
export async function loadConversation(dispatch, id, { isCurrent } = {}) {
  const conversation = await api.getConversation(id)
  if (isCurrent && !isCurrent(conversation)) return conversation
  dispatch({ type: 'conversation/loaded', conversation })
  return conversation
}

export async function createConversation(dispatch, body = {}) {
  const conversation = await api.createConversation(body)
  dispatch({
    type: 'conversation/created',
    summary: { id: conversation.id, title: conversation.title, created_at: conversation.created_at, updated_at: conversation.updated_at, turn_count: 0 },
  })
  dispatch({ type: 'conversation/loaded', conversation })
  return conversation
}

// Pass `{ selected }` (the currently selected id) so deleting the open conversation also clears
// the per-conversation slices (slotConfig, live buffers) via the frozen `conversation/cleared`.
export async function deleteConversation(dispatch, id, { selected } = {}) {
  await api.deleteConversation(id)
  dispatch({ type: 'conversation/deleted', id })
  if (selected === id) dispatch({ type: 'conversation/cleared' })
}

export async function renameConversation(dispatch, id, title) {
  const conversation = await api.renameConversation(id, title)
  dispatch({ type: 'conversation/renamed', id, title: conversation ? conversation.title : title })
  return conversation
}

// Concurrent catalog loads (several panes mount at once; StrictMode double-fires effects) share
// one in-flight request.
let modelsInFlight = null
export function loadModels(dispatch) {
  if (modelsInFlight) return modelsInFlight
  modelsInFlight = (async () => {
    try {
      const items = await api.listModels()
      dispatch({ type: 'models/loaded', items })
      return items
    } catch (e) {
      dispatch({ type: 'models/error', error: e.message })
      throw e
    } finally {
      modelsInFlight = null
    }
  })()
  return modelsInFlight
}

// Optimistic local update, then PUT; on failure reload the server copy.
// `isCurrent()` (optional) drops the server copy when the user switched conversations meanwhile.
export async function saveSlotConfig(dispatch, conversationId, patch, current, { isCurrent } = {}) {
  dispatch({ type: 'slotConfig/update', patch })
  const merged = mergeSlotConfig(current, patch)
  const still = () => !isCurrent || isCurrent(conversationId)
  try {
    const slotConfig = await api.putSlotConfig(conversationId, merged)
    if (still()) dispatch({ type: 'slotConfig/loaded', conversationId, slotConfig })
    return slotConfig
  } catch (e) {
    const slotConfig = await api.getSlotConfig(conversationId)
    if (still()) dispatch({ type: 'slotConfig/loaded', conversationId, slotConfig })
    throw e
  }
}

export function mergeSlotConfig(current, patch) {
  const out = { ...(current || {}), ...(patch || {}) }
  if (patch && patch.slots) {
    out.slots = { ...((current && current.slots) || {}) }
    for (const [slot, spec] of Object.entries(patch.slots)) out.slots[slot] = { ...(out.slots[slot] || {}), ...spec }
  }
  return out
}
