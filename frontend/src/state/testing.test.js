import { beforeEach, expect, test } from 'vitest'
import { _resetRegistryForTests, registerSlice } from './registry.js'
import { applyEvents, sample } from './testing.jsx'

beforeEach(() => _resetRegistryForTests())

test('applyEvents wraps turn_start (which carries a feature field) as an sse action', () => {
  registerSlice('seen', (s = [], a) => (a.type === 'sse' ? [...s, a.event.type] : s), [])
  registerSlice('ended', (s = false, a) => (a.type === 'sse/end' ? true : s), false)
  const s = applyEvents('send', [sample.turnStart(), sample.slotDelta('claude', 'x'), { type: 'sse/end', feature: 'send', ok: true }])
  expect(s.seen).toEqual(['turn_start', 'slot_delta'])
  expect(s.ended).toBe(true)
})
