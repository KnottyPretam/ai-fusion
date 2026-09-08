import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SlotConfigBar from './index.jsx'
import { renderWithStore } from '../../state/testing.jsx'

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

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// Route fetch by method + path; PUT echoes the merged config back like the backend does.
function stubFetch({ models = MODELS, putStatus = 200 } = {}) {
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    if (method === 'GET' && url === '/api/models') return jsonResponse(models)
    if (method === 'PUT' && url === '/api/conversations/c1/slot_config') return putStatus === 200 ? jsonResponse(body) : jsonResponse({ detail: { error: 'unsupported_effort' } }, putStatus)
    if (method === 'GET' && url === '/api/conversations/c1/slot_config') return jsonResponse(CFG)
    throw new Error(`unhandled ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const putBodies = (fn) => fn.mock.calls.filter(([, init]) => init && init.method === 'PUT').map(([, init]) => JSON.parse(init.body))

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
  })

  test('each control PUTs the merged full SlotConfig with its patch and updates the store', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<SlotConfigBar />, { preloaded: { conversation: CONV, slotConfig: CFG, models: { items: MODELS, byId: Object.fromEntries(MODELS.map((m) => [m.id, m])), loaded: true, error: null } } })

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
