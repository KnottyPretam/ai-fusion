// settings.js — defaults (capture all false, analyst chatgpt, zoom 1, theme dark, the default
// council of four web sites, no key, the migration marker), clamp, atomic round-trip, the theme key
// (the ONE source of truth for the desktop app's palette and nativeTheme.themeSource), the council key
// (council.js validated; a malformed member dropped on load), the openrouterKey key (base64 ciphertext
// or null — a plaintext key never survives the sanitiser), the one-time council-four-sites migration
// (2026-10-17) and debounced window bounds. Uses a real temp directory so the tmp + rename write is
// exercised.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettings, defaultSettings, sanitizeSettings, clampBounds, clampZoom, stepZoom, asTheme, asCiphertext, migrateSettings, sanitizeMigrations, councilMigrationReady, SETTINGS_FILE, SETTINGS_VERSION, MIN_WINDOW, THEMES, DEFAULT_THEME, COUNCIL_FOUR_SITES, MAX_MIGRATIONS } from '../../../main/settings.js'
import { DEFAULT_COUNCIL, LEGACY_COUNCIL } from '../../../main/council.js'
import { fakeTimers, fakeLog } from './_fakes.js'

const CLASSIC = { slots: { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' }, grok: { model: 'web:grok', effort: 'off' } } }
/** The default council since 2026-10-17: the four web sites. */
const FOUR = { slots: { ...CLASSIC.slots, gemini: { model: 'web:gemini', effort: 'off' } } }
const TWO = { slots: { chatgpt: { model: 'web:chatgpt', effort: 'off' }, qwen: { model: 'qwen/qwen3-235b-a22b', effort: 'low' } } }
const KEY = `sk-or-v1-${'b'.repeat(64)}`

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-settings-'))
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

test('defaults: version 1, capture all false, analyst chatgpt, zoom all 1, theme dark, the four-site council, no key, the migration marker, window 1600×900 uncentred', () => {
  assert.deepEqual(defaultSettings(), {
    version: 1,
    window: { x: null, y: null, width: 1600, height: 900, maximized: false },
    zoom: { claude: 1, chatgpt: 1, grok: 1, gemini: 1 },
    capture: { claude: false, chatgpt: false, grok: false, gemini: false },
    analyst: 'chatgpt',
    analystVisible: false,
    theme: 'dark',
    council: FOUR,
    openrouterKey: null,
    migrations: [COUNCIL_FOUR_SITES],
  })
  assert.equal(SETTINGS_VERSION, 1, 'the migrations key does not bump the version')
  assert.deepEqual(defaultSettings().council, DEFAULT_COUNCIL())
  assert.notEqual(defaultSettings().zoom, defaultSettings().zoom, 'a fresh object every time')
  assert.notEqual(defaultSettings().council, defaultSettings().council)
})

test('council: getCouncil is a copy, setCouncil validates (council.js) before persisting, notifies, round-trips; a malformed member is dropped on load and fewer than two fall back to the default — each with a warning naming what went', () => {
  const dir = tmpDir()
  const s = createSettings({ dir, log: fakeLog() })
  s.load()
  const seen = []
  s.subscribe(({ key, value }) => seen.push([key, value]))
  const c = s.getCouncil()
  c.slots.claude.model = 'tampered'
  assert.deepEqual(s.getCouncil(), FOUR, 'a copy out')
  assert.deepEqual(s.setCouncil(TWO), TWO)
  assert.deepEqual(readJson(s.file).council, TWO, 'written immediately')
  assert.deepEqual(seen, [['council', TWO]])
  for (const bad of [null, {}, { slots: {} }, { slots: { claude: { model: 'web:claude' } } }, { slots: { ...TWO.slots, bing: { model: 'x/y' } } }, { slots: { ...TWO.slots, qwen: { model: 'web:qwen' } } }]) {
    assert.throws(() => s.setCouncil(bad), /invalid council/)
  }
  assert.deepEqual(s.getCouncil(), TWO, 'a refused write leaves the document alone')
  assert.equal(seen.length, 1)
  const againLog = fakeLog()
  const again = createSettings({ dir, log: againLog })
  assert.deepEqual(again.load().council, TWO, 'survives a restart')
  const councilWarns = () => againLog.lines.filter(([l, m]) => l === 'warn' && m.startsWith('[settings] council:')).map(([, m]) => m)
  assert.deepEqual(councilWarns(), [], 'a council that loads as written is not remarked on')
  // on disk: one malformed member is dropped, the rest kept in catalog order; one survivor → default
  // — the user's configuration going away is said in the log, never silent
  // (web:deepseek is the malformed member since 2026-10-17: web:gemini is a site now)
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, council: { slots: { qwen: TWO.slots.qwen, grok: { model: 'web:grok', effort: 'off' }, deepseek: { model: 'web:deepseek', effort: 'off' } } } }))
  assert.deepEqual(Object.keys(again.load().council.slots), ['grok', 'qwen'])
  assert.deepEqual(councilWarns(), ['[settings] council: dropped deepseek (malformed or unknown member)'])
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, council: { slots: { qwen: TWO.slots.qwen, deepseek: { model: 'web:deepseek' } } } }))
  assert.deepEqual(again.load().council, FOUR)
  assert.deepEqual(councilWarns().slice(1), ['[settings] council: dropped deepseek (malformed or unknown member)', '[settings] council: fell back to the default council (claude, chatgpt, grok, gemini) — too_few'])
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, council: 'three' }))
  assert.deepEqual(again.load().council, FOUR)
  assert.equal(councilWarns().at(-1), '[settings] council: fell back to the default council (claude, chatgpt, grok, gemini) — not_a_council')
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1 }))
  const n = councilWarns().length
  assert.deepEqual(again.load().council, FOUR)
  assert.equal(councilWarns().length, n, 'no council key at all is the default, not a fallback')
})

test('openrouterKey: base64 ciphertext or null round-trips and notifies {configured}; a plaintext key (or anything not base64) is refused by the setter and dropped by the sanitiser', () => {
  const dir = tmpDir()
  const s = createSettings({ dir, log: fakeLog() })
  s.load()
  assert.equal(s.getOpenRouterKeyCiphertext(), null)
  const seen = []
  s.subscribe(({ key, value }) => seen.push([key, value]))
  const blob = Buffer.from('enc:anything').toString('base64')
  assert.equal(s.setOpenRouterKeyCiphertext(blob), blob)
  assert.equal(readJson(s.file).openrouterKey, blob)
  assert.equal(s.setOpenRouterKeyCiphertext(null), null)
  assert.equal(readJson(s.file).openrouterKey, null)
  assert.deepEqual(seen, [
    ['openrouterKey', { configured: true }],
    ['openrouterKey', { configured: false }],
  ])
  for (const bad of [KEY, '', ' ', 'not base64!', 42, {}, undefined]) assert.throws(() => s.setOpenRouterKeyCiphertext(bad), /base64 ciphertext or null/)
  assert.equal(seen.length, 2, 'a refused write notifies nobody')
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, openrouterKey: KEY }))
  const again = createSettings({ dir, log: fakeLog() })
  assert.equal(again.load().openrouterKey, null, 'a plaintext key in the file is dropped, never read back')
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, openrouterKey: blob }))
  assert.equal(again.load().openrouterKey, blob)
  assert.equal(asCiphertext(KEY), null, 'an OpenRouter key carries `-`, which base64 does not')
  assert.equal(asCiphertext(blob), blob)
  assert.equal(asCiphertext(''), null)
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
  assert.deepEqual(again.getCapture(), { claude: false, chatgpt: false, grok: true, gemini: false })
  assert.equal(again.getAnalyst(), null)
  assert.equal(again.getAnalystVisible(), true, 'the analyst view’s fourth-tab flag survives a restart')
  assert.equal(s.setAnalystVisible(0), false, 'the setter coerces (ipc.js is what rejects a non-boolean payload)')
  assert.equal(s.getAnalystVisible(), false)
  assert.equal(readJson(s.file).analystVisible, false)
})

test('theme: light | dark | system round-trips, notifies subscribers and rejects anything else', () => {
  const dir = tmpDir()
  const s = createSettings({ dir, log: fakeLog() })
  s.load()
  assert.equal(s.getTheme(), DEFAULT_THEME, 'the desktop shell defaults to dark')
  const seen = []
  s.subscribe(({ key, value }) => seen.push([key, value]))
  for (const theme of THEMES) {
    assert.equal(s.setTheme(theme), theme)
    assert.equal(s.getTheme(), theme)
    assert.equal(readJson(s.file).theme, theme, 'written immediately, like setCapture / setAnalyst')
  }
  assert.deepEqual(seen, [
    ['theme', 'light'],
    ['theme', 'dark'],
    ['theme', 'system'],
  ])
  for (const bad of ['Dark', 'auto', '', null, undefined, 1, {}]) assert.throws(() => s.setTheme(bad), /unknown theme/)
  assert.equal(s.getTheme(), 'system', 'a refused write leaves the document alone')
  const again = createSettings({ dir, log: fakeLog() })
  again.load()
  assert.equal(again.getTheme(), 'system', 'the choice survives a restart')
  assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE], 'no tmp file left behind')
})

test('theme: an unknown or missing value in the file falls back to dark; asTheme is the shared guard', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, theme: 'chartreuse' }))
  const s = createSettings({ dir, log: fakeLog() })
  assert.equal(s.load().theme, DEFAULT_THEME)
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1 }))
  assert.equal(s.load().theme, DEFAULT_THEME)
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, theme: 'light' }))
  assert.equal(s.load().theme, 'light')
  assert.equal(sanitizeSettings({ theme: 'system' }).theme, 'system')
  for (const t of THEMES) assert.equal(asTheme(t), t)
  assert.equal(asTheme('nope'), null)
  assert.equal(asTheme(undefined, DEFAULT_THEME), DEFAULT_THEME)
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
  assert.deepEqual(doc.zoom, { claude: 1, chatgpt: 2, grok: 1, gemini: 1 })
  assert.deepEqual(doc.capture, { claude: false, chatgpt: false, grok: true, gemini: false })
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
  assert.throws(() => s.setTheme('bing'), /unknown theme/)
  assert.throws(() => createSettings({}), /dir is required/)
})

// --- the one-time council-four-sites migration (2026-10-17) --------------------------------------

/** A settings.json as the pre-gemini build wrote it: the legacy three saved explicitly, no `migrations` key. */
const LEGACY_FILE = { version: 1, capture: { claude: true, chatgpt: false, grok: false }, analyst: 'chatgpt', council: CLASSIC }
const infoLines = (log) => log.lines.filter(([l, m]) => (l === 'info' || l === 'log') && m.startsWith('[settings]')).map(([, m]) => m)
const MIGRATED_LINE = `[settings] council: the classic three web sites (claude, chatgpt, grok) became the new default of four (claude, chatgpt, grok, gemini) — one-time migration ${COUNCIL_FOUR_SITES}`

test('migration: a legacy file (the classic three, no marker) loads as the four, is written back with the marker, and says so in ONE info line', () => {
  assert.equal(councilMigrationReady(), true, 'gemini is a site, so the migration is live')
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(LEGACY_FILE))
  const log = fakeLog()
  const s = createSettings({ dir, log })
  const seen = []
  s.subscribe(({ key }) => seen.push(key))
  const doc = s.load()
  assert.deepEqual(doc.council, FOUR)
  assert.deepEqual(doc.migrations, [COUNCIL_FOUR_SITES])
  assert.deepEqual(s.getCouncil(), FOUR)
  assert.deepEqual(infoLines(log), [MIGRATED_LINE], 'exactly one line, naming both councils and the migration')
  assert.deepEqual(log.lines.filter(([l]) => l === 'warn'), [], 'a migration is not a warning')
  const onDisk = readJson(s.file)
  assert.deepEqual(onDisk.council, FOUR, 'saved at once: the next launch reads four without migrating')
  assert.deepEqual(onDisk.migrations, [COUNCIL_FOUR_SITES])
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.capture.claude, true, 'every other key survives the rewrite')
  assert.deepEqual(seen, [], 'load notifies nobody (syncKey pushes the council on the next bridge connect)')
  assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE], 'no tmp file left behind')
  // the next launch: nothing to do, nothing logged, nothing written
  const log2 = fakeLog()
  const before = fs.statSync(s.file).mtimeMs
  const again = createSettings({ dir, log: log2 })
  assert.deepEqual(again.load().council, FOUR)
  assert.deepEqual(infoLines(log2), [])
  assert.equal(fs.statSync(s.file).mtimeMs, before, 'not rewritten')
})

test('migration: a customised council is left alone but MARKED — TWO, the legacy three at another effort, a three with qwen, a five', () => {
  const customs = [
    TWO,
    { slots: { ...CLASSIC.slots, claude: { model: 'web:claude', effort: 'low' } } },
    { slots: { claude: CLASSIC.slots.claude, chatgpt: CLASSIC.slots.chatgpt, qwen: TWO.slots.qwen } },
    { slots: { ...FOUR.slots, qwen: TWO.slots.qwen } },
  ]
  for (const council of customs) {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, council }))
    const log = fakeLog()
    const s = createSettings({ dir, log })
    assert.deepEqual(s.load().council, council, JSON.stringify(council))
    assert.deepEqual(infoLines(log), [], 'nothing moved, nothing said')
    const onDisk = readJson(s.file)
    assert.deepEqual(onDisk.migrations, [COUNCIL_FOUR_SITES], 'the marker records the evaluation')
    assert.deepEqual(onDisk.council, council)
  }
})

test('migration: with the marker present the legacy three stays three — and a deliberate choice of three after the migration sticks across a restart', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ ...LEGACY_FILE, migrations: [COUNCIL_FOUR_SITES] }))
  const log = fakeLog()
  const s = createSettings({ dir, log })
  assert.deepEqual(s.load().council, CLASSIC)
  assert.deepEqual(infoLines(log), [])
  // migrate, then choose the three on purpose, then relaunch
  const dir2 = tmpDir()
  fs.writeFileSync(path.join(dir2, SETTINGS_FILE), JSON.stringify(LEGACY_FILE))
  const first = createSettings({ dir: dir2, log: fakeLog() })
  assert.deepEqual(first.load().council, FOUR)
  assert.deepEqual(first.setCouncil(LEGACY_COUNCIL()), CLASSIC)
  const log2 = fakeLog()
  const second = createSettings({ dir: dir2, log: log2 })
  assert.deepEqual(second.load().council, CLASSIC, 'the marker was saved, so the three is not migrated again')
  assert.deepEqual(infoLines(log2), [])
  assert.deepEqual(readJson(second.file).migrations, [COUNCIL_FOUR_SITES])
})

test('migration: a fresh profile carries the marker by construction; a file with no council key is the default and gets marked; a corrupt file is not rewritten', () => {
  const fresh = createSettings({ dir: tmpDir(), log: fakeLog() })
  const doc = fresh.load()
  assert.deepEqual(doc.council, FOUR)
  assert.deepEqual(doc.migrations, [COUNCIL_FOUR_SITES])
  assert.equal(fs.existsSync(fresh.file), false, 'a missing file is not created by load')
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, theme: 'light' }))
  const log = fakeLog()
  const s = createSettings({ dir, log })
  assert.deepEqual(s.load().council, FOUR)
  assert.deepEqual(infoLines(log), [], 'the default already is four: nothing moved')
  assert.deepEqual(readJson(s.file).migrations, [COUNCIL_FOUR_SITES])
  assert.equal(readJson(s.file).theme, 'light')
  const bad = tmpDir()
  fs.writeFileSync(path.join(bad, SETTINGS_FILE), '{not json')
  const t = createSettings({ dir: bad, log: fakeLog() })
  assert.deepEqual(t.load().migrations, [COUNCIL_FOUR_SITES])
  assert.equal(fs.readFileSync(t.file, 'utf8'), '{not json', 'a corrupt file is left for the user; the next setter rewrites it')
})

test('migrateSettings: pure — the input is not touched; inert (no change, no marker) while the default still equals the legacy three; unknown markers kept', () => {
  const input = sanitizeSettings(LEGACY_FILE)
  const frozen = JSON.stringify(input)
  const r = migrateSettings(input)
  assert.equal(JSON.stringify(input), frozen, 'the input document is not mutated')
  assert.equal(r.changed, true)
  assert.deepEqual(r.doc.council, FOUR)
  assert.deepEqual(r.doc.migrations, [COUNCIL_FOUR_SITES])
  assert.deepEqual(r.notes, [MIGRATED_LINE.replace('[settings] ', '')])
  assert.notEqual(r.doc.council, DEFAULT_COUNCIL(), 'a copy of the default')
  // before gemini was a site: DEFAULT_COUNCIL() was the legacy three, and the migration must not mark itself done
  const inert = migrateSettings(input, { defaultCouncil: LEGACY_COUNCIL() })
  assert.equal(inert.changed, false)
  assert.deepEqual(inert.notes, [])
  assert.deepEqual(inert.doc.council, CLASSIC)
  assert.deepEqual(inert.doc.migrations, [], 'no marker: it runs once gemini is a site')
  assert.equal(councilMigrationReady(LEGACY_COUNCIL()), false)
  // already marked → nothing at all
  const marked = migrateSettings({ ...input, migrations: [COUNCIL_FOUR_SITES] })
  assert.equal(marked.changed, false)
  assert.deepEqual(marked.doc.council, CLASSIC)
  // a marker from a newer build is kept (a downgrade then an upgrade must not re-run it), ours appended
  const newer = migrateSettings({ ...input, migrations: ['some-future-step'] })
  assert.deepEqual(newer.doc.migrations, ['some-future-step', COUNCIL_FOUR_SITES])
  assert.deepEqual(newer.doc.council, FOUR)
  // not a document at all → just the marker
  assert.deepEqual(migrateSettings(null).doc, { migrations: [COUNCIL_FOUR_SITES] })
})

test('sanitizeMigrations / sanitizeSettings: well-formed unique ids from the FILE only (never the default), at most MAX_MIGRATIONS; anything else → []', () => {
  assert.deepEqual(sanitizeMigrations([COUNCIL_FOUR_SITES, 'x-1', COUNCIL_FOUR_SITES]), [COUNCIL_FOUR_SITES, 'x-1'], 'de-duplicated, order kept')
  assert.deepEqual(sanitizeMigrations(['Bad', '-lead', '', 'a b', 'ok', 42, null, {}, 'é', 'a'.repeat(65)]), ['ok'])
  assert.equal(sanitizeMigrations(Array.from({ length: 50 }, (_, i) => `m-${i}`)).length, MAX_MIGRATIONS)
  for (const bad of [undefined, null, 'council-four-sites', {}, 3]) assert.deepEqual(sanitizeMigrations(bad), [], JSON.stringify(bad))
  assert.deepEqual(sanitizeSettings({ version: 1 }).migrations, [], 'a file without the key has evaluated nothing, whatever the default says')
  assert.deepEqual(sanitizeSettings({ version: 1, migrations: [COUNCIL_FOUR_SITES, 'BAD'] }).migrations, [COUNCIL_FOUR_SITES])
})
