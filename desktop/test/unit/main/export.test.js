// export.js — the file side of "export this step" (Markdown / HTML / PDF / all three).
// Covers the default file name (slugging, odd titles, the length bound, the emoji / CJK fallback),
// the payload validators, the backend seam (`?format=md|html`, a JSON envelope, every failure
// coded), the ONE-save-dialog rule for several formats, cancellation at the dialog and at the
// overwrite confirmation, the offscreen print window (hardened, never shown, destroyed on every
// path including a load failure, a print failure and a timeout) and the write failures.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  FORMATS,
  EXTENSIONS,
  TURN_TYPES,
  MAX_ID_CHARS,
  MAX_TITLE_CHARS,
  MAX_STEM_CHARS,
  PDF_MARGINS,
  slugify,
  dateStamp,
  defaultFileName,
  ensureExtension,
  stripKnownExtension,
  requireFormats,
  requireExportRequest,
  exportUrl,
  fetchDocument,
  saveDialogOptions,
  targetPaths,
  renderPdf,
  exportTurn,
} from '../../../main/export.js'
import { fakeLog } from './_fakes.js'

const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const TURN = '7b2c1d0e-3f4a-4b5c-8d9e-0f1a2b3c4d5e'
const TS = Date.UTC(2026, 8, 18, 13, 45) // 2026-09-18
const BACKEND = 'http://127.0.0.1:8021'

/** An in-memory fs with just the calls export.js makes. */
function makeFs({ existing = [], failWrite = null, tmp = '/tmp/triplex-export-' } = {}) {
  const files = new Map()
  for (const p of existing) files.set(p, 'old')
  const fs = { files, dirs: [], removed: [], tmpDirs: [] }
  fs.existsSync = (p) => files.has(p)
  fs.mkdirSync = (p) => {
    fs.dirs.push(p)
  }
  fs.writeFileSync = (p, data) => {
    if (failWrite && String(p).includes(failWrite)) throw new Error('EACCES: permission denied')
    files.set(p, data)
  }
  fs.mkdtempSync = (prefix) => {
    const dir = `${tmp}${fs.tmpDirs.length}`
    fs.tmpDirs.push({ prefix, dir })
    return dir
  }
  fs.rmSync = (p) => {
    fs.removed.push(p)
  }
  return fs
}

/** The files an export wrote where the user asked (the print temp document filtered out). */
function outputs(fs) {
  return [...fs.files.keys()].filter((p) => !p.startsWith('/tmp/triplex-export-'))
}

/** dialog.showSaveDialog / showMessageBox, recording every call. */
function makeDialog({ filePath = '/out/report', canceled = false, replace = true, throwOnSave = false, noMessageBox = false } = {}) {
  const dialog = {
    saveCalls: [],
    messageCalls: [],
    async showSaveDialog(...args) {
      dialog.saveCalls.push(args)
      if (throwOnSave) throw new Error('no display')
      return canceled ? { canceled: true, filePath: '' } : { canceled: false, filePath }
    },
  }
  if (!noMessageBox) {
    dialog.showMessageBox = async (...args) => {
      dialog.messageCalls.push(args)
      return { response: replace ? 1 : 0 }
    }
  }
  return dialog
}

/** A response for the fake fetch. */
function textResponse(body, type = 'text/markdown; charset=utf-8') {
  return { ok: true, status: 200, headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? type : null) }, text: async () => body }
}

/** fetch(url) → the document for that `format=` query; records every URL. */
function makeFetch({ md = '# markdown\n', html = '<h1>html</h1>', fail = null, status = 200 } = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    if (fail === 'throw') throw new Error('ECONNREFUSED')
    if (fail === 'status') return { ok: false, status, headers: { get: () => null }, text: async () => '' }
    const format = new URL(String(url)).searchParams.get('format')
    if (fail === format) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    if (format === 'md') return textResponse(md)
    return textResponse(html, 'text/html; charset=utf-8')
  }
  impl.calls = calls
  return impl
}

/** A BrowserWindow class whose webContents emits did-finish-load (or the failure asked for). */
function makeBrowserWindow({ mode = 'ok', pdf = Buffer.from('%PDF-1.7 fake'), stall = false } = {}) {
  const instances = []
  class FakeWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      this.shown = 0
      this.focused = 0
      const wc = new EventEmitter()
      wc.loads = []
      wc.printCalls = []
      wc.loadURL = async (url) => {
        wc.loads.push(url)
        if (mode === 'loadfail') {
          setImmediate(() => wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND'))
          return new Promise(() => {}) // Electron's promise stays pending until the load settles
        }
        if (mode === 'loadstall') return new Promise(() => {})
        setImmediate(() => wc.emit('did-finish-load'))
        return undefined
      }
      wc.printToPDF = async (opts) => {
        wc.printCalls.push(opts)
        if (mode === 'printfail') throw new Error('printToPDF failed')
        if (mode === 'printstall' || stall) return new Promise(() => {})
        return pdf
      }
      this.webContents = wc
      this.show = () => {
        this.shown += 1
      }
      this.focus = () => {
        this.focused += 1
      }
      this.isDestroyed = () => this.destroyed
      this.destroy = () => {
        this.destroyed = true
      }
      instances.push(this)
    }
  }
  FakeWindow.instances = instances
  return FakeWindow
}

function run(overrides = {}) {
  const fs = overrides.fs || makeFs()
  const dialog = overrides.dialog || makeDialog()
  const fetchImpl = overrides.fetchImpl || makeFetch()
  const BrowserWindow = overrides.BrowserWindow || makeBrowserWindow()
  const log = overrides.log || fakeLog()
  const promise = exportTurn({
    conversationId: CONV,
    turnId: TURN,
    formats: ['md'],
    title: 'Why is the sky blue?',
    turnType: 'send',
    backendUrl: BACKEND,
    dialog,
    BrowserWindow,
    fetchImpl,
    fs,
    now: () => TS,
    defaultDir: '/home/u/Documents',
    log,
    ...overrides,
  })
  return { promise, fs, dialog, fetchImpl, BrowserWindow, log }
}

// --- names -----------------------------------------------------------------------------------

test('slugify: ASCII-safe, no separators, diacritics folded, bounded', () => {
  assert.equal(slugify('Why is the sky blue?'), 'why-is-the-sky-blue')
  assert.equal(slugify('  Café déjà vu — the naïve plan  '), 'cafe-deja-vu-the-naive-plan')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('a\\b/c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(slugify('...hidden...'), 'hidden')
  assert.equal(slugify('🎉 emoji 🎉'), 'emoji')
  assert.equal(slugify('日本語'), '')
  assert.equal(slugify('🎉🎉🎉'), '')
  assert.equal(slugify(null), '')
  assert.equal(slugify(42), '')
  assert.equal(slugify('x'.repeat(200)).length, 80)
  assert.equal(slugify('aaa bbb ccc', { max: 5 }), 'aaa-b')
  assert.equal(slugify('aaa bbb ccc', { max: 4 }), 'aaa', 'a slug never ends in a dash')
})

test('dateStamp: UTC YYYY-MM-DD, a bad timestamp falls back to now', () => {
  assert.equal(dateStamp(TS), '2026-09-18')
  assert.equal(/^\d{4}-\d{2}-\d{2}$/.test(dateStamp(null)), true)
  assert.equal(/^\d{4}-\d{2}-\d{2}$/.test(dateStamp('not a date')), true)
})

test('defaultFileName: <title>-<step>-<date>, safe, bounded, ASCII fallback for emoji / CJK titles', () => {
  assert.equal(defaultFileName({ title: 'Why is the sky blue?', turnType: 'send', ts: TS }), 'why-is-the-sky-blue-send-2026-09-18')
  for (const turnType of TURN_TYPES) {
    const name = defaultFileName({ title: 'Trade-offs of GNC fusion', turnType, ts: TS })
    assert.equal(name, `trade-offs-of-gnc-fusion-${turnType}-2026-09-18`)
  }
  // odd titles
  assert.equal(defaultFileName({ title: '🎉🎉🎉', turnType: 'fusion', ts: TS }), 'conversation-fusion-2026-09-18')
  assert.equal(defaultFileName({ title: '日本語のタイトル', turnType: 'analyze', ts: TS }), 'conversation-analyze-2026-09-18')
  assert.equal(defaultFileName({ title: '   ', turnType: 'analyze', ts: TS }), 'conversation-analyze-2026-09-18')
  assert.equal(defaultFileName({ title: '../../.ssh/id_rsa', turnType: 'send', ts: TS }), 'ssh-id_rsa-send-2026-09-18'.replace('id_rsa', 'id-rsa'))
  assert.equal(defaultFileName({ ts: TS }), 'conversation-turn-2026-09-18')
  assert.equal(defaultFileName({}), defaultFileName({ ts: Date.now() }))
  // never a separator, never a leading dot, always bounded
  const long = defaultFileName({ title: 'word '.repeat(80), turnType: 'continue', ts: TS })
  assert.ok(long.length <= MAX_STEM_CHARS, `${long.length} <= ${MAX_STEM_CHARS}`)
  for (const name of [long, defaultFileName({ title: '/../..//', turnType: 'send', ts: TS })]) {
    assert.equal(name.includes('/'), false)
    assert.equal(name.includes('\\'), false)
    assert.equal(name.startsWith('.'), false)
    assert.equal(path.basename(name), name)
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/)
  }
})

test('ensureExtension / stripKnownExtension', () => {
  assert.equal(ensureExtension('/out/report', '.md'), '/out/report.md')
  assert.equal(ensureExtension('/out/report.md', '.md'), '/out/report.md')
  assert.equal(ensureExtension('/out/report.MD', '.md'), '/out/report.MD')
  assert.equal(ensureExtension('/out/report.txt', '.md'), '/out/report.txt.md')
  assert.equal(stripKnownExtension('/out/report.html'), '/out/report')
  assert.equal(stripKnownExtension('/out/report.pdf'), '/out/report')
  assert.equal(stripKnownExtension('/out/report'), '/out/report')
  assert.equal(stripKnownExtension('/out/report.'), '/out/report')
  assert.equal(stripKnownExtension('/out/report.notes'), '/out/report.notes')
})

// --- validation ------------------------------------------------------------------------------

test('requireFormats: a non-empty subset of md|html|pdf, de-duplicated in canonical order', () => {
  assert.deepEqual(requireFormats(['md']), ['md'])
  assert.deepEqual(requireFormats(['pdf', 'md', 'md']), ['md', 'pdf'])
  assert.deepEqual(requireFormats([...FORMATS].reverse()), ['md', 'html', 'pdf'])
  for (const bad of [[], 'md', null, undefined, ['docx'], ['md', 'docx'], [1], [['md']], { 0: 'md' }, ['MD']]) {
    assert.throws(() => requireFormats(bad), /bad_request/)
  }
})

test('requireExportRequest: ids, formats, the optional title and turn kind', () => {
  assert.deepEqual(requireExportRequest({ conversationId: CONV, turnId: TURN, formats: ['pdf', 'md'] }), { conversationId: CONV, turnId: TURN, formats: ['md', 'pdf'], title: '', turnType: '' })
  assert.deepEqual(requireExportRequest({ conversationId: CONV, turnId: TURN, formats: ['md'], title: 'T', turnType: 'analyze' }).turnType, 'analyze')
  assert.equal(requireExportRequest({ conversationId: CONV, turnId: TURN, formats: ['md'], title: null, turnType: null }).title, '')
  assert.equal(requireExportRequest({ conversationId: 'x'.repeat(MAX_ID_CHARS), turnId: TURN, formats: ['md'] }).conversationId.length, MAX_ID_CHARS)
  const bad = [
    null,
    undefined,
    'string',
    [],
    { turnId: TURN, formats: ['md'] },
    { conversationId: CONV, formats: ['md'] },
    { conversationId: '', turnId: TURN, formats: ['md'] },
    { conversationId: CONV, turnId: '', formats: ['md'] },
    { conversationId: 1, turnId: TURN, formats: ['md'] },
    { conversationId: CONV, turnId: { id: 1 }, formats: ['md'] },
    { conversationId: 'x'.repeat(MAX_ID_CHARS + 1), turnId: TURN, formats: ['md'] },
    { conversationId: CONV, turnId: 'x'.repeat(MAX_ID_CHARS + 1), formats: ['md'] },
    { conversationId: CONV, turnId: TURN, formats: [] },
    { conversationId: CONV, turnId: TURN, formats: ['docx'] },
    { conversationId: CONV, turnId: TURN, formats: ['md'], title: 42 },
    { conversationId: CONV, turnId: TURN, formats: ['md'], title: 'x'.repeat(MAX_TITLE_CHARS + 1) },
    { conversationId: CONV, turnId: TURN, formats: ['md'], turnType: 'export' },
    { conversationId: CONV, turnId: TURN, formats: ['md'], turnType: 'Send' },
  ]
  for (const payload of bad) assert.throws(() => requireExportRequest(payload), /bad_request/, JSON.stringify(payload))
})

// --- the backend seam ------------------------------------------------------------------------

test('exportUrl: /api/conversations/<id>/export/<turnId>?format=…, encoded, no slot anywhere', () => {
  assert.equal(exportUrl(BACKEND, CONV, TURN, 'md'), `${BACKEND}/api/conversations/${CONV}/export/${TURN}?format=md`)
  assert.equal(exportUrl(`${BACKEND}/`, CONV, TURN, 'html'), `${BACKEND}/api/conversations/${CONV}/export/${TURN}?format=html`)
  assert.equal(exportUrl(BACKEND, 'a b/c', 'd?e', 'md').includes('a%20b%2Fc'), true)
  assert.throws(() => exportUrl('', CONV, TURN, 'md'), /export_unavailable/)
})

test('fetchDocument: text verbatim, a JSON envelope unwrapped, every failure coded', async () => {
  const doc = await fetchDocument({ backendUrl: BACKEND, conversationId: CONV, turnId: TURN, format: 'md', fetchImpl: makeFetch({ md: '# R1 vs R2\n' }) })
  assert.equal(doc, '# R1 vs R2\n')

  const json = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ format: 'md', content: '# from json\n' }) })
  assert.equal(await fetchDocument({ backendUrl: BACKEND, conversationId: CONV, turnId: TURN, format: 'md', fetchImpl: json }), '# from json\n')

  for (const impl of [
    makeFetch({ fail: 'throw' }),
    makeFetch({ fail: 'status', status: 404 }),
    async () => textResponse(''),
    async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => 'not json' }),
    async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }),
  ]) {
    await assert.rejects(fetchDocument({ backendUrl: BACKEND, conversationId: CONV, turnId: TURN, format: 'md', fetchImpl: impl }), /export_fetch_failed/)
  }
  await assert.rejects(fetchDocument({ backendUrl: BACKEND, conversationId: CONV, turnId: TURN, format: 'md', fetchImpl: null }), /export_unavailable/)
})

// --- one format ------------------------------------------------------------------------------

test('one format: one save dialog with the default name, the document written verbatim', async () => {
  const { promise, fs, dialog, fetchImpl } = run({ formats: ['md'], dialog: makeDialog({ filePath: '/out/report' }) })
  const res = await promise
  assert.equal(dialog.saveCalls.length, 1, 'exactly one save dialog')
  const options = dialog.saveCalls[0][0]
  assert.equal(options.defaultPath, path.join('/home/u/Documents', 'why-is-the-sky-blue-send-2026-09-18.md'))
  assert.deepEqual(options.filters[0], { name: 'MD', extensions: ['md'] })
  assert.ok(options.properties.includes('showOverwriteConfirmation'), 'the dialog confirms its own overwrite')
  assert.deepEqual(fetchImpl.calls, [`${BACKEND}/api/conversations/${CONV}/export/${TURN}?format=md`], 'only the markdown is fetched')
  assert.deepEqual(res, { cancelled: false, formats: ['md'], files: { md: '/out/report.md' }, paths: ['/out/report.md'], defaultName: 'why-is-the-sky-blue-send-2026-09-18' })
  assert.equal(fs.files.get('/out/report.md'), '# markdown\n')
})

test('one format: a parent window is passed to the dialog, and the extension the user typed is kept', async () => {
  const parentWindow = { id: 'win' }
  const { promise, dialog, fs } = run({ formats: ['html'], parentWindow, dialog: makeDialog({ filePath: '/out/mine.html' }) })
  await promise
  assert.equal(dialog.saveCalls[0][0], parentWindow, 'the dialog is modal to the app window')
  assert.equal(fs.files.get('/out/mine.html'), '<h1>html</h1>')
})

test('pdf only: the HTML is fetched as the print source but no .html file is written', async () => {
  const BrowserWindow = makeBrowserWindow()
  const { promise, fs, fetchImpl, dialog } = run({ formats: ['pdf'], BrowserWindow, dialog: makeDialog({ filePath: '/out/report' }) })
  const res = await promise
  assert.deepEqual(fetchImpl.calls.map((u) => new URL(u).searchParams.get('format')), ['html'])
  assert.deepEqual(res.paths, ['/out/report.pdf'])
  assert.deepEqual(outputs(fs), ['/out/report.pdf'], 'only the PDF lands where the user asked')
  assert.ok(Buffer.isBuffer(fs.files.get('/out/report.pdf')))
  assert.equal(dialog.saveCalls.length, 1)
  // the print window: hidden, hardened, never shown or focused, destroyed, temp file removed
  const win = BrowserWindow.instances[0]
  assert.equal(BrowserWindow.instances.length, 1)
  assert.equal(win.options.show, false)
  assert.equal(win.options.focusable, false)
  assert.equal(win.options.webPreferences.sandbox, true)
  assert.equal(win.options.webPreferences.contextIsolation, true)
  assert.equal(win.options.webPreferences.nodeIntegration, false)
  assert.equal(win.options.webPreferences.javascript, false)
  assert.equal(win.shown, 0)
  assert.equal(win.focused, 0)
  assert.equal(win.destroyed, true, 'the print window is torn down')
  assert.equal(fs.removed.length, 1, 'the temp document is removed')
  assert.match(win.webContents.loads[0], /^file:\/\/.*document\.html$/)
  const print = win.webContents.printCalls[0]
  assert.equal(print.printBackground, true)
  assert.equal(print.displayHeaderFooter, false, 'no title or local path is stamped into the PDF')
  assert.equal(print.pageSize, 'A4')
  assert.deepEqual(print.margins, { ...PDF_MARGINS })
})

// --- all three -------------------------------------------------------------------------------

test('all three: ONE dialog for a base path, three files beside each other', async () => {
  const { promise, fs, dialog, fetchImpl } = run({ formats: ['md', 'html', 'pdf'], dialog: makeDialog({ filePath: '/out/sky' }) })
  const res = await promise
  assert.equal(dialog.saveCalls.length, 1, 'the user is asked once, for a base name')
  const options = dialog.saveCalls[0][0]
  assert.equal(options.defaultPath, path.join('/home/u/Documents', 'why-is-the-sky-blue-send-2026-09-18'))
  assert.equal(options.filters, undefined, 'no extension filter when the base name is what is asked for')
  assert.deepEqual(res.paths, ['/out/sky.md', '/out/sky.html', '/out/sky.pdf'])
  assert.deepEqual(res.files, { md: '/out/sky.md', html: '/out/sky.html', pdf: '/out/sky.pdf' })
  assert.equal(fs.files.get('/out/sky.md'), '# markdown\n')
  assert.equal(fs.files.get('/out/sky.html'), '<h1>html</h1>')
  assert.ok(Buffer.isBuffer(fs.files.get('/out/sky.pdf')))
  assert.deepEqual(fetchImpl.calls.map((u) => new URL(u).searchParams.get('format')), ['md', 'html'], 'one fetch per document, html shared with the PDF')
})

test('all three: a base path the user typed with an extension loses it, so nothing is called report.md.html', async () => {
  const { promise, fs } = run({ formats: ['md', 'html', 'pdf'], dialog: makeDialog({ filePath: '/out/report.md' }) })
  const res = await promise
  assert.deepEqual(res.paths, ['/out/report.md', '/out/report.html', '/out/report.pdf'])
  assert.deepEqual(outputs(fs), ['/out/report.md', '/out/report.html', '/out/report.pdf'])
})

test('targetPaths / saveDialogOptions are the rule, in isolation', () => {
  assert.deepEqual(targetPaths(['md'], '/out/a'), { md: '/out/a.md' })
  assert.deepEqual(targetPaths(['md', 'pdf'], '/out/a.pdf'), { md: '/out/a.md', pdf: '/out/a.pdf' })
  const one = saveDialogOptions({ formats: ['html'], stem: 'stem', defaultDir: '' })
  assert.equal(one.defaultPath, 'stem.html')
  assert.equal(one.filters[0].extensions[0], 'html')
  const many = saveDialogOptions({ formats: FORMATS, stem: 'stem', defaultDir: '/d' })
  assert.equal(many.defaultPath, '/d/stem')
  assert.match(many.title, /MD, HTML, PDF/)
})

// --- cancellation ----------------------------------------------------------------------------

test('cancelling the save dialog writes nothing and reports cancelled', async () => {
  const { promise, fs, dialog } = run({ formats: ['md', 'html', 'pdf'], dialog: makeDialog({ canceled: true }) })
  const res = await promise
  assert.deepEqual(res, { cancelled: true, formats: ['md', 'html', 'pdf'], files: {}, paths: [], defaultName: 'why-is-the-sky-blue-send-2026-09-18' })
  assert.deepEqual(outputs(fs), [], 'nothing is written')
  assert.equal(dialog.saveCalls.length, 1)
  assert.equal(dialog.messageCalls.length, 0)
})

test('a dialog that answers no path at all is a cancel, not a write to undefined', async () => {
  for (const answer of [{}, { canceled: false }, { canceled: false, filePath: '' }, null]) {
    const dialog = { saveCalls: [], showSaveDialog: async (...a) => (dialog.saveCalls.push(a), answer) }
    const { promise, fs } = run({ formats: ['md'], dialog })
    const res = await promise
    assert.equal(res.cancelled, true)
    assert.deepEqual(outputs(fs), [])
  }
})

test('an existing sibling the dialog never named is confirmed once, and cancelling there writes nothing', async () => {
  const fsCancel = makeFs({ existing: ['/out/sky.pdf'] })
  const dialogCancel = makeDialog({ filePath: '/out/sky', replace: false })
  const cancelled = await exportTurn({ ...base(), formats: ['md', 'html', 'pdf'], fs: fsCancel, dialog: dialogCancel })
  assert.equal(cancelled.cancelled, true)
  assert.equal(dialogCancel.saveCalls.length, 1, 'still exactly one save dialog')
  assert.equal(dialogCancel.messageCalls.length, 1, 'one confirmation, not a second save dialog')
  assert.match(dialogCancel.messageCalls[0][0].detail, /sky\.pdf/)
  assert.deepEqual(outputs(fsCancel), ['/out/sky.pdf'], 'nothing new is written')
  assert.equal(fsCancel.files.get('/out/sky.pdf'), 'old')

  const fsReplace = makeFs({ existing: ['/out/sky.pdf'] })
  const dialogReplace = makeDialog({ filePath: '/out/sky', replace: true })
  const replaced = await exportTurn({ ...base(), formats: ['md', 'html', 'pdf'], fs: fsReplace, dialog: dialogReplace })
  assert.equal(replaced.cancelled, false)
  assert.equal(dialogReplace.saveCalls.length, 1)
  assert.equal(dialogReplace.messageCalls.length, 1)
  assert.ok(Buffer.isBuffer(fsReplace.files.get('/out/sky.pdf')), 'replaced after the confirmation')
})

test('the file the dialog itself returned is not confirmed twice (the dialog already asked)', async () => {
  const fs = makeFs({ existing: ['/out/report.md'] })
  const dialog = makeDialog({ filePath: '/out/report.md' })
  const res = await exportTurn({ ...base(), formats: ['md'], fs, dialog })
  assert.equal(res.cancelled, false)
  assert.equal(dialog.messageCalls.length, 0, 'no second prompt for the path the dialog confirmed')
})

test('no way to confirm an overwrite (no message box) refuses rather than overwriting silently', async () => {
  const fs = makeFs({ existing: ['/out/sky.html'] })
  const dialog = makeDialog({ filePath: '/out/sky', noMessageBox: true })
  const res = await exportTurn({ ...base(), formats: ['md', 'html'], fs, dialog })
  assert.equal(res.cancelled, true)
  assert.equal(fs.files.get('/out/sky.html'), 'old')
})

// --- failures --------------------------------------------------------------------------------

test('a backend fetch failure is coded, opens no dialog and creates no print window', async () => {
  const BrowserWindow = makeBrowserWindow()
  const dialog = makeDialog()
  const fs = makeFs()
  await assert.rejects(exportTurn({ ...base(), formats: ['md', 'html', 'pdf'], fetchImpl: makeFetch({ fail: 'html' }), dialog, fs, BrowserWindow }), /export_fetch_failed/)
  assert.equal(dialog.saveCalls.length, 0, 'nothing is asked for when there is no document')
  assert.equal(BrowserWindow.instances.length, 0)
  assert.deepEqual(outputs(fs), [])
})

test('a printToPDF failure is coded AND the offscreen window is destroyed', async () => {
  const BrowserWindow = makeBrowserWindow({ mode: 'printfail' })
  const dialog = makeDialog()
  const fs = makeFs()
  await assert.rejects(exportTurn({ ...base(), formats: ['pdf'], BrowserWindow, dialog, fs }), /export_pdf_failed/)
  assert.equal(BrowserWindow.instances.length, 1)
  assert.equal(BrowserWindow.instances[0].destroyed, true, 'destroyed on the failure path')
  assert.equal(fs.removed.length, 1, 'the temp document is removed on the failure path')
  assert.equal(dialog.saveCalls.length, 0, 'a failed print never reaches the dialog')
  assert.equal(fs.files.has('/out/report.pdf'), false)
})

test('a load failure is coded AND the offscreen window is destroyed', async () => {
  const BrowserWindow = makeBrowserWindow({ mode: 'loadfail' })
  const fs = makeFs()
  await assert.rejects(exportTurn({ ...base(), formats: ['pdf'], BrowserWindow, fs }), /export_pdf_failed/)
  assert.equal(BrowserWindow.instances[0].destroyed, true)
  assert.equal(BrowserWindow.instances[0].webContents.printCalls.length, 0)
  assert.equal(fs.removed.length, 1)
})

test('a document that never finishes loading or printing times out, bounded, and is torn down', async () => {
  for (const mode of ['loadstall', 'printstall']) {
    const BrowserWindow = makeBrowserWindow({ mode })
    const fs = makeFs()
    await assert.rejects(exportTurn({ ...base(), formats: ['pdf'], BrowserWindow, fs, pdfTimeoutMs: 15 }), /export_pdf_timeout/, mode)
    assert.equal(BrowserWindow.instances[0].destroyed, true, mode)
    assert.equal(fs.removed.length, 1, mode)
  }
})

test('renderPdf: an empty document, no BrowserWindow and an empty print result are coded', async () => {
  await assert.rejects(renderPdf({ html: '', BrowserWindow: makeBrowserWindow() }), /export_pdf_failed/)
  await assert.rejects(renderPdf({ html: '<p>x</p>', BrowserWindow: null }), /export_unavailable/)
  const Empty = makeBrowserWindow({ pdf: Buffer.alloc(0) })
  await assert.rejects(renderPdf({ html: '<p>x</p>', BrowserWindow: Empty, fs: makeFs() }), /export_pdf_failed/)
  assert.equal(Empty.instances[0].destroyed, true)
})

test('a write failure is coded and names nothing it did not write', async () => {
  const fs = makeFs({ failWrite: '.html' })
  await assert.rejects(exportTurn({ ...base(), formats: ['md', 'html'], fs, dialog: makeDialog({ filePath: '/out/sky' }) }), (e) => {
    assert.equal(e.message, 'export_write_failed')
    assert.deepEqual(e.written, ['/out/sky.md'])
    return true
  })
  assert.equal(fs.files.has('/out/sky.html'), false)
})

test('missing collaborators are coded export_unavailable, never a crash', async () => {
  await assert.rejects(exportTurn({ ...base(), dialog: null }), /export_unavailable/)
  await assert.rejects(exportTurn({ ...base(), dialog: {} }), /export_unavailable/)
  await assert.rejects(exportTurn({ ...base(), backendUrl: null }), /export_unavailable/)
  await assert.rejects(exportTurn({ ...base(), formats: ['pdf'], BrowserWindow: null }), /export_unavailable/)
  // validation comes first: a bad payload is a bad_request even with nothing wired
  await assert.rejects(exportTurn({ ...base(), conversationId: '', dialog: null }), /bad_request/)
  await assert.rejects(exportTurn({ ...base(), formats: [] }), /bad_request/)
  await assert.rejects(exportTurn({}), /bad_request/)
})

test('a dialog that throws is coded export_dialog_failed', async () => {
  await assert.rejects(exportTurn({ ...base(), dialog: makeDialog({ throwOnSave: true }) }), /export_dialog_failed/)
})

/** The standard deps for a direct exportTurn call (one place, so a test only says what differs). */
function base() {
  return {
    conversationId: CONV,
    turnId: TURN,
    formats: ['md'],
    title: 'Why is the sky blue?',
    turnType: 'send',
    backendUrl: BACKEND,
    dialog: makeDialog(),
    BrowserWindow: makeBrowserWindow(),
    fetchImpl: makeFetch(),
    fs: makeFs(),
    now: () => TS,
    defaultDir: '/home/u/Documents',
    log: fakeLog(),
  }
}

test('every format is covered by EXTENSIONS (a new format cannot be half-wired)', () => {
  assert.deepEqual(Object.keys(EXTENSIONS), [...FORMATS])
  for (const f of FORMATS) assert.match(EXTENSIONS[f], /^\.[a-z]+$/)
})
