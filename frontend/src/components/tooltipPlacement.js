// frontend/src/components/tooltipPlacement.js — where a tooltip bubble may go. Pure, so it is
// tested without a DOM.
//
// The hard constraint is not the window edge, it is the three site pages. In the desktop shell the
// panes are native `WebContentsView`s that Electron positions OVER the renderer from the placeholder
// rects the shell reports (desktop-contract §2): nothing the renderer paints inside a viewport rect
// is visible, it is simply behind the site. A tooltip is the first floating thing this app has, so
// it is the first thing that can land there — a bubble under a pane-header button, or above a
// prompt-bar button, would just disappear. So every candidate placement is tested against those
// rects and the first clean one wins.

/** Gap between the trigger and the bubble, and the margin kept from the window edges. */
export const TOOLTIP_GAP = 6
export const WINDOW_MARGIN = 4

/** The placements tried, in order: below first (a tooltip reads best under its control). */
export const PLACEMENTS = Object.freeze(['bottom', 'top', 'right', 'left'])

function rect(x, y, width, height) {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }
}

/** Clamp `value` into [min, max]; when the span is inverted, `min` wins (the window is too small). */
function clamp(value, min, max) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** The bubble rect for one placement, clamped to the window. */
export function placeAt(placement, trigger, size, win, { gap = TOOLTIP_GAP, margin = WINDOW_MARGIN } = {}) {
  const { width: w, height: h } = size
  const maxX = win.width - w - margin
  const maxY = win.height - h - margin
  const midX = trigger.left + trigger.width / 2 - w / 2
  const midY = trigger.top + trigger.height / 2 - h / 2
  if (placement === 'top') return rect(clamp(midX, margin, maxX), trigger.top - gap - h, w, h)
  if (placement === 'right') return rect(trigger.right + gap, clamp(midY, margin, maxY), w, h)
  if (placement === 'left') return rect(trigger.left - gap - w, clamp(midY, margin, maxY), w, h)
  return rect(clamp(midX, margin, maxX), trigger.bottom + gap, w, h) // bottom
}

/** Do two rects share any area? Touching edges do not count. */
export function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** How much of `a` lies outside the window, plus every blocked rect it covers — smaller is better. */
export function penalty(candidate, blocked, win, { margin = WINDOW_MARGIN } = {}) {
  let out = 0
  out += Math.max(0, margin - candidate.left)
  out += Math.max(0, margin - candidate.top)
  out += Math.max(0, candidate.right - (win.width - margin))
  out += Math.max(0, candidate.bottom - (win.height - margin))
  let covered = 0
  for (const b of blocked) {
    const w = Math.min(candidate.right, b.right) - Math.max(candidate.left, b.left)
    const h = Math.min(candidate.bottom, b.bottom) - Math.max(candidate.top, b.top)
    if (w > 0 && h > 0) covered += w * h
  }
  // A native view hides the bubble completely, an overflowing edge only crops it: weigh the first
  // far heavier, but keep it finite so a bubble with nowhere clean to go still gets the best spot.
  return out + covered * 1000
}

/**
 * choosePlacement(trigger, size, {blocked, win, order}) → {placement, rect, blockedBy}
 *
 * The first placement that is fully inside the window and clear of every blocked rect; when none
 * is, the least bad one, with `blockedBy` telling the caller it had to settle.
 */
export function choosePlacement(trigger, size, { blocked = [], win, order = PLACEMENTS, gap = TOOLTIP_GAP, margin = WINDOW_MARGIN } = {}) {
  const area = win || { width: 0, height: 0 }
  let best = null
  for (const placement of order) {
    const candidate = placeAt(placement, trigger, size, area, { gap, margin })
    const score = penalty(candidate, blocked, area, { margin })
    if (score === 0) return { placement, rect: candidate, blockedBy: null }
    if (!best || score < best.score) best = { placement, rect: candidate, score }
  }
  if (!best) return { placement: order[0] || 'bottom', rect: placeAt('bottom', trigger, size, area, { gap, margin }), blockedBy: null }
  const hit = blocked.find((b) => intersects(best.rect, b)) || null
  return { placement: best.placement, rect: best.rect, blockedBy: hit }
}

/**
 * The rects a tooltip must not land on: every pane viewport placeholder, which is exactly where
 * main has put a site view. `[data-testid$="-viewport"]` is the contract's name for them
 * (`pane-<slot>-viewport`, `pane-analyst-viewport`); a hidden one reports a zero box and is dropped.
 */
export function blockedRects(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return []
  const out = []
  for (const el of doc.querySelectorAll('[data-testid$="-viewport"]')) {
    if (typeof el.getBoundingClientRect !== 'function') continue
    const r = el.getBoundingClientRect()
    if (!r || r.width < 1 || r.height < 1) continue
    out.push(rect(r.left, r.top, r.width, r.height))
  }
  return out
}
