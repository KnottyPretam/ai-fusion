// trusted-input.js (2026-10-17) — main's TRUSTED keyboard input into a site view: insertText →
// webContents.insertText(text), pressEnter → sendInputEvent keyDown / char / keyUp Return, a missing or
// destroyed WebContents → view_crashed, and — gotcha 19 — nothing else: the fake WebContents' executeJavaScript,
// debugger.attach and setUserAgent THROW if called, so a passing run proves the module never touches them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedInput, ENTER_EVENTS, TRUSTED_VIEWS, TRUSTED_PAINT_MS } from '../../../main/trusted-input.js'
import { AdapterRequestError } from '../../../main/adapter-client.js'

/** A WebContents whose forbidden surfaces throw: executeJavaScript, debugger.attach, setUserAgent. */
function trapWebContents({ destroyed = false, insertFails = null } = {}) {
  const wc = {
    calls: [],
    isDestroyed: () => destroyed,
    insertText: async (text) => {
      wc.calls.push(['insertText', text])
      if (insertFails) throw insertFails
    },
    sendInputEvent: (event) => {
      wc.calls.push(['sendInputEvent', event])
    },
    executeJavaScript: () => {
      throw new Error('executeJavaScript must never be called (gotcha 19)')
    },
    debugger: {
      attach: () => {
        throw new Error('debugger.attach must never be called (gotcha 19)')
      },
      sendCommand: () => {
        throw new Error('debugger.sendCommand must never be called (gotcha 19)')
      },
    },
    setUserAgent: () => {
      throw new Error('setUserAgent must never be called (gotcha 19)')
    },
  }
  return wc
}

test('ENTER_EVENTS: keyDown Return, char \\r, keyUp Return — frozen; TRUSTED_VIEWS: pane and analyst', () => {
  assert.deepEqual(ENTER_EVENTS.map((e) => ({ ...e })), [
    { type: 'keyDown', keyCode: 'Return' },
    { type: 'char', keyCode: '\r' },
    { type: 'keyUp', keyCode: 'Return' },
  ])
  assert.ok(Object.isFrozen(ENTER_EVENTS))
  for (const e of ENTER_EVENTS) assert.ok(Object.isFrozen(e))
  assert.deepEqual([...TRUSTED_VIEWS], ['pane', 'analyst'])
})

test('insertText → wc.insertText(text) on the view the caller named, awaited; pressEnter → the three input events in order; the forbidden surfaces are never touched', async () => {
  const pane = trapWebContents()
  const analyst = trapWebContents()
  const asked = []
  const t = createTrustedInput({
    webContentsFor: (view, slot) => {
      asked.push([view, slot])
      return view === 'analyst' ? analyst : pane
    },
  })
  await t.insertText('pane', 'gemini', 'hello `x` <<<R1>>>')
  await t.pressEnter('pane', 'gemini')
  assert.deepEqual(pane.calls, [
    ['insertText', 'hello `x` <<<R1>>>'],
    ['sendInputEvent', { type: 'keyDown', keyCode: 'Return' }],
    ['sendInputEvent', { type: 'char', keyCode: '\r' }],
    ['sendInputEvent', { type: 'keyUp', keyCode: 'Return' }],
  ])
  await t.insertText('analyst', 'gemini', 'q')
  await t.pressEnter('analyst', 'gemini')
  assert.equal(analyst.calls.length, 4, 'the analyst view got its own keystrokes')
  assert.deepEqual(asked, [['pane', 'gemini'], ['pane', 'gemini'], ['analyst', 'gemini'], ['analyst', 'gemini']])
  // the events handed over are copies: a WebContents that mutates one cannot change ENTER_EVENTS
  pane.calls[1][1].keyCode = 'Escape'
  assert.equal(ENTER_EVENTS[0].keyCode, 'Return')
})

test('a missing, destroyed or unresolvable WebContents rejects view_crashed and types nothing', async () => {
  const dead = trapWebContents({ destroyed: true })
  const cases = [() => null, () => undefined, () => dead, () => {
    throw new Error('requireSlot: unknown slot')
  }]
  for (const webContentsFor of cases) {
    const t = createTrustedInput({ webContentsFor })
    await assert.rejects(t.insertText('pane', 'gemini', 'x'), (e) => e instanceof AdapterRequestError && e.code === 'view_crashed')
    await assert.rejects(t.pressEnter('pane', 'gemini'), (e) => e instanceof AdapterRequestError && e.code === 'view_crashed')
  }
  assert.deepEqual(dead.calls, [])
})

test('refusals before any keystroke: an unknown view, an empty / non-string text, a WebContents without the methods — site_error', async () => {
  const wc = trapWebContents()
  const t = createTrustedInput({ webContentsFor: () => wc })
  await assert.rejects(t.insertText('renderer', 'gemini', 'x'), (e) => e.code === 'site_error' && /unknown view/.test(e.message))
  for (const bad of ['', null, undefined, 42, ['x']]) await assert.rejects(t.insertText('pane', 'gemini', bad), (e) => e.code === 'site_error')
  assert.deepEqual(wc.calls, [])
  const bare = createTrustedInput({ webContentsFor: () => ({ isDestroyed: () => false }) })
  await assert.rejects(bare.insertText('pane', 'gemini', 'x'), (e) => e.code === 'site_error' && /no insertText/.test(e.message))
  await assert.rejects(bare.pressEnter('pane', 'gemini'), (e) => e.code === 'site_error' && /no sendInputEvent/.test(e.message))
  assert.throws(() => createTrustedInput({}), /webContentsFor is required/)
})

test('a WebContents that throws is re-thrown as site_error with its message — never with the text', async () => {
  const secret = 'PROMPT-SECRET-42'
  const wc = trapWebContents({ insertFails: new Error('render frame gone') })
  const t = createTrustedInput({ webContentsFor: () => wc })
  await assert.rejects(t.insertText('pane', 'gemini', secret), (e) => e.code === 'site_error' && /render frame gone/.test(e.message) && !e.message.includes(secret))
  const throwing = { isDestroyed: () => false, sendInputEvent: () => {
    throw new Error('input pipeline down')
  } }
  const t2 = createTrustedInput({ webContentsFor: () => throwing })
  await assert.rejects(t2.pressEnter('pane', 'gemini'), (e) => e.code === 'site_error' && /input pipeline down/.test(e.message))
})

test('wake (2026-10-17): setBackgroundThrottling(false) right before the insert and before the Enter — a widget created hidden drops sendInputEvent keys until Electron re-shows it; never true, never anything else; a throw there is ignored', async () => {
  const wc = trapWebContents()
  wc.setBackgroundThrottling = (allowed) => wc.calls.push(['setBackgroundThrottling', allowed])
  const t = createTrustedInput({ webContentsFor: () => wc })
  await t.insertText('analyst', 'gemini', 'typed')
  await t.pressEnter('analyst', 'gemini')
  assert.deepEqual(wc.calls, [
    ['setBackgroundThrottling', false],
    ['insertText', 'typed'],
    ['setBackgroundThrottling', false],
    ...ENTER_EVENTS.map((e) => ['sendInputEvent', { ...e }]),
  ])
  const throwing = trapWebContents()
  throwing.setBackgroundThrottling = () => {
    throw new Error('not now')
  }
  const t2 = createTrustedInput({ webContentsFor: () => throwing })
  await t2.insertText('pane', 'gemini', 'typed')
  await t2.pressEnter('pane', 'gemini')
  assert.deepEqual(throwing.calls.map((c) => c[0]), ['insertText', 'sendInputEvent', 'sendInputEvent', 'sendInputEvent'])
})

test('paint once (2026-10-17): ONE capturePage() between the wake and the Enter — a document that never painted drops keys — the image discarded; a capture that hangs is waited for TRUSTED_PAINT_MS at most, one that rejects is ignored', async () => {
  assert.equal(TRUSTED_PAINT_MS, 1500)
  const wc = trapWebContents()
  wc.setBackgroundThrottling = (allowed) => wc.calls.push(['setBackgroundThrottling', allowed])
  wc.capturePage = async () => {
    wc.calls.push(['capturePage'])
    return { image: true }
  }
  const t = createTrustedInput({ webContentsFor: () => wc })
  await t.insertText('analyst', 'gemini', 'typed')
  await t.pressEnter('analyst', 'gemini')
  assert.deepEqual(wc.calls.map((c) => c[0]), ['setBackgroundThrottling', 'insertText', 'setBackgroundThrottling', 'capturePage', 'sendInputEvent', 'sendInputEvent', 'sendInputEvent'], 'no capture before the insert: insertText lands unpainted')

  // a capture that never settles: the Enter goes out once TRUSTED_PAINT_MS elapses (injected timers)
  const timers = []
  const hung = trapWebContents()
  hung.capturePage = () => new Promise(() => {})
  const th = createTrustedInput({ webContentsFor: () => hung, setTimeout: (fn, ms) => (timers.push([fn, ms]), timers.length), clearTimeout: () => {} })
  const pressed = th.pressEnter('pane', 'gemini')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(hung.calls, [], 'nothing sent while the capture is pending')
  assert.deepEqual(timers.map((x) => x[1]), [TRUSTED_PAINT_MS])
  timers[0][0]()
  await pressed
  assert.deepEqual(hung.calls.map((c) => c[0]), ['sendInputEvent', 'sendInputEvent', 'sendInputEvent'])

  // a capture that throws (synchronously or by rejecting) is not a failure
  for (const capturePage of [() => { throw new Error('no') }, async () => { throw new Error('no') }]) {
    const bad = trapWebContents()
    bad.capturePage = capturePage
    await createTrustedInput({ webContentsFor: () => bad }).pressEnter('pane', 'gemini')
    assert.deepEqual(bad.calls.map((c) => c[0]), ['sendInputEvent', 'sendInputEvent', 'sendInputEvent'])
  }
})
