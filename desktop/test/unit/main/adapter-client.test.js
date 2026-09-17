// adapter-client.js — reqId match, foreign sender ignored, timeout → timeout, navigation → adapter_gone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapterClient, AdapterRequestError, isMainFrameOf, RESULT_CHANNEL } from '../../../main/adapter-client.js'
import { fakeIpcMain, fakeWebContents, eventFrom, fakeTimers, fakeLog } from './_fakes.js'

function setup() {
  const ipcMain = fakeIpcMain()
  const wc = fakeWebContents({ id: 7 })
  const timers = fakeTimers()
  let n = 0
  const client = createAdapterClient(wc, 'claude', { ipcMain, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: timers.now, makeId: () => `req-${++n}`, log: fakeLog() })
  return { ipcMain, wc, timers, client }
}

const rejection = (p) => p.then(() => assert.fail('expected rejection'), (e) => e)

test('request sends {reqId, op, ...payload} on triplex:adapter and resolves with the matching ok result', async () => {
  const { ipcMain, wc, client } = setup()
  const p = client.request('ready', { timeoutMs: 1500 })
  assert.deepEqual(wc.adapterMessages(), [{ timeoutMs: 1500, reqId: 'req-1', op: 'ready' }])
  assert.equal(client.pending(), 1)
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-1', ok: true, op: 'ready', composerSelector: '#prompt-textarea' })
  const res = await p
  assert.equal(res.composerSelector, '#prompt-textarea')
  assert.equal(client.pending(), 0)
})

test('results are matched by reqId: a reply for another request never settles this one', async () => {
  const { ipcMain, wc, client } = setup()
  const a = client.request('ready')
  const b = client.request('health')
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-2', ok: true, op: 'health', health: { composer: true } })
  const hb = await b
  assert.equal(hb.health.composer, true)
  assert.equal(client.pending(), 1)
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-1', ok: true, op: 'ready' })
  assert.equal((await a).op, 'ready')
})

test('a result from a foreign sender (another view, a popup, a sub-frame) is ignored', async () => {
  const { ipcMain, wc, client, timers } = setup()
  const other = fakeWebContents({ id: 99 })
  const p = client.request('ready')
  ipcMain.emit(RESULT_CHANNEL, eventFrom(other), { reqId: 'req-1', ok: true, op: 'ready' })
  ipcMain.emit(RESULT_CHANNEL, { sender: { id: 7 }, senderFrame: { parent: {} } }, { reqId: 'req-1', ok: true, op: 'ready' }) // sub-frame
  ipcMain.emit(RESULT_CHANNEL, { sender: null }, { reqId: 'req-1', ok: true, op: 'ready' })
  assert.equal(client.pending(), 1, 'still pending after foreign replies')
  ipcMain.emit(RESULT_CHANNEL, { sender: { id: 7 } }, { reqId: 'req-1', ok: true, op: 'ready' }) // same id, no frame info (accepted)
  assert.equal((await p).ok, true)
  assert.equal(timers.pending(), 0, 'timer cleared')
})

test('an ok:false result rejects with AdapterRequestError {code, message, partial}', async () => {
  const { ipcMain, wc, client } = setup()
  const p = client.request('insertAndSubmit', { text: 'hi' })
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-1', ok: false, op: 'insertAndSubmit', code: 'send_not_found', message: 'no send button', partial: 'h' })
  const e = await rejection(p)
  assert.ok(e instanceof AdapterRequestError)
  assert.equal(e.code, 'send_not_found')
  assert.equal(e.message, 'no send button')
  assert.equal(e.partial, 'h')
  assert.equal(e.op, 'insertAndSubmit')
})

test('timeout → code timeout, a cancel is sent for the request, a late reply is ignored', async () => {
  const { ipcMain, wc, client, timers } = setup()
  const p = client.request('ready', { timeoutMs: 1000 }, { timeoutMs: 2000 })
  timers.advance(1999)
  assert.equal(client.pending(), 1)
  timers.advance(1)
  const e = await rejection(p)
  assert.equal(e.code, 'timeout')
  assert.match(e.message, /ready timed out after 2000 ms/)
  const msgs = wc.adapterMessages()
  assert.deepEqual(msgs[1], { reqId: 'req-2', op: 'cancel', target: 'req-1' })
  assert.equal(client.pending(), 0)
  assert.doesNotThrow(() => ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-1', ok: true, op: 'ready' }))
})

test('did-navigate rejects every pending request with adapter_gone', async () => {
  const { wc, client } = setup()
  const a = client.request('ready')
  const b = client.request('insertAndSubmit', { text: 'x' })
  wc.emit('did-navigate', {}, 'https://chatgpt.com/c/abc')
  const ea = await rejection(a)
  const eb = await rejection(b)
  assert.equal(ea.code, 'adapter_gone')
  assert.equal(eb.code, 'adapter_gone')
  assert.equal(client.pending(), 0)
})

test('render-process-gone / destroyed reject pending with view_crashed; a destroyed view refuses new requests', async () => {
  const { wc, client } = setup()
  const a = client.request('ready')
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  assert.equal((await rejection(a)).code, 'view_crashed')
  wc.destroy()
  const e = await rejection(client.request('ready'))
  assert.equal(e.code, 'view_crashed')
  assert.equal(client.pending(), 0)
})

test('dispose detaches the listeners and fails pending requests adapter_gone', async () => {
  const { ipcMain, wc, client } = setup()
  const p = client.request('ready')
  client.dispose()
  assert.equal((await rejection(p)).code, 'adapter_gone')
  assert.equal(client.isDisposed(), true)
  assert.equal((ipcMain.listeners.get(RESULT_CHANNEL) || []).length, 0)
  assert.equal(wc.listenerCount('did-navigate'), 0)
  assert.equal((await rejection(client.request('ready'))).code, 'adapter_gone')
})

test('an invalid op rejects site_error without sending anything', async () => {
  const { wc, client } = setup()
  const e = await rejection(client.request(''))
  assert.equal(e.code, 'site_error')
  assert.deepEqual(wc.adapterMessages(), [])
})

test('isMainFrameOf: same sender + main frame only', () => {
  const wc = fakeWebContents({ id: 5 })
  assert.equal(isMainFrameOf(eventFrom(wc), wc), true)
  assert.equal(isMainFrameOf({ sender: wc, senderFrame: { parent: { id: 1 } } }, wc), false)
  assert.equal(isMainFrameOf({ sender: wc, senderFrame: null }, wc), false)
  assert.equal(isMainFrameOf({ sender: { id: 6 } }, wc), false)
  assert.equal(isMainFrameOf({ sender: { id: 5 } }, wc), true)
  assert.equal(isMainFrameOf(null, wc), false)
  const throwing = { sender: wc }
  Object.defineProperty(throwing, 'senderFrame', { get() { throw new Error('disposed') } })
  assert.equal(isMainFrameOf(throwing, wc), false)
})
