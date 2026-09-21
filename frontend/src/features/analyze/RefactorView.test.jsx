// RefactorView is presentational: it takes the refactor slice state and renders the refactored view.
// Every button, the run wiring and the export control live in AnalyzePane (the toolbar the user asked
// for), so they are tested there.
import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import RefactorView, { FALLBACK_NOTE } from './RefactorView.jsx'
import { degradedTurn, refactorTurn } from './refactorFixtures.js'

const SLOT_NAMES = /claude|chatgpt|grok|anthropic|openai|x-ai/i
const done = (turn = refactorTurn()) => ({ status: 'done', turn, cached: false, notice: null, error: null, ofTurn: 's1' })

describe('RefactorView', () => {
  test('renders the restated question, both halves of the graph, and all three reduced responses', () => {
    render(<RefactorView refactor={done()} />)
    expect(screen.getByTestId('refactor-question')).toHaveTextContent('What is the selectable gyroscope full-scale range?')

    const nodes = screen.getByTestId('refactor-graph-nodes')
    expect(within(nodes).getByText('inertial sensor')).toBeInTheDocument()
    expect(within(nodes).getByText('quantity')).toBeInTheDocument()
    // the edge table resolves node ids to their labels
    const edges = screen.getByTestId('refactor-graph-edges')
    expect(screen.getByTestId('refactor-edge-1')).toHaveTextContent('inertial sensor')
    expect(edges).toHaveTextContent('has property')
    expect(edges).toHaveTextContent('gyroscope range')

    for (const label of ['R1', 'R2', 'R3']) expect(screen.getByTestId(`refactor-reply-${label}`)).toBeInTheDocument()
    expect(screen.getByTestId('refactor-summary-R1')).toHaveTextContent('Reads the range from the range table.')
    expect(screen.getByTestId('refactor-claim-R1-2')).toHaveTextContent('Cites table 3')
    expect(screen.getByTestId('refactor-claim-R3-1')).toHaveTextContent('125 dps to 2000 dps')
  })

  test('labels only: it never names a slot or a vendor', () => {
    render(<RefactorView refactor={done()} />)
    expect(screen.getByTestId('refactor-report').textContent).not.toMatch(SLOT_NAMES)
  })

  test('an empty graph says so instead of rendering two empty tables', () => {
    const turn = refactorTurn({ refactoring: { graph: { nodes: [], edges: [] }, question: 'q', replies: [] } })
    render(<RefactorView refactor={done(turn)} />)
    expect(screen.queryByTestId('refactor-graph-nodes')).toBeNull()
    expect(screen.queryByTestId('refactor-graph-edges')).toBeNull()
    expect(screen.getByTestId('refactor-report')).toHaveTextContent('no graph for this question')
  })

  test('a degraded refactor says what happened, that Analyze falls back, and shows the attempts', () => {
    const turn = degradedTurn()
    render(<RefactorView refactor={{ status: 'degraded', turn, cached: false, notice: null, error: turn.error, ofTurn: 's1' }} />)
    expect(screen.getByTestId('refactor-degraded')).toHaveTextContent('parse_error')
    expect(screen.getByTestId('refactor-fallback')).toHaveTextContent(FALLBACK_NOTE)
    const raw = screen.getByTestId('refactor-raw-attempts')
    expect(within(raw).getByTestId('refactor-raw-attempt-1')).toHaveTextContent('Sure! Here you go:')
    expect(within(raw).getByTestId('refactor-raw-attempt-2')).toHaveTextContent('(no output)')
    expect(screen.queryByTestId('refactor-report')).toBeNull()
  })

  test('with nothing to show it renders nothing at all', () => {
    const { container } = render(<RefactorView refactor={{ status: 'idle', turn: null, error: null }} />)
    expect(container.firstChild).toBeNull()
  })
})
