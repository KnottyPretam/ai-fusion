// views.js (Stage 2) — loadUrl (a recorded chat link; ERR_ABORTED tolerated; failures → navigation;
// a URL off the site's hosts refused before anything loads), pendingNavigation (every navigation
// main starts is tracked until the main frame commits / the load fails / NAVIGATION_WAIT_MS),
// onNavigate (did-navigate + did-navigate-in-page, main frame only), pushConfig ({op:'config'} to
// every live view), signOut (clearStorageData on THAT partition only, then newChatUrl).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createViewManager, NAVIGATION_WAIT_MS } from '../../../main/views.js'
import { REQUEST_CHANNEL } from '../../../main/adapter-client.js'
import { makeFakeWebContentsViewClass, fakeSession, fakeSettings, fakeIpcMain, fakeTimers, fakeLog, fakeSites, tick } from './_fakes.js'

/** true when `p` is already resolved (its reaction runs before the setImmediate tick). */
const isSettled = (p) => Promise.race([Promise.resolve(p).then(() => true), tick().then(() => false)])

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

test('loadUrl refuses a URL off the site\'s hosts (loadURL bypasses will-navigate): code navigation, wc.loadURL never called, nothing pending', async () => {
  const { manager, wc } = setupManager()
  await Promise.resolve()
  const chatgpt = wc('chatgpt')
  chatgpt.emit('did-navigate', {}, chatgpt.getURL()) // the initial load committed
  const before = chatgpt.loads.length
  for (const bad of ['https://evil.example/c/x', 'http://evil.example/c/x', 'javascript:alert(1)', 'file:///etc/hostname', 'data:text/html,x', 'https://127.0.0.1.evil.example/c/x', 'about:blank']) {
    await assert.rejects(manager.loadUrl('chatgpt', bad), (e) => e.code === 'navigation' && /off the site's hosts/.test(e.message) && !e.message.includes('/c/x'), bad)
  }
  assert.equal(chatgpt.loads.length, before, 'never loaded')
  assert.equal(manager.pendingNavigation('chatgpt'), null, 'nothing tracked for a refused URL')
  // the site's own pages: http on loopback (the fake site), https on a listed host, url / newChatUrl always
  assert.equal(await manager.loadUrl('chatgpt', 'http://localhost:5199/c/1?site=chatgpt'), true)
  assert.equal(await manager.loadUrl('chatgpt', 'https://127.0.0.1:5199/c/2'), true)
  assert.equal(await manager.loadUrl('chatgpt', 'http://127.0.0.1:5199/?site=chatgpt'), true)
  assert.equal(chatgpt.loads.length, before + 3)
})

test('pendingNavigation: the initial load, newChat, reload and loadUrl are pending until did-navigate / a main-frame did-fail-load / NAVIGATION_WAIT_MS; a newer navigation supersedes; dispose settles', async () => {
  const { manager, wc, timers } = setupManager()
  await Promise.resolve()
  const claude = wc('claude')
  const initial = manager.pendingNavigation('claude')
  assert.ok(initial && typeof initial.then === 'function', 'the initial load is pending')
  assert.equal(await isSettled(initial), false)
  claude.emit('did-navigate-in-page', {}, 'http://127.0.0.1:5199/?site=claude#x', true, 1, 1)
  assert.equal(await isSettled(initial), false, 'an in-page navigation is not a commit')
  claude.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:5199/?site=claude', true)
  assert.equal(await isSettled(initial), false, 'ERR_ABORTED (superseded) keeps waiting for the real commit')
  claude.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5199/sub', false)
  assert.equal(await isSettled(initial), false, 'a sub-frame failure is not ours')
  claude.emit('did-navigate', {}, 'http://127.0.0.1:5199/?site=claude', 200, 'OK')
  assert.equal(await isSettled(initial), true, 'did-navigate commits')
  assert.equal(manager.pendingNavigation('claude'), null)
  const baseListeners = claude.listenerCount('did-navigate') // the zoom hook + the adapter client stay

  // newChat → pending until the commit; a second newChat supersedes (the first settles at once)
  manager.newChat('claude')
  const first = manager.pendingNavigation('claude')
  assert.equal(await isSettled(first), false)
  manager.newChat('claude')
  const second = manager.pendingNavigation('claude')
  assert.notEqual(first, second)
  assert.equal(await isSettled(first), true, 'superseded')
  assert.equal(await isSettled(second), false)
  claude.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5199/?site=claude', true)
  assert.equal(await isSettled(second), true, 'a main-frame failure settles (the adapter decides what the page is)')
  assert.equal(manager.pendingNavigation('claude'), null)

  // bounded: no event at all → settled after NAVIGATION_WAIT_MS
  manager.newChat('claude')
  const bounded = manager.pendingNavigation('claude')
  timers.advance(NAVIGATION_WAIT_MS - 1)
  assert.equal(await isSettled(bounded), false)
  timers.advance(1)
  assert.equal(await isSettled(bounded), true)
  assert.equal(manager.pendingNavigation('claude'), null)
  assert.equal(claude.listenerCount('did-navigate'), baseListeners, 'the tracker removed its listener')

  // reload tracks too
  manager.reload('claude')
  const reloaded = manager.pendingNavigation('claude')
  assert.equal(await isSettled(reloaded), false)
  claude.emit('did-navigate', {}, claude.getURL(), 200, 'OK')
  assert.equal(await isSettled(reloaded), true)

  // loadUrl: pending while loadURL runs, settled once it resolved (Electron resolves after the commit)
  let finish
  claude.loadURL = (u) =>
    new Promise((resolve) => {
      claude.loads.push(u)
      claude._url = u
      finish = resolve
    })
  const loading = manager.loadUrl('claude', 'http://127.0.0.1:5199/c/abc?site=claude')
  const tracked = manager.pendingNavigation('claude')
  assert.ok(tracked)
  assert.equal(await isSettled(tracked), false)
  finish()
  assert.equal(await loading, true)
  assert.equal(await isSettled(tracked), true)
  assert.equal(manager.pendingNavigation('claude'), null)
  // a failed loadUrl settles too
  claude.loadURL = async () => {
    const e = new Error('ERR_CONNECTION_REFUSED (-102)')
    e.errno = -102
    throw e
  }
  await assert.rejects(manager.loadUrl('claude', 'http://127.0.0.1:5199/c/y'), (e) => e.code === 'navigation')
  assert.equal(manager.pendingNavigation('claude'), null)
  // ERR_ABORTED keeps the tracker: the superseding navigation commits it
  claude.loadURL = async () => {
    const e = new Error('ERR_ABORTED (-3) loading')
    e.errno = -3
    throw e
  }
  assert.equal(await manager.loadUrl('claude', 'http://127.0.0.1:5199/c/z'), true)
  const aborted = manager.pendingNavigation('claude')
  assert.ok(aborted, 'still pending')
  claude.emit('did-navigate', {}, 'http://127.0.0.1:5199/c/redirected', 200, 'OK')
  assert.equal(await isSettled(aborted), true)

  // a disposed view settles whatever was pending; a dead view has nothing pending (grok's initial
  // tracker already expired with the advance above, so start a fresh navigation on it)
  const grok = wc('grok')
  manager.newChat('grok')
  const grokPending = manager.pendingNavigation('grok')
  assert.equal(await isSettled(grokPending), false)
  grok.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  assert.equal(await isSettled(grokPending), true)
  assert.equal(manager.pendingNavigation('grok'), null)
  assert.throws(() => manager.pendingNavigation('bing'), /unknown slot/)
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
