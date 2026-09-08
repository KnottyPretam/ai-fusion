import { beforeEach, describe, expect, test } from 'vitest'
import { _resetRegistryForTests, initialState, registerSlice, rootReducer, sliceKeys } from './registry.js'

beforeEach(() => _resetRegistryForTests())

describe('registry', () => {
  test('every slice sees every action; untouched slices keep identity', () => {
    registerSlice('slots', (s = { claude: '', grok: '' }, a) => (a.type === 'sse' && a.event.type === 'slot_delta' ? { ...s, [a.event.slot]: s[a.event.slot] + a.event.text } : s), { claude: '', grok: '' })
    registerSlice('meter', (s = { seen: 0 }, a) => (a.type === 'sse' ? { seen: s.seen + 1 } : s), { seen: 0 })
    registerSlice('other', (s = { untouched: true }) => s, { untouched: true })
    const s0 = initialState()
    const s1 = rootReducer(s0, { type: 'sse', feature: 'send', event: { type: 'slot_delta', slot: 'grok', text: 'x' } })
    expect(s1.slots).toEqual({ claude: '', grok: 'x' })
    expect(s1.meter.seen).toBe(1)
    expect(s1.other).toBe(s0.other) // identity preserved
    const s2 = rootReducer(s1, { type: 'noop' })
    expect(s2).toBe(s1) // nothing changed -> same root object
  })

  test('late registration is initialised on the next action', () => {
    registerSlice('a', (s = 1) => s, 1)
    const s0 = initialState()
    registerSlice('b', (s = 'init') => s, () => 'init')
    const s1 = rootReducer(s0, { type: '@@slice/registered' })
    expect(s1.b).toBe('init')
    expect(sliceKeys()).toEqual(['a', 'b'])
  })

  test('function initial state is called fresh each time', () => {
    registerSlice('f', (s) => s, () => ({ n: 0 }))
    const a = initialState()
    const b = initialState()
    expect(a.f).not.toBe(b.f)
  })
})
