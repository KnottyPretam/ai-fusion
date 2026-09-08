// FROZEN (W8). Buffered SSE reader over fetch (POST bodies need fetch, not EventSource).
// Fixes the concrete bug in llm-council's api.js: frames split across network reads were dropped
// and multi-byte UTF-8 straddling a chunk boundary was corrupted.

// Parse one SSE frame (the text between two blank lines). Returns undefined when the frame
// carries no data (comments / keep-alives such as ": OPENROUTER PROCESSING").
export function parseFrame(frame) {
  const dataLines = []
  for (const raw of frame.split(/\r?\n/)) {
    if (!raw || raw.startsWith(':')) continue
    if (raw.startsWith('data:')) dataLines.push(raw.slice(5).replace(/^ /, ''))
    // event:/id:/retry: fields are ignored — the kind rides inside the JSON as `type`.
  }
  if (!dataLines.length) return undefined
  const data = dataLines.join('\n')
  if (data === '[DONE]') return { type: '[DONE]' }
  try {
    return JSON.parse(data)
  } catch (e) {
    return { type: 'error', message: `unparseable SSE frame: ${e.message}`, raw: data }
  }
}

// Async generator of parsed events from a fetch Response body.
export async function* readSSE(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseFrame(frame)
        if (ev !== undefined) yield ev
      }
    }
    buf += decoder.decode()
    if (buf.trim()) {
      const ev = parseFrame(buf)
      if (ev !== undefined) yield ev
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

// Sync helper for tests/tools: all events in a complete text/event-stream body.
export function eventsFromText(text) {
  const out = []
  for (const frame of text.split('\n\n')) {
    const ev = parseFrame(frame)
    if (ev !== undefined) out.push(ev)
  }
  return out
}
