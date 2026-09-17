// ipc.js — validation (unknown slot / non-string / bad targets / non-renderer sender rejected),
// every panes:* channel incl. the Stage 2 ones (getCapture / setCapture / openChats — null leaves
// the panes, the three loads run in parallel and each is bounded / signOut / snapshot), no
// prompt:send handler at all (§2: removed in Stage 2), adapter:config by sender, health
// forwarding, the cached health + zoom + bridge state (with its error text) replayed after
// panes:getInfo, getInfo.backend.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerIpc, requireSlot, requireTargets, requireText, requireDirection, requireActive, requireBoolean, requireConvId, annotateHealth, snapshotFileName, publicBridgeState, MAX_PROMPT_CHARS, MAX_CONV_ID_CHARS, OPEN_CHATS_LOAD_TIMEOUT_MS } from '../../../main/ipc.js'
import { fakeIpcMain, fakeWebContents, eventFrom, fakeLog, fakeSites, fakeTimers, tick } from './_fakes.js'

const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'

function setup({ dev = true, backend = null, bridge = null, links = {}, urls = {}, inflight = {}, snapshotHtml = '<html><body>…</body></html>', timers = null } = {}) {
  const ipcMain = fakeIpcMain()
  const renderer = fakeWebContents({ id: 1 })
  const siteWc = { claude: fakeWebContents({ id: 11 }), chatgpt: fakeWebContents({ id: 12 }), grok: fakeWebContents({ id: 13 }) }
  const calls = []
  const health = {}
  const current = { claude: 'https://claude.test/c/1', chatgpt: 'https://chatgpt.test/c/1', grok: 'javascript:alert(1)', ...urls }
  const adapters = {}
  for (const slot of Object.keys(siteWc)) {
    adapters[slot] = {
      requests: [],
      request: async (op, payload, opts) => {
        adapters[slot].requests.push([op, payload, opts])
        if (snapshotHtml instanceof Error) throw snapshotHtml
        return { ok: true, op, html: snapshotHtml }
      },
    }
  }
  const views = {
    applyLayout: (n) => calls.push(['applyLayout', n]),
    newChat: (s) => calls.push(['newChat', s]),
    reload: (s) => calls.push(['reload', s]),
    currentUrl: (s) => current[s],
    loadUrl: (s, u) => {
      calls.push(['loadUrl', s, u])
      if (u.includes('hang')) return new Promise(() => {}) // a page that never finishes loading
      if (u.includes('fail')) return Promise.reject(new Error('ERR_CONNECTION_REFUSED'))
      current[s] = u
      return Promise.resolve(true)
    },
    signOut: async (s) => calls.push(['signOut', s]),
    adapterFor: (s) => (s === 'grok' ? null : adapters[s]),
    inspect: (s) => calls.push(['inspect', s]),
    focus: (s) => calls.push(['focus', s]),
    zoom: (s, d) => {
      calls.push(['zoom', s, d])
      return d === 'in' ? 1.1 : 1
    },
    slotOfSender: (event) => {
      for (const [slot, wc] of Object.entries(siteWc)) if (event && event.sender && event.sender.id === wc.id) return slot
      return null
    },
    setHealth: (s, h) => {
      health[s] = h
    },
  }
  const selectors = { current: () => ({ version: 1, chatgpt: { composer: ['#x'] }, claude: {}, grok: {} }), reload: () => calls.push(['selectors.reload']), lastError: () => null }
  const capture = { claude: false, chatgpt: false, grok: false }
  const settings = {
    getCapture: () => ({ ...capture }),
    setCapture: (s, on) => {
      capture[s] = on
      calls.push(['setCapture', s, on])
      return on
    },
  }
  const chats = { get: (convId, slot) => (convId === CONV && links[slot]) || null }
  const orchestrator = { inflight: (s) => (inflight[s] ? { reqId: 'r' } : null) }
  const sent = []
  const opened = []
  const layoutState = { mode: null, active: null }
  const snapshotsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-ipc-')), 'snapshots')
  const ipc = registerIpc({
    ipcMain,
    isRenderer: (event) => !!event && event.sender === renderer && (!event.senderFrame || !event.senderFrame.parent),
    views,
    layoutState,
    orchestrator,
    selectors,
    settings,
    chats,
    sites: fakeSites(),
    version: '0.1.0',
    dev,
    getBackend: () => backend,
    getBridgeState: () => bridge,
    snapshotsDir,
    openExternal: async (u) => opened.push(u),
    sendToRenderer: (channel, ...args) => sent.push([channel, ...args]),
    now: () => 1710000000000,
    log: fakeLog(),
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
  })
  const fromRenderer = eventFrom(renderer)
  return { ipcMain, renderer, siteWc, views, calls, sent, opened, health, layoutState, ipc, selectors, fromRenderer, capture, adapters, snapshotsDir, current }
}

const rejects = (p, re = /bad_request/) => assert.rejects(p, re)

test('validators: unknown slot, non-string / oversize text, bad targets, bad direction, boolean, conversation id', () => {
  assert.equal(requireSlot('claude'), 'claude')
  for (const bad of ['bing', '', null, undefined, 1, ['claude'], { toString: () => 'claude' }]) assert.throws(() => requireSlot(bad), /bad_request/)
  assert.deepEqual(requireTargets(['grok', 'claude', 'claude']), ['claude', 'grok'])
  assert.deepEqual(requireTargets([]), [])
  for (const bad of ['claude', null, ['claude', 'bing'], [1], { 0: 'claude' }]) assert.throws(() => requireTargets(bad), /bad_request/)
  assert.equal(requireText('x'.repeat(MAX_PROMPT_CHARS)).length, MAX_PROMPT_CHARS)
  assert.equal(requireText(''), '')
  for (const bad of ['x'.repeat(MAX_PROMPT_CHARS + 1), 42, null, undefined, ['a'], { text: 'a' }]) assert.throws(() => requireText(bad), /bad_request/)
  for (const d of ['in', 'out', 'reset']) assert.equal(requireDirection(d), d)
  for (const bad of ['IN', 'up', '', null, 1]) assert.throws(() => requireDirection(bad), /bad_request/)
  assert.deepEqual(requireActive({ mode: 'tabs', active: 'grok', extra: 1 }), { mode: 'tabs', active: 'grok' })
  for (const bad of [null, [], { mode: 'grid', active: 'grok' }, { mode: 'tabs' }, { mode: 'tabs', active: 'bing' }]) assert.throws(() => requireActive(bad), /bad_request/)
  assert.equal(requireBoolean(true), true)
  assert.equal(requireBoolean(false), false)
  for (const bad of ['true', 1, 0, null, undefined, {}]) assert.throws(() => requireBoolean(bad), /bad_request/)
  assert.equal(requireConvId(null), null)
  assert.equal(requireConvId(undefined), null)
  assert.equal(requireConvId(CONV), CONV)
  assert.equal(requireConvId('x'.repeat(MAX_CONV_ID_CHARS)).length, MAX_CONV_ID_CHARS)
  for (const bad of ['', 42, {}, [], 'x'.repeat(MAX_CONV_ID_CHARS + 1)]) assert.throws(() => requireConvId(bad), /bad_request/)
  assert.equal(snapshotFileName('grok', 1710000000000.4), 'grok-1710000000000.html')
  assert.throws(() => snapshotFileName('bing', 1), /bad_request/)
})

test('every renderer channel rejects bad_request for a non-renderer sender (a site view, a sub-frame, no sender)', async () => {
  const { ipcMain, siteWc, renderer } = setup()
  const foreign = eventFrom(siteWc.claude)
  const subframe = { sender: renderer, senderFrame: { parent: {} } }
  for (const ev of [foreign, subframe, { sender: null }, undefined]) {
    await rejects(ipcMain.invoke('panes:getInfo', ev))
    await rejects(ipcMain.invoke('panes:newChat', ev, ['claude']))
    await rejects(ipcMain.invoke('panes:reload', ev, 'claude'))
    await rejects(ipcMain.invoke('panes:openExternal', ev, 'claude'))
    await rejects(ipcMain.invoke('panes:inspect', ev, 'claude'))
    await rejects(ipcMain.invoke('panes:focus', ev, 'claude'))
    await rejects(ipcMain.invoke('panes:zoom', ev, 'claude', 'in'))
    await rejects(ipcMain.invoke('panes:getCapture', ev))
    await rejects(ipcMain.invoke('panes:setCapture', ev, 'claude', true))
    await rejects(ipcMain.invoke('panes:openChats', ev, null))
    await rejects(ipcMain.invoke('panes:signOut', ev, 'claude'))
    await rejects(ipcMain.invoke('panes:snapshot', ev, 'claude'))
  }
})

test('fire-and-forget channels from a non-renderer sender are dropped silently', () => {
  const { ipcMain, siteWc, calls, layoutState } = setup()
  ipcMain.emit('panes:layout', eventFrom(siteWc.claude), { claude: { x: 0, y: 0, width: 5, height: 5 } })
  ipcMain.emit('panes:active', eventFrom(siteWc.claude), { mode: 'tabs', active: 'claude' })
  assert.deepEqual(calls, [])
  assert.deepEqual(layoutState, { mode: null, active: null })
})

test('single-slot channels reject an unknown slot; zoom rejects a bad direction; setCapture / openChats reject bad payloads', async () => {
  const { ipcMain, fromRenderer, calls } = setup()
  for (const channel of ['panes:reload', 'panes:openExternal', 'panes:inspect', 'panes:focus', 'panes:signOut', 'panes:snapshot']) {
    await rejects(ipcMain.invoke(channel, fromRenderer, 'bing'))
    await rejects(ipcMain.invoke(channel, fromRenderer, 7))
  }
  await rejects(ipcMain.invoke('panes:zoom', fromRenderer, 'bing', 'in'))
  await rejects(ipcMain.invoke('panes:zoom', fromRenderer, 'claude', 'up'))
  await rejects(ipcMain.invoke('panes:newChat', fromRenderer, ['claude', 'bing']))
  await rejects(ipcMain.invoke('panes:newChat', fromRenderer, 'claude'))
  await rejects(ipcMain.invoke('panes:setCapture', fromRenderer, 'bing', true))
  await rejects(ipcMain.invoke('panes:setCapture', fromRenderer, 'claude', 'yes'))
  await rejects(ipcMain.invoke('panes:setCapture', fromRenderer, 'claude'))
  await rejects(ipcMain.invoke('panes:openChats', fromRenderer, 42))
  await rejects(ipcMain.invoke('panes:openChats', fromRenderer, ''))
  assert.deepEqual(calls, [], 'nothing reached the views or settings')
})

test('prompt:send is gone (§2, removed in Stage 2): no handler is registered on that channel', () => {
  const { ipcMain } = setup()
  assert.equal(ipcMain.handlers.has('prompt:send'), false)
  assert.equal(ipcMain.listeners.has('prompt:send'), false)
})

test('panes:getInfo reports version, dev, public sites, the layout once known and the backend when one is known', async () => {
  const { ipcMain, fromRenderer } = setup()
  const info = await ipcMain.invoke('panes:getInfo', fromRenderer)
  assert.equal(info.version, '0.1.0')
  assert.equal(info.dev, true)
  assert.equal(info.backend, null)
  assert.equal(info.layout, null)
  assert.deepEqual(Object.keys(info.sites), ['claude', 'chatgpt', 'grok'])
  assert.deepEqual(info.sites.claude, { url: 'http://127.0.0.1:5199/?site=claude', newChatUrl: 'http://127.0.0.1:5199/?site=claude', partition: 'persist:claude' })
  assert.equal('hosts' in info.sites.claude, false)
  ipcMain.emit('panes:active', fromRenderer, { mode: 'tabs', active: 'grok' })
  assert.deepEqual((await ipcMain.invoke('panes:getInfo', fromRenderer)).layout, { mode: 'tabs', active: 'grok' })

  const withBackend = setup({ backend: { port: 8021, url: 'http://127.0.0.1:8021', extra: 'dropped' } })
  assert.deepEqual((await withBackend.ipcMain.invoke('panes:getInfo', withBackend.fromRenderer)).backend, { port: 8021, url: 'http://127.0.0.1:8021' })
  const bogus = setup({ backend: { port: '8021' } })
  assert.equal((await bogus.ipcMain.invoke('panes:getInfo', bogus.fromRenderer)).backend, null)
})

test('panes:getInfo replays the cached health, the zoom factor of every view and the bridge state (the renderer subscribes before it asks)', async () => {
  const { ipcMain, fromRenderer, views, sent, siteWc } = setup({ bridge: { connected: true, since: 1710000000000 } })
  const h = { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: '#p', send: 'b', reply: null, stop: null, error: null }, url: 'u', host: 'h', title: 't', ts: 1 }
  const cache = { grok: h }
  views.slots = () => ['claude', 'chatgpt', 'grok']
  views.getHealth = (slot) => cache[slot] || null
  views.zoomFactor = (slot) => (slot === 'claude' ? 1.5 : 1)
  const info = await ipcMain.invoke('panes:getInfo', fromRenderer)
  assert.equal(info.version, '0.1.0')
  assert.deepEqual(sent, [
    ['panes:zoom', { slot: 'claude', factor: 1.5 }],
    ['panes:zoom', { slot: 'chatgpt', factor: 1 }],
    ['panes:health', 'grok', h],
    ['panes:zoom', { slot: 'grok', factor: 1 }],
    ['panes:bridge', { connected: true, since: 1710000000000 }],
  ])
  sent.length = 0
  await rejects(ipcMain.invoke('panes:getInfo', eventFrom(siteWc.claude)))
  assert.deepEqual(sent, [], 'a refused caller gets no replay')
  // a view manager without the getters (older fakes) → getInfo still answers, only the bridge state replayed
  delete views.getHealth
  delete views.zoomFactor
  assert.equal((await ipcMain.invoke('panes:getInfo', fromRenderer)).dev, true)
  assert.deepEqual(sent, [['panes:bridge', { connected: true, since: 1710000000000 }]])
  const off = setup({ bridge: { connected: false } })
  await off.ipcMain.invoke('panes:getInfo', off.fromRenderer)
  assert.deepEqual(off.sent.filter(([c]) => c === 'panes:bridge'), [['panes:bridge', { connected: false }]])
  // a backend that could not be spawned (a port already in use): the error text travels with the state
  const failed = setup({ bridge: { connected: false, error: 'http://127.0.0.1:8021/ already answers: another server owns port 8021' } })
  await failed.ipcMain.invoke('panes:getInfo', failed.fromRenderer)
  assert.deepEqual(failed.sent.filter(([c]) => c === 'panes:bridge'), [['panes:bridge', { connected: false, error: 'http://127.0.0.1:8021/ already answers: another server owns port 8021' }]])
  assert.deepEqual(publicBridgeState({ connected: true, since: 5, error: 'stale' }), { connected: true, since: 5 }, 'connected: no error text')
  assert.deepEqual(publicBridgeState({ connected: false, error: '' }), { connected: false })
  assert.deepEqual(publicBridgeState({ connected: false, error: 42 }), { connected: false })
})

test('panes:layout normalizes and applies; panes:active validates and stores', () => {
  const { ipcMain, fromRenderer, calls, layoutState } = setup()
  ipcMain.emit('panes:layout', fromRenderer, { claude: { x: 0.4, y: 1.6, width: 0, height: 10 }, chatgpt: null })
  assert.deepEqual(calls, [['applyLayout', { claude: { x: 0, y: 2, width: 1, height: 10 }, chatgpt: null, grok: null, analyst: null }]])
  ipcMain.emit('panes:active', fromRenderer, { mode: 'split', active: 'claude' })
  assert.deepEqual(layoutState, { mode: 'split', active: 'claude' })
  ipcMain.emit('panes:active', fromRenderer, { mode: 'nope', active: 'claude' })
  assert.deepEqual(layoutState, { mode: 'split', active: 'claude' }, 'a bad payload leaves the state alone')
})

test('newChat / reload / openExternal / inspect / focus / zoom drive the view manager', async () => {
  const { ipcMain, fromRenderer, calls, opened, sent } = setup()
  await ipcMain.invoke('panes:newChat', fromRenderer, ['grok', 'claude', 'grok'])
  assert.deepEqual(calls.splice(0), [['newChat', 'claude'], ['newChat', 'grok']])
  await ipcMain.invoke('panes:reload', fromRenderer, 'chatgpt')
  assert.deepEqual(calls.splice(0), [['selectors.reload'], ['reload', 'chatgpt']], 'Reload re-reads the selectors override first')
  await ipcMain.invoke('panes:openExternal', fromRenderer, 'claude')
  await ipcMain.invoke('panes:openExternal', fromRenderer, 'grok') // javascript: URL → never opened
  assert.deepEqual(opened, ['https://claude.test/c/1'])
  await ipcMain.invoke('panes:inspect', fromRenderer, 'claude')
  await ipcMain.invoke('panes:focus', fromRenderer, 'grok')
  assert.deepEqual(calls.splice(0), [['inspect', 'claude'], ['focus', 'grok']])
  assert.deepEqual(await ipcMain.invoke('panes:zoom', fromRenderer, 'claude', 'in'), { factor: 1.1 })
  assert.deepEqual(calls.splice(0), [['zoom', 'claude', 'in']])
  assert.deepEqual(sent, [['panes:zoom', { slot: 'claude', factor: 1.1 }]])
})

test('panes:inspect is a no-op outside dev', async () => {
  const { ipcMain, fromRenderer, calls } = setup({ dev: false })
  await ipcMain.invoke('panes:inspect', fromRenderer, 'claude')
  assert.deepEqual(calls, [])
})

test('panes:getCapture / panes:setCapture read and write the settings switches', async () => {
  const { ipcMain, fromRenderer, calls, capture } = setup()
  assert.deepEqual(await ipcMain.invoke('panes:getCapture', fromRenderer), { claude: false, chatgpt: false, grok: false })
  assert.equal(await ipcMain.invoke('panes:setCapture', fromRenderer, 'grok', true), undefined)
  assert.deepEqual(calls, [['setCapture', 'grok', true]])
  assert.deepEqual(capture, { claude: false, chatgpt: false, grok: true })
  assert.deepEqual(await ipcMain.invoke('panes:getCapture', fromRenderer), { claude: false, chatgpt: false, grok: true })
  await ipcMain.invoke('panes:setCapture', fromRenderer, 'grok', false)
  assert.equal(capture.grok, false)
})

test('panes:openChats: a differing link → navigated; the same link → kept; no link → new (or kept when already on newChatUrl); a busy view is kept; null leaves every pane where it is', async () => {
  const { ipcMain, fromRenderer, calls, sent } = setup({
    links: { claude: 'https://claude.test/c/old', chatgpt: 'https://chatgpt.test/c/1' },
    urls: { grok: 'http://127.0.0.1:5199/?site=grok' },
  })
  assert.deepEqual(await ipcMain.invoke('panes:openChats', fromRenderer, CONV), { claude: 'navigated', chatgpt: 'kept', grok: 'kept' })
  assert.deepEqual(calls, [['loadUrl', 'claude', 'https://claude.test/c/old']])
  assert.deepEqual(sent, [['panes:turn', { slot: 'claude', phase: 'idle' }]])
  calls.length = 0
  assert.deepEqual(await ipcMain.invoke('panes:openChats', fromRenderer, CONV), { claude: 'kept', chatgpt: 'kept', grok: 'kept' }, 'already there')
  assert.deepEqual(calls, [])
  assert.deepEqual(await ipcMain.invoke('panes:openChats', fromRenderer, 'unknown-conv'), { claude: 'new', chatgpt: 'new', grok: 'kept' })
  assert.deepEqual(calls, [['newChat', 'claude'], ['newChat', 'chatgpt']])
  calls.length = 0
  sent.length = 0
  assert.deepEqual(await ipcMain.invoke('panes:openChats', fromRenderer, null), { claude: 'kept', chatgpt: 'kept', grok: 'kept' }, '§2: null = the open conversation was cleared — main leaves the panes where they are')
  assert.deepEqual(calls, [], 'no newChat / loadUrl for null')
  assert.deepEqual(sent, [], 'no panes:turn for null')
  const onChats = setup({ links: { claude: 'https://claude.test/c/1', chatgpt: 'https://chatgpt.test/c/1' } })
  assert.deepEqual(await onChats.ipcMain.invoke('panes:openChats', onChats.fromRenderer, null), { claude: 'kept', chatgpt: 'kept', grok: 'kept' }, 'panes sitting on chats stay on them after a delete')
  assert.deepEqual(onChats.calls, [])

  const busy = setup({ links: { claude: 'https://claude.test/c/old' }, inflight: { claude: true } })
  assert.equal((await busy.ipcMain.invoke('panes:openChats', busy.fromRenderer, CONV)).claude, 'kept', 'a turn in flight is never navigated away')
  assert.deepEqual(busy.calls.filter(([c]) => c === 'loadUrl'), [])

  const failing = setup({ links: { claude: 'https://claude.test/c/fail' } })
  assert.equal((await failing.ipcMain.invoke('panes:openChats', failing.fromRenderer, CONV)).claude, 'kept', 'a failed load is reported as kept, not thrown')
})

test('panes:openChats opens the three panes in parallel and bounds each load: a pane still loading after OPEN_CHATS_LOAD_TIMEOUT_MS is reported kept while the others answer', async () => {
  const timers = fakeTimers()
  const { ipcMain, fromRenderer, calls, sent } = setup({
    timers,
    links: { claude: 'https://claude.test/c/hang-1', chatgpt: 'https://chatgpt.test/c/hang-2', grok: 'https://grok.test/c/ok' },
    urls: { grok: 'https://grok.test/' },
  })
  const invoked = ipcMain.invoke('panes:openChats', fromRenderer, CONV)
  let settled = null
  invoked.then((v) => {
    settled = v
  })
  for (let i = 0; i < 4; i++) await tick()
  assert.deepEqual(calls, [
    ['loadUrl', 'claude', 'https://claude.test/c/hang-1'],
    ['loadUrl', 'chatgpt', 'https://chatgpt.test/c/hang-2'],
    ['loadUrl', 'grok', 'https://grok.test/c/ok'],
  ], 'all three loads are issued before any of them settles (no serial await)')
  assert.equal(settled, null, 'two panes are still loading')
  assert.deepEqual(sent, [['panes:turn', { slot: 'grok', phase: 'idle' }]], 'the pane that loaded already reported')
  timers.advance(OPEN_CHATS_LOAD_TIMEOUT_MS - 1)
  for (let i = 0; i < 4; i++) await tick()
  assert.equal(settled, null)
  timers.advance(1)
  for (let i = 0; i < 4; i++) await tick()
  assert.deepEqual(settled, { claude: 'kept', chatgpt: 'kept', grok: 'navigated' }, 'a load that never finishes within the bound is kept (the load itself goes on)')
  assert.equal(timers.pending(), 0, 'the bounds are cleared')
  assert.equal(sent.length, 1, 'no panes:turn for the panes that were kept')
})

test('panes:signOut drives views.signOut for that slot only', async () => {
  const { ipcMain, fromRenderer, calls } = setup()
  await ipcMain.invoke('panes:signOut', fromRenderer, 'chatgpt')
  assert.deepEqual(calls, [['signOut', 'chatgpt']])
})

test('panes:snapshot asks the adapter for a snapshot and writes <slot>-<ts>.html under snapshots/; a dead view or a bad answer fails', async () => {
  const { ipcMain, fromRenderer, adapters, snapshotsDir } = setup({ snapshotHtml: '<html><body><div id="x">…</div></body></html>' })
  const { path: file } = await ipcMain.invoke('panes:snapshot', fromRenderer, 'claude')
  assert.equal(file, path.join(snapshotsDir, 'claude-1710000000000.html'))
  assert.equal(fs.readFileSync(file, 'utf8'), '<html><body><div id="x">…</div></body></html>')
  assert.deepEqual(adapters.claude.requests, [['snapshot', {}, { timeoutMs: 15000 }]])
  await assert.rejects(ipcMain.invoke('panes:snapshot', fromRenderer, 'grok'), /view_crashed/)
  const bad = setup({ snapshotHtml: 42 })
  await assert.rejects(bad.ipcMain.invoke('panes:snapshot', bad.fromRenderer, 'claude'), /site_error/)
  const err = new Error('op snapshot in flight')
  err.code = 'busy'
  const busy = setup({ snapshotHtml: err })
  await assert.rejects(busy.ipcMain.invoke('panes:snapshot', busy.fromRenderer, 'claude'), /op snapshot in flight/)
})

test('adapter:config is resolved by sender id: a site view gets its slot + the FULL merged config, others site:null', async () => {
  const { ipcMain, siteWc, renderer, selectors } = setup()
  const cfg = await ipcMain.invoke('adapter:config', eventFrom(siteWc.chatgpt))
  assert.deepEqual(cfg, { site: 'chatgpt', selectors: selectors.current(), dev: true })
  assert.deepEqual(Object.keys(cfg.selectors), ['version', 'chatgpt', 'claude', 'grok'])
  const popup = await ipcMain.invoke('adapter:config', eventFrom(fakeWebContents({ id: 555 })))
  assert.equal(popup.site, null)
  assert.equal((await ipcMain.invoke('adapter:config', eventFrom(renderer))).site, null)
})

test('triplex:adapter:health from a site view is cached and forwarded as panes:health; foreign / malformed dropped', () => {
  const { ipcMain, siteWc, renderer, sent, health } = setup()
  const h = { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: '#p', send: 'b', reply: null, stop: null, error: null }, url: 'u', host: 'h', title: 't', ts: 1 }
  ipcMain.emit('triplex:adapter:health', eventFrom(siteWc.grok), h)
  assert.deepEqual(sent, [['panes:health', 'grok', h]])
  assert.deepEqual(health.grok, h)
  ipcMain.emit('triplex:adapter:health', eventFrom(renderer), h)
  ipcMain.emit('triplex:adapter:health', eventFrom(siteWc.grok), 'nope')
  ipcMain.emit('triplex:adapter:health', eventFrom(siteWc.grok), null)
  assert.equal(sent.length, 1)
})

test('a selectors error is stamped into health.matched.error unless the adapter reported its own', () => {
  const base = { session: 'ok', matched: { composer: '#p', send: null, reply: null, stop: null, error: null } }
  assert.equal(annotateHealth(base, null), base)
  assert.equal(annotateHealth(base, 'x.json: bad').matched.error, 'x.json: bad')
  assert.equal(annotateHealth(base, 'x.json: bad').matched.composer, '#p')
  const own = { session: 'ok', matched: { error: 'adapter says' } }
  assert.equal(annotateHealth(own, 'x.json: bad').matched.error, 'adapter says')
  assert.equal(annotateHealth({ session: 'ok' }, 'e').matched.error, 'e')
})

test('dispose() removes every handler and listener', () => {
  const { ipcMain, ipc } = setup()
  assert.ok(ipcMain.handlers.size > 0)
  ipc.dispose()
  assert.equal(ipcMain.handlers.size, 0)
  for (const list of ipcMain.listeners.values()) assert.equal(list.length, 0)
})
