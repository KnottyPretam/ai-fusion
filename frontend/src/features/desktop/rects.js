// rects.js (renderer-desktop, Stage 1) — pure layout derivation for `triplex.setLayout`.
//
// The site pages are native Electron `WebContentsView`s, not DOM: the renderer only renders a
// placeholder `pane-<slot>-viewport` div per pane and reports where it is. Main applies the map
// with `normalizeLayout` (round, clamp ≥ 1, null → hidden). Rects are CSS px relative to the
// window (getBoundingClientRect; the desk layout never scrolls, so viewport == window).
import { SLOT_IDS, isSlotId } from './slice.js'

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Normalise one measurement into `{x, y, width, height}` or null.
 * Accepts an Element (measured with getBoundingClientRect), a DOMRect-like object
 * (`{x|left, y|top, width, height}`), or null/undefined. A zero-area rect is null: a viewport
 * with no area (display:none, collapsed) must hide its view, not pin a 1×1 one.
 */
export function rectOf(target) {
  if (!target || typeof target !== 'object') return null
  const r = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : target
  if (!r || typeof r !== 'object') return null
  const x = num(r.x) ?? num(r.left)
  const y = num(r.y) ?? num(r.top)
  const width = num(r.width)
  const height = num(r.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * rectsFor(mode, active, viewports) → `{claude: rect|null, chatgpt: rect|null, grok: rect|null}`.
 *   viewports — `{slot: Element | DOMRect-like | null}`; a missing slot is hidden.
 *   'tabs'    — only `active` is visible; every other slot is null even when it measures.
 *   'split'   — every slot with a measurable viewport is visible.
 * Unknown modes are treated as 'split' (everything measurable is shown) so a corrupt persisted
 * value never hides all three views.
 */
export function rectsFor(mode, active, viewports) {
  const views = viewports && typeof viewports === 'object' ? viewports : {}
  const tabs = mode === 'tabs'
  const shown = tabs && isSlotId(active) ? active : null
  const out = {}
  for (const slot of SLOT_IDS) {
    out[slot] = tabs && slot !== shown ? null : rectOf(views[slot])
  }
  return out
}

/** True when two layout maps describe the same rects (used to skip redundant setLayout calls). */
export function sameLayout(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  for (const slot of SLOT_IDS) {
    const p = a[slot]
    const q = b[slot]
    if (p === q) continue
    if (!p || !q) return false
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) return false
  }
  return true
}
