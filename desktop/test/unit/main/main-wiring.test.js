// main.js wiring — the real desktop/main/main.js run under Node with a fake `electron` module
// (test/unit/main/_fake-electron.mjs, substituted by a module.register resolve hook). Proves the
// preflight (flags, TRIPLEX_USER_DATA_DIR, loopback refusal of URLs and trusted hosts), the window
// + three views with the hardened webPreferences, every IPC channel (Stage 1 + Stage 2), the
// shortcut path, health forwarding (renderer + bridge), the bridge handshake over a fake WebSocket
// (hello with the attach token, hello_ack, capture / health frames, one request → accepted →
// ready → insertAndSubmit → observe → result, the chat link recorded in chats.json, a cancel, the
// banner state on a drop), no prompt:send handler, openChats (null → every pane kept) / signOut /
// snapshot, a request holding `ready` until a New-chat navigation commits, the renderer's origin
// guard + foreign-frame IPC refusal, child-window / redirect / backstop policy, the Bluetooth
// chooser, the health + zoom + bridge + analyst + theme replay, the theme channel (settings.json →
// nativeTheme.themeSource + panes:theme), the export channel (validated in main and pointed at the
// attached backend), crash recreation, the bounds → settings.json
// flush on close and the Stage 3 hidden analyst page (hello.analyst, a `web:chatgpt:analyst` request
// creating the view lazily on persist:chatgpt and observing with capture off, auto-reveal on a
// challenge, the `analyst` rect, panes:setAnalyst switching the partition + the `analyst` frame +
// the next spawn's ANALYST_MODEL, analyst_not_chosen);
// TRIPLEX_BACKEND_URL on a non-loopback host refused (exit 2) unless
// TRIPLEX_ALLOW_REMOTE_BACKEND=1. The fake forces TRIPLEX_BACKEND_URL (attach mode): a wiring run
// never spawns a backend and never opens a real socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..', '..', '..')
const MAIN = path.join(DESKTOP, 'main', 'main.js')
const REGISTER = path.join(HERE, '_register-fake-electron.mjs')
const FAKE_BASE = 'http://127.0.0.1:5199'
const SLOTS = ['claude', 'chatgpt', 'grok']
const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const ATTACH_URL = 'http://127.0.0.1:1'

function sitesJson(base = FAKE_BASE) {
  const sites = {}
  for (const slot of SLOTS) sites[slot] = { url: `${base}/?site=${slot}`, newChatUrl: `${base}/?site=${slot}`, hosts: ['127.0.0.1', 'localhost'] }
  return JSON.stringify(sites)
}

/** A selectors override pointing every chatUrlPattern at the fake site (the wiring probe records a chat link). */
function writeSelectorsOverride(userData) {
  const override = {}
  for (const slot of SLOTS) override[slot] = { chatUrlPattern: '^http://127\\.0\\.0\\.1:5199/c/[A-Za-z0-9]+' }
  fs.writeFileSync(path.join(userData, 'selectors.json'), JSON.stringify(override))
}

function run(env) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
  const r = spawnSync(process.execPath, ['--import', REGISTER, MAIN], { cwd: DESKTOP, env: { ...clean, TRIPLEX_BACKEND_URL: ATTACH_URL, BRIDGE_TOKEN: 'wiring', ...env }, encoding: 'utf8', timeout: 30000 })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('FAKE_ELECTRON_REPORT '))
  return { status: r.status, report: line ? JSON.parse(line.slice('FAKE_ELECTRON_REPORT '.length)) : null, stderr: r.stderr, stdout: r.stdout }
}

test('happy path: userData, window, three hardened views, IPC, shortcuts, health, the bridge round trip, Stage 2 channels, the Stage 3 analyst page, crash recreate, bounds flush', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-'))
  writeSelectorsOverride(userData)
  const { status, report, stderr } = run({ TRIPLEX_USER_DATA_DIR: userData, TRIPLEX_E2E_APP: '1', TRIPLEX_SITES_JSON: sitesJson(), TRIPLEX_RENDERER_URL: 'http://localhost:5184' })
  assert.equal(status, 0, stderr)
  assert.ok(report, 'report printed')
  assert.equal(report.exit, null)
  assert.equal(report.paths.userData, userData)
  assert.equal(report.singleInstanceRequested, true)

  // renderer window: sandboxed, isolated, renderer preload, loads TRIPLEX_RENDERER_URL, hidden menu bar
  assert.equal(report.windows.length, 1)
  const win = report.windows[0]
  assert.equal(win.options.webPreferences.sandbox, true)
  assert.equal(win.options.webPreferences.contextIsolation, true)
  assert.equal(win.options.webPreferences.nodeIntegration, false)
  assert.ok(win.options.webPreferences.preload.endsWith(path.join('preload', 'renderer.cjs')))
  assert.equal(win.options.autoHideMenuBar, true)
  assert.deepEqual(win.loads, ['http://localhost:5184'])
  assert.deepEqual([win.options.width, win.options.height], [1600, 900])
  // the stored theme's ground is in the constructor options: nothing flashes white while the
  // renderer URL loads (default theme = dark, and loadWithRetry can retry for seconds)
  assert.equal(win.options.backgroundColor, '#0d1117', 'a dark launch paints the dark --bg, not Electron’s white')

  // three views, one per slot, in SLOTS order, each on its partition with the site preload, unthrottled
  // three panes + the lazily created analyst view (persist:chatgpt) + its replacement after
  // setAnalyst('claude') + the pane recreated by the crash probe
  assert.equal(report.views.length, 6, 'three panes, two analyst views, one recreated pane')
  const views = report.views.slice(0, 3)
  SLOTS.forEach((slot, i) => {
    const wp = views[i].options.webPreferences
    assert.equal(wp.partition, `persist:${slot}`)
    assert.equal(wp.sandbox, true)
    assert.equal(wp.contextIsolation, true)
    assert.equal(wp.nodeIntegration, false)
    assert.equal(wp.backgroundThrottling, false)
    assert.ok(wp.preload.endsWith(path.join('preload', 'site.cjs')))
    assert.equal(views[i].loads[0], `${FAKE_BASE}/?site=${slot}`)
  })
  assert.deepEqual([...report.sessions].sort(), ['default', 'persist:chatgpt', 'persist:claude', 'persist:grok'])

  // every §2 channel is registered once; prompt:send (removed in Stage 2) is not registered at all
  const handles = report.ipcHandles
  for (const c of ['panes:getInfo', 'panes:newChat', 'panes:reload', 'panes:openExternal', 'panes:inspect', 'panes:focus', 'panes:zoom', 'adapter:config', 'panes:getCapture', 'panes:setCapture', 'panes:openChats', 'panes:signOut', 'panes:snapshot', 'panes:setAnalyst', 'panes:showAnalyst', 'panes:export']) {
    assert.equal(handles.filter((h) => h === c).length, 1, c)
  }
  assert.equal(handles.includes('prompt:send'), false, 'prompt:send is gone')
  for (const c of ['panes:layout', 'panes:active', 'triplex:adapter:health', 'triplex:adapter:result']) assert.ok(report.ipcOns.includes(c), c)

  // the application menu: the accelerator table + the Site menu
  assert.ok(report.menu)
  assert.deepEqual(report.menu.labels, ['Triplex', 'Panes', 'Site', 'Edit'])
  for (const a of ['CommandOrControl+1', 'CommandOrControl+2', 'CommandOrControl+3', 'CommandOrControl+\\', 'CommandOrControl+L', 'CommandOrControl+Shift+N', 'CommandOrControl+=', 'CommandOrControl+-', 'CommandOrControl+0', 'CommandOrControl+R', 'F12']) {
    assert.ok(report.menu.accelerators.includes(a), a)
  }
  for (const label of ['Reload pane', 'Inspect pane', 'Reload selectors', 'Save DOM snapshot of the active pane', 'Show analyst page', 'Sign out of Claude', 'Sign out of ChatGPT', 'Sign out of Grok']) {
    assert.ok(report.menu.items.includes(label), label)
  }

  const p = report.probes
  assert.ok(p && !p.error, JSON.stringify(p))
  assert.equal(p.getInfo.ok, true)
  assert.equal(p.getInfo.value.version, '0.1.0')
  assert.equal(p.getInfo.value.dev, true)
  assert.equal(p.getInfo.value.layout, null)
  assert.deepEqual(p.getInfo.value.backend, { port: 1, url: ATTACH_URL }, 'getInfo().backend = the attached backend')
  assert.deepEqual(p.getInfo.value.sites.claude, { url: `${FAKE_BASE}/?site=claude`, newChatUrl: `${FAKE_BASE}/?site=claude`, partition: 'persist:claude' })
  assert.deepEqual(p.getInfoFromView, { ok: false, error: 'bad_request' }, 'a site view is not the renderer')
  assert.equal(p.adapterConfigView.ok, true)
  assert.equal(p.adapterConfigView.value.site, 'chatgpt')
  assert.deepEqual(Object.keys(p.adapterConfigView.value.selectors), ['version', 'chatgpt', 'claude', 'grok'])
  assert.equal(p.adapterConfigView.value.selectors.claude.chatUrlPattern, '^http://127\\.0\\.0\\.1:5199/c/[A-Za-z0-9]+', 'the override is merged')
  assert.equal(p.adapterConfigView.value.dev, true)
  assert.equal(p.adapterConfigPopup.value.site, null)
  assert.deepEqual(p.badSlot, { ok: false, error: 'bad_request' })
  assert.equal(p.promptSendHandled, false, 'no prompt:send handler')
  assert.deepEqual(p.newChatForeign, { ok: false, error: 'bad_request' }, 'a site view is not the renderer')

  assert.deepEqual(p.layout, [
    { bounds: { x: 0, y: 100, width: 500, height: 600 }, visible: true },
    { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false },
    { bounds: { x: 500, y: 100, width: 500, height: 600 }, visible: true },
  ])
  assert.deepEqual(p.getInfoAfterActive.value.layout, { mode: 'tabs', active: 'grok' })

  assert.deepEqual(p.zoom, { ok: true, value: { factor: 1.1 } })
  assert.equal(p.zoomApplied, 1.1)
  assert.deepEqual(p.zoomOthers, [1, 1])

  assert.equal(p.shortcut.prevented, true, 'Ctrl+2 on a site view is consumed in main')
  assert.deepEqual(p.shortcut.sent, [['panes:shortcut', { name: 'tab-2' }]])
  assert.equal(p.shortcutZoom.prevented, true)
  assert.equal(p.shortcutZoom.activeZoom, 1.2, 'Ctrl+= zooms the ACTIVE pane (grok, from panes:active)')
  assert.deepEqual(p.shortcutZoom.sent.at(-1), ['panes:zoom', { slot: 'grok', factor: 1.2 }])

  // --- the bridge: attach mode → ws://127.0.0.1:1/api/bridge, hello with BRIDGE_TOKEN, nothing before open
  assert.deepEqual(p.socket, { url: 'ws://127.0.0.1:1/api/bridge', sentBeforeOpen: 0 })
  assert.equal(p.bridgeBeforeAck, 'connecting')
  assert.deepEqual(p.hello, { type: 'hello', protocol: 1, token: 'wiring', version: '0.1.0', sites: SLOTS, capture: { claude: false, chatgpt: false, grok: false }, analyst: { slot: 'chatgpt' } }, 'hello.analyst reflects settings.analyst (default chatgpt)')
  assert.equal(p.bridgeAfterAck.connected, true)
  assert.equal(p.bridgeAfterAck.pingS, 20)
  // every panes:getInfo before the ack replayed {connected:false}; the ack itself sent exactly one connected:true
  const replays = p.bridgeSentToRenderer.filter((s) => !s.connected)
  assert.ok(replays.length >= 1, 'the pre-ack getInfo probes replayed the bridge state')
  for (const r of replays) assert.deepEqual(r, { connected: false })
  assert.equal(p.bridgeSentToRenderer.filter((s) => s.connected).length, 1)
  assert.equal(p.bridgeSentToRenderer.at(-1).connected, true)
  assert.equal(typeof p.bridgeSentToRenderer.at(-1).since, 'number')

  // capture switch → settings + a capture frame; a bad payload is refused
  assert.deepEqual(p.getCapture, { ok: true, value: { claude: false, chatgpt: false, grok: false } })
  assert.equal(p.setCapture.ok, true)
  assert.deepEqual(p.setCaptureBad, { ok: false, error: 'bad_request' })
  assert.deepEqual(p.captureFrames, [{ type: 'capture', capture: { claude: true, chatgpt: false, grok: false } }])

  // health → renderer AND bridge
  assert.equal(p.health.length, 1)
  assert.equal(p.health[0][1], 'claude')
  assert.equal(p.health[0][2].matched.composer, '#x')
  assert.equal(p.healthFrames.length, 1)
  assert.equal(p.healthFrames[0].slot, 'claude')
  assert.equal(p.healthFrames[0].health.matched.composer, '#x')

  // request → accepted → ready → insertAndSubmit (focused under the mutex) → observe (capture on for claude) → result
  assert.deepEqual(p.accepted, [{ type: 'accepted', req_id: '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c', view: 'pane', slot: 'claude' }])
  assert.ok(p.readyMsg, 'a ready op reached the claude view')
  assert.equal(p.readyMsg.timeoutMs, 15000)
  assert.ok(p.insertMsg, 'then insertAndSubmit')
  assert.equal(p.insertMsg.text, 'hi `x`')
  assert.equal(p.viewFocusedDuringInsert, 1, 'the view was focused under the mutex before the insert')
  assert.ok(p.observeMsg, 'capture on → observe')
  assert.equal(p.observeMsg.baselineCount, 0)
  assert.equal(p.observeMsg.quietMs, 2500)
  assert.equal(p.observeMsg.timeoutMs, 300000)
  assert.equal(p.results.length, 1)
  const result = p.results[0]
  assert.equal(result.req_id, '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c')
  assert.equal(result.ok, true)
  assert.equal(result.captured, true)
  assert.equal(result.text, 'Echo: hi `x`')
  assert.equal(result.done_by, 'stop_gone')
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0)
  assert.deepEqual(p.turnEvents.slice(0, 4), [
    { slot: 'claude', phase: 'typing' },
    { slot: 'claude', phase: 'submitted' },
    { slot: 'claude', phase: 'replying' },
    { slot: 'claude', phase: 'done' },
  ])
  assert.equal(p.rendererFocusedAfterSend, 1, 'renderer focus restored once')
  assert.deepEqual(p.chatsFile, { [CONV]: { claude: 'http://127.0.0.1:5199/c/1?site=claude' } }, 'the matching navigation after the submit is recorded in chats.json')

  // a bridge cancel aborts the in-flight op (adapter cancel) and the result is `cancelled`
  assert.ok(p.cancelMsg, 'a cancel op reached the grok view')
  assert.equal(p.cancelMsg.op, 'cancel')
  assert.ok(p.cancelResult, 'the cancelled turn answered')
  assert.equal(p.cancelResult.ok, false)
  assert.equal(p.cancelResult.code, 'cancelled')

  // Stage 2 IPC: openChats navigates claude to its recorded link, the others stay on newChatUrl;
  // null (the open conversation was cleared) leaves every pane where it is — claude stays on /c/1
  assert.deepEqual(p.openChats, { ok: true, value: { claude: 'navigated', chatgpt: 'kept', grok: 'kept' } })
  assert.equal(p.openChatsLoads.claude, 'http://127.0.0.1:5199/c/1?site=claude')
  assert.deepEqual(p.openChatsNull, { ok: true, value: { claude: 'kept', chatgpt: 'kept', grok: 'kept' } })
  assert.deepEqual(p.openChatsNullLoads, [0, 0, 0], 'nothing loaded for null')
  // a request that arrives while a New-chat load is pending on its pane: accepted at once, `ready` only after the commit
  assert.deepEqual(p.pendingNavigation, { accepted: true, readyBeforeCommit: 0, readyAfterCommit: 1 })
  assert.equal(p.signOut.ok, true)
  assert.deepEqual(p.signOutCleared, { grok: 1, claude: 0 }, 'clearStorageData on the grok partition only')
  assert.equal(p.signOutLoad, `${FAKE_BASE}/?site=grok`)
  assert.equal(p.snapshot.ok, true, JSON.stringify(p.snapshot))
  assert.ok(p.snapshot.value.path.startsWith(path.join(userData, 'snapshots', 'chatgpt-')), p.snapshot.value.path)
  assert.ok(p.snapshot.value.path.endsWith('.html'))
  assert.equal(p.snapshotFile, '<html><body>…</body></html>')


  // --- Stage 3: the hidden analyst page ---------------------------------------------------------
  // nothing exists until the first analyst request; then ONE view on persist:chatgpt, hidden
  assert.equal(p.analystViewsCreated, 1, 'a web:chatgpt:analyst request creates the analyst view lazily')
  assert.deepEqual(p.analystView, {
    partition: 'persist:chatgpt',
    sitePreload: true,
    sandbox: true,
    contextIsolation: true,
    backgroundThrottling: false,
    zoom: 1,
    visible: false,
    // the initial load, then fresh:true opening a new chat
    loads: [`${FAKE_BASE}/?site=chatgpt`, `${FAKE_BASE}/?site=chatgpt`],
  })
  assert.deepEqual(p.analystAccepted, { type: 'accepted', req_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', view: 'analyst', slot: 'chatgpt' })
  assert.equal(p.analystAdapterConfig.ok, true)
  assert.equal(p.analystAdapterConfig.value.site, 'chatgpt', 'the analyst view gets the slot’s selectors, not site:null')
  assert.ok(p.analystReadyMsg, 'fresh:true navigates, then waits for the composer')
  assert.equal(p.analystReadyMsg.timeoutMs, 15000)
  assert.equal(p.analystInsertMsg.text, '<<<R1>>> claim', 'the analyst prompt is typed verbatim')
  assert.equal(p.analystFocusedDuringInsert, 1, 'the hidden view is focused under the mutex (the Stage 0 spike)')
  assert.ok(p.analystObserveMsg, 'the analyst ALWAYS observes — capture is off for chatgpt here')
  assert.equal(p.analystObserveMsg.baselineCount, 1)
  assert.equal(p.analystResult.ok, true)
  assert.equal(p.analystResult.captured, true)
  assert.equal(p.analystResult.text, '```json\n{"agreements": []}\n```')
  assert.deepEqual(p.analystPaneUntouched, { paneAdapterOps: 0, newTurnEvents: 0 }, 'the chatgpt PANE was never asked anything and reported no phase')

  // a challenge on the analyst view reveals it and never lands on the chatgpt pane chip
  assert.equal(p.analystHealthLeaked, 0, 'the analyst’s health is not that slot’s panes:health')
  const revealed = p.analystStates.at(-1)
  assert.equal(revealed.slot, 'chatgpt')
  assert.equal(revealed.visible, true, 'challenge → panes:analyst visible:true')
  assert.equal(revealed.health.session, 'challenge')
  assert.deepEqual(p.analystLayout, { bounds: { x: 10, y: 700, width: 400, height: 200 }, visible: true }, 'the analyst rect positions the revealed view')
  assert.equal(p.analystHiddenAgain, false, 'showAnalyst(false) hides it at once')

  // setAnalyst switches the partition, re-sends the `analyst` frame and updates the spawn env
  assert.deepEqual(p.setAnalyst.frames, [{ type: 'analyst', analyst: { slot: 'claude' } }])
  assert.equal(p.setAnalyst.oldDestroyed, true, 'the chatgpt analyst view is gone')
  assert.equal(p.setAnalyst.created, 2, 'one replacement view')
  assert.equal(p.setAnalyst.newPartition, 'persist:claude')
  assert.equal(p.setAnalyst.newVisible, false)
  assert.equal(p.setAnalyst.settingsAnalyst, 'claude')
  assert.equal(p.setAnalyst.spawnAnalystModel, 'web:claude:analyst', 'the next backend start gets the new ANALYST_MODEL')
  assert.deepEqual(p.setAnalystBad, { ok: false, error: 'bad_request' })

  // no analyst chosen → analyst_not_chosen, the view torn down and ANALYST_MODEL pinned to ''
  assert.equal(p.analystNotChosen.code, 'analyst_not_chosen')
  assert.deepEqual(p.analystNullState, { destroyed: true, spawnAnalystModel: '' })
  assert.equal(p.analystViewsAfterRestore, 2, 'choosing an analyst again stays lazy: no view until it is needed')

  // a socket drop → the banner state reaches the renderer; the client is scheduling a reconnect
  assert.equal(p.bridgeAfterDrop, 'closed')
  assert.deepEqual(p.bridgeSentAfterDrop.at(-1), { connected: false })
  // the probe keeps running for >1 s after the drop, so the 0.5 s backoff has opened the reconnect socket by the time the report is printed
  assert.ok(report.sockets.length >= 1)
  assert.deepEqual(report.sockets[0].closed, { code: 1006, reason: '' })
  for (const s of report.sockets) assert.equal(s.url, 'ws://127.0.0.1:1/api/bridge', 'every (re)connect targets the attached backend')

  // the renderer window is pinned to the origin of TRIPLEX_RENDERER_URL; popups go to the system browser
  assert.deepEqual(p.rendererNav, {
    foreign: true,
    same: false,
    redirect: true,
    popup: { action: 'deny' },
    opened: ['https://evil.example/', 'https://evil.example/r', 'https://evil.example/p'],
  })
  assert.deepEqual(p.foreignFrame, { ok: false, error: 'bad_request' }, 'IPC from a foreign document in the renderer webContents is refused')
  assert.equal(p.ownFrame.ok, true)
  assert.equal(p.ownFrame.value.version, '0.1.0')

  // site views: will-redirect policed (main frame only), SSO list empty under E2E, child windows policed like the opener
  assert.deepEqual(p.viewPolicy.ssoPopupUnderE2E, { action: 'deny' }, 'TRIPLEX_E2E_APP=1: no real SSO host opens in-app')
  assert.equal(p.viewPolicy.ownPopup, 'allow')
  assert.equal(p.viewPolicy.redirect, true)
  assert.equal(p.viewPolicy.subframeRedirect, false)
  assert.equal(p.viewPolicy.ownNav, false)
  assert.deepEqual(p.viewPolicy.childBackstop, { popup: { action: 'deny' }, nav: true }, 'before did-create-window the child is held by the backstop')
  assert.deepEqual(p.viewPolicy.child, { handler: true, evilPopup: { action: 'deny' }, evilNav: true, ownNav: false })
  assert.deepEqual(p.viewPolicy.opened, ['https://accounts.google.com/o/oauth2', 'https://evil.example/r', 'https://evil.example/', 'https://evil.example/2'])

  // backstop: a webContents nobody policed opens nothing and stays put
  assert.deepEqual(p.backstop, { popup: { action: 'deny' }, nav: true, redirect: true })

  // select-bluetooth-device: prevented + cancelled on the renderer, every view and stray contents; one listener each
  for (const kind of ['view', 'window', 'stray']) assert.deepEqual(p.bluetooth[kind], { prevented: true, chosen: '', listeners: 1 }, kind)

  // cached health + zoom + bridge state replayed on did-finish-load and after panes:getInfo
  const expectedReplay = [
    ['panes:health', 'claude', p.health[0][2]],
    ['panes:zoom', { slot: 'claude', factor: 1 }],
    ['panes:zoom', { slot: 'chatgpt', factor: 1 }],
    ['panes:zoom', { slot: 'grok', factor: 1.2 }],
    ['panes:bridge', { connected: false }],
    ['panes:analyst', { slot: 'chatgpt', visible: false, health: null }],
    ['panes:theme', { theme: 'light' }],
  ]
  assert.deepEqual(p.replay, expectedReplay)
  assert.deepEqual(p.replayOnGetInfo, expectedReplay)

  // theme: settings.json (default dark) is applied to nativeTheme at start; panes:setTheme
  // persists + applies + announces; a bad payload or a foreign sender changes nothing
  assert.equal(p.themeAtStart, 'dark', 'the shell default reaches nativeTheme.themeSource at start')
  // WHEN it happened is the point: the site pages only get the right prefers-color-scheme on their
  // FIRST paint if themeSource is set before any window or view exists (main.js start(), before
  // createWindow / createViewManager). The fake records the order, so moving the call fails here.
  assert.ok(report.themeSourceSets.length >= 1, 'themeSource was assigned')
  assert.deepEqual(report.themeSourceSets[0], { theme: 'dark', views: 0, windows: 0, surfaces: 0 }, 'the theme is applied before the window and every site view is created')
  assert.ok(report.themeSourceSets.slice(1).every((set) => set.surfaces > 0), 'later assignments are the runtime setTheme path')
  // every site view is created on the same ground (a dark site page over a white view flashes too),
  // and the runtime switch to 'light' repaints the live ones
  for (const v of report.views.slice(0, 3)) assert.equal(v.backgrounds[0], '#0d1117', `view on ${v.options.webPreferences.partition} created on the dark ground`)
  assert.equal(report.views[0].background, '#ffffff', 'panes:setTheme repainted the live views')
  assert.equal(p.themeInGetInfo, 'dark', 'getInfo carries the theme the renderer paints from')
  assert.deepEqual(p.setTheme, { ok: true, value: { theme: 'light' } })
  assert.equal(p.themeAfterSet, 'light', 'the SITE views follow through nativeTheme')
  assert.deepEqual(p.themeSentToRenderer, [{ theme: 'light' }])
  assert.equal(p.setThemeBad.ok, false)
  assert.equal(p.setThemeBad.error, 'bad_request')
  assert.equal(p.setThemeForeign.error, 'bad_request', 'only the renderer may set the theme')
  assert.equal(p.themeAfterBad, 'light', 'a refused call leaves themeSource alone')
  assert.equal(p.themeSettings, 'light')

  // export: registered, validated in main, and wired to the backend this launch talks to. The
  // attached backend answers nothing, so the fetch fails BEFORE any dialog opens and before any
  // print window exists — a wiring run writes nothing and adds no window.
  assert.equal(p.exportBadPayload.error, 'bad_request', 'an empty conversation id is a bad_request')
  assert.equal(p.exportBadFormat.error, 'bad_request', 'an unknown format is a bad_request')
  assert.equal(p.exportForeign.error, 'bad_request', 'only the renderer may export')
  assert.equal(p.exportUnreachable.ok, false)
  assert.equal(p.exportUnreachable.error, 'export_fetch_failed', 'the runner fetched the attached backend and failed with a code')
  assert.equal(p.exportDialogCalls, 0, 'no save dialog opens when the document could not be fetched')
  assert.equal(report.dialogSaveCalls, 0)

  assert.deepEqual(p.crashHealth, ['view_crashed'])
  assert.equal(p.recreated, 1)
  assert.equal(p.recreatedPartition, 'persist:chatgpt')

  assert.deepEqual(p.settingsFile.window, { x: 10, y: 20, width: 900, height: 700, maximized: false })
  assert.deepEqual(p.settingsFile.zoom, { claude: 1, chatgpt: 1, grok: 1.2 })
  assert.deepEqual(p.settingsFile.capture, { claude: true, chatgpt: false, grok: false }, 'the capture switch persisted')
  assert.equal(p.settingsFile.analyst, 'chatgpt')
  assert.equal(p.settingsFile.analystVisible, false)
  assert.equal(p.settingsFile.theme, 'light', 'the theme choice is persisted for the next launch')
  for (const key of ['views', 'analystViews', 'orchestrator', 'settings', 'bridge', 'chats', 'backend']) assert.ok(p.testGlobal.includes(key), key)

  // the token never reaches a log line
  assert.equal(stderr.includes('wiring'), false, 'BRIDGE_TOKEN is never logged')
})

test('saved window bounds are restored (clamped) on the next launch and maximized is honoured', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-'))
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ version: 1, window: { x: 5000, y: 5000, width: 1000, height: 700, maximized: false }, zoom: { claude: 1.5 } }))
  const { status, report } = run({ TRIPLEX_USER_DATA_DIR: userData, TRIPLEX_E2E_APP: '1', TRIPLEX_SITES_JSON: sitesJson() })
  assert.equal(status, 0)
  const win = report.windows[0]
  assert.deepEqual([win.options.x, win.options.y, win.options.width, win.options.height], [920, 380, 1000, 700], 'clamped into the 1920×1080 work area')
  assert.equal(report.views[0].options.webPreferences.zoomFactor, 1.5, 'zoom from settings')
  assert.equal(report.views[0].zoom, 1.5)
  assert.ok(report.probes.replay.some(([c, m]) => c === 'panes:zoom' && m.slot === 'claude' && m.factor === 1.5), 'the persisted zoom is replayed to the renderer on did-finish-load')
})

test('TRIPLEX_CHROMIUM_FLAGS: a flag outside the allow-list refuses to start (exit 2) before any window', () => {
  const { status, report, stderr } = run({ TRIPLEX_CHROMIUM_FLAGS: '--disable-gpu --remote-debugging-port=9222', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 2)
  assert.equal(report.exit, 2)
  assert.equal(report.windows.length, 0)
  assert.equal(report.views.length, 0)
  assert.equal(report.sockets.length, 0)
  assert.match(stderr, /--remote-debugging-port=9222.*not allow-listed/)
})

test('allowed flags and TRIPLEX_DISABLE_GPU=1 are appended to the command line; the default renderer URL is the backend /app/', () => {
  const { status, report } = run({ TRIPLEX_CHROMIUM_FLAGS: '--ignore-gpu-blocklist --use-gl=egl', TRIPLEX_DISABLE_GPU: '1', TRIPLEX_BACKEND_URL: 'http://127.0.0.1:8021', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 0)
  assert.deepEqual(report.switches, [['ignore-gpu-blocklist'], ['use-gl', 'egl'], ['disable-gpu']])
  assert.equal(report.windows.length, 1)
  assert.equal(report.views[0].loads[0], 'https://claude.ai/new', 'the real sites without TRIPLEX_SITES_JSON')
  assert.deepEqual(report.windows[0].loads, ['http://127.0.0.1:8021/app/'], 'default renderer URL = the backend /app/')
  assert.equal(report.sockets[0].url, 'ws://127.0.0.1:8021/api/bridge')
})

test('TRIPLEX_E2E_APP=1 refuses a non-loopback site URL (exit 3) before any window', () => {
  const { status, report, stderr } = run({ TRIPLEX_E2E_APP: '1', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 3)
  assert.equal(report.exit, 3)
  assert.equal(report.windows.length, 0)
  assert.match(stderr, /refuses the non-loopback site URL claude\.url=https:\/\/claude\.ai\/new/)
  const partial = run({ TRIPLEX_E2E_APP: '1', TRIPLEX_SITES_JSON: JSON.stringify({ claude: { url: `${FAKE_BASE}/?site=claude`, newChatUrl: `${FAKE_BASE}/?site=claude` } }), TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(partial.status, 3)
  assert.match(partial.stderr, /chatgpt\.url=https:\/\/chatgpt\.com\//)
})

test('TRIPLEX_E2E_APP=1 also refuses a non-loopback trusted host (exit 3): loopback URLs with the real hosts', () => {
  const sites = {}
  for (const slot of SLOTS) sites[slot] = { url: `${FAKE_BASE}/?site=${slot}`, newChatUrl: `${FAKE_BASE}/?site=${slot}` } // hosts stay chatgpt.com / claude.ai / grok.com
  const { status, report, stderr } = run({ TRIPLEX_E2E_APP: '1', TRIPLEX_SITES_JSON: JSON.stringify(sites), TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 3)
  assert.equal(report.exit, 3)
  assert.equal(report.windows.length, 0)
  assert.match(stderr, /refuses the non-loopback trusted host claude\.hosts=claude\.ai/)
  const one = { ...JSON.parse(sitesJson()) }
  one.grok.hosts = ['127.0.0.1', 'localhost', 'grok.com']
  const partial = run({ TRIPLEX_E2E_APP: '1', TRIPLEX_SITES_JSON: JSON.stringify(one), TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(partial.status, 3)
  assert.match(partial.stderr, /grok\.hosts=grok\.com/)
})

test('TRIPLEX_BACKEND_URL on a non-loopback host is refused before any window (exit 2) unless TRIPLEX_ALLOW_REMOTE_BACKEND=1, which warns loudly and never logs the token', () => {
  const refused = run({ TRIPLEX_BACKEND_URL: 'http://10.0.0.5:8021', BRIDGE_TOKEN: 'remote-secret', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(refused.status, 2)
  assert.equal(refused.report.exit, 2)
  assert.equal(refused.report.windows.length, 0)
  assert.equal(refused.report.sockets.length, 0, 'no socket, so the token never left')
  assert.match(refused.stderr, /TRIPLEX_BACKEND_URL names the non-loopback host 10\.0\.0\.5.*TRIPLEX_ALLOW_REMOTE_BACKEND=1/)
  assert.equal(refused.stderr.includes('remote-secret'), false)

  const allowed = run({ TRIPLEX_BACKEND_URL: 'http://10.0.0.5:8021', BRIDGE_TOKEN: 'remote-secret', TRIPLEX_ALLOW_REMOTE_BACKEND: '1', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.equal(allowed.report.windows.length, 1)
  assert.equal(allowed.report.sockets[0].url, 'ws://10.0.0.5:8021/api/bridge')
  assert.match(allowed.stderr, /WARNING: TRIPLEX_ALLOW_REMOTE_BACKEND=1 .*REMOTE backend host 10\.0\.0\.5.*cleartext http/)
  assert.equal(allowed.stderr.includes('remote-secret'), false, 'the token is never logged')
})

test('a broken TRIPLEX_SITES_JSON is a config error (exit 2)', () => {
  const { status, stderr } = run({ TRIPLEX_SITES_JSON: '{nope', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 2)
  assert.match(stderr, /TRIPLEX_SITES_JSON is not valid JSON/)
})
