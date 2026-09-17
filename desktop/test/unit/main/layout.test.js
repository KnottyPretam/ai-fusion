// layout.js — normalizeLayout (rounding, null = hidden, min 1) and applyLayout with fake views.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLayout, normalizeRect, applyLayout, LAYOUT_KEYS } from '../../../main/layout.js'
import { fakeView } from './_fakes.js'

test('LAYOUT_KEYS = the three slots plus analyst', () => {
  assert.deepEqual([...LAYOUT_KEYS], ['claude', 'chatgpt', 'grok', 'analyst'])
})

test('normalizeLayout rounds every coordinate', () => {
  const out = normalizeLayout({ claude: { x: 10.4, y: 20.6, width: 300.5, height: 199.49 } })
  assert.deepEqual(out.claude, { x: 10, y: 21, width: 301, height: 199 })
})

test('normalizeLayout clamps width and height to at least 1', () => {
  const out = normalizeLayout({ chatgpt: { x: 0, y: 0, width: 0, height: -5 }, grok: { x: 1, y: 1, width: 0.2, height: 0.4 } })
  assert.deepEqual(out.chatgpt, { x: 0, y: 0, width: 1, height: 1 })
  assert.deepEqual(out.grok, { x: 1, y: 1, width: 1, height: 1 })
})

test('normalizeLayout: null, missing and malformed rects are hidden (null)', () => {
  const out = normalizeLayout({ claude: null, chatgpt: { x: 1, y: 2, width: 3, height: 4 }, grok: { x: 'a', y: 0, width: 1, height: 1 } })
  assert.equal(out.claude, null)
  assert.deepEqual(out.chatgpt, { x: 1, y: 2, width: 3, height: 4 })
  assert.equal(out.grok, null)
  assert.equal(out.analyst, null)
  assert.deepEqual(Object.keys(out), ['claude', 'chatgpt', 'grok', 'analyst'])
})

test('normalizeLayout drops unknown keys and hides everything for a non-object', () => {
  const out = normalizeLayout({ evil: { x: 0, y: 0, width: 9, height: 9 }, claude: { x: 0, y: 0, width: 9, height: 9 } })
  assert.equal('evil' in out, false)
  assert.deepEqual(out.claude, { x: 0, y: 0, width: 9, height: 9 })
  for (const bad of [null, undefined, 'x', 42, [1, 2]]) {
    const hidden = normalizeLayout(bad)
    for (const key of LAYOUT_KEYS) assert.equal(hidden[key], null, `${String(bad)} → ${key} hidden`)
  }
})

test('normalizeRect never returns -0 and rejects non-finite numbers', () => {
  const r = normalizeRect({ x: -0.2, y: -0.4, width: 5, height: 5 })
  assert.equal(Object.is(r.x, -0), false)
  assert.equal(Object.is(r.y, -0), false)
  assert.equal(normalizeRect({ x: Infinity, y: 0, width: 1, height: 1 }), null)
  assert.equal(normalizeRect({ x: 0, y: NaN, width: 1, height: 1 }), null)
  assert.equal(normalizeRect([0, 0, 1, 1]), null)
})

test('applyLayout sets bounds + shows for rects, hides for null, skips missing views', () => {
  const views = { claude: fakeView(), chatgpt: fakeView() }
  const touched = applyLayout(views, normalizeLayout({ claude: { x: 1, y: 2, width: 30, height: 40 }, chatgpt: null, grok: { x: 0, y: 0, width: 1, height: 1 } }))
  assert.deepEqual(touched, ['claude', 'chatgpt'])
  assert.deepEqual(views.claude.bounds, { x: 1, y: 2, width: 30, height: 40 })
  assert.equal(views.claude.visible, true)
  assert.equal(views.chatgpt.visible, false)
  assert.equal(views.chatgpt.bounds, null)
})
