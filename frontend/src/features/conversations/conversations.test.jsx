import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Sidebar, { fmtWhen } from './index.jsx'
import { renderWithStore } from '../../state/testing.jsx'

const CFG = {
  slots: { claude: { model: 'a', effort: 'medium' }, chatgpt: { model: 'b', effort: 'medium' }, grok: { model: 'c', effort: 'medium' } },
  analyst_model: 'x',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}
const ITEMS = [
  { id: 'c2', title: 'Second', created_at: '2026-09-07T10:00:00.000Z', updated_at: '2026-09-07T12:30:00.000Z', turn_count: 3 },
  { id: 'c1', title: 'First', created_at: '2026-09-06T10:00:00.000Z', updated_at: '2026-09-06T10:05:00.000Z', turn_count: 1 },
]
const conv = (id, title, extra = {}) => ({ id, title, created_at: '2026-09-07T10:00:00.000Z', updated_at: '2026-09-07T10:00:00.000Z', slot_config: CFG, threads: { claude: [], chatgpt: [], grok: [] }, turns: [], schema_version: 1, ...extra })

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function stubFetch(items = ITEMS) {
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    if (method === 'GET' && url === '/api/conversations') return jsonResponse(items)
    if (method === 'POST' && url === '/api/conversations') return jsonResponse(conv('c3', 'New conversation'), 201)
    if (method === 'DELETE' && url.startsWith('/api/conversations/')) return jsonResponse(null, 204)
    if (method === 'PATCH' && url.endsWith('/title')) return jsonResponse(conv(url.split('/')[3], body.title))
    if (method === 'GET' && url.startsWith('/api/conversations/')) {
      const id = url.split('/')[3]
      const it = items.find((c) => c.id === id)
      return it ? jsonResponse(conv(id, it.title)) : jsonResponse({ detail: { error: 'not_found', what: 'conversation' } }, 404)
    }
    throw new Error(`unhandled ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const calls = (fn, method) => fn.mock.calls.filter(([, init]) => (init && init.method ? init.method : 'GET') === method).map(([url, init]) => [url, init && init.body ? JSON.parse(init.body) : undefined])
const rows = () => screen.queryAllByTestId('conv-row')

afterEach(() => vi.unstubAllGlobals())

describe('Sidebar', () => {
  test('lists conversations on mount with title, updated_at and turn count', async () => {
    const fetchFn = stubFetch()
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(fetchFn).toHaveBeenCalledWith('/api/conversations', expect.anything())
    const [first, second] = rows()
    expect(first).toHaveAttribute('data-id', 'c2')
    expect(within(first).getByTestId('conv-title')).toHaveTextContent('Second')
    expect(within(first).getByTestId('conv-meta')).toHaveTextContent('3 turns')
    expect(within(first).getByTestId('conv-meta')).toHaveTextContent(fmtWhen('2026-09-07T12:30:00.000Z'))
    expect(within(second).getByTestId('conv-meta')).toHaveTextContent('1 turn')
    expect(screen.queryByTestId('conv-empty')).toBeNull()
    expect(rows().every((r) => r.getAttribute('data-selected') === 'false')).toBe(true)
  })

  test('shows the empty state when there are no conversations', async () => {
    stubFetch([])
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(screen.getByTestId('conv-empty')).toHaveTextContent(/no conversations yet/i))
    expect(screen.queryByTestId('conv-list')).toBeNull()
  })

  test('mount survives a rejected list load (Node fetch / no backend)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to parse URL') }))
    renderWithStore(<Sidebar />)
    expect(screen.getByTestId('conv-empty')).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('conv-error')).toBeNull()
  })

  test('clicking a row loads that conversation and marks it selected', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(within(rows()[1]).getByTestId('conv-select'))
    await waitFor(() => expect(rows()[1]).toHaveAttribute('data-selected', 'true'))
    expect(calls(fetchFn, 'GET').map(([u]) => u)).toContain('/api/conversations/c1')
    expect(rows()[1]).toHaveAttribute('aria-current', 'true')
    expect(rows()[0]).toHaveAttribute('data-selected', 'false')
  })

  test('the selected row renders state.conversation.title (the backend auto-titles on first Send)', async () => {
    stubFetch()
    renderWithStore(<Sidebar />, { preloaded: { conversations: ITEMS, conversation: conv('c1', 'What is the maximum gyroscope full-scale range') } })
    await act(async () => {}) // let the mount-time list load settle
    const row = rows()[1]
    expect(row).toHaveAttribute('data-selected', 'true')
    expect(within(row).getByTestId('conv-title')).toHaveTextContent('What is the maximum gyroscope full-scale range')
    expect(within(rows()[0]).getByTestId('conv-title')).toHaveTextContent('Second')
  })

  test('+ New conversation creates one, prepends it and selects it', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(screen.getByTestId('conv-new'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(calls(fetchFn, 'POST')).toEqual([['/api/conversations', {}]])
    expect(rows()[0]).toHaveAttribute('data-id', 'c3')
    expect(rows()[0]).toHaveAttribute('data-selected', 'true')
    expect(within(rows()[0]).getByTestId('conv-title')).toHaveTextContent('New conversation')
    expect(within(rows()[0]).getByTestId('conv-meta')).toHaveTextContent('0 turns')
  })

  test('rename inline: Enter PATCHes the title and the row updates; Escape cancels', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(within(rows()[0]).getByTestId('conv-rename'))
    const input = screen.getByTestId('conv-rename-input')
    expect(input).toHaveValue('Second')
    await user.clear(input)
    await user.type(input, 'Renamed title{Enter}')
    await waitFor(() => expect(within(rows()[0]).getByTestId('conv-title')).toHaveTextContent('Renamed title'))
    expect(calls(fetchFn, 'PATCH')).toEqual([['/api/conversations/c2/title', { title: 'Renamed title' }]])
    expect(screen.queryByTestId('conv-rename-input')).toBeNull()

    await user.click(within(rows()[0]).getByTestId('conv-rename'))
    await user.type(screen.getByTestId('conv-rename-input'), ' more{Escape}')
    expect(screen.queryByTestId('conv-rename-input')).toBeNull()
    expect(within(rows()[0]).getByTestId('conv-title')).toHaveTextContent('Renamed title')
    expect(calls(fetchFn, 'PATCH')).toHaveLength(1)
  })

  test('rename with an empty or unchanged title sends nothing', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(within(rows()[0]).getByTestId('conv-rename'))
    await user.type(screen.getByTestId('conv-rename-input'), '{Enter}')
    await user.click(within(rows()[0]).getByTestId('conv-rename'))
    await user.clear(screen.getByTestId('conv-rename-input'))
    await user.type(screen.getByTestId('conv-rename-input'), '   {Enter}')
    expect(calls(fetchFn, 'PATCH')).toHaveLength(0)
    expect(within(rows()[0]).getByTestId('conv-title')).toHaveTextContent('Second')
  })

  test('delete asks for confirmation, then DELETEs and removes the row; cancel keeps it', async () => {
    const fetchFn = stubFetch()
    const user = userEvent.setup()
    renderWithStore(<Sidebar />, { preloaded: { conversation: conv('c2', 'Second') } })
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(within(rows()[0]).getByTestId('conv-delete'))
    expect(within(rows()[0]).getByTestId('conv-delete-prompt')).toBeInTheDocument()
    await user.click(within(rows()[0]).getByTestId('conv-delete-cancel'))
    expect(screen.queryByTestId('conv-delete-prompt')).toBeNull()
    expect(calls(fetchFn, 'DELETE')).toHaveLength(0)

    await user.click(within(rows()[0]).getByTestId('conv-delete'))
    await user.click(within(rows()[0]).getByTestId('conv-delete-confirm'))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(calls(fetchFn, 'DELETE')).toEqual([['/api/conversations/c2', undefined]])
    expect(rows()[0]).toHaveAttribute('data-id', 'c1')
    // the deleted conversation was the selected one: nothing is selected any more
    expect(rows()[0]).toHaveAttribute('data-selected', 'false')
  })

  test('a failed loader shows an error line', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        if ((init.method || 'GET') === 'GET') return jsonResponse(ITEMS)
        return jsonResponse({ detail: { error: 'not_found', what: 'conversation' } }, 404)
      }),
    )
    renderWithStore(<Sidebar />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(within(rows()[0]).getByTestId('conv-delete'))
    await user.click(within(rows()[0]).getByTestId('conv-delete-confirm'))
    await waitFor(() => expect(screen.getByTestId('conv-error')).toHaveTextContent('not_found'))
    expect(rows()).toHaveLength(2)
  })
})

test('fmtWhen tolerates garbage', () => {
  expect(fmtWhen('')).toBe('')
  expect(fmtWhen('not a date')).toBe('not a date')
  expect(fmtWhen('2026-09-07T12:30:00.000Z')).not.toBe('')
})
