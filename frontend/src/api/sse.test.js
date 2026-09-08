import { describe, expect, test } from 'vitest'
import { eventsFromText, parseFrame, readSSE } from './sse.js'

function streamOf(chunks) {
  const enc = new TextEncoder()
  const parts = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c))
  let i = 0
  return {
    body: {
      getReader() {
        return {
          read: async () => (i < parts.length ? { value: parts[i++], done: false } : { value: undefined, done: true }),
          releaseLock() {},
        }
      },
    },
  }
}

async function collect(chunks) {
  const out = []
  for await (const ev of readSSE(streamOf(chunks))) out.push(ev)
  return out
}

describe('parseFrame', () => {
  test('skips comment keep-alives', () => {
    expect(parseFrame(': OPENROUTER PROCESSING')).toBeUndefined()
    expect(parseFrame('')).toBeUndefined()
  })
  test('parses data and [DONE]', () => {
    expect(parseFrame('data: {"type":"x","n":1}')).toEqual({ type: 'x', n: 1 })
    expect(parseFrame('data: [DONE]')).toEqual({ type: '[DONE]' })
  })
  test('joins multi-line data and tolerates CRLF', () => {
    expect(parseFrame('data: {"a":\r\ndata: 1}')).toEqual({ a: 1 })
  })
  test('bad JSON becomes an error event, not a crash', () => {
    const ev = parseFrame('data: {oops')
    expect(ev.type).toBe('error')
    expect(ev.raw).toBe('{oops')
  })
})

describe('readSSE', () => {
  test('reassembles a frame split across two reads', async () => {
    const evs = await collect(['data: {"type":"slot_del', 'ta","slot":"claude","text":"hi"}\n\n'])
    expect(evs).toEqual([{ type: 'slot_delta', slot: 'claude', text: 'hi' }])
  })
  test('handles many frames in one read and a trailing partial frame', async () => {
    const evs = await collect(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"ty', 'pe":"c"}\n\n'])
    expect(evs.map((e) => e.type)).toEqual(['a', 'b', 'c'])
  })
  test('does not corrupt multi-byte UTF-8 straddling a chunk boundary', async () => {
    const bytes = new TextEncoder().encode('data: {"type":"t","text":"héllo → ünïcode ✓"}\n\n')
    const cut = 22 // inside the "é" sequence
    const evs = await collect([bytes.slice(0, cut), bytes.slice(cut)])
    expect(evs[0].text).toBe('héllo → ünïcode ✓')
  })
  test('skips comments between frames and yields [DONE]', async () => {
    const evs = await collect([': OPENROUTER PROCESSING\n\ndata: {"type":"a"}\n\n: ping\n\ndata: [DONE]\n\n'])
    expect(evs.map((e) => e.type)).toEqual(['a', '[DONE]'])
  })
  test('flushes a final frame with no trailing blank line', async () => {
    const evs = await collect(['data: {"type":"last"}'])
    expect(evs).toEqual([{ type: 'last' }])
  })
})

test('eventsFromText', () => {
  expect(eventsFromText('data: {"type":"a"}\n\n: c\n\ndata: {"type":"b"}\n\n').map((e) => e.type)).toEqual(['a', 'b'])
})
