// rects.js (renderer-desktop, Stage 1) — pure layout derivation for `triplex.setLayout`.
//
// The site pages are native Electron `WebContentsView`s, not DOM: the renderer only renders a
// placeholder `pane-<slot>-viewport` div per pane and reports where it is. Main applies the map
// with `normalizeLayout` (round, clamp ≥ 1, null → hidden). Rects are CSS px relative to the
// window (getBoundingClientRect; the desk layout never scrolls, so viewport == window).
// Stage 3: the hidden analyst page is a fourth view under the layout key 'analyst' (contract §2);
// `rectsFor` emits that key only when the caller passes an `analyst` option (the analyst pane is
// mounted), so a layout without it is byte-identical to Stage 1/2 and main (whose normalizeLayout
// treats an absent key as hidden) hides the view.
import { SLOT_IDS, isSlotId } from './slice.js'

/** Every key a layout may carry (main's LAYOUT_KEYS): the three panes plus the analyst view. */
export const LAYOUT_KEYS = [...SLOT_IDS, 'analyst']

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
 * rectsFor(mode, active, viewports, options?) → `{claude: rect|null, chatgpt: rect|null, grok: rect|null}`.
 *   viewports — `{slot: Element | DOMRect-like | null}`; a missing slot is hidden (an `analyst`
 *               entry in this map is ignored: the analyst is only reported through `options`).
 *   'tabs'    — only `active` is visible; every other slot is null even when it measures.
 *   'split'   — every slot with a measurable viewport is visible.
 *   options.analyst (S3) — the analyst viewport (Element | DOMRect-like | null); when the option is
 *               present the map gains `analyst: rect|null`, shown in both modes (the analyst pane
 *               is an extra pane, not a slot); when absent the key is omitted (= hidden for main).
 * Unknown modes are treated as 'split' (everything measurable is shown) so a corrupt persisted
 * value never hides all three views.
 */
export function rectsFor(mode, active, viewports, options) {
  const views = viewports && typeof viewports === 'object' ? viewports : {}
  const tabs = mode === 'tabs'
  const shown = tabs && isSlotId(active) ? active : null
  const out = {}
  for (const slot of SLOT_IDS) {
    out[slot] = tabs && slot !== shown ? null : rectOf(views[slot])
  }
  if (options && typeof options === 'object' && 'analyst' in options) out.analyst = rectOf(options.analyst)
  return out
}

/**
 * True when two layout maps describe the same rects (used to skip redundant setLayout calls). An
 * absent `analyst` key equals `null` (both mean hidden to main).
 */
export function sameLayout(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  for (const key of LAYOUT_KEYS) {
    const p = a[key] ?? null
    const q = b[key] ?? null
    if (p === q) continue
    if (!p || !q) return false
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) return false
  }
  return true
}
