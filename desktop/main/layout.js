// desktop/main/layout.js — renderer placeholder rects → view bounds (contract §2 'panes:layout').
// Pure module: no electron import, no I/O.
//
// The renderer reports `{[slot|'analyst']: {x, y, width, height} | null}` in CSS px (= DIP at zoom
// factor 1). Main rounds every coordinate, clamps width/height to ≥ 1 and treats `null` (or a
// missing / malformed rect) as "hidden".

import { SLOTS } from './sites.js'

/** Every key a layout may carry: the three panes plus the Stage 3 analyst view. */
export const LAYOUT_KEYS = Object.freeze([...SLOTS, 'analyst'])

const RECT_KEYS = ['x', 'y', 'width', 'height']

function roundCoord(n) {
  const r = Math.round(n)
  return r === 0 ? 0 : r // never -0
}

/** One rect: rounded, width/height ≥ 1; `null` for null/undefined/non-object/non-finite input. */
export function normalizeRect(rect) {
  if (rect === null || rect === undefined || typeof rect !== 'object' || Array.isArray(rect)) return null
  const nums = RECT_KEYS.map((k) => (typeof rect[k] === 'number' ? rect[k] : Number(rect[k])))
  if (!nums.every((n) => Number.isFinite(n))) return null
  const [x, y, w, h] = nums.map(roundCoord)
  return { x, y, width: Math.max(1, w), height: Math.max(1, h) }
}

/**
 * normalizeLayout(layout) → `{claude, chatgpt, grok, analyst}` where every value is a normalized
 * rect or `null` (hidden). Keys absent from the input are hidden; unknown keys are dropped; a
 * non-object input hides everything.
 */
export function normalizeLayout(layout) {
  const out = {}
  for (const key of LAYOUT_KEYS) out[key] = null
  if (layout === null || layout === undefined || typeof layout !== 'object' || Array.isArray(layout)) return out
  for (const key of LAYOUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(layout, key)) out[key] = normalizeRect(layout[key])
  }
  return out
}

/**
 * Apply a normalized layout to a `{[key]: view}` map of View-like objects (`setBounds(rect)`,
 * `setVisible(bool)`): a rect sets the bounds and shows the view, `null` hides it. Keys without a
 * view are skipped. Returns the list of keys touched.
 */
export function applyLayout(views, normalized) {
  const touched = []
  if (!views || !normalized) return touched
  for (const key of LAYOUT_KEYS) {
    const view = views[key]
    if (!view) continue
    const rect = normalized[key]
    if (rect) {
      view.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      view.setVisible(true)
    } else {
      view.setVisible(false)
    }
    touched.push(key)
  }
  return touched
}
