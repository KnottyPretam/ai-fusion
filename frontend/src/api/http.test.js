import { afterEach, describe, expect, test, vi } from 'vitest'
import { deleteConversation, loadConversation, loadModels, saveSlotConfig } from './http.js'

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
afterEach(() => vi.unstubAllGlobals())

describe('loaders', () => {
  test('loadModels shares one in-flight request between concurrent callers', async () => {
    let resolve
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (resolve = r))))
    const actions = []
    const p1 = loadModels((a) => actions.push(a))
    const p2 = loadModels((a) => actions.push(a))
    expect(fetch).toHaveBeenCalledTimes(1)
    resolve(json([{ id: 'm1' }]))
    await Promise.all([p1, p2])
    expect(actions.filter((a) => a.type === 'models/loaded')).toHaveLength(1)
    // a later call after settle fetches again
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'm2' }])))
    await loadModels(() => {})
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('deleteConversation clears the store when the selected conversation is deleted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json: async () => null })))
    const actions = []
    await deleteConversation((a) => actions.push(a), 'c1', { selected: 'c1' })
    expect(actions.map((a) => a.type)).toEqual(['conversation/deleted', 'conversation/cleared'])
    actions.length = 0
    await deleteConversation((a) => actions.push(a), 'c2', { selected: 'c1' })
    expect(actions.map((a) => a.type)).toEqual(['conversation/deleted'])
  })

  test('loadConversation and saveSlotConfig drop stale responses via isCurrent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'c1', slot_config: { slots: {} } })))
    const actions = []
    await loadConversation((a) => actions.push(a), 'c1', { isCurrent: () => false })
    expect(actions).toEqual([])
    await loadConversation((a) => actions.push(a), 'c1', { isCurrent: (c) => c.id === 'c1' })
    expect(actions.map((a) => a.type)).toEqual(['conversation/loaded'])
    actions.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => json({ slots: {}, grounded: true })))
    await saveSlotConfig((a) => actions.push(a), 'c1', { grounded: true }, { slots: {} }, { isCurrent: () => false })
    expect(actions.map((a) => a.type)).toEqual(['slotConfig/update'])
  })
})
