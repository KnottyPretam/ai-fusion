import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import RefactorPane from './index.jsx'
import { FALLBACK_NOTE } from './RefactorPane.jsx'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import { conversation, degradedTurn, events, refactorTurn, sendTurn } from './fixtures.js'

const SLOT_NAMES = /claude|chatgpt|grok|anthropic|openai|x-ai/i

function stateWith(evs = [], { conv = conversation([sendTurn()]) } = {}) {
  return applyEvents('refactor', [events.loaded(conv), ...evs])
}

const renderPane = (preloaded) => renderWithStore(<RefactorPane />, { preloaded })

afterEach(() => vi.unstubAllGlobals())

describe('RefactorPane: the refactored view', () => {
  test('renders the restated question, both halves of the graph, and all three reduced responses', () => {
    renderPane(stateWith([events.start(), events.notice('mapping the question'), events.done(refactorTurn())]))
    expect(screen.getByTestId('refactor')).toHaveAttribute('data-status', 'done')
    expect(screen.queryByTestId('refactor-notice')).toBeNull()

    expect(screen.getByTestId('refactor-question')).toHaveTextContent('What is the selectable gyroscope full-scale range?')

    const nodes = screen.getByTestId('refactor-graph-nodes')
    expect(within(nodes).getByText('inertial sensor')).toBeInTheDocument()
    expect(within(nodes).getByText('quantity')).toBeInTheDocument()
    // the edge table resolves ids to labels
    const edges = screen.getByTestId('refactor-graph-edges')
    expect(screen.getByTestId('refactor-edge-1')).toHaveTextContent('inertial sensor')
    expect(edges).toHaveTextContent('has property')
    expect(edges).toHaveTextContent('gyroscope range')

    for (const label of ['R1', 'R2', 'R3']) {
      expect(screen.getByTestId(`refactor-reply-${label}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('refactor-summary-R1')).toHaveTextContent('Reads the range from the range table.')
    expect(screen.getByTestId('refactor-claim-R1-2')).toHaveTextContent('Cites table 3')
    expect(screen.getByTestId('refactor-claim-R3-1')).toHaveTextContent('125 dps to 2000 dps')
  })

  test('labels only: the report never names a slot or a vendor', () => {
    renderPane(stateWith([events.done(refactorTurn())]))
    expect(screen.getByTestId('refactor-report').textContent).not.toMatch(SLOT_NAMES)
  })

  test('an empty graph says so instead of rendering two empty tables', () => {
    const turn = refactorTurn({ refactoring: { graph: { nodes: [], edges: [] }, question: 'q', replies: [] } })
    renderPane(stateWith([events.done(turn)]))
    expect(screen.queryByTestId('refactor-graph-nodes')).toBeNull()
    expect(screen.queryByTestId('refactor-graph-edges')).toBeNull()
    expect(screen.getByTestId('refactor-report')).toHaveTextContent('no graph for this question')
  })
})

describe('RefactorPane: progress, failure and the cache', () => {
  test('a narration is shown as progress, not as a failure', () => {
    renderPane(stateWith([events.start(), events.notice("refactoring R2's reply (3,000 characters)")]))
    expect(screen.getByTestId('refactor')).toHaveAttribute('data-status', 'working')
    expect(screen.getByTestId('refactor-notice')).toHaveTextContent("refactoring R2's reply")
    expect(screen.queryByTestId('refactor-error')).toBeNull()
  })

  test('a degraded turn says what happened, that Analyze falls back, and shows the attempts', () => {
    renderPane(stateWith([events.start(), events.degraded(degradedTurn())]))
    const box = screen.getByTestId('refactor-degraded')
    expect(box).toHaveTextContent('parse_error')
    expect(screen.getByTestId('refactor-fallback')).toHaveTextContent(FALLBACK_NOTE)
    const raw = screen.getByTestId('refactor-raw-attempts')
    expect(within(raw).getByTestId('refactor-raw-attempt-1')).toHaveTextContent('Sure! Here you go:')
    expect(within(raw).getByTestId('refactor-raw-attempt-2')).toHaveTextContent('(no output)')
    expect(screen.queryByTestId('refactor-report')).toBeNull()
  })

  test('a terminal error is its own box', () => {
    renderPane(stateWith([events.start(), events.error('bridge_disconnected')]))
    expect(screen.getByTestId('refactor-error')).toHaveTextContent('bridge_disconnected')
  })

  test('the cached chip shows only when the run was served from an existing turn', () => {
    renderPane(stateWith([events.done(refactorTurn(), true)]))
    expect(screen.getByTestId('refactor-cached')).toBeInTheDocument()
  })
})

describe('RefactorPane: running it', () => {
  test('Refactor posts {} to /api/conversations/<id>/refactor, renders the stream, then refetches', async () => {
    const conv = conversation([sendTurn()])
    const convAfter = conversation([sendTurn(), refactorTurn()])
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return sseResponse([events.start(), events.done(refactorTurn(), false)])
      return jsonResponse(convAfter)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPane(stateWith([], { conv }))

    fireEvent.click(screen.getByTestId('refactor-run'))
    await waitFor(() => expect(screen.getByTestId('refactor-report')).toBeInTheDocument())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/conversations/c1/refactor')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})
    expect(fetchMock.mock.calls[1][0]).toBe('/api/conversations/c1')
  })

  test('Re-run posts {force:true}', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return sseResponse([events.start(), events.done(refactorTurn(), false)])
      return jsonResponse(conversation([sendTurn(), refactorTurn()]))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPane(stateWith([events.done(refactorTurn())]))
    fireEvent.click(screen.getByTestId('refactor-rerun'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ force: true })
  })

  test('with no turn yet there is no Re-run button', () => {
    renderPane(stateWith())
    expect(screen.getByTestId('refactor-run')).toBeEnabled()
    expect(screen.queryByTestId('refactor-rerun')).toBeNull()
  })

  test('an incomplete send turn disables the run and names the slot and the cause', () => {
    const conv = conversation([sendTurn({ responses: { claude: 'a', chatgpt: null, grok: 'c' }, errors: { chatgpt: 'timeout: no reply within 300s' } })])
    renderPane(stateWith([], { conv }))
    expect(screen.getByTestId('refactor-run')).toBeDisabled()
    const hint = screen.getByTestId('refactor-hint')
    expect(hint).toHaveTextContent('timeout: no reply within 300s')
    expect(hint).toHaveTextContent('Send again')
  })

  test('without a conversation the pane renders nothing at all', () => {
    const { container } = renderWithStore(<RefactorPane />, { preloaded: {} })
    expect(container.querySelector('[data-testid="refactor"]')).toBeNull()
  })
})

// --- streaming through a stubbed fetch -------------------------------------------------------
function sseResponse(evs) {
  const enc = new TextEncoder()
  const chunks = [enc.encode(evs.map((e) => `data: ${JSON.stringify(e.event || e)}\n\n`).join(''))]
  let i = 0
  return {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
        cancel: async () => {},
        releaseLock() {},
      }),
    },
  }
}

function jsonResponse(obj, status = 200) {
  return { ok: status < 400, status, json: async () => obj }
}
