// The placement rules. Pure: no DOM, no React.
import { describe, expect, test } from 'vitest'
import { PLACEMENTS, blockedRects, choosePlacement, intersects, penalty, placeAt } from './tooltipPlacement.js'

const WIN = { width: 1000, height: 800 }
const SIZE = { width: 200, height: 40 }
/** A DOMRect-ish box. */
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })

describe('placeAt', () => {
  const trigger = box(400, 300, 60, 20)

  test('each side sits outside the trigger by the gap and is centred on it', () => {
    expect(placeAt('bottom', trigger, SIZE, WIN).top).toBe(326)
    expect(placeAt('top', trigger, SIZE, WIN).bottom).toBe(294)
    expect(placeAt('right', trigger, SIZE, WIN).left).toBe(466)
    expect(placeAt('left', trigger, SIZE, WIN).right).toBe(394)
    expect(placeAt('bottom', trigger, SIZE, WIN).left).toBe(330) // 400 + 30 - 100
  })

  test('a bubble wider than the space it is centred in is clamped inside the window, never off it', () => {
    const atEdge = box(970, 300, 20, 20)
    const r = placeAt('bottom', atEdge, SIZE, WIN)
    expect(r.right).toBeLessThanOrEqual(WIN.width)
    expect(r.left).toBeGreaterThanOrEqual(0)
  })
})

describe('choosePlacement', () => {
  test('below by default: a tooltip reads best under its control', () => {
    expect(choosePlacement(box(400, 300, 60, 20), SIZE, { win: WIN }).placement).toBe('bottom')
  })

  test('a native site view below the trigger pushes it above', () => {
    // The shape of the desktop shell: a pane header at the top, its viewport filling the rest.
    const viewport = box(0, 40, 1000, 700)
    const headerButton = box(400, 10, 60, 20)
    const { placement, rect, blockedBy } = choosePlacement(headerButton, SIZE, { win: WIN, blocked: [viewport] })
    expect(placement).toBe('top')
    expect(blockedBy).toBe(null)
    expect(intersects(rect, viewport)).toBe(false)
  })

  test('a view ABOVE the trigger (a prompt-bar button) leaves it below', () => {
    const viewport = box(0, 0, 1000, 700)
    const promptButton = box(400, 720, 60, 20)
    const { placement, rect } = choosePlacement(promptButton, SIZE, { win: WIN, blocked: [viewport] })
    expect(placement).toBe('bottom')
    expect(intersects(rect, viewport)).toBe(false)
  })

  test('views above and below, with room beside: it goes to a side, clear of both', () => {
    const above = box(0, 0, 1000, 300)
    const below = box(0, 400, 1000, 400)
    const trigger = box(400, 340, 60, 20) // in the strip between them
    const { placement, rect } = choosePlacement(trigger, SIZE, { win: WIN, blocked: [above, below] })
    expect(['right', 'left']).toContain(placement)
    expect(intersects(rect, above) || intersects(rect, below)).toBe(false)
  })

  test('a gap too short for the bubble has no clean answer, and it says so', () => {
    // A side placement is centred on the trigger, it is not squeezed into the free strip: 40 px of
    // bubble cannot fit a 30 px gap, so every candidate covers something. The caller gets the
    // least-bad box and `blockedBy`, rather than a placement that pretends to be clear.
    const above = box(0, 0, 1000, 300)
    const below = box(0, 330, 1000, 470)
    const { rect, blockedBy } = choosePlacement(box(400, 305, 60, 20), SIZE, { win: WIN, blocked: [above, below] })
    expect(blockedBy).not.toBe(null)
    expect(rect.height).toBe(SIZE.height)
  })

  test('with nowhere clean it still returns the least-covered spot and names what it hit', () => {
    const everywhere = box(0, 0, 1000, 800)
    const { rect, blockedBy } = choosePlacement(box(400, 300, 60, 20), SIZE, { win: WIN, blocked: [everywhere] })
    expect(blockedBy).toEqual(everywhere)
    expect(rect.width).toBe(SIZE.width) // a real box, not null: something is better than nothing
  })

  test('covering a view costs far more than overflowing the window edge', () => {
    const view = box(0, 0, 1000, 400)
    const overflowing = box(-20, 500, 200, 40)
    const covering = box(100, 100, 200, 40)
    expect(penalty(covering, [view], WIN)).toBeGreaterThan(penalty(overflowing, [view], WIN))
  })

  test('the order tried is below, above, right, left', () => {
    expect([...PLACEMENTS]).toEqual(['bottom', 'top', 'right', 'left'])
  })

  test('touching edges do not count as an intersection', () => {
    expect(intersects(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(false)
    expect(intersects(box(0, 0, 10, 10), box(9, 0, 10, 10))).toBe(true)
  })
})

describe('blockedRects', () => {
  const fakeDoc = (rects) => ({
    querySelectorAll: () => rects.map((r) => ({ getBoundingClientRect: () => r })),
  })

  test('reads every *-viewport placeholder and drops the collapsed ones', () => {
    const doc = fakeDoc([box(0, 40, 300, 600), box(0, 0, 0, 0), box(310, 40, 300, 600)])
    expect(blockedRects(doc).map((r) => r.left)).toEqual([0, 310])
  })

  test('no document at all is no blockers, not a crash', () => {
    expect(blockedRects(null)).toEqual([])
    expect(blockedRects({})).toEqual([])
  })
})
