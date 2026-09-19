// The export leak gate. The user's first decision about this feature: an Analyze or Fusion export
// says R1 / R2 / R3 — exactly what the UI shows — and must NEVER reveal which slot is which; a Send
// export names the columns because the Send columns are labelled on screen. The backend renders both
// documents (it owns the label↔slot map, which is stripped from every API response and stays that
// way); the desktop's job is to copy bytes and name files.
//
// So this file gates the two things the file layer could get wrong:
//   1. `main/export.js` never names a vendor, a product, a slot or the label map at all — it cannot
//      leak an identity it does not know. The word list mirrors backend/config.py
//      FORBIDDEN_IDENTITY_STRINGS + FORBIDDEN_MODEL_CODENAMES (the backend's leak sweep).
//   2. Nothing is added to, removed from or rewritten in a document on its way to disk: the .md and
//      .html files are byte-identical to what the backend returned, the PDF is printed from that
//      same HTML with `displayHeaderFooter:false` (no Chromium-stamped title or path), and neither
//      the request URL nor the generated file name carries a slot.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { defaultFileName, requireExportRequest, exportUrl, exportTurn } from '../../../main/export.js'
import { fakeLog } from './_fakes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXPORT_JS = path.join(HERE, '..', '..', '..', 'main', 'export.js')
const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const TURN = '7b2c1d0e-3f4a-4b5c-8d9e-0f1a2b3c4d5e'
const TS = Date.UTC(2026, 8, 18)
const BACKEND = 'http://127.0.0.1:8021'

/** backend/config.py FORBIDDEN_IDENTITY_STRINGS (word-bounded) + the slug-only code names. */
const FORBIDDEN = ['claude', 'chatgpt', 'grok', 'openai', 'anthropic', 'xai', 'x-ai', 'spacexai', 'gpt', 'opus', 'sonnet', 'fable']
const CODENAMES = ['luna', 'sol', 'astra']

function leaks(text) {
  const found = []
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word.replace('-', '\\-')}\\b`, 'i').test(text)) found.push(word)
  }
  for (const code of CODENAMES) {
    if (new RegExp(`-${code}\\b`, 'i').test(text)) found.push(code)
  }
  if (/anon[_-]?map/i.test(text)) found.push('anon_map')
  return found
}

/** An Analyze / Fusion document as the backend renders it: R-labels only. */
const ANALYZE_MD = '# Analyze\n\n## Similar\n- R1, R2 and R3 agree that the sky scatters blue light\n\n## Differs\n- R1 says Rayleigh; R2 says Mie; R3 abstains\n'
const ANALYZE_HTML = '<h1>Analyze</h1><p>R1 and R2 differ; R3 abstains.</p>'
const FUSION_MD = '# Fusion\n\nRound 1 — R1 defends, R2 revises (flagged), R3 stands.\n'
const SEND_MD = '# Send\n\n## Claude\nBlue.\n\n## ChatGPT\nBlue.\n\n## Grok\nBlue.\n'

function makeFs() {
  const files = new Map()
  const self = { files, removed: [], tmpDirs: 0 }
  self.existsSync = (p) => files.has(p)
  self.mkdirSync = () => {}
  self.writeFileSync = (p, data) => files.set(p, data)
  self.mkdtempSync = () => `/tmp/triplex-export-${self.tmpDirs++}`
  self.rmSync = (p) => self.removed.push(p)
  return self
}

function makeDialog(filePath) {
  const dialog = { saveCalls: [], showSaveDialog: async (...a) => (dialog.saveCalls.push(a), { canceled: false, filePath }), showMessageBox: async () => ({ response: 1 }) }
  return dialog
}

function makeFetch({ md, html }) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    const format = new URL(String(url)).searchParams.get('format')
    const body = format === 'md' ? md : html
    return { ok: true, status: 200, headers: { get: () => (format === 'md' ? 'text/markdown' : 'text/html') }, text: async () => body }
  }
  impl.calls = calls
  return impl
}

function makeBrowserWindow(seen) {
  return class FakeWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      const wc = new EventEmitter()
      wc.printCalls = []
      wc.loadURL = async (url) => {
        seen.loaded.push(url)
        setImmediate(() => wc.emit('did-finish-load'))
      }
      wc.printToPDF = async (opts) => {
        wc.printCalls.push(opts)
        seen.print.push(opts)
        return Buffer.from('%PDF-1.7 fake')
      }
      this.webContents = wc
      this.isDestroyed = () => this.destroyed
      this.destroy = () => {
        this.destroyed = true
      }
    }
  }
}

test('main/export.js names no vendor, product, slot or label map — it cannot leak what it never knows', () => {
  const source = fs.readFileSync(EXPORT_JS, 'utf8')
  assert.deepEqual(leaks(source), [], 'export.js must stay slot-agnostic')
  // ...and the sanity check that the gate itself works
  assert.deepEqual(leaks('the chatgpt column'), ['chatgpt'])
  assert.deepEqual(leaks('gpt-5.6-luna'), ['gpt', 'luna'])
  assert.deepEqual(leaks('{"anon_map": {}}'), ['anon_map'])
  assert.deepEqual(leaks('R1 and R2 disagree; the analyst abstains'), [])
})

test('an Analyze export is written byte for byte, with R-labels and no slot in the name, URL or PDF', async () => {
  const fsFake = makeFs()
  const dialog = makeDialog('/out/base')
  const fetchImpl = makeFetch({ md: ANALYZE_MD, html: ANALYZE_HTML })
  const seen = { loaded: [], print: [] }
  const res = await exportTurn({
    conversationId: CONV,
    turnId: TURN,
    formats: ['md', 'html', 'pdf'],
    title: 'Why is the sky blue?',
    turnType: 'analyze',
    backendUrl: BACKEND,
    dialog,
    BrowserWindow: makeBrowserWindow(seen),
    fetchImpl,
    fs: fsFake,
    now: () => TS,
    log: fakeLog(),
  })
  assert.equal(res.cancelled, false)
  // the documents reach disk exactly as the backend rendered them
  assert.equal(fsFake.files.get('/out/base.md'), ANALYZE_MD)
  assert.equal(fsFake.files.get('/out/base.html'), ANALYZE_HTML)
  assert.deepEqual(leaks(fsFake.files.get('/out/base.md')), [], 'the R-labelled report stays anonymous')
  assert.deepEqual(leaks(fsFake.files.get('/out/base.html')), [])
  // the PDF is printed from that same HTML, unmodified, with nothing stamped around it
  const printed = [...fsFake.files.entries()].find(([p]) => p.startsWith('/tmp/triplex-export-'))
  assert.equal(printed[1], ANALYZE_HTML, 'the print source is the fetched HTML, not a rewrite')
  // A header IS stamped on every page now, and it is OURS: the mark and the product name. What
  // matters here is that it says nothing about which model answered — it is built from the app
  // name and an asset, never from the document — and that Chromium's own title / path / page
  // numbers stay off, which is what the empty footer template is for.
  const print = seen.print[0]
  assert.equal(print.displayHeaderFooter, true)
  assert.deepEqual(leaks(print.headerTemplate), [], 'the printed header names no model')
  assert.equal(print.footerTemplate, '<span></span>', 'no page numbers, no file path')
  assert.doesNotMatch(print.headerTemplate, /file:\/\/|\/tmp\/|document\.html/, 'no local path')
  assert.doesNotMatch(print.headerTemplate, /why-is-the-sky-blue|analyze/i, 'nothing from the document')
  // the request and the file name carry no slot either
  for (const url of fetchImpl.calls) {
    assert.deepEqual(leaks(url), [], url)
    assert.equal(new URL(url).searchParams.has('slot'), false)
  }
  assert.deepEqual(leaks(res.defaultName), [])
  assert.equal(res.defaultName, 'why-is-the-sky-blue-analyze-2026-09-18')
})

test('a Fusion export is the same rule; only the step in the name changes', async () => {
  const fsFake = makeFs()
  const fetchImpl = makeFetch({ md: FUSION_MD, html: '<p>R1 stands.</p>' })
  const res = await exportTurn({
    conversationId: CONV,
    turnId: TURN,
    formats: ['md'],
    title: 'Sky colour',
    turnType: 'fusion',
    backendUrl: BACKEND,
    dialog: makeDialog('/out/fusion'),
    fetchImpl,
    fs: fsFake,
    now: () => TS,
    log: fakeLog(),
  })
  assert.equal(fsFake.files.get('/out/fusion.md'), FUSION_MD)
  assert.deepEqual(leaks(FUSION_MD), [], 'the fixture itself is anonymous — the export adds nothing')
  assert.equal(res.defaultName, 'sky-colour-fusion-2026-09-18')
})

test('a Send export carries the labels the backend put there — the file layer neither adds nor removes them', async () => {
  const fsFake = makeFs()
  const fetchImpl = makeFetch({ md: SEND_MD, html: '<h1>Send</h1>' })
  await exportTurn({
    conversationId: CONV,
    turnId: TURN,
    formats: ['md'],
    title: 'Why is the sky blue?',
    turnType: 'send',
    backendUrl: BACKEND,
    dialog: makeDialog('/out/send.md'),
    fetchImpl,
    fs: fsFake,
    now: () => TS,
    log: fakeLog(),
  })
  // The named columns come from the BACKEND's Send document (the columns are labelled on screen);
  // what matters here is that the bytes are untouched, whichever document it is.
  assert.equal(fsFake.files.get('/out/send.md'), SEND_MD)
})

test('the payload cannot smuggle a slot into the request: only five fields survive validation', () => {
  const req = requireExportRequest({ conversationId: CONV, turnId: TURN, formats: ['md'], slot: 'claude', anon_map: { R1: 'claude' }, label: 'R1' })
  assert.deepEqual(Object.keys(req).sort(), ['conversationId', 'formats', 'title', 'turnId', 'turnType'])
  const url = exportUrl(BACKEND, req.conversationId, req.turnId, 'md')
  assert.deepEqual(leaks(url), [])
  assert.equal(url, `${BACKEND}/api/conversations/${CONV}/export/${TURN}?format=md`)
})

test('a title the user typed is the ONE place a name can carry anything — the step and date never do', () => {
  // User prompts are out of scope for the leak rule (the backend applies the same stance): a title
  // is the user's own words. What the export must not do is invent an identity of its own.
  const fromUser = defaultFileName({ title: 'Compare the three answers', turnType: 'analyze', ts: TS })
  assert.deepEqual(leaks(fromUser), [])
  for (const turnType of ['send', 'continue', 'analyze', 'fusion']) {
    assert.deepEqual(leaks(defaultFileName({ title: '', turnType, ts: TS })), [], turnType)
  }
})
