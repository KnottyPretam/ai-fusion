// shortcuts.js — Ctrl+2 → tab-2, Ctrl+= → zoom the active pane, the rest of the §2 table.
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchShortcut, createShortcuts, SHORTCUT_NAMES } from '../../../main/shortcuts.js'
import { fakeWebContents, fakeLog } from './_fakes.js'

const key = (k, extra = {}) => ({ type: 'keyDown', key: k, code: '', isAutoRepeat: false, control: true, shift: false, alt: false, meta: false, ...extra })

test('matchShortcut: the §2 table', () => {
  assert.deepEqual(matchShortcut(key('1')), { kind: 'shortcut', name: 'tab-1' })
  assert.deepEqual(matchShortcut(key('2')), { kind: 'shortcut', name: 'tab-2' })
  assert.deepEqual(matchShortcut(key('3')), { kind: 'shortcut', name: 'tab-3' })
  assert.deepEqual(matchShortcut(key('\\')), { kind: 'shortcut', name: 'toggle-mode' })
  assert.deepEqual(matchShortcut(key('l')), { kind: 'shortcut', name: 'focus-prompt' })
  assert.deepEqual(matchShortcut(key('L')), { kind: 'shortcut', name: 'focus-prompt' })
  assert.deepEqual(matchShortcut(key('N', { shift: true })), { kind: 'shortcut', name: 'new-chat-all' })
  assert.deepEqual(matchShortcut(key('=')), { kind: 'zoom', direction: 'in' })
  assert.deepEqual(matchShortcut(key('+', { shift: true })), { kind: 'zoom', direction: 'in' })
  assert.deepEqual(matchShortcut(key('-')), { kind: 'zoom', direction: 'out' })
  assert.deepEqual(matchShortcut(key('0')), { kind: 'zoom', direction: 'reset' })
  assert.deepEqual(matchShortcut(key('r')), { kind: 'reload' })
  assert.deepEqual(matchShortcut({ type: 'keyDown', key: 'F12', control: false }, { dev: true }), { kind: 'inspect' })
  assert.equal(matchShortcut({ type: 'keyDown', key: 'F12', control: false }, { dev: false }), null)
  // codes work when the layout maps keys differently
  assert.deepEqual(matchShortcut(key('', { code: 'Digit2' })), { kind: 'shortcut', name: 'tab-2' })
  assert.deepEqual(matchShortcut(key('', { code: 'Equal' })), { kind: 'zoom', direction: 'in' })
  assert.deepEqual(matchShortcut(key('', { code: 'Backslash' })), { kind: 'shortcut', name: 'toggle-mode' })
})

test('matchShortcut: Enter / Shift+Enter, plain keys, keyUp, auto-repeat, Alt and unknown Ctrl combos never match', () => {
  assert.equal(matchShortcut({ type: 'keyDown', key: 'Enter', control: false }), null)
  assert.equal(matchShortcut({ type: 'keyDown', key: 'Enter', shift: true, control: false }), null)
  assert.equal(matchShortcut({ type: 'keyDown', key: '2', control: false }), null)
  assert.equal(matchShortcut(key('2', { type: 'keyUp' })), null)
  assert.equal(matchShortcut(key('2', { isAutoRepeat: true })), null)
  assert.equal(matchShortcut(key('2', { alt: true })), null)
  assert.equal(matchShortcut(key('2', { shift: true })), null)
  assert.equal(matchShortcut(key('c')), null)
  assert.equal(matchShortcut(key('v')), null)
  assert.equal(matchShortcut(key('i', { shift: true })), null, 'Ctrl+Shift+I stays with Electron')
  assert.equal(matchShortcut(null), null)
  assert.equal(matchShortcut('Ctrl+2'), null)
})

function setup({ active = 'claude', dev = false } = {}) {
  const calls = []
  const sc = createShortcuts({
    getActive: () => active,
    zoom: (slot, direction) => {
      calls.push(['zoom', slot, direction])
      return direction === 'in' ? 1.1 : direction === 'out' ? 0.9 : 1
    },
    reload: (slot) => calls.push(['reload', slot]),
    inspect: (slot) => calls.push(['inspect', slot]),
    focusRenderer: () => calls.push(['focusRenderer']),
    sendToRenderer: (channel, payload) => calls.push(['send', channel, payload]),
    dev,
    log: fakeLog(),
  })
  return { sc, calls }
}

test('Ctrl+2 → panes:shortcut {name:"tab-2"} to the renderer', () => {
  const { sc, calls } = setup()
  assert.equal(sc.handleInput(key('2')), true)
  assert.deepEqual(calls, [['send', 'panes:shortcut', { name: 'tab-2' }]])
})

test('Ctrl+= zooms the ACTIVE pane in main, then emits panes:zoom {slot, factor}', () => {
  const { sc, calls } = setup({ active: 'grok' })
  assert.equal(sc.handleInput(key('=')), true)
  assert.deepEqual(calls, [['zoom', 'grok', 'in'], ['send', 'panes:zoom', { slot: 'grok', factor: 1.1 }]])
  calls.length = 0
  sc.handleInput(key('-'))
  sc.handleInput(key('0'))
  assert.deepEqual(calls, [
    ['zoom', 'grok', 'out'],
    ['send', 'panes:zoom', { slot: 'grok', factor: 0.9 }],
    ['zoom', 'grok', 'reset'],
    ['send', 'panes:zoom', { slot: 'grok', factor: 1 }],
  ])
})

test('Ctrl+L focuses the renderer BEFORE emitting focus-prompt; Ctrl+R reloads the active pane; F12 inspects only in dev', () => {
  const { sc, calls } = setup({ active: 'chatgpt' })
  sc.handleInput(key('l'))
  assert.deepEqual(calls, [['focusRenderer'], ['send', 'panes:shortcut', { name: 'focus-prompt' }]])
  calls.length = 0
  sc.handleInput(key('r'))
  assert.deepEqual(calls, [['reload', 'chatgpt']])
  calls.length = 0
  assert.equal(sc.handleInput({ type: 'keyDown', key: 'F12' }), false)
  assert.deepEqual(calls, [])
  const dev = setup({ active: 'chatgpt', dev: true })
  assert.equal(dev.sc.handleInput({ type: 'keyDown', key: 'F12' }), true)
  assert.deepEqual(dev.calls, [['inspect', 'chatgpt']])
})

test('an unknown active slot falls back to the first slot; unhandled input returns false', () => {
  const { sc, calls } = setup({ active: 'nope' })
  sc.handleInput(key('='))
  assert.deepEqual(calls[0], ['zoom', 'claude', 'in'])
  assert.equal(sc.handleInput(key('x')), false)
  assert.equal(sc.run({ kind: 'shortcut', name: 'not-a-name' }), false)
})

test('attach(): before-input-event on a webContents preventDefaults handled keys only; detach removes it', () => {
  const { sc, calls } = setup()
  const wc = fakeWebContents()
  const detach = sc.attach(wc)
  const handled = { prevented: false, preventDefault() { this.prevented = true } }
  wc.emit('before-input-event', handled, key('3'))
  assert.equal(handled.prevented, true)
  assert.deepEqual(calls, [['send', 'panes:shortcut', { name: 'tab-3' }]])
  const plain = { prevented: false, preventDefault() { this.prevented = true } }
  wc.emit('before-input-event', plain, { type: 'keyDown', key: 'a', control: false })
  assert.equal(plain.prevented, false)
  detach()
  assert.equal(wc.listenerCount('before-input-event'), 0)
})

test('menuTemplate carries an accelerator per table entry and its click runs the same action', () => {
  const { sc, calls } = setup({ active: 'claude', dev: true })
  const template = sc.menuTemplate()
  const panes = template.find((m) => m.label === 'Panes').submenu.filter((i) => i.accelerator)
  const accelerators = panes.map((i) => i.accelerator)
  for (const a of ['CommandOrControl+1', 'CommandOrControl+2', 'CommandOrControl+3', 'CommandOrControl+\\', 'CommandOrControl+L', 'CommandOrControl+Shift+N', 'CommandOrControl+=', 'CommandOrControl+-', 'CommandOrControl+0', 'CommandOrControl+R', 'F12']) {
    assert.ok(accelerators.includes(a), a)
  }
  panes.find((i) => i.accelerator === 'CommandOrControl+2').click()
  assert.deepEqual(calls, [['send', 'panes:shortcut', { name: 'tab-2' }]])
  assert.equal(setup({ dev: false }).sc.menuTemplate().find((m) => m.label === 'Panes').submenu.some((i) => i.accelerator === 'F12'), false)
  assert.deepEqual([...SHORTCUT_NAMES], ['tab-1', 'tab-2', 'tab-3', 'toggle-mode', 'focus-prompt', 'new-chat-all'])
})
