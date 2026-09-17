// views.js (Stage 2) — loadUrl (a recorded chat link; ERR_ABORTED tolerated; failures → navigation),
// onNavigate (did-navigate + did-navigate-in-page, main frame only), pushConfig ({op:'config'} to
// every live view), signOut (clearStorageData on THAT partition only, then newChatUrl).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createViewManager } from '../../../main/views.js'
import { REQUEST_CHANNEL } from '../../../main/adapter-client.js'
import { makeFakeWebContentsViewClass, fakeSession, fakeSettings, fakeIpcMain, fakeTimers, fakeLog, fakeSites } from './_fakes.js'

const PRELOAD = '/app/preload/site.cjs'

function setupManager() {
  const instances = []
  const WebContentsView = makeFakeWebContentsViewClass(instances)
  const sessions = {}
  const children = []
  const timers = fakeTimers()
  const manager = createViewManager({
    WebContentsView,
    sessionFromPartition: (p) => {
      if (!sessions[p]) {
        sessions[p] = fakeSession(p)
        sessions[p].cleared = 0
        sessions[p].clearStorageData = async () => {
          sessions[p].cleared += 1
        }
      }
      return sessions[p]
    },
    contentView: { addChildView: (v) => children.push(v), removeChildView: () => {} },
    sites: fakeSites(),
    preload: PRELOAD,
    settings: fakeSettings(),
    ipcMain: fakeIpcMain(),
    openExternal: () => {},
    dev: true,
    log: fakeLog(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
  })
  manager.createAll()
  const wc = (slot) => manager.webContents(slot)
  return { manager, instances, sessions, wc, timers }
}

test('loadUrl navigates the live view and resolves; ERR_ABORTED (superseded) resolves; other failures reject with code navigation; a dead view rejects view_crashed', async () => {
  const { manager, wc } = setupManager()
  await Promise.resolve()
  const claude = wc('claude')
  const before = claude.loads.length
  assert.equal(await manager.loadUrl('claude', 'http://127.0.0.1:5199/c/abc?site=claude'), true)
  assert.equal(claude.loads.at(-1), 'http://127.0.0.1:5199/c/abc?site=claude')
  assert.equal(claude.loads.length, before + 1)
  assert.equal(manager.currentUrl('claude'), 'http://127.0.0.1:5199/c/abc?site=claude')

  claude.loadURL = async () => {
    const e = new Error('ERR_ABORTED (-3) loading')
    e.errno = -3
    e.code = 'ERR_ABORTED'
    throw e
  }
  assert.equal(await manager.loadUrl('claude', 'http://127.0.0.1:5199/c/x'), true, 'a superseded load is not a failure')
  claude.loadURL = async () => {
    const e = new Error('ERR_CONNECTION_REFUSED (-102)')
    e.errno = -102
    throw e
  }
  await assert.rejects(manager.loadUrl('claude', 'http://127.0.0.1:5199/c/y'), (e) => e.code === 'navigation' && /could not open/.test(e.message))
  await assert.rejects(manager.loadUrl('claude', ''), /url is required/)
  wc('grok').destroy()
  await assert.rejects(manager.loadUrl('grok', 'http://127.0.0.1:5199/'), (e) => e.code === 'view_crashed')
  await assert.rejects(manager.loadUrl('bing', 'x'), /unknown slot/)
})

test('onNavigate reports did-navigate and main-frame did-navigate-in-page URLs; unsubscribe detaches; a dead view yields a no-op', () => {
  const { manager, wc } = setupManager()
  const seen = []
  const off = manager.onNavigate('chatgpt', (url, meta) => seen.push([url, meta.inPage]))
  const c = wc('chatgpt')
  c.emit('did-navigate', {}, 'http://127.0.0.1:5199/?site=chatgpt', 200, 'OK')
  c.emit('did-navigate-in-page', {}, 'http://127.0.0.1:5199/c/1?site=chatgpt', true, 1, 2)
  c.emit('did-navigate-in-page', {}, 'http://127.0.0.1:5199/frame', false, 1, 3)
  assert.deepEqual(seen, [
    ['http://127.0.0.1:5199/?site=chatgpt', false],
    ['http://127.0.0.1:5199/c/1?site=chatgpt', true],
  ])
  off()
  c.emit('did-navigate', {}, 'http://127.0.0.1:5199/after', 200, 'OK')
  assert.equal(seen.length, 2)
  assert.equal(c.listenerCount('did-navigate-in-page'), 0)
  wc('grok').destroy()
  assert.equal(typeof manager.onNavigate('grok', () => {}), 'function')
  assert.equal(typeof manager.onNavigate('claude', 'not a function'), 'function')
})

test('pushConfig sends {op:"config", selectors} on triplex:adapter to every LIVE view and reports the count', () => {
  const { manager, wc } = setupManager()
  const selectors = { version: 2, chatgpt: {}, claude: {}, grok: {} }
  assert.equal(manager.pushConfig(selectors), 3)
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    const msgs = wc(slot).adapterMessages()
    assert.deepEqual(msgs.at(-1), { op: 'config', selectors })
  }
  wc('grok').destroy()
  assert.equal(manager.pushConfig(selectors), 2, 'a dead view is skipped')
  assert.deepEqual(wc('claude').adapterMessages().filter((m) => m.op === 'config').length, 2)
})

test('signOut clears storage on exactly that partition, then navigates the view to newChatUrl', async () => {
  const { manager, sessions, wc } = setupManager()
  await Promise.resolve()
  const grokLoads = wc('grok').loads.length
  assert.equal(await manager.signOut('grok'), true)
  assert.equal(sessions['persist:grok'].cleared, 1)
  assert.equal(sessions['persist:claude'].cleared, 0)
  assert.equal(sessions['persist:chatgpt'].cleared, 0)
  await Promise.resolve()
  assert.equal(wc('grok').loads.length, grokLoads + 1)
  assert.equal(wc('grok').loads.at(-1), 'http://127.0.0.1:5199/?site=grok')
  assert.equal(manager.partitionOf('grok'), 'persist:grok')
  await assert.rejects(manager.signOut('bing'), /unknown slot/)
})
