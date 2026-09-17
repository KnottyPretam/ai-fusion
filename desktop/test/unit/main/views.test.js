// views.js — sandbox:true + contextIsolation:true in every webPreferences (the pure option-builder),
// the view manager with fakes: partitions, permissions per partition, zoom per view, layout,
// render-process-gone → recreate + health view_crashed, slotOfSender, loadWithRetry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildViewOptions, buildWindowOptions, crashedHealth, loadWithRetry, createViewManager, RECREATE_DELAY_MS, CRASH_LIMIT } from '../../../main/views.js'
import { SITES, SLOTS } from '../../../main/sites.js'
import { normalizeLayout } from '../../../main/layout.js'
import { makeFakeWebContentsViewClass, fakeSession, fakeSettings, fakeIpcMain, fakeTimers, fakeLog, fakeSites, fakeWebContents, eventFrom } from './_fakes.js'

const PRELOAD = '/app/preload/site.cjs'

test('buildViewOptions: every site view is sandboxed, isolated, node-free, unthrottled, on its partition with the site preload', () => {
  for (const slot of SLOTS) {
    const { webPreferences } = buildViewOptions(SITES[slot], { preload: PRELOAD, zoomFactor: 1.2 })
    assert.equal(webPreferences.sandbox, true, slot)
    assert.equal(webPreferences.contextIsolation, true, slot)
    assert.equal(webPreferences.nodeIntegration, false, slot)
    assert.equal(webPreferences.nodeIntegrationInSubFrames, false, slot)
    assert.equal(webPreferences.webviewTag, false, slot)
    assert.equal(webPreferences.backgroundThrottling, false, slot)
    assert.equal(webPreferences.partition, `persist:${slot}`, slot)
    assert.equal(webPreferences.preload, PRELOAD, slot)
    assert.equal(webPreferences.zoomFactor, 1.2, slot)
    assert.equal('userAgent' in webPreferences, false, 'the UA is never set')
  }
  assert.throws(() => buildViewOptions(SITES.claude, {}), /preload is required/)
  assert.throws(() => buildViewOptions({}, { preload: PRELOAD }), /partition/)
})

test('buildWindowOptions: the renderer window is sandboxed and isolated too, with autoHideMenuBar and optional x/y', () => {
  const o = buildWindowOptions({ preload: '/app/preload/renderer.cjs', bounds: { width: 1000, height: 700, maximized: false } })
  assert.equal(o.webPreferences.sandbox, true)
  assert.equal(o.webPreferences.contextIsolation, true)
  assert.equal(o.webPreferences.nodeIntegration, false)
  assert.equal(o.webPreferences.preload, '/app/preload/renderer.cjs')
  assert.equal(o.autoHideMenuBar, true)
  assert.deepEqual([o.width, o.height, 'x' in o, 'y' in o], [1000, 700, false, false])
  const p = buildWindowOptions({ preload: '/p', bounds: { x: 5, y: 6, width: 800, height: 600 } })
  assert.deepEqual([p.x, p.y], [5, 6])
})

test('crashedHealth is a §1 Health with session unknown and matched.error view_crashed', () => {
  const h = crashedHealth('grok', { url: 'https://grok.com/c/1', now: () => 1234.6 })
  assert.deepEqual(h, {
    composer: false,
    send: false,
    reply: null,
    stop: null,
    session: 'unknown',
    matched: { composer: null, send: null, reply: null, stop: null, error: 'view_crashed' },
    url: 'https://grok.com/c/1',
    host: 'grok.com',
    title: '',
    ts: 1235,
  })
  assert.equal(crashedHealth('grok', { url: 'nope' }).host, '')
})

test('loadWithRetry: retries main-frame failures every retryMs up to maxRetries, ignores ERR_ABORTED and sub-frames, stops on cancel', async () => {
  const wc = fakeWebContents()
  const timers = fakeTimers()
  const log = fakeLog()
  const cancel = loadWithRetry(wc, 'http://x.test/', { tag: 't', log, setTimeout: timers.setTimeout, retryMs: 1000, maxRetries: 2 })
  await Promise.resolve()
  assert.deepEqual(wc.loads, ['http://x.test/'])
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x.test/', true)
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x.test/', false)
  assert.equal(timers.pending(), 0, 'aborted / sub-frame failures never schedule a retry')
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x.test/', true)
  assert.equal(timers.pending(), 1)
  timers.advance(1000)
  await Promise.resolve()
  assert.equal(wc.loads.length, 2)
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x.test/', true)
  timers.advance(1000)
  await Promise.resolve()
  assert.equal(wc.loads.length, 3)
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x.test/', true) // 3rd failure > maxRetries → give up
  assert.equal(timers.pending(), 0)
  assert.ok(log.lines.some(([l, m]) => l === 'error' && m.includes('giving up')))
  assert.equal(wc.listenerCount('did-fail-load'), 0)
  cancel()
  // a fresh load that succeeds detaches its listeners
  const ok = fakeWebContents()
  loadWithRetry(ok, 'http://y.test/', { setTimeout: timers.setTimeout, log })
  ok.emit('did-finish-load')
  assert.equal(ok.listenerCount('did-fail-load'), 0)
})

function setupManager({ zoom } = {}) {
  const instances = []
  const WebContentsView = makeFakeWebContentsViewClass(instances)
  const sessions = {}
  const children = []
  const timers = fakeTimers()
  const ipcMain = fakeIpcMain()
  const settings = fakeSettings(zoom)
  const healthEvents = []
  const opened = []
  const log = fakeLog()
  const manager = createViewManager({
    WebContentsView,
    sessionFromPartition: (p) => (sessions[p] = sessions[p] || fakeSession(p)),
    contentView: {
      addChildView: (v) => children.push(v),
      removeChildView: (v) => {
        const i = children.indexOf(v)
        if (i !== -1) children.splice(i, 1)
      },
    },
    sites: fakeSites(),
    preload: PRELOAD,
    settings,
    ipcMain,
    openExternal: (u) => opened.push(u),
    onHealth: (slot, h) => healthEvents.push([slot, h]),
    dev: true,
    log,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
  })
  return { manager, instances, sessions, children, timers, ipcMain, settings, healthEvents, opened, log }
}

test('createAll: three views, one per slot, each on its partition with hardened prefs; permissions installed per partition once', async () => {
  const { manager, instances, sessions, children } = setupManager({ zoom: { claude: 1.5, chatgpt: 1, grok: 0.8 } })
  manager.createAll()
  assert.equal(instances.length, 3)
  assert.deepEqual(Object.keys(sessions).sort(), ['persist:chatgpt', 'persist:claude', 'persist:grok'])
  for (const ses of Object.values(sessions)) {
    assert.equal(typeof ses.requestHandler, 'function')
    assert.equal(ses.deviceHandler(), false)
  }
  SLOTS.forEach((slot, i) => {
    const v = instances[i]
    assert.equal(v.options.webPreferences.partition, `persist:${slot}`)
    assert.equal(v.options.webPreferences.sandbox, true)
    assert.equal(v.options.webPreferences.contextIsolation, true)
    assert.equal(v.options.webPreferences.preload, PRELOAD)
    assert.equal(manager.get(slot), v)
    assert.equal(manager.webContents(slot), v.webContents)
    assert.equal(typeof v.webContents.windowOpenHandler, 'function', 'policy attached')
  })
  assert.equal(children.length, 3)
  await Promise.resolve()
  assert.deepEqual(instances.map((v) => v.webContents.loads[0]), SLOTS.map((s) => `http://127.0.0.1:5199/?site=${s}`))
  assert.equal(instances[0].webContents.zoom, 1.5)
  assert.equal(instances[2].webContents.zoom, 0.8)
  assert.equal(instances[0].options.webPreferences.zoomFactor, 1.5)
  manager.createAll()
  assert.equal(instances.length, 3, 'idempotent')
})

test('applyLayout sets bounds / visibility now and again for a view created later; slotOfSender by main-frame id', () => {
  const { manager, instances, ipcMain } = setupManager()
  manager.createAll()
  manager.applyLayout(normalizeLayout({ claude: { x: 0, y: 40, width: 500, height: 600 }, chatgpt: null, grok: { x: 500, y: 40, width: 500, height: 600 } }))
  assert.deepEqual(instances[0].getBounds(), { x: 0, y: 40, width: 500, height: 600 })
  assert.equal(instances[0].getVisible(), true)
  assert.equal(instances[1].getVisible(), false)
  assert.equal(instances[2].getVisible(), true)
  assert.equal(manager.slotOfSender(eventFrom(instances[1].webContents)), 'chatgpt')
  assert.equal(manager.slotOfSender({ sender: { id: instances[2].webContents.id } }), 'grok')
  assert.equal(manager.slotOfSender({ sender: instances[1].webContents, senderFrame: { parent: {} } }), null, 'sub-frames are not the view')
  assert.equal(manager.slotOfSender(eventFrom(fakeWebContents({ id: 9999 }))), null)
  assert.equal(manager.adapterFor('claude').slot, 'claude')
  assert.equal(ipcMain.listeners.get('triplex:adapter:result').length, 3, 'one adapter client per view')
})

test('zoom(slot, direction) steps, persists, applies to that view only and is re-applied on did-navigate', () => {
  const { manager, instances, settings } = setupManager()
  manager.createAll()
  assert.equal(manager.zoom('chatgpt', 'in'), 1.1)
  assert.equal(instances[1].webContents.zoom, 1.1)
  assert.equal(instances[0].webContents.zoom, 1, 'other views untouched')
  assert.equal(settings.zoom.chatgpt, 1.1)
  assert.equal(manager.zoomFactor('chatgpt'), 1.1)
  assert.equal(manager.zoom('chatgpt', 'reset'), 1)
  manager.zoom('grok', 'out')
  instances[2].webContents.zoom = 1 // Chromium's per-origin level after a cross-host hop
  instances[2].webContents.emit('did-navigate', {}, 'http://127.0.0.1:5199/c/1')
  assert.equal(instances[2].webContents.zoom, 0.9, 're-applied from settings')
})

test('focus / reload / newChat / currentUrl / inspect drive the right webContents', async () => {
  const { manager, instances } = setupManager()
  manager.createAll()
  await Promise.resolve()
  assert.equal(manager.focus('grok'), true)
  assert.equal(instances[2].webContents.focused, 1)
  assert.equal(manager.reload('claude'), true)
  assert.equal(instances[0].webContents.reloads, 1)
  assert.equal(manager.newChat('chatgpt'), true)
  await Promise.resolve()
  assert.equal(instances[1].webContents.loads.at(-1), 'http://127.0.0.1:5199/?site=chatgpt')
  assert.equal(manager.currentUrl('chatgpt'), 'http://127.0.0.1:5199/?site=chatgpt')
  assert.equal(manager.inspect('claude'), true)
  assert.deepEqual(instances[0].webContents.devtools, [{ mode: 'detach' }])
  assert.throws(() => manager.focus('bing'), /unknown slot/)
})

test('render-process-gone: health view_crashed is published, the view is recreated after RECREATE_DELAY_MS with layout + zoom re-applied', async () => {
  const { manager, instances, children, timers, healthEvents, ipcMain } = setupManager()
  const created = []
  manager.onCreated((slot, wc) => created.push([slot, wc.id]))
  manager.createAll()
  manager.applyLayout(normalizeLayout({ claude: { x: 0, y: 0, width: 300, height: 300 }, chatgpt: { x: 300, y: 0, width: 300, height: 300 }, grok: null }))
  manager.zoom('chatgpt', 'in')
  const crashed = instances[1]
  const oldClient = manager.adapterFor('chatgpt')
  const pendingReq = oldClient.request('ready')
  crashed.webContents._url = 'http://127.0.0.1:5199/c/abc?site=chatgpt'
  crashed.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })

  assert.equal(healthEvents.length, 1)
  assert.equal(healthEvents[0][0], 'chatgpt')
  assert.equal(healthEvents[0][1].matched.error, 'view_crashed')
  assert.equal(healthEvents[0][1].url, 'http://127.0.0.1:5199/c/abc?site=chatgpt')
  assert.equal(manager.getHealth('chatgpt').matched.error, 'view_crashed')
  assert.equal(manager.get('chatgpt'), null, 'gone until recreated')
  assert.equal(manager.adapterFor('chatgpt'), null)
  assert.equal(children.includes(crashed), false, 'removed from the window')
  assert.equal((await pendingReq.then(() => null, (e) => e.code)), 'view_crashed')
  assert.equal(ipcMain.listeners.get('triplex:adapter:result').length, 2, 'old client detached')

  timers.advance(RECREATE_DELAY_MS)
  await Promise.resolve()
  assert.equal(instances.length, 4)
  const fresh = instances[3]
  assert.equal(manager.get('chatgpt'), fresh)
  assert.equal(fresh.options.webPreferences.partition, 'persist:chatgpt')
  assert.deepEqual(fresh.getBounds(), { x: 300, y: 0, width: 300, height: 300 }, 'last layout re-applied')
  assert.equal(fresh.getVisible(), true)
  assert.equal(fresh.webContents.zoom, 1.1, 'zoom re-applied')
  assert.equal(fresh.webContents.loads[0], 'http://127.0.0.1:5199/?site=chatgpt')
  assert.equal(manager.adapterFor('chatgpt').webContents, fresh.webContents)
  assert.equal(ipcMain.listeners.get('triplex:adapter:result').length, 3)
  assert.deepEqual(created, [['claude', instances[0].webContents.id], ['chatgpt', crashed.webContents.id], ['grok', instances[2].webContents.id], ['chatgpt', fresh.webContents.id]])
  assert.equal(manager.slotOfSender(eventFrom(fresh.webContents)), 'chatgpt')
  assert.equal(manager.slotOfSender(eventFrom(crashed.webContents)), null)
})

test('a clean-exit is not a crash; a crash loop stops recreating after CRASH_LIMIT and an explicit Reload brings the view back', () => {
  const { manager, instances, timers, healthEvents, log } = setupManager()
  manager.createAll()
  instances[0].webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  assert.equal(healthEvents.length, 0)
  assert.equal(manager.get('claude'), instances[0])

  for (let i = 0; i <= CRASH_LIMIT; i++) {
    manager.get('grok').webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 })
    timers.advance(RECREATE_DELAY_MS)
  }
  assert.equal(manager.get('grok'), null, 'gave up')
  assert.ok(log.lines.some(([l, m]) => l === 'error' && m.includes('not recreating')))
  const before = instances.length
  assert.equal(manager.reload('grok'), true)
  assert.equal(instances.length, before + 1)
  assert.equal(manager.get('grok'), instances[before])
})

test('destroyAll disposes every view and client', () => {
  const { manager, instances, children, ipcMain } = setupManager()
  manager.createAll()
  manager.destroyAll()
  assert.equal(children.length, 0)
  assert.equal(ipcMain.listeners.get('triplex:adapter:result').length, 0)
  for (const v of instances) assert.equal(v.webContents.isDestroyed(), true)
  assert.equal(manager.get('claude'), null)
})

test('createViewManager validates its seams', () => {
  assert.throws(() => createViewManager({}), /WebContentsView is required/)
  assert.throws(() => createViewManager({ WebContentsView: class {} }), /contentView is required/)
})
