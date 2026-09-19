// frontend/src/components/TooltipLayer.jsx — one delegated tooltip for the whole app.
//
// Mounted once (main.jsx, beside the root). It listens on the document rather than wrapping each
// control, so every button that already carries a `title` gets a readable, themed bubble after a
// beat, and a new control gets one by describing itself the same way. `data-tip` wins over `title`
// when a control wants a longer description than the native tooltip should carry.
//
// Three things it has to get right:
//   1. ONE tooltip. While a trigger is armed its `title` is taken off the element (and put back the
//      moment the tooltip hides, on unmount, and even if the element leaves the DOM first), because
//      the only way to stop the browser drawing its own tooltip on top of ours is to not have one.
//   2. The site pages. The three panes are native views painted OVER the renderer, so a bubble that
//      lands inside a viewport rect is invisible. `choosePlacement` tries below, above, right, left
//      and takes the first that is clear of them (tooltipPlacement.js).
//   3. Not lying to a screen reader. The title it removes comes back as `aria-describedby` pointing
//      at the bubble, which is what a description is supposed to be anyway.
//
// Keyboard focus arms it too (same delay), so the descriptions are reachable without a mouse.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { blockedRects, choosePlacement } from './tooltipPlacement.js'
import css from './tooltip.module.css'

/** How long a pointer has to rest on a control before its description appears. */
export const TOOLTIP_DELAY_MS = 1000
/** Focus arms the same description; a shorter beat, because focus is deliberate. */
export const TOOLTIP_FOCUS_DELAY_MS = 400
export const TOOLTIP_ID = 'app-tooltip'
/** What a description may be read from, in order. */
export const TIP_ATTRS = Object.freeze(['data-tip', 'title'])
/** Marks a subtree that never wants a tooltip (the bubble itself). */
export const TIP_OPT_OUT = 'data-no-tip'

/** The nearest ancestor of `node` that has a description, or null. */
export function tipTargetOf(node) {
  if (!node || typeof node.closest !== 'function') return null
  const el = node.closest(`[${TIP_ATTRS.join('], [')}]`)
  if (!el) return null
  if (el.closest(`[${TIP_OPT_OUT}]`)) return null
  return el
}

/** The description text on `el` — `data-tip` first, then `title` — trimmed, or '' when there is none. */
export function tipTextOf(el, taken = null) {
  if (!el) return ''
  const explicit = typeof el.getAttribute === 'function' ? el.getAttribute('data-tip') : null
  if (explicit && explicit.trim()) return explicit.trim()
  const stashed = taken && taken.get(el)
  const title = typeof stashed === 'string' ? stashed : typeof el.getAttribute === 'function' ? el.getAttribute('title') : null
  return title && title.trim() ? title.trim() : ''
}

export default function TooltipLayer({
  delayMs = TOOLTIP_DELAY_MS,
  focusDelayMs = TOOLTIP_FOCUS_DELAY_MS,
  doc = typeof document === 'undefined' ? null : document,
  win = typeof window === 'undefined' ? null : window,
}) {
  // {el, text} while armed or shown; `placed` is the fixed position once it has been measured.
  const [tip, setTip] = useState(null)
  const [placed, setPlaced] = useState(null)
  const bubbleRef = useRef(null)
  const timerRef = useRef(null)
  // The `title`s currently taken off their elements, so every one of them is put back.
  const takenRef = useRef(new WeakMap())
  const armedRef = useRef(null)
  // The element whose timer is running. Without it, `pointerover` firing again for a child of the
  // same button would restart the delay, and a tooltip over an icon+label button would never appear.
  const pendingRef = useRef(null)

  /** Give an element its `title` back (idempotent). */
  const restore = useCallback((el) => {
    const taken = takenRef.current
    if (!el || !taken.has(el)) return
    const text = taken.get(el)
    taken.delete(el)
    try {
      if (typeof el.setAttribute === 'function' && typeof text === 'string') el.setAttribute('title', text)
      if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-describedby')
    } catch (_e) {
      /* the element is gone; nothing to restore it to */
    }
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    const el = armedRef.current
    armedRef.current = null
    if (el) restore(el)
    setTip(null)
    setPlaced(null)
  }, [restore])

  const show = useCallback(
    (el, text) => {
      armedRef.current = el
      // Take the native tooltip out of the way, once, remembering what it said.
      const taken = takenRef.current
      if (!taken.has(el) && typeof el.getAttribute === 'function' && el.getAttribute('title') !== null) {
        taken.set(el, el.getAttribute('title'))
        try {
          el.removeAttribute('title')
          el.setAttribute('aria-describedby', TOOLTIP_ID)
        } catch (_e) {
          /* ignore: a detached node */
        }
      }
      setPlaced(null)
      setTip({ el, text })
    },
    [],
  )

  const arm = useCallback(
    (el, ms) => {
      const text = tipTextOf(el, takenRef.current)
      if (!text) return
      if (armedRef.current === el) return // already showing for this one
      if (pendingRef.current === el && timerRef.current !== null) return // its timer is already running
      if (armedRef.current) hide()
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      pendingRef.current = el
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        pendingRef.current = null
        // Still connected and still described? Otherwise there is nothing to point at.
        if (el.isConnected === false) return
        show(el, text)
      }, ms)
    },
    [hide, show],
  )

  useEffect(() => {
    if (!doc || typeof doc.addEventListener !== 'function') return undefined

    const onOver = (e) => {
      const el = tipTargetOf(e.target)
      if (!el) {
        if (armedRef.current) hide()
        return
      }
      arm(el, delayMs)
    }
    const onOut = (e) => {
      const el = armedRef.current || pendingRef.current
      if (!el) return
      // Leaving for somewhere still inside the trigger is not leaving.
      const to = e.relatedTarget
      if (to && typeof el.contains === 'function' && el.contains(to)) return
      hide()
    }
    const onFocusIn = (e) => {
      const el = tipTargetOf(e.target)
      if (el) arm(el, focusDelayMs)
      else if (armedRef.current) hide()
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape' || armedRef.current) hide()
    }

    doc.addEventListener('pointerover', onOver, true)
    doc.addEventListener('pointerout', onOut, true)
    doc.addEventListener('pointerdown', hide, true)
    doc.addEventListener('focusin', onFocusIn, true)
    doc.addEventListener('focusout', hide, true)
    doc.addEventListener('keydown', onKeyDown, true)
    doc.addEventListener('scroll', hide, true)
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('blur', hide)
      win.addEventListener('resize', hide)
    }
    return () => {
      doc.removeEventListener('pointerover', onOver, true)
      doc.removeEventListener('pointerout', onOut, true)
      doc.removeEventListener('pointerdown', hide, true)
      doc.removeEventListener('focusin', onFocusIn, true)
      doc.removeEventListener('focusout', hide, true)
      doc.removeEventListener('keydown', onKeyDown, true)
      doc.removeEventListener('scroll', hide, true)
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('blur', hide)
        win.removeEventListener('resize', hide)
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (armedRef.current) restore(armedRef.current)
    }
  }, [doc, win, delayMs, focusDelayMs, arm, hide, restore])

  // Measure the bubble where it cannot be seen, then place it clear of the site views.
  useLayoutEffect(() => {
    if (!tip || placed) return
    const node = bubbleRef.current
    if (!node || typeof tip.el.getBoundingClientRect !== 'function') return
    const trigger = tip.el.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    const area = { width: (win && win.innerWidth) || 0, height: (win && win.innerHeight) || 0 }
    const { placement, rect } = choosePlacement(trigger, { width: box.width, height: box.height }, { blocked: blockedRects(doc), win: area })
    setPlaced({ left: Math.round(rect.left), top: Math.round(rect.top), placement })
  }, [tip, placed, doc, win])

  if (!tip || !doc || !doc.body) return null
  const style = placed ? { left: `${placed.left}px`, top: `${placed.top}px` } : undefined
  return createPortal(
    <div
      ref={bubbleRef}
      id={TOOLTIP_ID}
      role="tooltip"
      data-testid="tooltip"
      data-placement={placed ? placed.placement : 'measuring'}
      {...{ [TIP_OPT_OUT]: '' }}
      className={placed ? css.bubble : `${css.bubble} ${css.measuring}`}
      style={style}
    >
      {tip.text}
    </div>,
    doc.body,
  )
}
