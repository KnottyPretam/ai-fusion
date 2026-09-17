// main.js wiring — the real desktop/main/main.js run under Node with a fake `electron` module
// (test/unit/main/_fake-electron.mjs, substituted by a module.register resolve hook). Proves the
// preflight (flags, TRIPLEX_USER_DATA_DIR, loopback refusal), the window + three views with the
// hardened webPreferences, every IPC channel, the shortcut path, health forwarding, one full
// prompt:send round trip, crash recreation and the bounds → settings.json flush on close.
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

function sitesJson(base = FAKE_BASE) {
  const sites = {}
  for (const slot of SLOTS) sites[slot] = { url: `${base}/?site=${slot}`, newChatUrl: `${base}/?site=${slot}`, hosts: ['127.0.0.1', 'localhost'] }
  return JSON.stringify(sites)
}

function run(env) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
  for (const k of Object.keys(process.env)) if (k.startsWith('TRIPLEX_')) delete clean[k]
  const r = spawnSync(process.execPath, ['--import', REGISTER, MAIN], { cwd: DESKTOP, env: { ...clean, ...env }, encoding: 'utf8', timeout: 30000 })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('FAKE_ELECTRON_REPORT '))
  return { status: r.status, report: line ? JSON.parse(line.slice('FAKE_ELECTRON_REPORT '.length)) : null, stderr: r.stderr, stdout: r.stdout }
}

test('happy path: userData, window, three hardened views, IPC, shortcuts, health, prompt:send, crash recreate, bounds flush', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-'))
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

  // three views, one per slot, in SLOTS order, each on its partition with the site preload, unthrottled
  assert.equal(report.views.length, 4, 'three initial views + one recreated after the crash probe')
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

  // every §2 channel is registered once
  const handles = report.ipcHandles
  for (const c of ['panes:getInfo', 'panes:newChat', 'panes:reload', 'panes:openExternal', 'panes:inspect', 'panes:focus', 'panes:zoom', 'prompt:send', 'adapter:config']) {
    assert.equal(handles.filter((h) => h === c).length, 1, c)
  }
  for (const c of ['panes:layout', 'panes:active', 'triplex:adapter:health', 'triplex:adapter:result']) assert.ok(report.ipcOns.includes(c), c)

  // hidden menu with the accelerator table
  assert.ok(report.menu)
  for (const a of ['CommandOrControl+1', 'CommandOrControl+2', 'CommandOrControl+3', 'CommandOrControl+\\', 'CommandOrControl+L', 'CommandOrControl+Shift+N', 'CommandOrControl+=', 'CommandOrControl+-', 'CommandOrControl+0', 'CommandOrControl+R', 'F12']) {
    assert.ok(report.menu.accelerators.includes(a), a)
  }

  const p = report.probes
  assert.ok(p && !p.error, JSON.stringify(p))
  assert.equal(p.getInfo.ok, true)
  assert.equal(p.getInfo.value.version, '0.1.0')
  assert.equal(p.getInfo.value.dev, true)
  assert.equal(p.getInfo.value.layout, null)
  assert.deepEqual(p.getInfo.value.sites.claude, { url: `${FAKE_BASE}/?site=claude`, newChatUrl: `${FAKE_BASE}/?site=claude`, partition: 'persist:claude' })
  assert.deepEqual(p.getInfoFromView, { ok: false, error: 'bad_request' }, 'a site view is not the renderer')
  assert.equal(p.adapterConfigView.ok, true)
  assert.equal(p.adapterConfigView.value.site, 'chatgpt')
  assert.deepEqual(Object.keys(p.adapterConfigView.value.selectors), ['version', 'chatgpt', 'claude', 'grok'])
  assert.equal(p.adapterConfigView.value.dev, true)
  assert.equal(p.adapterConfigPopup.value.site, null)
  assert.deepEqual(p.badSlot, { ok: false, error: 'bad_request' })
  assert.deepEqual(p.oversize, { ok: false, error: 'bad_request' })

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

  assert.equal(p.health.length, 1)
  assert.equal(p.health[0][1], 'claude')
  assert.equal(p.health[0][2].matched.composer, '#x')

  assert.ok(p.readyMsg, 'prompt:send sent a ready op to the claude view')
  assert.equal(p.readyMsg.op, 'ready')
  assert.equal(p.readyMsg.timeoutMs, 15000)
  assert.ok(p.insertMsg, 'then insertAndSubmit')
  assert.equal(p.insertMsg.text, 'hi `x`')
  assert.equal(p.viewFocusedDuringInsert, 1, 'the view was focused under the mutex before the insert')
  assert.equal(p.promptSend.ok, true)
  assert.equal(p.promptSend.value.results.claude.ok, true)
  assert.equal(p.promptSend.value.results.claude.composerSelector, '#c')
  assert.equal(p.promptSend.value.results.claude.url, 'http://127.0.0.1:5199/c/1')
  assert.equal(p.rendererFocusedAfterSend, 1, 'renderer focus restored once')

  assert.deepEqual(p.crashHealth, ['view_crashed'])
  assert.equal(p.recreated, 1)
  assert.equal(p.recreatedPartition, 'persist:chatgpt')

  assert.deepEqual(p.settingsFile.window, { x: 10, y: 20, width: 900, height: 700, maximized: false })
  assert.deepEqual(p.settingsFile.zoom, { claude: 1, chatgpt: 1, grok: 1.2 })
  assert.deepEqual(p.settingsFile.capture, { claude: false, chatgpt: false, grok: false })
  assert.equal(p.settingsFile.analyst, 'chatgpt')
  for (const key of ['views', 'orchestrator', 'settings']) assert.ok(p.testGlobal.includes(key), key)
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
})

test('TRIPLEX_CHROMIUM_FLAGS: a flag outside the allow-list refuses to start (exit 2) before any window', () => {
  const { status, report, stderr } = run({ TRIPLEX_CHROMIUM_FLAGS: '--disable-gpu --remote-debugging-port=9222', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 2)
  assert.equal(report.exit, 2)
  assert.equal(report.windows.length, 0)
  assert.equal(report.views.length, 0)
  assert.match(stderr, /--remote-debugging-port=9222.*not allow-listed/)
})

test('allowed flags and TRIPLEX_DISABLE_GPU=1 are appended to the command line', () => {
  const { status, report } = run({ TRIPLEX_CHROMIUM_FLAGS: '--ignore-gpu-blocklist --use-gl=egl', TRIPLEX_DISABLE_GPU: '1', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 0)
  assert.deepEqual(report.switches, [['ignore-gpu-blocklist'], ['use-gl', 'egl'], ['disable-gpu']])
  assert.equal(report.windows.length, 1)
  assert.equal(report.views[0].loads[0], 'https://claude.ai/new', 'the real sites without TRIPLEX_SITES_JSON')
  assert.deepEqual(report.windows[0].loads, ['http://127.0.0.1:8021/app/'], 'default renderer URL = the backend /app/')
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

test('a broken TRIPLEX_SITES_JSON is a config error (exit 2)', () => {
  const { status, stderr } = run({ TRIPLEX_SITES_JSON: '{nope', TRIPLEX_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-wiring-')) })
  assert.equal(status, 2)
  assert.match(stderr, /TRIPLEX_SITES_JSON is not valid JSON/)
})
