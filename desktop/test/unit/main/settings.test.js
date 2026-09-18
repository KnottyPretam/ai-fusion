// settings.js — defaults (capture all false, analyst chatgpt, zoom 1), clamp, atomic round-trip,
// debounced window bounds. Uses a real temp directory so the tmp + rename write is exercised.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettings, defaultSettings, sanitizeSettings, clampBounds, clampZoom, stepZoom, SETTINGS_FILE, MIN_WINDOW } from '../../../main/settings.js'
import { fakeTimers, fakeLog } from './_fakes.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-settings-'))
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

test('defaults: version 1, capture all false, analyst chatgpt, zoom all 1, window 1600×900 uncentred', () => {
  assert.deepEqual(defaultSettings(), {
    version: 1,
    window: { x: null, y: null, width: 1600, height: 900, maximized: false },
    zoom: { claude: 1, chatgpt: 1, grok: 1 },
    capture: { claude: false, chatgpt: false, grok: false },
    analyst: 'chatgpt',
    analystVisible: false,
  })
  assert.notEqual(defaultSettings().zoom, defaultSettings().zoom, 'a fresh object every time')
})

test('load() without a file yields the defaults; get() is a copy', () => {
  const dir = tmpDir()
  const s = createSettings({ dir, log: fakeLog() })
  const loaded = s.load()
  assert.deepEqual(loaded, defaultSettings())
  loaded.capture.claude = true
  assert.equal(s.get().capture.claude, false)
  assert.equal(s.file, path.join(dir, SETTINGS_FILE))
})

test('round-trip: setZoom / setCapture / setAnalyst write atomically and load back identically', () => {
  const dir = tmpDir()
  const s = createSettings({ dir, log: fakeLog() })
  s.load()
  assert.equal(s.setZoom('claude', 1.3000001), 1.3)
  assert.equal(s.setCapture('grok', true), true)
  assert.equal(s.setAnalyst(null), null)
  assert.equal(s.setAnalystVisible(true), true)
  const onDisk = readJson(s.file)
  assert.equal(onDisk.zoom.claude, 1.3)
  assert.equal(onDisk.capture.grok, true)
  assert.equal(onDisk.analyst, null)
  assert.equal(onDisk.analystVisible, true)
  assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE], 'no tmp file left behind')

  const again = createSettings({ dir, log: fakeLog() })
  assert.deepEqual(again.load(), s.get())
  assert.equal(again.getZoom('claude'), 1.3)
  assert.deepEqual(again.getCapture(), { claude: false, chatgpt: false, grok: true })
  assert.equal(again.getAnalyst(), null)
  assert.equal(again.getAnalystVisible(), true, 'the analyst view’s fourth-tab flag survives a restart')
  assert.equal(s.setAnalystVisible(0), false, 'the setter coerces (ipc.js is what rejects a non-boolean payload)')
  assert.equal(s.getAnalystVisible(), false)
  assert.equal(readJson(s.file).analystVisible, false)
})

test('corrupt or foreign JSON falls back to defaults / well-typed keys only, with a warning', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{not json')
  const log = fakeLog()
  const s = createSettings({ dir, log })
  assert.deepEqual(s.load(), defaultSettings())
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes('not valid JSON')))

  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, zoom: { claude: 'big', chatgpt: 9 }, capture: { claude: 'yes', grok: true }, analyst: 'bing', window: { x: 10, y: 'a', width: 100, height: 700, maximized: 1 } }))
  const doc = s.load()
  assert.deepEqual(doc.zoom, { claude: 1, chatgpt: 2, grok: 1 })
  assert.deepEqual(doc.capture, { claude: false, chatgpt: false, grok: true })
  assert.equal(doc.analyst, 'chatgpt')
  assert.deepEqual(doc.window, { x: 10, y: null, width: MIN_WINDOW.width, height: 700, maximized: false })
})

test('clampBounds keeps the window inside the work area and above the minimum size', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 }
  assert.deepEqual(clampBounds({ x: 5000, y: 5000, width: 3000, height: 3000 }, wa), { x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(clampBounds({ x: -300, y: -50, width: 800, height: 600 }, wa), { x: 0, y: 0, width: 800, height: 600 })
  assert.deepEqual(clampBounds({ x: 1500, y: 900, width: 800, height: 600 }, wa), { x: 1120, y: 480, width: 800, height: 600 })
  assert.deepEqual(clampBounds({ x: 10, y: 10, width: 10, height: 10 }, wa), { x: 10, y: 10, width: MIN_WINDOW.width, height: MIN_WINDOW.height })
  assert.deepEqual(clampBounds({ width: 1000, height: 700 }, wa), { x: null, y: null, width: 1000, height: 700 })
  // a second monitor to the right keeps its own origin
  assert.deepEqual(clampBounds({ x: 3000, y: 100, width: 800, height: 600 }, { x: 1920, y: 0, width: 1280, height: 800 }), { x: 2400, y: 100, width: 800, height: 600 })
  assert.deepEqual(clampBounds({ x: 1.6, y: 2.4, width: 800.4, height: 600.5 }, null), { x: 2, y: 2, width: 800, height: 601 })
})

test('windowBoundsForLaunch clamps to screen.getDisplayMatching(...).workArea and carries maximized', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, window: { x: 9000, y: 9000, width: 1600, height: 900, maximized: true } }))
  const asked = []
  const screen = {
    getDisplayMatching(rect) {
      asked.push(rect)
      return { workArea: { x: 0, y: 30, width: 1280, height: 770 } }
    },
  }
  const s = createSettings({ dir, screen, log: fakeLog() })
  s.load()
  assert.deepEqual(s.windowBoundsForLaunch(), { x: 0, y: 30, width: 1280, height: 770, maximized: true })
  assert.deepEqual(asked, [{ x: 9000, y: 9000, width: 1600, height: 900 }])
  // no saved position → no x/y (Electron centres), size still clamped
  const t = createSettings({ dir: tmpDir(), screen, log: fakeLog() })
  t.load()
  assert.deepEqual(t.windowBoundsForLaunch(), { width: 1280, height: 770, maximized: false })
  // no screen at all → raw defaults
  const u = createSettings({ dir: tmpDir(), log: fakeLog() })
  u.load()
  assert.deepEqual(u.windowBoundsForLaunch(), { width: 1600, height: 900, maximized: false })
})

test('queueWindowBounds is debounced; flushWindowBounds writes immediately; maximized keeps the normal bounds', () => {
  const dir = tmpDir()
  const timers = fakeTimers()
  const s = createSettings({ dir, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 500, log: fakeLog() })
  s.load()
  s.queueWindowBounds({ x: 1, y: 2, width: 800, height: 600 }, false)
  s.queueWindowBounds({ x: 11, y: 12, width: 900, height: 650 }, false)
  assert.equal(fs.existsSync(s.file), false, 'nothing written before the debounce')
  assert.equal(s.hasPendingBounds(), true)
  timers.advance(499)
  assert.equal(fs.existsSync(s.file), false)
  timers.advance(1)
  assert.deepEqual(readJson(s.file).window, { x: 11, y: 12, width: 900, height: 650, maximized: false })
  assert.equal(s.hasPendingBounds(), false)

  s.queueWindowBounds({ x: 20, y: 30, width: 1000, height: 700 }, true)
  assert.equal(s.flushWindowBounds(), true)
  assert.deepEqual(readJson(s.file).window, { x: 20, y: 30, width: 1000, height: 700, maximized: true })
  assert.equal(timers.pending(), 0)
  assert.equal(s.flushWindowBounds(), false, 'nothing pending')
})

test('clampZoom / stepZoom: one decimal, 0.5..2.0, reset → 1', () => {
  assert.equal(clampZoom(1.25), 1.3)
  assert.equal(clampZoom(0.1), 0.5)
  assert.equal(clampZoom(7), 2)
  assert.equal(clampZoom('x'), 1)
  assert.equal(stepZoom(1, 'in'), 1.1)
  assert.equal(stepZoom(1.1, 'in'), 1.2)
  assert.equal(stepZoom(2, 'in'), 2)
  assert.equal(stepZoom(0.5, 'out'), 0.5)
  assert.equal(stepZoom(1.7, 'reset'), 1)
  assert.equal(stepZoom(0.7, 'out'), 0.6)
})

test('sanitizeSettings / unknown slot guards', () => {
  assert.deepEqual(sanitizeSettings('nope'), defaultSettings())
  const s = createSettings({ dir: tmpDir(), log: fakeLog() })
  assert.throws(() => s.setZoom('bing', 1), /unknown slot/)
  assert.throws(() => s.setAnalyst('bing'), /unknown analyst/)
  assert.throws(() => createSettings({}), /dir is required/)
})
