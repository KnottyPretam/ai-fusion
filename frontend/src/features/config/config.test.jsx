import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SlotConfigBar, { GROUNDED_LABEL, GROUNDED_TITLE, analystGroups } from './index.jsx'
import { renderWithStore } from '../../state/testing.jsx'
import { useDispatch } from '../../state/store.jsx'

const CFG = {
  slots: { claude: { model: 'anthropic/claude-opus-5', effort: 'medium' }, chatgpt: { model: 'openai/gpt-5.6-sol', effort: 'medium' }, grok: { model: 'x-ai/grok-4.6', effort: 'medium' } },
  analyst_model: 'openai/gpt-5.6-luna',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}
const MODELS = [
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'openai', efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'x-ai/grok-4.6', name: 'Grok 4.6', vendor: 'x-ai', efforts: ['low', 'medium', 'high'] },
]
const CONV = { id: 'c1', title: 'T', slot_config: CFG, threads: { claude: [], chatgpt: [], grok: [] }, turns: [] }
const loadedModels = (items = MODELS) => ({ items, byId: Object.fromEntries(items.map((m) => [m.id, m])), loaded: true, error: null })

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// Route fetch by method + path; PUT echoes the merged config back like the backend does.
// `deferPut` = 1-based indexes of PUTs that stay pending until `release[i]()` is called.
function stubFetch({ models = MODELS, putStatus = 200, deferPut = [] } = {}) {
  const release = {}
  let puts = 0
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    if (method === 'GET' && url === '/api/models') return jsonResponse(models)
    if (method === 'PUT' && url === '/api/conversations/c1/slot_config') {
      puts += 1
      const reply = () => (putStatus === 200 ? jsonResponse(body) : jsonResponse({ detail: { error: 'unsupported_effort' } }, putStatus))
      if (!deferPut.includes(puts)) return reply()
      const i = puts
      return new Promise((res) => {
        release[i] = () => res(reply())
      })
    }
    if (method === 'GET' && url === '/api/conversations/c1/slot_config') return jsonResponse(CFG)
    throw new Error(`unhandled ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  fn.release = release
  return fn
}

// A button that switches the selected conversation, as the sidebar would.
function SwitchProbe({ conversation }) {
  const dispatch = useDispatch()
  return <button type="button" data-testid="probe-switch" onClick={() => dispatch({ type: 'conversation/loaded', conversation })} />
}

const putBodies = (fn) => fn.mock.calls.filter(([, init]) => init && init.method === 'PUT').map(([, init]) => JSON.parse(init.body))
const modelGets = (fn) => fn.mock.calls.filter(([url]) => url === '/api/models')

afterEach(() => vi.unstubAllGlobals())

describe('SlotConfigBar', () => {
  test('loads the model catalog on mount and is disabled without a conversation', async () => {
    const fetchFn = stubFetch()
    renderWithStore(<SlotConfigBar />)
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/models', expect.anything()))
    for (const id of ['config-analyst-model', 'config-max-iterations', 'config-materiality-min', 'config-grounded']) {
      expect(screen.getByTestId(id)).toBeDisabled()
    }
    expect(screen.getByTestId('config-hint')).toBeInTheDocument()
    // the catalog landed in the store: every model is an analyst option
    await waitFor(() => expect(screen.getByTestId('config-analyst-model').querySelectorAll('option').length).toBeGreaterThanOrEqual(MODELS.length))
  })

  test('does not refetch a catalog the store already holds (the Send pane loads the same one)', async () => {
    const fetchFn = stubFetch()
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels() } })
    await act(async () => {})
    expect(modelGets(fetchFn)).toHaveLength(0)
    expect(screen.getByTestId('config-analyst-model').querySelectorAll('option')).toHaveLength(MODELS.length)
  })

  test('mount survives a rejected catalog load (Node fetch / no backend)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to parse URL') }))
    renderWithStore(<SlotConfigBar />)
    await waitFor(() => expect(screen.getByTestId('config-models-error')).toBeInTheDocument())
    expect(screen.getByTestId('config-analyst-model')).toBeDisabled()
  })

  test('reflects the loaded slotConfig, listing an unknown configured analyst slug as an option', async () => {
    stubFetch({ models: [] })
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG } })
    await act(async () => {}) // let the mount-time catalog load settle
    const analyst = screen.getByTestId('config-analyst-model')
    expect(analyst).not.toBeDisabled()
    expect(analyst).toHaveValue('openai/gpt-5.6-luna')
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('2')
    expect(screen.getByTestId('config-materiality-min')).toHaveValue('medium')
    expect(screen.getByTestId('config-grounded')).not.toBeChecked()
    expect(screen.queryByTestId('config-hint')).toBeNull()
    expect(screen.getByText('Fusion iterations (default)')).toBeInTheDocument()
  })

  test('groups structured-outputs models first in the analyst picker, sorted by name; a flat list otherwise', async () => {
    const catalog = [
      { id: 'z/zeta', name: 'Zeta', vendor: 'z', structured_outputs: true },
      { id: 'o/other', name: 'Other', vendor: 'o', structured_outputs: false },
      { id: 'a/alpha', name: 'Alpha', vendor: 'a', structured_outputs: true },
      { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'openai', structured_outputs: true },
    ]
    stubFetch({ models: catalog })
    const { unmount } = renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels(catalog) } })
    await act(async () => {})
    const select = screen.getByTestId('config-analyst-model')
    const groups = select.querySelectorAll('optgroup')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveAttribute('label', expect.stringMatching(/structured outputs/))
    expect([...groups[0].querySelectorAll('option')].map((o) => o.value)).toEqual(['a/alpha', 'openai/gpt-5.6-luna', 'z/zeta'])
    expect([...groups[1].querySelectorAll('option')].map((o) => o.value)).toEqual(['o/other'])
    expect(select).toHaveValue('openai/gpt-5.6-luna')
    expect(within(groups[0]).getByText('Alpha (a/alpha)')).toBeInTheDocument()
    expect(analystGroups(catalog).other.map((m) => m.id)).toEqual(['o/other'])
    unmount()

    // no structured_outputs information at all: one flat, name-sorted list, no optgroups
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels() } })
    const flat = screen.getByTestId('config-analyst-model')
    expect(flat.querySelectorAll('optgroup')).toHaveLength(0)
    expect([...flat.querySelectorAll('option')].map((o) => o.value)).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5.6-luna', 'x-ai/grok-4.6'])
  })

  test('each control PUTs the merged full SlotConfig with its patch and updates the store', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels() } })

    await user.selectOptions(screen.getByTestId('config-analyst-model'), 'anthropic/claude-opus-5')
    await waitFor(() => expect(putBodies(fetchFn)).toHaveLength(1))
    expect(putBodies(fetchFn)[0]).toEqual({ ...CFG, analyst_model: 'anthropic/claude-opus-5' })
    expect(screen.getByTestId('config-analyst-model')).toHaveValue('anthropic/claude-opus-5')

    await user.selectOptions(screen.getByTestId('config-max-iterations'), '4')
    await waitFor(() => expect(putBodies(fetchFn)).toHaveLength(2))
    expect(putBodies(fetchFn)[1]).toMatchObject({ analyst_model: 'anthropic/claude-opus-5', max_iterations: 4 })
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('4')

    await user.click(screen.getByTestId('config-grounded'))
    await waitFor(() => expect(putBodies(fetchFn)).toHaveLength(3))
    expect(putBodies(fetchFn)[2]).toMatchObject({ max_iterations: 4, grounded: true })
    expect(screen.getByTestId('config-grounded')).toBeChecked()

    await user.selectOptions(screen.getByTestId('config-materiality-min'), 'high')
    await waitFor(() => expect(putBodies(fetchFn)).toHaveLength(4))
    expect(putBodies(fetchFn)[3]).toMatchObject({ grounded: true, materiality_min: 'high', slots: CFG.slots })
    expect(screen.getByTestId('config-materiality-min')).toHaveValue('high')
    expect(screen.queryByTestId('config-error')).toBeNull()
  })

  test('a slow earlier save cannot revert a later change: only the latest save lands in the store', async () => {
    const fetchFn = stubFetch({ deferPut: [1] })
    const user = userEvent.setup()
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels() } })

    await user.selectOptions(screen.getByTestId('config-max-iterations'), '4') // PUT #1 stays pending
    await user.click(screen.getByTestId('config-grounded')) // PUT #2 answers at once
    await waitFor(() => expect(putBodies(fetchFn)).toHaveLength(2))
    expect(putBodies(fetchFn)[1]).toMatchObject({ max_iterations: 4, grounded: true })
    expect(screen.getByTestId('config-grounded')).toBeChecked()
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('4')

    await act(async () => fetchFn.release[1]()) // PUT #1's copy {max_iterations: 4, grounded: false} arrives last
    await act(async () => {})
    expect(screen.getByTestId('config-grounded')).toBeChecked()
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('4')
    expect(screen.queryByTestId('config-error')).toBeNull()
  })

  test('a save response for a conversation that is no longer selected is dropped', async () => {
    const fetchFn = stubFetch({ deferPut: [1] })
    const user = userEvent.setup()
    const other = { ...CONV, id: 'c2', slot_config: { ...CFG, max_iterations: 5 } }
    renderWithStore(
      <>
        <SlotConfigBar />
        <SwitchProbe conversation={other} />
      </>,
      { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels() } },
    )
    await user.selectOptions(screen.getByTestId('config-max-iterations'), '3') // PUT for c1 pending
    await user.click(screen.getByTestId('probe-switch'))
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('5')
    await waitFor(() => expect(fetchFn.release[1]).toBeDefined())
    await act(async () => fetchFn.release[1]())
    await act(async () => {})
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('5')
  })

  test('the grounded toggle reads "Grounded (web search on Send)" and its title explains the extra cost (PLAN §8 Phase 5)', async () => {
    stubFetch()
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: loadedModels() } })
    await act(async () => {})
    expect(GROUNDED_LABEL).toBe('Grounded (web search on Send)')
    const label = screen.getByTestId('config-grounded-label')
    expect(label.tagName).toBe('LABEL')
    expect(label).toHaveTextContent('Grounded (web search on Send)')
    expect(within(label).getByTestId('config-grounded')).not.toBeChecked() // the text is the checkbox's label
    expect(label).toHaveAttribute('title', GROUNDED_TITLE)
    expect(GROUNDED_TITLE).toMatch(/web-search plugin/)
    expect(GROUNDED_TITLE).toMatch(/Costs extra/)
    expect(GROUNDED_TITLE).toMatch(/per-request search fee/)
    expect(GROUNDED_TITLE).toMatch(/prompt tokens/)
    expect(GROUNDED_TITLE).toMatch(/never to Analyze or Fusion/)
    // Clicking the label text toggles the box and PUTs grounded: true.
    const user = userEvent.setup()
    await user.click(screen.getByText('Grounded (web search on Send)'))
    await waitFor(() => expect(screen.getByTestId('config-grounded')).toBeChecked())
  })

  test('a rejected PUT shows the error code and reverts to the server copy', async () => {
    const fetchFn = stubFetch({ putStatus: 422 })
    const user = userEvent.setup()
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG } })
    await user.selectOptions(screen.getByTestId('config-max-iterations'), '5')
    await waitFor(() => expect(screen.getByTestId('config-error')).toHaveTextContent('unsupported_effort'))
    expect(fetchFn).toHaveBeenCalledWith('/api/conversations/c1/slot_config', expect.objectContaining({ method: 'GET' }))
    expect(screen.getByTestId('config-max-iterations')).toHaveValue('2')
  })
})
