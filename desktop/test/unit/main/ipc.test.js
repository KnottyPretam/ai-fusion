// ipc.js — validation (unknown slot / non-string / oversize text / non-renderer sender rejected),
// every panes:* channel, prompt:send, adapter:config by sender, health forwarding, the cached
// health + zoom replayed after panes:getInfo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerIpc, requireSlot, requireTargets, requireText, requireDirection, requireActive, requirePrompt, annotateHealth, MAX_PROMPT_CHARS } from '../../../main/ipc.js'
import { fakeIpcMain, fakeWebContents, eventFrom, fakeLog, fakeSites } from './_fakes.js'

function setup({ dev = true } = {}) {
  const ipcMain = fakeIpcMain()
  const renderer = fakeWebContents({ id: 1 })
  const siteWc = { claude: fakeWebContents({ id: 11 }), chatgpt: fakeWebContents({ id: 12 }), grok: fakeWebContents({ id: 13 }) }
  const calls = []
  const health = {}
  const views = {
    applyLayout: (n) => calls.push(['applyLayout', n]),
    newChat: (s) => calls.push(['newChat', s]),
    reload: (s) => calls.push(['reload', s]),
    currentUrl: (s) => (s === 'grok' ? 'javascript:alert(1)' : `https://${s}.test/c/1`),
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
  const orchestrator = { submitAll: async (req) => ({ results: { echo: req } }) }
  const sent = []
  const opened = []
  const layoutState = { mode: null, active: null }
  const ipc = registerIpc({
    ipcMain,
    isRenderer: (event) => !!event && event.sender === renderer && (!event.senderFrame || !event.senderFrame.parent),
    views,
    layoutState,
    orchestrator,
    selectors,
    sites: fakeSites(),
    version: '0.1.0',
    dev,
    openExternal: async (u) => opened.push(u),
    sendToRenderer: (channel, ...args) => sent.push([channel, ...args]),
    log: fakeLog(),
  })
  const fromRenderer = eventFrom(renderer)
  return { ipcMain, renderer, siteWc, views, calls, sent, opened, health, layoutState, ipc, selectors, fromRenderer }
}

const rejects = (p, re = /bad_request/) => assert.rejects(p, re)

test('validators: unknown slot, non-string / oversize text, bad targets, bad direction', () => {
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
  assert.deepEqual(requirePrompt({ targets: ['chatgpt'], text: 'hi' }), { targets: ['chatgpt'], text: 'hi' })
  for (const bad of [null, 'x', { targets: 'chatgpt', text: 'hi' }, { targets: ['chatgpt'] }, { targets: ['chatgpt'], text: 1 }]) assert.throws(() => requirePrompt(bad), /bad_request/)
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
    await rejects(ipcMain.invoke('prompt:send', ev, { targets: ['claude'], text: 'x' }))
  }
})

test('fire-and-forget channels from a non-renderer sender are dropped silently', () => {
  const { ipcMain, siteWc, calls, layoutState } = setup()
  ipcMain.emit('panes:layout', eventFrom(siteWc.claude), { claude: { x: 0, y: 0, width: 5, height: 5 } })
  ipcMain.emit('panes:active', eventFrom(siteWc.claude), { mode: 'tabs', active: 'claude' })
  assert.deepEqual(calls, [])
  assert.deepEqual(layoutState, { mode: null, active: null })
})

test('single-slot channels reject an unknown slot; zoom rejects a bad direction; prompt:send rejects bad bodies', async () => {
  const { ipcMain, fromRenderer } = setup()
  for (const channel of ['panes:reload', 'panes:openExternal', 'panes:inspect', 'panes:focus']) {
    await rejects(ipcMain.invoke(channel, fromRenderer, 'bing'))
    await rejects(ipcMain.invoke(channel, fromRenderer, 7))
  }
  await rejects(ipcMain.invoke('panes:zoom', fromRenderer, 'bing', 'in'))
  await rejects(ipcMain.invoke('panes:zoom', fromRenderer, 'claude', 'up'))
  await rejects(ipcMain.invoke('panes:newChat', fromRenderer, ['claude', 'bing']))
  await rejects(ipcMain.invoke('panes:newChat', fromRenderer, 'claude'))
  await rejects(ipcMain.invoke('prompt:send', fromRenderer, { targets: ['bing'], text: 'x' }))
  await rejects(ipcMain.invoke('prompt:send', fromRenderer, { targets: ['claude'], text: 42 }))
  await rejects(ipcMain.invoke('prompt:send', fromRenderer, { targets: ['claude'], text: 'x'.repeat(MAX_PROMPT_CHARS + 1) }))
  await rejects(ipcMain.invoke('prompt:send', fromRenderer, null))
})

test('panes:getInfo reports version, dev, public sites and the layout once known', async () => {
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
})

test('panes:getInfo replays the cached health and the zoom factor of every view (the renderer subscribes before it asks)', async () => {
  const { ipcMain, fromRenderer, views, sent, siteWc } = setup()
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
  ])
  sent.length = 0
  await rejects(ipcMain.invoke('panes:getInfo', eventFrom(siteWc.claude)))
  assert.deepEqual(sent, [], 'a refused caller gets no replay')
  // a view manager without the getters (older fakes) → getInfo still answers, nothing replayed
  delete views.getHealth
  delete views.zoomFactor
  assert.equal((await ipcMain.invoke('panes:getInfo', fromRenderer)).dev, true)
  assert.deepEqual(sent, [])
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

test('prompt:send validates then hands {targets (normalized), text} to the orchestrator', async () => {
  const { ipcMain, fromRenderer } = setup()
  const text = 'hello `x` "y" ${z}\nline2'
  const out = await ipcMain.invoke('prompt:send', fromRenderer, { targets: ['grok', 'claude', 'claude'], text })
  assert.deepEqual(out, { results: { echo: { targets: ['claude', 'grok'], text } } })
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
