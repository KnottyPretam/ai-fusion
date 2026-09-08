import { afterEach, describe, expect, test, vi } from 'vitest'
import { abortStream, runStream } from './runStream.js'

function sseResponse(text, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder()
  const chunks = [enc.encode(text)]
  let i = 0
  return {
    ok,
    status,
    json: async () => JSON.parse(text),
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }), releaseLock() {} }) },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('runStream', () => {
  test('dispatches start, every event verbatim, then end ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('data: {"type":"a","x":1}\n\ndata: {"type":"b"}\n\ndata: [DONE]\n\n')))
    const actions = []
    const events = await runStream((a) => actions.push(a), 'send', '/api/x', { prompt: 'p' })
    expect(events.map((e) => e.type)).toEqual(['a', 'b'])
    expect(actions[0]).toEqual({ type: 'sse/start', feature: 'send' })
    expect(actions[1]).toEqual({ type: 'sse', feature: 'send', event: { type: 'a', x: 1 } })
    expect(actions.at(-1)).toMatchObject({ type: 'sse/end', feature: 'send', ok: true })
    const [, init] = fetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ prompt: 'p' })
  })

  test('non-ok response: surfaces the JSON error body and throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('{"detail":{"error":"nothing_to_fuse"}}', { ok: false, status: 409 })))
    const actions = []
    await expect(runStream((a) => actions.push(a), 'fusion', '/api/x', {})).rejects.toMatchObject({ status: 409, code: 'nothing_to_fuse' })
    expect(actions.at(-1)).toMatchObject({ type: 'sse/end', feature: 'fusion', ok: false, status: 409, error: 'nothing_to_fuse' })
  })

  test('terminal error event marks the stream failed under HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('data: {"type":"turn_start"}\n\ndata: {"type":"error","message":"analyze_degraded"}\n\n')))
    const actions = []
    await runStream((a) => actions.push(a), 'fusion', '/api/x', {})
    expect(actions.at(-1)).toMatchObject({ type: 'sse/end', ok: false, error: 'analyze_degraded' })
  })

  test('abort dispatches sse/abort and resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))),
    )
    const actions = []
    const p = runStream((a) => actions.push(a), 'send', '/api/x', {})
    abortStream('send')
    await p
    expect(actions.at(-1)).toEqual({ type: 'sse/abort', feature: 'send' })
  })
})

describe('runStream supersede', () => {
  test('a replaced stream never reports sse/abort after the new stream started', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        call += 1
        if (call === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
        return Promise.resolve(sseResponse('data: {"type":"a"}\n\n'))
      }),
    )
    const actions = []
    const a = runStream((x) => actions.push(x), 'send', '/api/x', {})
    const b = runStream((x) => actions.push(x), 'send', '/api/x', {})
    await Promise.all([a, b])
    const startIdx = actions.findIndex((x, i) => i > 0 && x.type === 'sse/start')
    expect(actions.slice(startIdx).some((x) => x.type === 'sse/abort')).toBe(false)
    expect(actions.at(-1)).toMatchObject({ type: 'sse/end', ok: true })
  })

  test('FastAPI validation errors become readable messages with code validation_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('{"detail":[{"loc":["body","max_iterations"],"msg":"Input should be less than or equal to 5","type":"less_than_equal"}]}', { ok: false, status: 422 })))
    await expect(runStream(() => {}, 'fusion', '/api/x', {})).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
      message: 'max_iterations: Input should be less than or equal to 5',
    })
  })
})
