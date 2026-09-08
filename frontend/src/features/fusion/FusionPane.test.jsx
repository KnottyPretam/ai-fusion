import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FusionPane from './index.jsx'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import { initialState } from '../../state/registry.js'
import { useDispatch } from '../../state/store.jsx'
import { ANALYZE_PREFIX, EXTRACTION, ROUND1, SLOT_CONFIG, analyzeTurn, conversation, exchange, fakeResponse, fullRun, fusionStart, fusionTurnFromEvents, roundDone, sendTurn, sseText } from './fixtures.js'

afterEach(() => vi.unstubAllGlobals())

const start = { type: 'sse/start', feature: 'fusion' }
const endOk = { type: 'sse/end', feature: 'fusion', ok: true }

function loaded(conv = conversation(), extra = []) {
  return applyEvents('fusion', [{ type: 'conversation/loaded', conversation: conv }, ...extra])
}

function Dispatcher({ action, label }) {
  const dispatch = useDispatch()
  return (
    <button type="button" data-testid={`dispatch-${label}`} onClick={() => dispatch(action)}>
      {label}
    </button>
  )
}

describe('FusionPane: mount and gating', () => {
  test('renders nothing without a conversation (the app-fusion section stays :empty)', () => {
    const { container } = renderWithStore(<FusionPane />)
    expect(container.innerHTML).toBe('')
  })

  test('button disabled while the latest send turn is incomplete, enabled once complete', () => {
    const incomplete = conversation([sendTurn('s1', { claude: 'a', chatgpt: null, grok: 'c' })])
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(incomplete) })
    const btn = screen.getByTestId('fusion-run')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'latest send turn is incomplete')
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('latest send turn is incomplete')
    unmount()
    renderWithStore(<FusionPane />, { preloaded: loaded(conversation([sendTurn()])) })
    expect(screen.getByTestId('fusion-run')).toBeEnabled()
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('will run Analyze first')
  })

  test('button disabled when the ok analyze turn has an empty standing set; enabled with standing ids', () => {
    const none = conversation([sendTurn(), analyzeTurn('a1', 's1', { agreements: [], divergences: [EXTRACTION.divergences[2]] })])
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(none) })
    expect(screen.getByTestId('fusion-run')).toBeDisabled()
    expect(screen.getByTestId('fusion-run').title).toMatch(/nothing to fuse/)
    unmount()
    renderWithStore(<FusionPane />, { preloaded: loaded() })
    expect(screen.getByTestId('fusion-run')).toBeEnabled()
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('2 standing divergences')
  })

  test('button disabled while any stream is streaming', () => {
    for (const f of ['send', 'analyze', 'fusion']) {
      const s = loaded(conversation(), [{ type: 'sse/start', feature: f }])
      const { unmount } = renderWithStore(<FusionPane />, { preloaded: s })
      expect(screen.getByTestId('fusion-run')).toBeDisabled()
      unmount()
    }
  })
})

describe('FusionPane: iterations stepper', () => {
  test('defaults to slotConfig.max_iterations and is bounded 1..5', async () => {
    const user = userEvent.setup()
    const conv = conversation()
    conv.slot_config = { ...SLOT_CONFIG, max_iterations: 4 }
    renderWithStore(<FusionPane />, { preloaded: loaded(conv) })
    const input = screen.getByTestId('fusion-iterations')
    expect(input).toHaveValue(4)
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '5')
    await user.click(screen.getByTestId('fusion-iterations-inc'))
    expect(input).toHaveValue(5)
    expect(screen.getByTestId('fusion-iterations-inc')).toBeDisabled()
    await user.click(screen.getByTestId('fusion-iterations-inc'))
    expect(input).toHaveValue(5)
    for (let i = 0; i < 6; i++) await user.click(screen.getByTestId('fusion-iterations-dec'))
    expect(input).toHaveValue(1)
    expect(screen.getByTestId('fusion-iterations-dec')).toBeDisabled()
    fireEvent.change(input, { target: { value: '9' } })
    expect(input).toHaveValue(5)
    fireEvent.change(input, { target: { value: '0' } })
    expect(input).toHaveValue(1)
    fireEvent.change(input, { target: { value: '3' } })
    expect(input).toHaveValue(3)
  })

  test('clearing the field to type a new count works; an abandoned empty field restores the last value', async () => {
    const user = userEvent.setup()
    renderWithStore(<FusionPane />, { preloaded: loaded() })
    const input = screen.getByTestId('fusion-iterations')
    expect(input).toHaveValue(2)
    // clear, then type: the field stays empty until a digit arrives (no '1' + '4' -> 14 -> 5 snap)
    fireEvent.change(input, { target: { value: '' } })
    expect(input).toHaveValue(null)
    fireEvent.change(input, { target: { value: '4' } })
    expect(input).toHaveValue(4)
    // the same through real keystrokes
    await user.clear(input)
    expect(input).toHaveValue(null)
    await user.type(input, '3')
    expect(input).toHaveValue(3)
    // leaving the field empty restores the last committed value
    await user.clear(input)
    expect(input).toHaveValue(null)
    fireEvent.blur(input)
    expect(input).toHaveValue(3)
    // the stepper buttons operate on the committed value and drop an empty draft
    fireEvent.change(input, { target: { value: '' } })
    await user.click(screen.getByTestId('fusion-iterations-inc'))
    expect(input).toHaveValue(4)
  })

  test('re-syncs to the persisted default when slotConfig changes', async () => {
    const user = userEvent.setup()
    renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="cfg" action={{ type: 'slotConfig/update', patch: { max_iterations: 5 } }} />
      </>,
      { preloaded: loaded() },
    )
    const input = screen.getByTestId('fusion-iterations')
    expect(input).toHaveValue(2)
    await user.click(screen.getByTestId('fusion-iterations-inc'))
    expect(input).toHaveValue(3)
    await user.click(screen.getByTestId('dispatch-cfg'))
    expect(input).toHaveValue(5)
  })
})

describe('FusionPane: timeline and final report', () => {
  test('renders one row per standing divergence, one cell per round, statuses, gap, trace and report', () => {
    const s = loaded(conversation(), [start, ...fullRun(), endOk])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('done')
    const table = screen.getByTestId('fusion-timeline')
    expect(within(table).getAllByTestId(/^fusion-row-/).map((r) => r.dataset.testid)).toEqual(['fusion-row-d1', 'fusion-row-d2'])
    expect(screen.getByTestId('fusion-round-head-1')).toHaveTextContent('round 1')
    expect(screen.getByTestId('fusion-round-head-2')).toHaveTextContent('round 2')
    // topics come from the analyze turn referenced by ofAnalyze
    expect(screen.getByTestId('fusion-topic-d1')).toHaveTextContent('gyroscope full-scale range')
    expect(screen.getByTestId('fusion-topic-d2')).toHaveTextContent('accelerometer bandwidth')
    // d1 round 1: three stances, R2 revise, resolved
    const c11 = screen.getByTestId('fusion-cell-d1-1')
    expect(within(c11).getByTestId('fusion-exchange-d1-1-R1')).toHaveAttribute('data-stance', 'defend')
    expect(within(c11).getByTestId('fusion-exchange-d1-1-R2')).toHaveAttribute('data-stance', 'revise')
    expect(within(c11).getByTestId('fusion-exchange-d1-1-R2')).toHaveTextContent('R2 revises')
    expect(within(c11).queryByTestId('fusion-flag-unjustified')).toBeNull()
    expect(screen.getByTestId('fusion-status-d1-1')).toHaveTextContent('resolved')
    expect(screen.getByTestId('fusion-status-d1-1')).toHaveClass('stResolved')
    // d1 round 2: already resolved -> not re-challenged gap
    expect(screen.getByTestId('fusion-cell-d1-2')).toHaveTextContent('—')
    expect(screen.getByTestId('fusion-cell-d1-2')).toHaveAttribute('data-status', 'resolved')
    // d2 round 2: R3 unavailable renders as a gap; status standing
    const ex = screen.getByTestId('fusion-exchange-d2-2-R3')
    expect(ex).toHaveAttribute('data-stance', 'unavailable')
    expect(ex).toHaveClass('exUnavailable')
    expect(ex).toHaveTextContent('R3 unavailable')
    expect(ex.title).toContain('Provider disconnected')
    expect(screen.getByTestId('fusion-status-d2-2')).toHaveTextContent('standing')
    expect(screen.getByTestId('fusion-status-d2-2')).toHaveClass('stStanding')
    expect(screen.getByTestId('fusion-row-d2')).toHaveAttribute('data-final-status', 'standing')
    // trace text
    expect(screen.getByTestId('fusion-trace-d1')).toHaveTextContent('R1 defends → R2 revises → R3 defends → resolved, round 1')
    expect(screen.getByTestId('fusion-trace-d2')).toHaveTextContent('R1 defends → R3 defends → R1 defends → R3 unavailable → standing, round 2')
    // not fused
    expect(screen.getByTestId('fusion-not-fused')).toHaveTextContent('d3 (low) package marking')
    // final report
    const final = screen.getByTestId('fusion-final')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'max_iterations')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveTextContent('max iterations reached')
    expect(within(final).getByTestId('fusion-final-d1')).toHaveAttribute('data-status', 'resolved')
    expect(within(final).getByTestId('fusion-final-d1')).toHaveTextContent('convergence, not verified truth')
    expect(within(final).queryByTestId('fusion-sides-d1')).toBeNull()
    // standing item: both sides' latest claim + justification
    const d2 = within(final).getByTestId('fusion-final-d2')
    expect(d2).toHaveAttribute('data-status', 'standing')
    const r1 = within(d2).getByTestId('fusion-side-d2-R1')
    expect(r1).toHaveTextContent('280 Hz')
    expect(r1).toHaveTextContent('R1 defends d2 in round 2 with datasheet specifics.')
    const r3 = within(d2).getByTestId('fusion-side-d2-R3')
    expect(r3).toHaveTextContent('145 Hz')
    expect(r3).toHaveTextContent('R3 defends d2 in round 1 with datasheet specifics.')
    expect(within(d2).queryByTestId('fusion-side-d2-R2')).toBeNull() // R2 holds no position on d2
    expect(r1.querySelector('.markdown-content')).not.toBeNull()
    expect(screen.getByTestId('fusion-usage')).toHaveTextContent('1540 tokens (1200 in / 340 out) · $0.0123 · 4200 ms · 7 calls')
  })

  test('resolved_unjustified is labelled and styled distinctly; the flagged revise carries a marker', () => {
    const body = [fusionStart({ max_iterations: 1, standing: ['d1'] }), { type: 'round_start', round: 1 }, exchange(1, 'd1', 'R1', 'defend'), exchange(1, 'd1', 'R2', 'revise', { flagged_unjustified: true, justification: 'You are right, I revise.', persuaded_by: null }), exchange(1, 'd1', 'R3', 'defend'), roundDone(1, { d1: 'resolved_unjustified' }, true)]
    const turn = fusionTurnFromEvents(body, { max_iterations: 1, exit_reason: 'converged' })
    const s = loaded(conversation(), [start, ...body, { type: 'fusion_done', turn, exit_reason: 'converged', usage: turn.usage }, endOk])
    renderWithStore(<FusionPane />, { preloaded: s })
    const cell = screen.getByTestId('fusion-cell-d1-1')
    expect(within(cell).getByTestId('fusion-flag-unjustified')).toHaveTextContent('unjustified')
    const st = screen.getByTestId('fusion-status-d1-1')
    expect(st).toHaveTextContent('resolved (unjustified)')
    expect(st).toHaveClass('stUnjustified')
    expect(st).not.toHaveClass('stResolved')
    expect(screen.getByTestId('fusion-trace-d1')).toHaveTextContent('R1 defends → R2 revises (unjustified) → R3 defends → resolved_unjustified, round 1')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveTextContent('converged')
    expect(screen.getByTestId('fusion-final-d1')).toHaveTextContent('resolved only through revisions flagged as unjustified')
  })

  test('hydrates the last timeline from a reloaded conversation', () => {
    const turn = fullRun().at(-1).turn
    const s = loaded(conversation([sendTurn(), analyzeTurn(), turn]))
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('fusion-timeline')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^fusion-row-/)).toHaveLength(2)
    expect(screen.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'max_iterations')
  })

  test('live progress while running: analyzing prefix, then round progress', () => {
    const s1 = loaded(conversation([sendTurn()]), [start, ANALYZE_PREFIX[0]])
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: s1 })
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('analyzing…')
    expect(screen.getByTestId('fusion-status')).toHaveAttribute('data-analyzing', 'true')
    expect(screen.getByTestId('fusion-progress')).toHaveTextContent('Analyze is running first')
    expect(screen.getByTestId('fusion-run')).toBeDisabled()
    expect(screen.queryByTestId('fusion-timeline')).toBeNull()
    unmount()
    const s2 = loaded(conversation(), [start, fusionStart(), ...ROUND1, { type: 'round_start', round: 2 }, exchange(2, 'd2', 'R1', 'defend')])
    renderWithStore(<FusionPane />, { preloaded: s2 })
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('round 2 of 2…')
    expect(screen.getByTestId('fusion-progress')).toHaveTextContent('round 2 of 2 in progress · 6 exchanges so far · 2 standing')
    expect(screen.getByTestId('fusion-status-d2-2')).toHaveTextContent('in progress')
    expect(screen.getByTestId('fusion-cell-d1-2')).toHaveTextContent('—')
    expect(screen.getByTestId('fusion-trace-d2')).toHaveTextContent('R1 defends → …')
    expect(screen.queryByTestId('fusion-final')).toBeNull()
  })

  test('analyze prefix + error{nothing_to_fuse} renders a notice, not an error', () => {
    const s = loaded(conversation([sendTurn()]), [start, ...ANALYZE_PREFIX, { type: 'error', message: 'nothing_to_fuse' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'nothing_to_fuse' }])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('fusion-notice')).toHaveAttribute('data-notice', 'nothing_to_fuse')
    expect(screen.getByTestId('fusion-notice')).toHaveTextContent('Nothing to fuse')
    expect(screen.queryByTestId('fusion-error')).toBeNull()
    expect(screen.queryByTestId('fusion-final')).toBeNull()
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('stopped')
    expect(screen.getByTestId('fusion-status')).not.toHaveClass('state_error')
  })

  test('a real terminal error renders the error box', () => {
    const s = loaded(conversation(), [start, fusionStart(), { type: 'error', message: 'cost_cap_exceeded' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'cost_cap_exceeded' }])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('fusion-error')).toHaveTextContent('Fusion failed: cost_cap_exceeded')
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('failed')
  })

  test('the refetch after a run that failed mid-stream keeps the error box and the partial timeline', async () => {
    const user = userEvent.setup()
    const s = loaded(conversation(), [start, fusionStart(), ...ROUND1, { type: 'error', message: 'boom' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'boom' }])
    renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="refetch" action={{ type: 'conversation/loaded', conversation: conversation() }} />
      </>,
      { preloaded: s },
    )
    expect(screen.getByTestId('fusion-error')).toHaveTextContent('Fusion failed: boom')
    expect(screen.getByTestId('fusion-row-d1')).toBeInTheDocument()
    await user.click(screen.getByTestId('dispatch-refetch'))
    expect(screen.getByTestId('fusion-error')).toHaveTextContent('Fusion failed: boom')
    expect(screen.getByTestId('fusion-row-d1')).toBeInTheDocument()
    expect(screen.getByTestId('fusion-status-d1-1')).toHaveTextContent('resolved')
    expect(screen.queryByTestId('fusion-final')).toBeNull()
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('failed')
  })

  test('stalemate and error exit reasons are labelled', () => {
    const body = [fusionStart({ max_iterations: 1, standing: ['d1'] }), { type: 'round_start', round: 1 }, exchange(1, 'd1', 'R1', 'defend'), exchange(1, 'd1', 'R2', 'defend'), exchange(1, 'd1', 'R3', 'defend'), roundDone(1, { d1: 'standing' }, false)]
    const stalemate = fusionTurnFromEvents(body, { max_iterations: 1, exit_reason: 'stalemate' })
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(conversation([sendTurn(), analyzeTurn(), stalemate])) })
    expect(screen.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'stalemate')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveTextContent('exit: stalemate')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveClass('exit_stalemate')
    expect(screen.getByTestId('fusion-final-d1')).toHaveAttribute('data-status', 'standing')
    unmount()
    const errBody = [fusionStart({ max_iterations: 1, standing: ['d1'] }), { type: 'round_start', round: 1 }, exchange(1, 'd1', 'R1', 'unavailable'), exchange(1, 'd1', 'R2', 'unavailable'), exchange(1, 'd1', 'R3', 'unavailable'), roundDone(1, { d1: 'standing' }, false)]
    const errored = fusionTurnFromEvents(errBody, { max_iterations: 1, exit_reason: 'error' })
    renderWithStore(<FusionPane />, { preloaded: loaded(conversation([sendTurn(), analyzeTurn(), errored])) })
    expect(screen.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'error')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveTextContent('exit: error')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveClass('exit_error')
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('done') // a persisted turn, not a crash
    expect(screen.queryByTestId('fusion-error')).toBeNull()
  })

  test('the "not fused" list follows the current slotConfig.materiality_min, not the as-run standing set', async () => {
    const user = userEvent.setup()
    const turn = fullRun().at(-1).turn // ran with materiality_min medium: standing d1, d2
    renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="high" action={{ type: 'slotConfig/update', patch: { materiality_min: 'high' } }} />
        <Dispatcher label="low" action={{ type: 'slotConfig/update', patch: { materiality_min: 'low' } }} />
      </>,
      { preloaded: loaded(conversation([sendTurn(), analyzeTurn(), turn])) },
    )
    expect(screen.getByTestId('fusion-not-fused')).toHaveTextContent('not fused (below materiality "medium"): d3 (low) package marking')
    expect(screen.getByTestId('fusion-not-fused')).not.toHaveTextContent('d2')
    await user.click(screen.getByTestId('dispatch-high'))
    expect(screen.getByTestId('fusion-not-fused')).toHaveTextContent('below materiality "high"')
    expect(screen.getByTestId('fusion-not-fused')).toHaveTextContent('d2 (medium) accelerometer bandwidth')
    expect(screen.getByTestId('fusion-not-fused')).toHaveTextContent('d3 (low) package marking')
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('1 standing divergence')
    // the timeline still shows the as-run standing set
    expect(screen.getAllByTestId(/^fusion-row-/)).toHaveLength(2)
    await user.click(screen.getByTestId('dispatch-low'))
    expect(screen.queryByTestId('fusion-not-fused')).toBeNull()
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('3 standing divergences')
  })

  test('a report or notice for an earlier send turn is captioned as such', async () => {
    const user = userEvent.setup()
    const turn = fullRun().at(-1).turn
    const conv = conversation([sendTurn(), analyzeTurn(), turn])
    const { unmount } = renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="send" action={{ type: 'conversation/loaded', conversation: conversation([...conv.turns, sendTurn('s2')]) }} />
      </>,
      { preloaded: loaded(conv) },
    )
    expect(screen.queryByTestId('fusion-stale')).toBeNull()
    await user.click(screen.getByTestId('dispatch-send'))
    expect(screen.getByTestId('fusion-final')).toBeInTheDocument() // the last report is still shown
    expect(screen.getByTestId('fusion-stale')).toHaveTextContent('for an earlier send turn (s1)')
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('will run Analyze first')
    unmount()
    // the same for a "nothing to fuse" notice kept across the refetch
    const notice = loaded(conversation([sendTurn()]), [start, ...ANALYZE_PREFIX, { type: 'error', message: 'nothing_to_fuse' }, { type: 'sse/end', feature: 'fusion', ok: false, error: 'nothing_to_fuse' }])
    renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="send2" action={{ type: 'conversation/loaded', conversation: conversation([sendTurn(), ANALYZE_PREFIX[1].turn, sendTurn('s2')]) }} />
      </>,
      { preloaded: notice },
    )
    expect(screen.queryByTestId('fusion-stale')).toBeNull()
    await user.click(screen.getByTestId('dispatch-send2'))
    expect(screen.getByTestId('fusion-notice')).toBeInTheDocument()
    expect(screen.getByTestId('fusion-stale')).toHaveTextContent('for an earlier send turn (s1)')
  })

  test("a conversation switch mid-stream keeps the live timeline; the run's own refetch settles it", async () => {
    const user = userEvent.setup()
    const turn = fullRun().at(-1).turn
    const s = loaded(conversation(), [start, fusionStart(), ...ROUND1])
    renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="switch" action={{ type: 'conversation/loaded', conversation: conversation([sendTurn()], 'c2') }} />
        <Dispatcher label="back" action={{ type: 'conversation/loaded', conversation: conversation([sendTurn(), analyzeTurn(), turn]) }} />
      </>,
      { preloaded: s },
    )
    expect(screen.getByTestId('fusion-progress')).toHaveTextContent('round 1 of 2 done')
    await user.click(screen.getByTestId('dispatch-switch'))
    expect(screen.getByTestId('fusion-progress')).toHaveTextContent('round 1 of 2 done')
    expect(screen.getByTestId('fusion-row-d1')).toBeInTheDocument()
    expect(screen.getByTestId('fusion-run')).toBeDisabled()
    expect(screen.getByTestId('fusion-topic-d1')).toHaveTextContent('(topic pending)') // c2 has no analyze turn
    await user.click(screen.getByTestId('dispatch-back'))
    // still running: the refetch of c1 does not clobber the live timeline either
    expect(screen.getByTestId('fusion-progress')).toHaveTextContent('round 1 of 2 done')
    expect(screen.getByTestId('fusion-topic-d1')).toHaveTextContent('gyroscope full-scale range')
  })
})

describe('FusionPane: running a stream', () => {
  test('click posts max_iterations, renders the streamed timeline, then refetches the conversation', async () => {
    const user = userEvent.setup()
    const events = fullRun({ max_iterations: 3 })
    const conv = conversation()
    const after = conversation([sendTurn(), analyzeTurn(), events.at(-1).turn])
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return fakeResponse(sseText(events))
      return fakeResponse(JSON.stringify(after))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(<FusionPane />, { preloaded: loaded(conv) })
    await user.click(screen.getByTestId('fusion-iterations-inc'))
    expect(screen.getByTestId('fusion-iterations')).toHaveValue(3)
    await user.click(screen.getByTestId('fusion-run'))
    await screen.findByTestId('fusion-final')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/conversations/c1/fusion')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ max_iterations: 3 })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/conversations/c1')
    expect(screen.getAllByTestId(/^fusion-row-/)).toHaveLength(2)
    expect(screen.getByTestId('fusion-status-d1-1')).toHaveTextContent('resolved')
    expect(screen.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'max_iterations')
    // the stream is over: the button is usable again
    await waitFor(() => expect(screen.getByTestId('fusion-run')).toBeEnabled())
  })

  test('auto-run path: topics come from analyze_done on the fusion stream before any refetch', async () => {
    const user = userEvent.setup()
    const conv = conversation([sendTurn()]) // no analyze turn -> the stream auto-runs Analyze
    const extracted = analyzeTurn('a9', 's1')
    const body = [fusionStart({ of_analyze: 'a9', max_iterations: 2 }), ...ROUND1]
    const turn = fusionTurnFromEvents(body, { of_analyze: 'a9', max_iterations: 2, exit_reason: 'converged' })
    const events = [{ type: 'analyze_start', turn_id: 'a9', of_turn: 's1' }, { type: 'analyze_done', turn: extracted, cached: false }, ...body, { type: 'fusion_done', turn, exit_reason: 'converged', usage: turn.usage }]
    let refetches = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (init && init.method === 'POST') return fakeResponse(sseText(events))
        refetches += 1
        return fakeResponse(JSON.stringify(conversation([sendTurn(), extracted, turn])))
      }),
    )
    renderWithStore(<FusionPane />, { preloaded: loaded(conv) })
    expect(screen.getByTestId('fusion-gate-hint')).toHaveTextContent('will run Analyze first')
    await user.click(screen.getByTestId('fusion-run'))
    await screen.findByTestId('fusion-final')
    expect(screen.getByTestId('fusion-topic-d1')).toHaveTextContent('gyroscope full-scale range')
    await waitFor(() => expect(refetches).toBe(1))
  })

  test('auto-run path ending in error{nothing_to_fuse}: notice shown, conversation refetched, no crash', async () => {
    const user = userEvent.setup()
    const conv = conversation([sendTurn()])
    const events = [...ANALYZE_PREFIX, { type: 'error', message: 'nothing_to_fuse' }]
    const after = conversation([sendTurn(), ANALYZE_PREFIX[1].turn])
    const fetchMock = vi.fn(async (url, init) => (init && init.method === 'POST' ? fakeResponse(sseText(events)) : fakeResponse(JSON.stringify(after))))
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(<FusionPane />, { preloaded: loaded(conv) })
    await user.click(screen.getByTestId('fusion-run'))
    await screen.findByTestId('fusion-notice')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('fusion-notice')).toHaveTextContent('Nothing to fuse')
    expect(screen.queryByTestId('fusion-error')).toBeNull()
    // after the refetch the ok analyze turn with an empty standing set disables the button
    await waitFor(() => expect(screen.getByTestId('fusion-run')).toBeDisabled())
    expect(screen.getByTestId('fusion-run').title).toMatch(/nothing to fuse/)
  })

  test('an HTTP 409 is shown as an error and nothing is refetched', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => fakeResponse('{"detail":{"error":"busy"}}', { ok: false, status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(<FusionPane />, { preloaded: loaded(conversation()) })
    await user.click(screen.getByTestId('fusion-run'))
    await screen.findByTestId('fusion-error')
    expect(screen.getByTestId('fusion-error')).toHaveTextContent('busy')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('after an HTTP 409 the next refetch brings the persisted report back with the failure still visible', async () => {
    const user = userEvent.setup()
    const turn = fullRun().at(-1).turn
    const conv = conversation([sendTurn(), analyzeTurn(), turn])
    const fetchMock = vi.fn(async () => fakeResponse('{"detail":{"error":"busy"}}', { ok: false, status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(
      <>
        <FusionPane />
        <Dispatcher label="refetch" action={{ type: 'conversation/loaded', conversation: conv }} />
      </>,
      { preloaded: loaded(conv) },
    )
    expect(screen.getByTestId('fusion-final')).toBeInTheDocument()
    await user.click(screen.getByTestId('fusion-run'))
    await screen.findByTestId('fusion-error')
    expect(screen.getByTestId('fusion-error')).toHaveTextContent('Fusion failed: busy')
    expect(screen.queryByTestId('fusion-final')).toBeNull() // sse/start reset the slice
    // a later refetch (after a Send, an Analyze, a rename, ...) re-hydrates the persisted report
    await user.click(screen.getByTestId('dispatch-refetch'))
    expect(screen.getByTestId('fusion-final')).toBeInTheDocument()
    expect(screen.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'max_iterations')
    expect(screen.getAllByTestId(/^fusion-row-/)).toHaveLength(2)
    expect(screen.getByTestId('fusion-error')).toHaveTextContent('Fusion failed: busy — showing the last persisted report')
    expect(screen.getByTestId('fusion-status')).toHaveTextContent('done')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

test('the registry knows the fusion slice with its initial shape', () => {
  expect(initialState().fusion.status).toBe('idle')
})
