// useAutoReread (2026-10-18): the automatic Read again, mounted the way DesktopShell mounts it.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import './index.jsx' // registers the `panes` slice
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch, useSlice } from '../../state/store.jsx'
import { AUTO_REREAD_SETTLE_MS } from './autoReread.js'
import { jsonResponse, sseResponse } from './fakes.js'
import { formatResult } from './PromptBar.jsx'
import { initialPanes } from './slice.js'
import { useAutoReread } from './useAutoReread.js'

const STILL = 'the reply was still in progress after 525880 ms [containers=0 anchor=0 stopNow=true stopSeen=true reply=0]'
const WEB = { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' }, grok: { model: 'web:grok', effort: 'off' } }
const send = (over = {}) => ({ type: 'send', id: 's1', prompt: 'Explain it', slot_config: { slots: WEB }, responses: { claude: 'a', chatgpt: null, grok: 'c' }, errors: { chatgpt: STILL }, ...over })
const conversation = (turns) => ({ id: 'c1', title: 't', turns, threads: {} })
const STUCK = conversation([send()])
const FILLED = conversation([send({ responses: { claude: 'a', chatgpt: 'the finished answer', grok: 'c' }, errors: {} })])
const health = (over = {}) => ({ composer: true, send: true, reply: null, stop: false, session: 'ok', chatOf: ['c1'], url: 'https://chatgpt.com/c/x', host: 'chatgpt.com', ts: 1, ...over })
const STILL_LINE = { ok: false, code: 'timeout', message: STILL }

let dispatchRef = null
function Probe() {
  useAutoReread()
  dispatchRef = useDispatch()
  const panes = useSlice('panes')
  const conv = useSlice('conversation')
  const turn = conv && conv.turns && conv.turns[0]
  return (
    <div>
      <span data-testid="line">{formatResult(panes.lastSend.chatgpt)}</span>
      <span data-testid="filled">{String(turn ? turn.responses.chatgpt : '')}</span>
    </div>
  )
}

function mount({ conv = STUCK, stop = false, lastSend = { chatgpt: STILL_LINE }, capture = true, chatOf = ['c1'], connected = true } = {}) {
  const panes = { ...initialPanes(), health: { claude: health(), chatgpt: health({ stop, chatOf }), grok: health() }, capture: { claude: true, chatgpt: capture, grok: true }, lastSend, bridge: { connected } }
  return renderWithStore(<Probe />, { preloaded: { conversation: conv, panes } })
}

function stubServer({ post = () => sseResponse([{ type: 'reread_start', turn_id: 's1', slot: 'chatgpt' }, { type: 'reread_done', turn_id: 's1', slot: 'chatgpt', chars: 19, done_by: 'done_selector' }]), after = FILLED } = {}) {
  const fetchMock = vi.fn(async (url, init) => (init && init.method === 'POST' ? post(url) : jsonResponse(after)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const posts = (fetchMock) => fetchMock.mock.calls.filter(([, init]) => init && init.method === 'POST')
const advance = (ms) => act(() => vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  dispatchRef = null
})

describe('useAutoReread', () => {
  test('once the pane has held its stop control gone for the settle window, the slot is read again, the line follows and the conversation is refetched', async () => {
    const fetchMock = stubServer()
    mount()
    expect(screen.getByTestId('line')).toHaveTextContent('… still answering — read when it finishes')
    await advance(AUTO_REREAD_SETTLE_MS - 500)
    expect(posts(fetchMock)).toHaveLength(0)
    await advance(600)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    expect(posts(fetchMock)[0][0]).toBe('/api/conversations/c1/turns/s1/slots/chatgpt/reread')
    await waitFor(() => expect(screen.getByTestId('line').textContent).toMatch(/^read again ✓ captured/))
    await waitFor(() => expect(screen.getByTestId('filled')).toHaveTextContent('the finished answer'))
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/conversations/c1' && !(init && init.method === 'POST'))).toBe(true)
  })

  test('a stop control that comes back inside the settle window cancels the pending read; it starts again once it is gone for good', async () => {
    const fetchMock = stubServer()
    mount()
    await advance(AUTO_REREAD_SETTLE_MS - 1000)
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ stop: true }) }))
    await advance(AUTO_REREAD_SETTLE_MS + 1000)
    expect(posts(fetchMock)).toHaveLength(0)
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ stop: false }) }))
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
  })

  test('nothing while the site is still answering, or with capture off', async () => {
    const fetchMock = stubServer()
    mount({ stop: true })
    await advance(AUTO_REREAD_SETTLE_MS * 3)
    expect(posts(fetchMock)).toHaveLength(0)
    act(() => dispatchRef({ type: 'panes/capture', slot: 'chatgpt', on: false }))
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ stop: false }) }))
    await advance(AUTO_REREAD_SETTLE_MS * 3)
    expect(posts(fetchMock)).toHaveLength(0)
  })

  test('a failed read shows its code on the line and is never retried by itself (the Analyze tab\'s button is the manual path)', async () => {
    const fetchMock = stubServer({
      post: () =>
        sseResponse([
          { type: 'reread_start', turn_id: 's1', slot: 'chatgpt' },
          { type: 'reread_error', turn_id: 's1', slot: 'chatgpt', code: 'reply_not_found', message: 'no assistant container [containers=0 stopNow=false]', error_type: 'site' },
        ]),
      after: STUCK,
    })
    mount()
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(screen.getByTestId('line')).toHaveTextContent('✗ read again: reply_not_found'))
    // the refetched conversation still has the slot stuck and the pane still says finished: no second try
    await advance(AUTO_REREAD_SETTLE_MS * 4)
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ stop: true }) }))
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ stop: false, ts: 2 }) }))
    await advance(AUTO_REREAD_SETTLE_MS * 4)
    expect(posts(fetchMock)).toHaveLength(1)
  })

  test('a refused read (409 reread_stale) shows the code and is final', async () => {
    const fetchMock = stubServer({ post: () => jsonResponse({ detail: { error: 'reread_stale', since: 'send' } }, 409), after: STUCK })
    mount()
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(screen.getByTestId('line')).toHaveTextContent('✗ read again: reread_stale'))
    await advance(AUTO_REREAD_SETTLE_MS * 4)
    expect(posts(fetchMock)).toHaveLength(1)
  })

  test('a TRANSIENT failure (view_busy, a 409 busy, a fetch that threw) gets exactly ONE more try', async () => {
    for (const first of [
      () => sseResponse([{ type: 'reread_start', turn_id: 's1', slot: 'chatgpt' }, { type: 'reread_error', turn_id: 's1', slot: 'chatgpt', code: 'view_busy', message: 'a turn is in flight', error_type: 'triplex' }]),
      () => jsonResponse({ detail: { error: 'busy' } }, 409),
      () => {
        throw new TypeError('Failed to fetch')
      },
    ]) {
      const fetchMock = stubServer({ post: first, after: STUCK })
      const { unmount } = mount()
      await advance(AUTO_REREAD_SETTLE_MS + 100)
      await waitFor(() => expect(screen.getByTestId('line').textContent).toMatch(/^✗ read again: /))
      await advance(AUTO_REREAD_SETTLE_MS + 100)
      await waitFor(() => expect(posts(fetchMock)).toHaveLength(2))
      // the retry may overwrite its own failed line
      await waitFor(() => expect(screen.getByTestId('line').textContent).toMatch(/^✗ read again: /))
      await advance(AUTO_REREAD_SETTLE_MS * 4)
      expect(posts(fetchMock)).toHaveLength(2)
      unmount()
      vi.unstubAllGlobals()
    }
  })

  test('the retry after a transient failure completes the line when it succeeds', async () => {
    let n = 0
    const fetchMock = stubServer({
      post: () =>
        (n += 1) === 1
          ? sseResponse([{ type: 'reread_start', turn_id: 's1', slot: 'chatgpt' }, { type: 'reread_error', turn_id: 's1', slot: 'chatgpt', code: 'bridge_unavailable', message: 'the bridge is down', error_type: 'triplex' }])
          : sseResponse([{ type: 'reread_start', turn_id: 's1', slot: 'chatgpt' }, { type: 'reread_done', turn_id: 's1', slot: 'chatgpt', chars: 19, done_by: 'quiet' }]),
      after: STUCK,
    })
    mount()
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(screen.getByTestId('line')).toHaveTextContent('✗ read again: bridge_unavailable'))
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId('line').textContent).toMatch(/^read again ✓ captured/))
  })

  test('only while the pane shows THIS conversation\'s chat: another page waits (nothing marked), and the read fires once it is back', async () => {
    const fetchMock = stubServer()
    mount({ chatOf: ['c9'] })
    await advance(AUTO_REREAD_SETTLE_MS * 3)
    expect(posts(fetchMock)).toHaveLength(0)
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ chatOf: [] }) }))
    await advance(AUTO_REREAD_SETTLE_MS * 3)
    expect(posts(fetchMock)).toHaveLength(0)
    act(() => dispatchRef({ type: 'panes/health', slot: 'chatgpt', health: health({ chatOf: ['c1'] }) }))
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
  })

  test('nothing while the bridge is disconnected', async () => {
    const fetchMock = stubServer()
    mount({ connected: false })
    await advance(AUTO_REREAD_SETTLE_MS * 3)
    expect(posts(fetchMock)).toHaveLength(0)
    act(() => dispatchRef({ type: 'panes/bridge', connected: true }))
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
  })

  test('line ownership: another conversation\'s read never rewrites this line; this one\'s failure shows ✗, never a ✓', async () => {
    const STILL_A = STILL.replace('525880', '511111')
    const STILL_B = STILL.replace('525880', '522222')
    const A = { ...conversation([send({ errors: { chatgpt: STILL_A } })]), id: 'cA' }
    const B = { ...conversation([send({ id: 'sB', errors: { chatgpt: STILL_B } })]), id: 'cB' }
    const B_FILLED = { ...B, turns: [{ ...B.turns[0], responses: { claude: 'a', chatgpt: 'B answer', grok: 'c' }, errors: {} }] }
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        return url.includes('/cB/')
          ? sseResponse([{ type: 'reread_start', turn_id: 'sB', slot: 'chatgpt' }, { type: 'reread_done', turn_id: 'sB', slot: 'chatgpt', chars: 8, done_by: 'quiet' }])
          : sseResponse([{ type: 'reread_start', turn_id: 's1', slot: 'chatgpt' }, { type: 'reread_error', turn_id: 's1', slot: 'chatgpt', code: 'reply_not_found', message: 'no anchor', error_type: 'site' }])
      }
      return jsonResponse(url.endsWith('/cB') ? B_FILLED : A)
    })
    vi.stubGlobal('fetch', fetchMock)
    // A's still-answering line is on screen; conversation B (a different message) is open and read
    mount({ conv: B, lastSend: { chatgpt: { ok: false, code: 'timeout', message: STILL_A } }, chatOf: ['cA', 'cB'] })
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    expect(posts(fetchMock)[0][0]).toBe('/api/conversations/cB/turns/sB/slots/chatgpt/reread')
    await waitFor(() => expect(screen.getByTestId('filled')).toHaveTextContent('B answer'))
    expect(screen.getByTestId('line')).toHaveTextContent('… still answering — read when it finishes')
    // back in A: its own read fails, and its line says so
    act(() => dispatchRef({ type: 'conversation/loaded', conversation: A }))
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId('line')).toHaveTextContent('✗ read again: reply_not_found'))
    expect(screen.getByTestId('line').textContent).not.toMatch(/✓/)
  })

  test('the prompt-bar line is rewritten only when it was the "still answering" line', async () => {
    const fetchMock = stubServer()
    mount({ lastSend: {} })
    await advance(AUTO_REREAD_SETTLE_MS + 100)
    await waitFor(() => expect(screen.getByTestId('filled')).toHaveTextContent('the finished answer'))
    expect(posts(fetchMock)).toHaveLength(1)
    expect(screen.getByTestId('line')).toHaveTextContent('')
    expect(screen.getByTestId('line').textContent).toBe('')
  })

  test('nothing for a Send whose slots are all filled', async () => {
    const fetchMock = stubServer()
    mount({ conv: FILLED })
    await advance(AUTO_REREAD_SETTLE_MS * 3)
    expect(posts(fetchMock)).toHaveLength(0)
  })
})
