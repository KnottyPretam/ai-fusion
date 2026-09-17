// desktop/main/shortcuts.js — the keyboard table of contract §2, handled once in main.
//
//   Ctrl+1 / Ctrl+2 / Ctrl+3   → renderer 'panes:shortcut' {name:'tab-n'}   (tabs: activate; split: focusPane)
//   Ctrl+\                     → {name:'toggle-mode'}
//   Ctrl+L                     → main focuses the renderer, then {name:'focus-prompt'}
//   Ctrl+Shift+N               → {name:'new-chat-all'}
//   Ctrl+= / Ctrl++ / Ctrl+-  / Ctrl+0 → zoom of the ACTIVE pane applied in main, then 'panes:zoom' {slot, factor}
//   Ctrl+R                     → reload the active pane
//   F12 (dev only)             → inspect the active pane
//   Enter / Shift+Enter        → renderer-local, never intercepted
//
// Focused site views swallow renderer keys, so the table is matched in `before-input-event` on
// every webContents (site views + renderer; `event.preventDefault()` also suppresses the menu
// accelerator, so a shortcut never fires twice) and, as the fallback for focus that no view
// holds, by a hidden application Menu whose accelerators call the same `run()`.
// Pure module: everything (views, renderer, Menu) is injected.

import { SLOTS } from './sites.js'

export const SHORTCUT_NAMES = Object.freeze(['tab-1', 'tab-2', 'tab-3', 'toggle-mode', 'focus-prompt', 'new-chat-all'])

/**
 * matchShortcut(input, {dev}) → action | null for an Electron `Input` (`before-input-event`).
 *   {kind:'shortcut', name} | {kind:'zoom', direction:'in'|'out'|'reset'} | {kind:'reload'} | {kind:'inspect'}
 * Only `keyDown` events match; auto-repeat is ignored; Alt/Meta must be up (Ctrl is the modifier
 * on Linux/Windows; `meta` is accepted as its macOS equivalent only for the same table).
 */
export function matchShortcut(input, { dev = false } = {}) {
  if (!input || typeof input !== 'object') return null
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null
  if (input.isAutoRepeat) return null
  const key = typeof input.key === 'string' ? input.key : ''
  const code = typeof input.code === 'string' ? input.code : ''
  const ctrl = !!(input.control || input.meta)
  const shift = !!input.shift
  const alt = !!input.alt

  if (!ctrl && !alt && !shift && (key === 'F12' || code === 'F12')) return dev ? { kind: 'inspect' } : null
  if (!ctrl || alt) return null

  const lower = key.toLowerCase()
  if (shift) {
    if (lower === 'n' || code === 'KeyN') return { kind: 'shortcut', name: 'new-chat-all' }
    if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return { kind: 'zoom', direction: 'in' }
    return null
  }
  if (key === '1' || code === 'Digit1' || code === 'Numpad1') return { kind: 'shortcut', name: 'tab-1' }
  if (key === '2' || code === 'Digit2' || code === 'Numpad2') return { kind: 'shortcut', name: 'tab-2' }
  if (key === '3' || code === 'Digit3' || code === 'Numpad3') return { kind: 'shortcut', name: 'tab-3' }
  if (key === '\\' || code === 'Backslash' || code === 'IntlBackslash') return { kind: 'shortcut', name: 'toggle-mode' }
  if (lower === 'l' || code === 'KeyL') return { kind: 'shortcut', name: 'focus-prompt' }
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return { kind: 'zoom', direction: 'in' }
  if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') return { kind: 'zoom', direction: 'out' }
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return { kind: 'zoom', direction: 'reset' }
  if (lower === 'r' || code === 'KeyR') return { kind: 'reload' }
  return null
}

/**
 * createShortcuts({getActive, zoom, reload, inspect, focusRenderer, sendToRenderer, dev, log}) → shortcuts
 *   run(action)              perform one matched action; returns true when handled
 *   handleInput(input)       matchShortcut + run; returns true when handled
 *   attach(webContents)      `before-input-event` listener (preventDefault when handled); returns a detach fn
 *   menuTemplate()           the hidden Menu template (accelerators → run) for Menu.buildFromTemplate
 *
 * Collaborators: `getActive() → slot`, `zoom(slot, direction) → factor`, `reload(slot)`,
 * `inspect(slot)`, `focusRenderer()`, `sendToRenderer(channel, payload)`.
 */
export function createShortcuts({ getActive, zoom, reload, inspect, focusRenderer, sendToRenderer, dev = false, log = console } = {}) {
  const active = () => {
    const slot = typeof getActive === 'function' ? getActive() : null
    return SLOTS.includes(slot) ? slot : SLOTS[0]
  }
  const safe = (fn, ...args) => {
    try {
      return typeof fn === 'function' ? fn(...args) : undefined
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[shortcuts] ${(e && e.message) || e}`)
      return undefined
    }
  }

  function run(action) {
    if (!action || typeof action !== 'object') return false
    switch (action.kind) {
      case 'shortcut': {
        if (!SHORTCUT_NAMES.includes(action.name)) return false
        if (action.name === 'focus-prompt') safe(focusRenderer)
        safe(sendToRenderer, 'panes:shortcut', { name: action.name })
        return true
      }
      case 'zoom': {
        const slot = active()
        const factor = safe(zoom, slot, action.direction)
        if (typeof factor === 'number') safe(sendToRenderer, 'panes:zoom', { slot, factor })
        return true
      }
      case 'reload':
        safe(reload, active())
        return true
      case 'inspect':
        if (!dev) return false
        safe(inspect, active())
        return true
      default:
        return false
    }
  }

  function handleInput(input) {
    const action = matchShortcut(input, { dev })
    return action ? run(action) : false
  }

  function attach(webContents) {
    if (!webContents || typeof webContents.on !== 'function') return () => {}
    const listener = (event, input) => {
      if (handleInput(input) && event && typeof event.preventDefault === 'function') event.preventDefault()
    }
    webContents.on('before-input-event', listener)
    return () => {
      if (typeof webContents.removeListener === 'function') webContents.removeListener('before-input-event', listener)
    }
  }

  function menuTemplate() {
    const item = (label, accelerator, action) => ({ label, accelerator, click: () => run(action) })
    const panes = [
      item('Pane 1', 'CommandOrControl+1', { kind: 'shortcut', name: 'tab-1' }),
      item('Pane 2', 'CommandOrControl+2', { kind: 'shortcut', name: 'tab-2' }),
      item('Pane 3', 'CommandOrControl+3', { kind: 'shortcut', name: 'tab-3' }),
      { type: 'separator' },
      item('Toggle tabs / split', 'CommandOrControl+\\', { kind: 'shortcut', name: 'toggle-mode' }),
      item('Focus prompt', 'CommandOrControl+L', { kind: 'shortcut', name: 'focus-prompt' }),
      item('New chat everywhere', 'CommandOrControl+Shift+N', { kind: 'shortcut', name: 'new-chat-all' }),
      { type: 'separator' },
      item('Zoom in', 'CommandOrControl+=', { kind: 'zoom', direction: 'in' }),
      item('Zoom out', 'CommandOrControl+-', { kind: 'zoom', direction: 'out' }),
      item('Reset zoom', 'CommandOrControl+0', { kind: 'zoom', direction: 'reset' }),
      { type: 'separator' },
      item('Reload pane', 'CommandOrControl+R', { kind: 'reload' }),
    ]
    if (dev) panes.push(item('Inspect pane', 'F12', { kind: 'inspect' }))
    return [
      { label: 'Triplex', submenu: [{ role: 'quit' }] },
      { label: 'Panes', submenu: panes },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    ]
  }

  return { run, handleInput, attach, menuTemplate }
}
