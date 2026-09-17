import { describe, expect, test } from 'vitest'
import { rectOf, rectsFor, sameLayout } from './rects.js'
import { RECTS } from './fakes.js'

const el = (rect) => ({ getBoundingClientRect: () => ({ ...rect, top: rect.y, left: rect.x }) })

describe('rectOf', () => {
  test('measures an element, accepts a DOMRect-like object and left/top aliases', () => {
    expect(rectOf(el(RECTS.claude))).toEqual(RECTS.claude)
    expect(rectOf({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(rectOf({ left: 1, top: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    // fractional CSS px pass through untouched: main rounds (contract §2)
    expect(rectOf({ x: 0.5, y: 39.25, width: 533.33, height: 600 })).toEqual({ x: 0.5, y: 39.25, width: 533.33, height: 600 })
  })

  test('null for missing, non-finite and zero-area rects', () => {
    expect(rectOf(null)).toBe(null)
    expect(rectOf(undefined)).toBe(null)
    expect(rectOf('rect')).toBe(null)
    expect(rectOf({ x: 0, y: 0, width: 0, height: 0 })).toBe(null)
    expect(rectOf({ x: 0, y: 0, width: 10, height: 0 })).toBe(null)
    expect(rectOf({ x: NaN, y: 0, width: 10, height: 10 })).toBe(null)
    expect(rectOf({ x: 0, y: 0, width: Infinity, height: 10 })).toBe(null)
    expect(rectOf({ getBoundingClientRect: () => null })).toBe(null)
  })
})

describe('rectsFor', () => {
  const viewports = { claude: el(RECTS.claude), chatgpt: el(RECTS.chatgpt), grok: el(RECTS.grok) }

  test('split → a rect for all three', () => {
    expect(rectsFor('split', 'chatgpt', viewports)).toEqual(RECTS)
  })

  test('tabs → one rect (the active slot) and null for the others, even though they measure', () => {
    expect(rectsFor('tabs', 'chatgpt', viewports)).toEqual({ claude: null, chatgpt: RECTS.chatgpt, grok: null })
    expect(rectsFor('tabs', 'grok', viewports)).toEqual({ claude: null, chatgpt: null, grok: RECTS.grok })
  })

  test('a hidden or missing viewport is null; the map always carries all three slots', () => {
    expect(rectsFor('split', 'chatgpt', { claude: el(RECTS.claude) })).toEqual({ claude: RECTS.claude, chatgpt: null, grok: null })
    expect(rectsFor('split', 'chatgpt', { ...viewports, grok: el({ x: 0, y: 0, width: 0, height: 0 }) })).toEqual({ claude: RECTS.claude, chatgpt: RECTS.chatgpt, grok: null })
    expect(rectsFor('split', 'chatgpt', null)).toEqual({ claude: null, chatgpt: null, grok: null })
  })

  test('tabs with an unknown active hides everything; an unknown mode shows everything measurable', () => {
    expect(rectsFor('tabs', 'gemini', viewports)).toEqual({ claude: null, chatgpt: null, grok: null })
    expect(rectsFor('stack', 'chatgpt', viewports)).toEqual(RECTS)
  })

  test('the map has no extra keys (main validates slot ∈ SLOTS)', () => {
    expect(Object.keys(rectsFor('split', 'chatgpt', { ...viewports, analyst: el(RECTS.claude) }))).toEqual(['claude', 'chatgpt', 'grok'])
  })
})

describe('sameLayout', () => {
  test('compares rects by value and nulls by position', () => {
    const a = rectsFor('split', 'chatgpt', { claude: RECTS.claude, chatgpt: RECTS.chatgpt, grok: RECTS.grok })
    const b = rectsFor('split', 'chatgpt', { claude: { ...RECTS.claude }, chatgpt: { ...RECTS.chatgpt }, grok: { ...RECTS.grok } })
    expect(sameLayout(a, b)).toBe(true)
    expect(sameLayout(a, { ...b, grok: null })).toBe(false)
    expect(sameLayout(a, { ...b, grok: { ...RECTS.grok, width: 501 } })).toBe(false)
    expect(sameLayout(a, null)).toBe(false)
    expect(sameLayout(null, null)).toBe(true)
  })
})
