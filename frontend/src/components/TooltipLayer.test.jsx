// The delegated tooltip: when it appears, that only one appears, that it gives the native `title`
// back, and that it stays out from behind the site views.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import TooltipLayer, { TOOLTIP_DELAY_MS, TOOLTIP_FOCUS_DELAY_MS, TOOLTIP_ID, tipTargetOf, tipTextOf } from './TooltipLayer.jsx'

/** Give an element a real box; jsdom reports zeros for everything. */
function pin(el, { left = 100, top = 10, width = 60, height = 20 } = {}) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
  return el
}

function mount(ui, { width = 1000, height = 800 } = {}) {
  window.innerWidth = width
  window.innerHeight = height
  return render(
    <>
      {ui}
      <TooltipLayer />
    </>,
  )
}

const tip = () => screen.queryByTestId('tooltip')
// The delay is a setTimeout that sets React state: advance the clock INSIDE act() or the state
// lands without a render and the bubble never appears in the DOM under test.
const wait = (ms) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

/** The bubble is created by the portal, so it cannot be pinned by hand: give every tooltip a
 *  realistic box through the prototype, or jsdom reports 0x0 and placement has nothing to avoid. */
const BUBBLE = { width: 200, height: 40 }
let realRect = null

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  realRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function measured() {
    if (this.dataset && this.dataset.testid === 'tooltip') {
      const left = parseFloat(this.style.left) || 0
      const top = parseFloat(this.style.top) || 0
      return { ...BUBBLE, left, top, x: left, y: top, right: left + BUBBLE.width, bottom: top + BUBBLE.height }
    }
    return realRect.call(this)
  }
})
afterEach(() => {
  cleanup()
  if (realRect) HTMLElement.prototype.getBoundingClientRect = realRect
  vi.useRealTimers()
})

describe('when it appears', () => {
  test('nothing for the first second, then the description', () => {
    mount(<button title="Reload this pane">R</button>)
    const button = pin(screen.getByRole('button'))
    fireEvent.pointerOver(button)
    wait(TOOLTIP_DELAY_MS - 50)
    expect(tip()).toBeNull()
    wait(60)
    expect(tip()).toHaveTextContent('Reload this pane')
  })

  test('leaving before the delay is up shows nothing at all', () => {
    mount(<button title="Reload this pane">R</button>)
    const button = pin(screen.getByRole('button'))
    fireEvent.pointerOver(button)
    wait(500)
    fireEvent.pointerOut(button, { relatedTarget: document.body })
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toBeNull()
  })

  test('moving WITHIN the control does not restart the clock', () => {
    // A button with an icon and a label: pointerover fires again for the inner span.
    mount(
      <button title="Export this step">
        <span data-testid="icon">⇩</span>
      </button>,
    )
    const button = pin(screen.getByRole('button'))
    fireEvent.pointerOver(button)
    wait(800)
    fireEvent.pointerOver(screen.getByTestId('icon')) // same trigger, via a child
    wait(300)
    expect(tip()).toHaveTextContent('Export this step')
  })

  test('keyboard focus arms it too, on its own shorter beat', () => {
    mount(<button title="Send to every checked site">S</button>)
    const button = pin(screen.getByRole('button'))
    fireEvent.focusIn(button)
    wait(TOOLTIP_FOCUS_DELAY_MS - 50)
    expect(tip()).toBeNull()
    wait(60)
    expect(tip()).toHaveTextContent('Send to every checked site')
  })

  test('a control with no description never arms anything', () => {
    mount(<button>plain</button>)
    fireEvent.pointerOver(pin(screen.getByRole('button')))
    wait(TOOLTIP_DELAY_MS * 2)
    expect(tip()).toBeNull()
  })

  test('data-tip wins over title when a control wants to say more', () => {
    mount(<button title="short" data-tip="the longer description">x</button>)
    fireEvent.pointerOver(pin(screen.getByRole('button')))
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toHaveTextContent('the longer description')
  })
})

describe('only one tooltip', () => {
  test('the native title is taken while it shows and given back when it hides', () => {
    mount(<button title="Reload this pane">R</button>)
    const button = pin(screen.getByRole('button'))
    expect(button).toHaveAttribute('title', 'Reload this pane')

    fireEvent.pointerOver(button)
    wait(TOOLTIP_DELAY_MS)
    expect(button).not.toHaveAttribute('title') // the browser has nothing of its own to draw
    expect(button).toHaveAttribute('aria-describedby', TOOLTIP_ID) // still described, for a reader

    fireEvent.pointerOut(button, { relatedTarget: document.body })
    expect(button).toHaveAttribute('title', 'Reload this pane')
    expect(button).not.toHaveAttribute('aria-describedby')
    expect(tip()).toBeNull()
  })

  test('unmounting while one is open still gives the title back', () => {
    const { unmount } = mount(<button title="Reload this pane">R</button>)
    const button = pin(screen.getByRole('button'))
    fireEvent.pointerOver(button)
    wait(TOOLTIP_DELAY_MS)
    expect(button).not.toHaveAttribute('title')
    unmount()
    expect(button).toHaveAttribute('title', 'Reload this pane')
  })

  test('moving to a second control swaps the bubble and restores the first', () => {
    mount(
      <>
        <button title="first">a</button>
        <button title="second">b</button>
      </>,
    )
    const [a, b] = screen.getAllByRole('button').map((el) => pin(el))
    fireEvent.pointerOver(a)
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toHaveTextContent('first')

    fireEvent.pointerOver(b)
    expect(a).toHaveAttribute('title', 'first')
    wait(TOOLTIP_DELAY_MS)
    expect(screen.getAllByTestId('tooltip')).toHaveLength(1)
    expect(tip()).toHaveTextContent('second')
  })
})

describe('it gets out of the way', () => {
  const dismissals = [
    ['a key press', () => fireEvent.keyDown(document, { key: 'a' })],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['a click', () => fireEvent.pointerDown(document.body)],
    ['a scroll', () => fireEvent.scroll(document)],
    ['the window losing focus', () => fireEvent.blur(window)],
    ['a resize', () => fireEvent.resize(window)],
  ]
  for (const [what, act] of dismissals) {
    test(`${what} hides it`, () => {
      mount(<button title="Reload this pane">R</button>)
      fireEvent.pointerOver(pin(screen.getByRole('button')))
      wait(TOOLTIP_DELAY_MS)
      expect(tip()).not.toBeNull()
      act()
      expect(tip()).toBeNull()
    })
  }

  test('it never eats a click: the bubble does not take pointer events', () => {
    mount(<button title="Reload this pane">R</button>)
    fireEvent.pointerOver(pin(screen.getByRole('button')))
    wait(TOOLTIP_DELAY_MS)
    expect(tip().className).toMatch(/bubble/)
    // the stylesheet is a CSS module, so assert the opt-out marker the layer relies on instead
    expect(tip()).toHaveAttribute('data-no-tip')
  })

  test('a pane viewport below the button sends the bubble above it', () => {
    mount(
      <>
        <button title="Reload this pane">R</button>
        <div data-testid="pane-claude-viewport" />
      </>,
    )
    const button = pin(screen.getByRole('button'), { left: 100, top: 10, width: 60, height: 20 })
    pin(screen.getByTestId('pane-claude-viewport'), { left: 0, top: 40, width: 1000, height: 700 })
    fireEvent.pointerOver(button)
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toHaveAttribute('data-placement', 'top')
  })

  test('with nothing in the way it sits below, where a tooltip belongs', () => {
    mount(<button title="Reload this pane">R</button>)
    fireEvent.pointerOver(pin(screen.getByRole('button'), { left: 400, top: 300, width: 60, height: 20 }))
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toHaveAttribute('data-placement', 'bottom')
  })
})

describe('the pure helpers', () => {
  test('tipTargetOf finds the described ancestor and refuses the bubble itself', () => {
    document.body.innerHTML = '<button title="t"><span id="kid">x</span></button><div data-no-tip><b id="inside" title="no">y</b></div>'
    expect(tipTargetOf(document.getElementById('kid')).tagName).toBe('BUTTON')
    expect(tipTargetOf(document.getElementById('inside'))).toBeNull()
    expect(tipTargetOf(null)).toBeNull()
  })

  test('tipTextOf trims, prefers data-tip, and reads a title that has been taken away', () => {
    const el = document.createElement('button')
    el.setAttribute('title', '  spaced  ')
    expect(tipTextOf(el)).toBe('spaced')
    el.setAttribute('data-tip', ' longer ')
    expect(tipTextOf(el)).toBe('longer')
    const bare = document.createElement('button')
    expect(tipTextOf(bare)).toBe('')
    expect(tipTextOf(bare, new WeakMap([[bare, 'stashed']]))).toBe('stashed')
  })
})
