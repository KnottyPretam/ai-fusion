// adapter-client.js (Stage 2) — request(op, payload, {signal}): an abort sends cancel{target},
// the adapter's own `cancelled` result settles the promise, CANCEL_GRACE_MS without it fails
// locally; an already-aborted signal never sends; a gone view fails at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapterClient, RESULT_CHANNEL, CANCEL_GRACE_MS } from '../../../main/adapter-client.js'
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

test('abort → cancel{target} is sent; the adapter answers cancelled (with partial) and that settles the request', async () => {
  const { ipcMain, wc, client } = setup()
  const controller = new AbortController()
  const p = client.request('observe', { baselineCount: 1 }, { timeoutMs: 60000, signal: controller.signal })
  assert.deepEqual(wc.adapterMessages(), [{ baselineCount: 1, reqId: 'req-1', op: 'observe' }])
  controller.abort()
  assert.deepEqual(wc.adapterMessages().at(-1), { reqId: 'req-2', op: 'cancel', target: 'req-1' })
  assert.equal(client.pending(), 1, 'still pending: the adapter answers cancelled itself')
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-2', ok: true, op: 'cancel', cancelled: true })
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-1', ok: false, op: 'observe', code: 'cancelled', message: 'cancelled', partial: 'At sea' })
  const e = await rejection(p)
  assert.equal(e.code, 'cancelled')
  assert.equal(e.partial, 'At sea')
  assert.equal(client.pending(), 0)
})

test('no answer within CANCEL_GRACE_MS after the cancel → rejected cancelled locally; a late result is ignored', async () => {
  const { ipcMain, wc, client, timers } = setup()
  const controller = new AbortController()
  const p = client.request('observe', {}, { timeoutMs: 60000, signal: controller.signal })
  controller.abort()
  timers.advance(CANCEL_GRACE_MS - 1)
  assert.equal(client.pending(), 1)
  timers.advance(1)
  const e = await rejection(p)
  assert.equal(e.code, 'cancelled')
  assert.match(e.message, /no answer from the adapter/)
  assert.equal(client.pending(), 0)
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-1', ok: true, op: 'observe', text: 'late' })
  assert.equal(client.pending(), 0)
  timers.advance(60000)
  assert.equal(timers.pending(), 0, 'the request timer was cleared with the entry')
})

test('an already-aborted signal rejects cancelled without sending anything; a normal completion detaches the abort listener', async () => {
  const { ipcMain, wc, client, timers } = setup()
  const aborted = new AbortController()
  aborted.abort()
  const e = await rejection(client.request('ready', {}, { signal: aborted.signal }))
  assert.equal(e.code, 'cancelled')
  assert.deepEqual(wc.adapterMessages(), [])

  const controller = new AbortController()
  const p = client.request('ready', {}, { signal: controller.signal })
  ipcMain.emit(RESULT_CHANNEL, eventFrom(wc), { reqId: 'req-2', ok: true, op: 'ready' })
  assert.equal((await p).ok, true)
  controller.abort()
  assert.equal(wc.adapterMessages().length, 1, 'no cancel after completion')
  assert.equal(timers.pending(), 0)
})

test('abort on a destroyed view rejects cancelled at once (nothing to cancel)', async () => {
  const { wc, client } = setup()
  const controller = new AbortController()
  const p = client.request('observe', {}, { signal: controller.signal })
  wc._destroyed = true
  controller.abort()
  const e = await rejection(p)
  assert.equal(e.code, 'cancelled')
  assert.match(e.message, /view gone/)
  assert.equal(client.pending(), 0)
})
