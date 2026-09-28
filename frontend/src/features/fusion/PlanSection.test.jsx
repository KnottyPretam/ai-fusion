// The Plan section (2026-09-27), rendered by the Fusion pane under its final report: the table from
// a loaded conversation, a run through the real runStream + refetch, the gate, the agent picker per
// shell, the cached / stale / degraded states and the per-plan step ticks.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FusionPane from './index.jsx'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import { initialState } from '../../state/registry.js'
import { DEFAULT_MODEL, OLLAMA_GROUP, OPENROUTER_GROUP, PLAN_CHECKED_PREFIX, PLAN_MODEL_KEY, WEB_ANALYST_GROUP, WEB_PANE_GROUP } from './planSlice.js'
import { DESKTOP_CATALOG, ROUND1, fakeResponse, fullRun, fusionStart, fusionTurnFromEvents, modelsState, planEvents, planTurn, plannedConversation, roundDone, sseText } from './fixtures.js'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const loaded = (conv, extra = [], preloaded) => applyEvents('plan', [{ type: 'conversation/loaded', conversation: conv }, ...extra], { preloaded })
const BROWSER_CATALOG = [
  { id: 'openai/gpt-5', name: 'GPT-5', structured_outputs: true },
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', structured_outputs: false },
]

describe('PlanSection: a persisted plan', () => {
  test('renders objective, prerequisites, the procedure table, decisions, risks, done-when, the agent and the usage', () => {
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation()) })
    const root = screen.getByTestId('plan-root')
    expect(root).toHaveAttribute('data-status', 'done')
    expect(screen.getByTestId('plan-status')).toHaveTextContent('done')
    expect(screen.getByTestId('plan-objective')).toHaveTextContent('Configure the BMI088 gyroscope for the 2000 deg/s range')
    expect(within(screen.getByTestId('plan-prerequisites')).getAllByRole('listitem')).toHaveLength(2)
    // the procedure table: one row per step, a details row where there is something to tell
    const table = screen.getByTestId('plan-steps')
    expect(within(table).getAllByTestId(/^plan-step-\d+$/).map((r) => r.dataset.testid)).toEqual(['plan-step-1', 'plan-step-2', 'plan-step-3'])
    const row2 = screen.getByTestId('plan-step-2')
    expect(row2).toHaveAttribute('data-done', 'false')
    expect(row2).toHaveTextContent('2')
    expect(row2).toHaveTextContent('Set the gyroscope range')
    expect(row2).toHaveTextContent('Write the range register for 2000 deg/s.')
    expect(row2).toHaveTextContent('Reading the register back returns the 2000 deg/s code.')
    expect(screen.getByTestId('plan-step-2-details')).toHaveTextContent('The range settled on in the comparison.')
    expect(screen.getByTestId('plan-step-2-details')).toHaveTextContent('range register address')
    expect(screen.getByTestId('plan-step-2-details')).toHaveTextContent('range = 2000 deg/s')
    expect(screen.queryByTestId('plan-step-3-details')).toBeNull() // nothing beyond action + verify
    expect(screen.getByTestId('plan-step-3')).toHaveTextContent('The bandwidth register reads the chosen value.')
    // decision points carry the divergence id, the options, the recommendation and the rationale
    const d1 = screen.getByTestId('plan-decision-1')
    expect(d1).toHaveAttribute('data-divergence-id', 'd2')
    expect(d1).toHaveTextContent('d2')
    expect(d1).toHaveTextContent('accelerometer bandwidth')
    expect(within(d1).getAllByRole('listitem')).toHaveLength(2)
    expect(d1).toHaveTextContent('recommendation: 145 Hz')
    expect(d1).toHaveTextContent('The only cited evidence is the register map.')
    expect(screen.getByTestId('plan-risks')).toHaveTextContent('The range register code differs between datasheet revisions. — Read the register back after writing it.')
    const done = screen.getByTestId('plan-done-when')
    const boxes = within(done).getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(b).toBeDisabled()
    expect(done).toHaveTextContent('the gyroscope reports 2000 deg/s full scale')
    expect(screen.getByTestId('plan-model-used')).toHaveTextContent('made by web:claude')
    expect(screen.getByTestId('plan-usage')).toHaveTextContent('3000 tokens (2100 in / 900 out) · $0.0456 · 30000 ms · 1 calls')
    expect(screen.getByTestId('plan-run')).toHaveTextContent('Re-plan')
    expect(screen.getByTestId('plan-run')).toBeEnabled()
    expect(screen.getByTestId('export-plan')).toBeEnabled()
    expect(screen.queryByTestId('plan-cached')).toBeNull()
    expect(screen.queryByTestId('plan-stale')).toBeNull()
    expect(screen.queryByTestId('plan-degraded')).toBeNull()
    // the section sits under the final report, inside the fusion pane
    const pane = screen.getByTestId('fusion-root')
    expect(pane.contains(root)).toBe(true)
    expect(screen.getByTestId('fusion-final').compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('a decision with no divergence id shows the topic only; empty lists say so', () => {
    const plan = { objective: 'o', prerequisites: [], steps: [], decisions: [{ divergence_id: null, topic: 'which host', options: [], recommendation: '', rationale: '' }], risks: [], done_when: [] }
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: planTurn('p1', 'f1', { plan }) })) })
    expect(screen.getByTestId('plan-prerequisites')).toHaveTextContent('(none)')
    expect(screen.getByTestId('plan-steps')).toHaveTextContent('(no steps)')
    expect(screen.getByTestId('plan-decision-1')).toHaveTextContent('which host')
    expect(screen.getByTestId('plan-decision-1')).toHaveAttribute('data-divergence-id', '')
    expect(screen.getByTestId('plan-risks')).toHaveTextContent('(none)')
    expect(screen.getByTestId('plan-done-when')).toHaveTextContent('(none given)')
  })

  test('every button and the picker carry a description for the tooltip layer', () => {
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation()) })
    for (const btn of within(screen.getByTestId('plan-root')).getAllByRole('button')) expect(btn.getAttribute('title')).toBeTruthy()
    expect(screen.getByTestId('plan-model').closest('label').getAttribute('title')).toBeTruthy()
    expect(screen.getByTestId('plan-step-1-done').getAttribute('title')).toBeTruthy()
  })

  test('step ticks are kept per plan turn in this browser, and survive a remount', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation()) })
    await user.click(screen.getByTestId('plan-step-2-done'))
    expect(screen.getByTestId('plan-step-2')).toHaveAttribute('data-done', 'true')
    expect(screen.getByTestId('plan-step-1')).toHaveAttribute('data-done', 'false')
    expect(localStorage.getItem(`${PLAN_CHECKED_PREFIX}p1`)).toBe('[2]')
    unmount()
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation()) })
    expect(screen.getByTestId('plan-step-2-done')).toBeChecked()
    await user.click(screen.getByTestId('plan-step-2-done'))
    expect(screen.getByTestId('plan-step-2')).toHaveAttribute('data-done', 'false')
    expect(localStorage.getItem(`${PLAN_CHECKED_PREFIX}p1`)).toBe('[]')
    // another plan turn starts from its own (empty) list
    localStorage.setItem(`${PLAN_CHECKED_PREFIX}p1`, '[1]')
    const { unmount: u2 } = renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: planTurn('p7', 'f1') })) })
    expect(screen.getAllByTestId('plan-step-1-done').at(-1)).not.toBeChecked()
    u2()
  })
})

describe('PlanSection: gate and states', () => {
  test('with a fusion report and no plan the button reads "Make a plan"; without a report there is no section at all', () => {
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null })) })
    expect(screen.getByTestId('plan-run')).toHaveTextContent('Make a plan')
    expect(screen.getByTestId('plan-run')).toBeEnabled()
    expect(screen.getByTestId('plan-status')).toHaveTextContent('idle')
    expect(screen.getByTestId('export-plan')).toBeDisabled()
    expect(screen.getByTestId('export-plan')).toHaveAttribute('title', 'Export: no plan to export yet')
    unmount()
    const noFusion = plannedConversation({ plan: null })
    noFusion.turns = noFusion.turns.slice(0, 2)
    renderWithStore(<FusionPane />, { preloaded: loaded(noFusion) })
    expect(screen.queryByTestId('plan-root')).toBeNull()
  })

  test('disabled while any stream runs, the plan stream included', () => {
    for (const f of ['send', 'analyze', 'plan']) {
      const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation(), [{ type: 'sse/start', feature: f }]) })
      expect(screen.getByTestId('plan-run')).toBeDisabled()
      expect(screen.getByTestId('plan-run')).toHaveAttribute('title', 'Plan: a stream is running')
      unmount()
    }
  })

  test('the narration while running is progress, not a failure; the picker and the export are locked meanwhile', () => {
    const s = loaded(plannedConversation({ plan: null }), [{ type: 'sse/start', feature: 'plan' }, planEvents.start(), planEvents.retry('asking the agent for a plan')])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('plan-root')).toHaveAttribute('data-status', 'working')
    expect(screen.getByTestId('plan-status')).toHaveTextContent('working…')
    expect(screen.getByTestId('plan-notice')).toHaveTextContent('asking the agent for a plan')
    expect(screen.queryByTestId('plan-error')).toBeNull()
    expect(screen.getByTestId('plan-model')).toBeDisabled()
    expect(screen.getByTestId('export-plan')).toBeDisabled() // no turn yet, and a run in flight
  })

  test('a finished plan is not exportable while another stream runs', () => {
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation(), [{ type: 'sse/start', feature: 'send' }]) })
    expect(screen.getByTestId('export-plan')).toBeDisabled()
    expect(screen.getByTestId('export-plan')).toHaveAttribute('title', 'Export: a stream is running')
  })

  test('a cached hit shows the chip', () => {
    const s = loaded(plannedConversation({ plan: null }), [{ type: 'sse/start', feature: 'plan' }, ...planEvents.stream(planTurn(), { cached: true }), { type: 'sse/end', feature: 'plan', ok: true }])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('plan-cached')).toHaveTextContent('cached')
    expect(screen.getByTestId('plan-objective')).toBeInTheDocument()
  })

  test('a degraded turn shows the error and the raw attempts, no table, and the button offers a re-plan', () => {
    const s = loaded(plannedConversation({ plan: null }), [{ type: 'sse/start', feature: 'plan' }, planEvents.start({ turn_id: 'p2' }), planEvents.degraded(), { type: 'sse/end', feature: 'plan', ok: true }])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('plan-root')).toHaveAttribute('data-status', 'degraded')
    expect(screen.getByTestId('plan-status')).toHaveTextContent('degraded')
    const box = screen.getByTestId('plan-degraded')
    expect(box).toHaveTextContent('Plan degraded.')
    expect(box).toHaveTextContent('after one retry')
    expect(box).toHaveTextContent('parse_error: no JSON object found')
    expect(screen.getByTestId('plan-raw-attempts')).toHaveTextContent('raw attempts (2)')
    expect(screen.getByTestId('plan-raw-attempt-1')).toHaveTextContent('not json')
    expect(screen.getByTestId('plan-raw-attempt-2')).toHaveTextContent('still not json')
    expect(screen.queryByTestId('plan-report')).toBeNull()
    expect(screen.getByTestId('plan-run')).toHaveTextContent('Re-plan')
    expect(screen.getByTestId('export-plan')).toBeEnabled() // the degraded document exists
  })

  test('a plan made for an earlier fusion turn than the report shown is captioned stale and the button starts afresh', () => {
    const body = [fusionStart({ turn_id: 'f2', max_iterations: 1, standing: ['d1'] }), ...ROUND1.slice(0, 4), roundDone(1, { d1: 'resolved', d2: 'standing' }, true)]
    const turn = fusionTurnFromEvents(body, { id: 'f2', max_iterations: 1, exit_reason: 'max_iterations' })
    // the plan p1 (for f1) is hydrated, then a NEW fusion run (f2) streams on the fusion feature key
    const s = applyEvents('fusion', [{ type: 'sse/start', feature: 'fusion' }, ...body, { type: 'fusion_done', turn, exit_reason: 'max_iterations', usage: turn.usage }, { type: 'sse/end', feature: 'fusion', ok: true }], { state: loaded(plannedConversation()) })
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('fusion-exit-reason')).toBeInTheDocument()
    expect(screen.getByTestId('plan-stale')).toHaveTextContent('made for an earlier Fusion report (f1)')
    expect(screen.getByTestId('plan-run')).toHaveTextContent('Make a plan')
    expect(screen.getByTestId('plan-objective')).toBeInTheDocument() // the last plan stays readable
  })
})

describe('PlanSection: running a stream', () => {
  test('click posts of_fusion + the picked model, renders the streamed plan, then refetches; a second click re-plans with force', async () => {
    const user = userEvent.setup()
    const conv = plannedConversation({ plan: null })
    const after = plannedConversation()
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return fakeResponse(sseText(planEvents.stream()))
      return fakeResponse(JSON.stringify(after))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(<FusionPane />, { preloaded: loaded(conv) })
    expect(screen.getByTestId('plan-model')).toHaveValue(DEFAULT_MODEL) // the browser default
    await user.click(screen.getByTestId('plan-run'))
    await screen.findByTestId('plan-objective')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/conversations/c1/plan')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ of_fusion: 'f1', model: 'anthropic/claude-opus-5.5' })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/conversations/c1')
    expect(screen.getByTestId('plan-status')).toHaveTextContent('done')
    expect(screen.getAllByTestId(/^plan-step-\d+$/)).toHaveLength(3)
    await waitFor(() => expect(screen.getByTestId('plan-run')).toBeEnabled())
    expect(screen.getByTestId('plan-run')).toHaveTextContent('Re-plan')
    await user.click(screen.getByTestId('plan-run'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ of_fusion: 'f1', model: 'anthropic/claude-opus-5.5', force: true })
  })

  test('the picked agent is remembered and posted; a fresh mount reads it back', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async (url, init) => (init && init.method === 'POST' ? fakeResponse(sseText(planEvents.stream(planTurn('p1', 'f1', { model: 'openai/gpt-5' })))) : fakeResponse(JSON.stringify(plannedConversation()))))
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null }), [], { models: modelsState(BROWSER_CATALOG) }) })
    const select = screen.getByTestId('plan-model')
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['structured outputs (recommended)', 'other models'])
    await user.selectOptions(select, 'openai/gpt-5')
    expect(localStorage.getItem(PLAN_MODEL_KEY)).toBe('openai/gpt-5')
    await user.click(screen.getByTestId('plan-run'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'openai/gpt-5' })
    await screen.findByTestId('plan-model-used')
    expect(screen.getByTestId('plan-model-used')).toHaveTextContent('made by openai/gpt-5')
    unmount()
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null }), [], { models: modelsState(BROWSER_CATALOG) }) })
    expect(screen.getByTestId('plan-model')).toHaveValue('openai/gpt-5')
  })

  test('a remembered agent the catalog no longer lists is still selectable, shown as its raw id', () => {
    localStorage.setItem(PLAN_MODEL_KEY, 'ollama:hermes3')
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null })) })
    expect(screen.getByTestId('plan-model')).toHaveValue('ollama:hermes3')
  })

  test('an HTTP 409 is shown as an error and nothing is refetched', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => fakeResponse('{"detail":{"error":"busy"}}', { ok: false, status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null })) })
    await user.click(screen.getByTestId('plan-run'))
    await screen.findByTestId('plan-error')
    expect(screen.getByTestId('plan-error')).toHaveTextContent('Plan failed: busy')
    expect(screen.getByTestId('plan-root')).toHaveAttribute('data-status', 'error')
    expect(screen.getByTestId('plan-status')).toHaveTextContent('failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a terminal error event ends the run in the error box, keeping the fusion report on screen', () => {
    const s = loaded(plannedConversation({ plan: null }), [{ type: 'sse/start', feature: 'plan' }, planEvents.start(), { type: 'error', message: 'missing_api_key' }, { type: 'sse/end', feature: 'plan', ok: false, error: 'missing_api_key' }])
    renderWithStore(<FusionPane />, { preloaded: s })
    expect(screen.getByTestId('plan-error')).toHaveTextContent('missing_api_key')
    expect(screen.getByTestId('fusion-final')).toBeInTheDocument()
  })
})

describe('PlanSection: the desktop picker', () => {
  test('the web panes come first, then the hidden analyst pages and local Ollama; OpenRouter only once a key is configured', () => {
    vi.stubGlobal('triplex', { version: '0.1.0', slots: ['claude', 'chatgpt', 'grok'] })
    const { unmount } = renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null }), [], { models: modelsState(DESKTOP_CATALOG) }) })
    let select = screen.getByTestId('plan-model')
    expect(select).toHaveValue('web:claude') // the desktop default: typed into this conversation's chat
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([WEB_PANE_GROUP, WEB_ANALYST_GROUP, OLLAMA_GROUP])
    expect(select.querySelector('option[value="web:claude"]')).toHaveTextContent("Claude — this conversation's chat")
    expect(select.querySelector('option[value="openai/gpt-5"]')).toBeNull()
    unmount()
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null }), [], { models: modelsState(DESKTOP_CATALOG), panes: { openRouterKey: { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: true } } }) })
    select = screen.getByTestId('plan-model')
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([WEB_PANE_GROUP, WEB_ANALYST_GROUP, OLLAMA_GROUP, OPENROUTER_GROUP])
    expect(select.querySelector('option[value="openai/gpt-5"]')).not.toBeNull()
  })

  test('the run posts the web pane model by default', async () => {
    vi.stubGlobal('triplex', { version: '0.1.0', slots: ['claude', 'chatgpt', 'grok'] })
    const fetchMock = vi.fn(async (url, init) => (init && init.method === 'POST' ? fakeResponse(sseText(planEvents.stream())) : fakeResponse(JSON.stringify(plannedConversation()))))
    vi.stubGlobal('fetch', fetchMock)
    renderWithStore(<FusionPane />, { preloaded: loaded(plannedConversation({ plan: null })) })
    fireEvent.click(screen.getByTestId('plan-run'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ of_fusion: 'f1', model: 'web:claude' })
  })
})

test('the registry knows the plan slice with its initial shape', () => {
  expect(initialState().plan).toEqual({ status: 'idle', turn: null, cached: false, notice: null, error: null, ofFusion: null, model: null })
  // and a full fusion run still hydrates the report the section hangs under
  expect(fullRun().at(-1).type).toBe('fusion_done')
})
