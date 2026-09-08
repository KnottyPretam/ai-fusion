// FROZEN (W8). Open a feature SSE stream and dispatch every event verbatim as
// { type: 'sse', feature, event }, bracketed by sse/start and sse/end | sse/abort.
import { useCallback } from 'react'
import { ApiError, BASE, safeJson } from './http.js'
import { readSSE } from './sse.js'
import { useDispatch } from '../state/store.jsx'

const controllers = new Map()

export function abortStream(feature) {
  const c = controllers.get(feature)
  if (c) {
    c.abort()
    controllers.delete(feature)
  }
}

export async function runStream(dispatch, feature, url, body, { onEvent } = {}) {
  const prev = controllers.get(feature)
  if (prev) prev.superseded = true // a replaced stream must not report sse/abort over the new one
  abortStream(feature)
  const controller = new AbortController()
  controllers.set(feature, controller)
  dispatch({ type: 'sse/start', feature })
  const events = []
  try {
    const r = await fetch(BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    })
    if (!r.ok) {
      const b = await safeJson(r)
      const err = new ApiError(r.status, b)
      dispatch({ type: 'sse/end', feature, ok: false, error: err.message, status: r.status, body: b })
      throw err
    }
    for await (const event of readSSE(r)) {
      if (event.type === '[DONE]') continue
      events.push(event)
      dispatch({ type: 'sse', feature, event })
      if (onEvent) onEvent(event)
    }
    const failed = events.length && events[events.length - 1].type === 'error'
    dispatch({ type: 'sse/end', feature, ok: !failed, error: failed ? events[events.length - 1].message : undefined })
    return events
  } catch (e) {
    if (e && e.name === 'AbortError') {
      if (!controller.superseded) dispatch({ type: 'sse/abort', feature })
      return events
    }
    if (!(e instanceof ApiError)) dispatch({ type: 'sse/end', feature, ok: false, error: e.message })
    throw e
  } finally {
    if (controllers.get(feature) === controller) controllers.delete(feature)
  }
}

export function useRunStream() {
  const dispatch = useDispatch()
  return useCallback((feature, url, body, opts) => runStream(dispatch, feature, url, body, opts), [dispatch])
}
