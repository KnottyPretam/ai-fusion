// views.js — sandbox:true + contextIsolation:true in every webPreferences (the pure option-builder),
// the view manager with fakes: partitions, permissions per partition, zoom per view, layout,
// render-process-gone → recreate + health view_crashed, slotOfSender, loadWithRetry, the
// Bluetooth chooser cancelled per view, child windows policed, ssoHosts passed through.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildViewOptions, buildWindowOptions, crashedHealth, loadWithRetry, createViewManager, backgroundFor, paintBackground, BACKGROUND_LIGHT, BACKGROUND_DARK, RECREATE_DELAY_MS, CRASH_LIMIT } from '../../../main/views.js'
import { SITES, SLOTS } from '../../../main/sites.js'
import { normalizeLayout } from '../../../main/layout.js'
import { isPoliced } from '../../../main/policy.js'
import { makeFakeWebContentsViewClass, fakeSession, fakeSettings, fakeIpcMain, fakeTimers, fakeLog, fakeSites, fakeWebContents, eventFrom, fakeChildWindow, navEvent } from './_fakes.js'

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

test('buildWindowOptions paints a ground before the first paint: the resolved theme colour, light by default', () => {
  // Electron's default is #FFF, so a dark-theme launch flashes white for the whole renderer load.
  assert.equal(buildWindowOptions({ preload: '/p' }).backgroundColor, BACKGROUND_LIGHT)
  assert.equal(buildWindowOptions({ preload: '/p', backgroundColor: BACKGROUND_DARK }).backgroundColor, BACKGROUND_DARK)
  assert.equal(buildWindowOptions({ preload: '/p', backgroundColor: '' }).backgroundColor, BACKGROUND_LIGHT, 'a junk colour never reaches Electron')
  assert.equal(buildWindowOptions({ preload: '/p', backgroundColor: 7 }).backgroundColor, BACKGROUND_LIGHT)
})

test("backgroundFor resolves the theme to a --bg token ('system' decided by the caller's prefersDark)", () => {
  assert.equal(backgroundFor('light'), BACKGROUND_LIGHT)
  assert.equal(backgroundFor('dark'), BACKGROUND_DARK)
  assert.equal(backgroundFor('system'), BACKGROUND_LIGHT, 'no prefersDark → light')
  assert.equal(backgroundFor('system', { prefersDark: true }), BACKGROUND_DARK)
  assert.equal(backgroundFor('light', { prefersDark: true }), BACKGROUND_LIGHT, 'an explicit choice wins over the OS')
  assert.equal(backgroundFor(undefined), BACKGROUND_DARK, 'an unknown value falls back to DEFAULT_THEME (dark)')
  assert.equal(backgroundFor('chartreuse'), BACKGROUND_DARK)
})

test('paintBackground never throws: a view without the method, a junk colour or a throwing setter', () => {
  const view = { background: null, setBackgroundColor(c) { this.background = c } }
  assert.equal(paintBackground(view, BACKGROUND_DARK), true)
  assert.equal(view.background, BACKGROUND_DARK)
  assert.equal(paintBackground(null, BACKGROUND_DARK), false)
  assert.equal(paintBackground({}, BACKGROUND_DARK), false, 'no setBackgroundColor → skipped, not thrown')
  assert.equal(paintBackground(view, ''), false)
  const log = fakeLog()
  assert.equal(paintBackground({ setBackgroundColor() { throw new Error('nope') } }, BACKGROUND_DARK, { log }), false)
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes('setBackgroundColor')))
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

function setupManager({ zoom, ssoHosts, background } = {}) {
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
    ...(ssoHosts ? { ssoHosts } : {}),
    ...(background ? { backgroundColor: background } : {}),
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
    assert.equal(isPoliced(v.webContents), true)
    assert.equal(v.webContents.listenerCount('will-redirect'), 1, 'redirects policed')
    assert.equal(v.webContents.listenerCount('did-create-window'), 1, 'child windows policed')
    assert.equal(v.webContents.listenerCount('select-bluetooth-device'), 1, 'Bluetooth chooser cancelled')
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

test('every view cancels Bluetooth device requests, polices its child windows and redirects, and honours ssoHosts ([] under E2E)', () => {
  const { manager, instances, opened } = setupManager()
  manager.createAll()
  const wc = instances[0].webContents
  const ev = { prevented: false, preventDefault() { this.prevented = true } }
  let chosen = null
  wc.emit('select-bluetooth-device', ev, [{ deviceId: 'd1' }], (id) => { chosen = id })
  assert.equal(ev.prevented, true)
  assert.equal(chosen, '')

  assert.equal(wc.windowOpenHandler({ url: 'https://accounts.google.com/o/oauth2' }).action, 'allow', 'SSO_HOSTS by default')
  assert.equal(wc.windowOpenHandler({ url: 'http://127.0.0.1:5199/share' }).action, 'allow')
  const child = fakeChildWindow()
  wc.emit('did-create-window', child, { url: 'https://accounts.google.com/o/oauth2' })
  assert.equal(isPoliced(child.webContents), true)
  assert.deepEqual(child.webContents.windowOpenHandler({ url: 'https://evil.example/' }), { action: 'deny' })
  const childNav = navEvent('https://evil.example/2')
  child.webContents.emit('will-navigate', childNav, childNav.url)
  assert.equal(childNav.prevented, true)
  const redirect = navEvent('https://evil.example/r')
  wc.emit('will-redirect', redirect, redirect.url, false, true)
  assert.equal(redirect.prevented, true)
  const own = navEvent('http://localhost:5199/c/1')
  wc.emit('will-redirect', own, own.url, false, true)
  assert.equal(own.prevented, false)
  assert.deepEqual(opened, ['https://evil.example/', 'https://evil.example/2', 'https://evil.example/r'])

  const e2e = setupManager({ ssoHosts: [] })
  e2e.manager.createAll()
  const gwc = e2e.instances[2].webContents
  assert.deepEqual(gwc.windowOpenHandler({ url: 'https://accounts.google.com/' }), { action: 'deny' })
  assert.deepEqual(e2e.opened, ['https://accounts.google.com/'], 'an E2E run never opens a real SSO host in-app')
  assert.equal(gwc.windowOpenHandler({ url: 'http://127.0.0.1:5199/x' }).action, 'allow')
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

test('every site view is created on the theme ground; setBackgroundColor repaints the live views and the next recreate', async () => {
  let ground = BACKGROUND_LIGHT
  const { manager, instances, timers } = setupManager({ background: () => ground })
  manager.createAll()
  assert.deepEqual(instances.map((v) => v.background), [BACKGROUND_LIGHT, BACKGROUND_LIGHT, BACKGROUND_LIGHT], 'no white rect under a light page')

  // the theme button: main hands the new ground to the manager, which repaints every live view
  assert.equal(manager.setBackgroundColor(BACKGROUND_DARK), 3)
  assert.deepEqual(instances.map((v) => v.background), [BACKGROUND_DARK, BACKGROUND_DARK, BACKGROUND_DARK])
  assert.equal(manager.setBackgroundColor(''), 0, 'a junk colour is ignored')

  // a view created later (crash recreate) starts on the current ground, not the launch one
  instances[1].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
  timers.advance(RECREATE_DELAY_MS)
  await Promise.resolve()
  assert.equal(instances.length, 4)
  assert.equal(instances[3].background, BACKGROUND_DARK)

  // a function that throws leaves the view unpainted and logs, it never breaks creation
  const bad = setupManager({ background: () => { throw new Error('boom') } })
  bad.manager.createAll()
  assert.deepEqual(bad.instances.map((v) => v.background), [BACKGROUND_LIGHT, BACKGROUND_LIGHT, BACKGROUND_LIGHT], 'falls back to the light ground')
  assert.ok(bad.log.lines.some(([l, m]) => l === 'warn' && m.includes('backgroundColor()')))
})

test('createViewManager validates its seams', () => {
  assert.throws(() => createViewManager({}), /WebContentsView is required/)
  assert.throws(() => createViewManager({ WebContentsView: class {} }), /contentView is required/)
})

// ---------------------------------------------------------------------------------------------
// loadWithRetry against a backend that is still binding its port. This is the shape that shipped a
// packaged app as a BLACK WINDOW on 2026-09-20: the renderer raced its own backend, the first load
// was refused, and the retry loop died without a word.
// ---------------------------------------------------------------------------------------------

/**
 * A webContents that refuses the first `failures` loads. Electron does BOTH things on a refusal —
 * emits `did-fail-load`, then `did-finish-load` for the error page, and rejects the `loadURL`
 * promise — so the fake does all three, in that order.
 */
function flakyContents({ failures = 1, rejectToo = true, emitFinishOnError = true } = {}) {
  const wc = new EventEmitter()
  wc.loads = []
  wc.isDestroyed = () => false
  wc.loadURL = (u) => {
    wc.loads.push(u)
    if (wc.loads.length <= failures) {
      setImmediate(() => {
        wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', u, true)
        if (emitFinishOnError) wc.emit('did-finish-load')
      })
      return rejectToo ? Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)')) : new Promise(() => {})
    }
    setImmediate(() => wc.emit('did-finish-load'))
    return Promise.resolve()
  }
  return wc
}

/** Run every pending retry timer to completion. */
function makeClock() {
  const queue = []
  const setT = (fn) => {
    queue.push(fn)
    return queue.length
  }
  const drain = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) {
      const due = queue.splice(0, queue.length)
      for (const fn of due) fn()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    }
  }
  return { setT, drain, pending: () => queue.length }
}

test('a refused first load is retried until the backend answers (the black-window bug)', async () => {
  const wc = flakyContents({ failures: 2 })
  const clock = makeClock()
  const log = fakeLog()
  loadWithRetry(wc, 'http://127.0.0.1:8021/app/', { tag: 'renderer', log, setTimeout: clock.setT })
  await clock.drain()
  assert.equal(wc.loads.length, 3, 'two refusals then the load that works')
  assert.deepEqual(new Set(wc.loads), new Set(['http://127.0.0.1:8021/app/']))
})

test("the error page's did-finish-load is not mistaken for success", async () => {
  // This is precisely what broke it: `did-finish-load` arrives for Chromium's error page, and
  // treating it as success removed the listeners after the very first failure.
  const wc = flakyContents({ failures: 3, emitFinishOnError: true })
  const clock = makeClock()
  loadWithRetry(wc, 'http://x/app/', { log: fakeLog(), setTimeout: clock.setT })
  await clock.drain()
  assert.equal(wc.loads.length, 4)
})

test('a rejection with no event at all still drives the loop', async () => {
  // The other half: `loadURL` rejects and nothing is emitted. Swallowing that rejection was what
  // made the failure silent.
  const wc = new EventEmitter()
  wc.loads = []
  wc.isDestroyed = () => false
  wc.loadURL = (u) => {
    wc.loads.push(u)
    if (wc.loads.length <= 2) return Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    setImmediate(() => wc.emit('did-finish-load'))
    return Promise.resolve()
  }
  const clock = makeClock()
  const log = fakeLog()
  loadWithRetry(wc, 'http://x/app/', { tag: 'renderer', log, setTimeout: clock.setT })
  await clock.drain()
  assert.equal(wc.loads.length, 3)
  assert.match(log.lines.map(([, l]) => l).join('\n'), /ERR_CONNECTION_REFUSED/)
})

test('the event and the rejection for ONE attempt schedule only one retry', async () => {
  const wc = flakyContents({ failures: 1, rejectToo: true })
  const clock = makeClock()
  loadWithRetry(wc, 'http://x/app/', { log: fakeLog(), setTimeout: clock.setT })
  await clock.drain()
  assert.equal(wc.loads.length, 2, 'not 3: the double signal is one failure, not two')
})

test('it gives up after maxRetries and says so, instead of retrying forever', async () => {
  const wc = flakyContents({ failures: 99 })
  const clock = makeClock()
  const log = fakeLog()
  loadWithRetry(wc, 'http://x/app/', { tag: 'renderer', log, setTimeout: clock.setT, maxRetries: 3 })
  await clock.drain(20)
  assert.equal(wc.loads.length, 4, 'the first load plus three retries')
  assert.match(log.lines.map(([, l]) => l).join('\n'), /giving up on http:\/\/x\/app\/ after 3 retries/)
  assert.equal(clock.pending(), 0, 'and nothing is left scheduled')
})

test('ERR_ABORTED is a superseded load, not a failure', async () => {
  const wc = new EventEmitter()
  wc.loads = []
  wc.isDestroyed = () => false
  wc.loadURL = (u) => {
    wc.loads.push(u)
    setImmediate(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', u, true))
    return Promise.resolve()
  }
  const clock = makeClock()
  loadWithRetry(wc, 'http://x/app/', { log: fakeLog(), setTimeout: clock.setT })
  await clock.drain(3)
  assert.equal(wc.loads.length, 1)
  assert.equal(clock.pending(), 0)
})

test('cancel() stops a retry that is already scheduled', async () => {
  const wc = flakyContents({ failures: 99 })
  const clock = makeClock()
  const cancel = loadWithRetry(wc, 'http://x/app/', { log: fakeLog(), setTimeout: clock.setT })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  cancel()
  await clock.drain(5)
  assert.equal(wc.loads.length, 1, 'the one attempt that had already started')
})
