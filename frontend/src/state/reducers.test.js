import { describe, expect, test } from 'vitest'
import { initialState, rootReducer } from './registry.js'
import './reducers.js'
import { deepMerge } from './reducers.js'

const conv = { id: 'c1', title: 'T', slot_config: { slots: { claude: { model: 'a', effort: 'high' } }, analyst_model: 'x', max_iterations: 2 }, threads: {}, turns: [] }

describe('core slices', () => {
  test('conversation/loaded fills conversation and slotConfig', () => {
    const s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conv })
    expect(s.conversation.id).toBe('c1')
    expect(s.slotConfig.slots.claude.effort).toBe('high')
  })
  test('slotConfig/update deep-merges a patch', () => {
    let s = rootReducer(initialState(), { type: 'conversation/loaded', conversation: conv })
    s = rootReducer(s, { type: 'slotConfig/update', patch: { slots: { claude: { effort: 'low' } }, grounded: true } })
    expect(s.slotConfig.slots.claude).toEqual({ model: 'a', effort: 'low' })
    expect(s.slotConfig.grounded).toBe(true)
    expect(s.slotConfig.analyst_model).toBe('x')
  })
  test('conversations list / create / rename / delete', () => {
    let s = rootReducer(initialState(), { type: 'conversations/list', items: [{ id: 'c1', title: 'T' }] })
    s = rootReducer(s, { type: 'conversation/created', summary: { id: 'c2', title: 'New' } })
    expect(s.conversations.map((c) => c.id)).toEqual(['c2', 'c1'])
    s = rootReducer(s, { type: 'conversation/renamed', id: 'c2', title: 'Renamed' })
    expect(s.conversations[0].title).toBe('Renamed')
    s = rootReducer(s, { type: 'conversation/deleted', id: 'c1' })
    expect(s.conversations.map((c) => c.id)).toEqual(['c2'])
  })
  test('models/loaded indexes by id', () => {
    const s = rootReducer(initialState(), { type: 'models/loaded', items: [{ id: 'm1' }, { id: 'm2' }] })
    expect(s.models.byId.m2).toEqual({ id: 'm2' })
    expect(s.models.loaded).toBe(true)
  })
  test('streams slice tracks per-feature status and terminal error events', () => {
    let s = rootReducer(initialState(), { type: 'sse/start', feature: 'send' })
    expect(s.streams.send.status).toBe('streaming')
    expect(s.streams.analyze.status).toBe('idle')
    s = rootReducer(s, { type: 'sse', feature: 'send', event: { type: 'error', message: 'nope' } })
    expect(s.streams.send).toMatchObject({ status: 'error', error: 'nope' })
    s = rootReducer(s, { type: 'sse/start', feature: 'analyze' })
    s = rootReducer(s, { type: 'sse/end', feature: 'analyze', ok: true })
    expect(s.streams.analyze.status).toBe('done')
  })
  test('deepMerge does not touch arrays or siblings', () => {
    expect(deepMerge({ a: { b: 1, c: [1] }, d: 2 }, { a: { b: 3 } })).toEqual({ a: { b: 3, c: [1] }, d: 2 })
  })
})
