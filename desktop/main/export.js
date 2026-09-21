// desktop/main/export.js — "export this step as Markdown / HTML / PDF" (the file side).
//
// The user's request: after every step — the chat prompt (a Send turn), Analyze and Fusion — the
// turn can be written out as `.md`, `.html`, `.pdf`, or all three at once. Two decisions from the
// user are binding here and are the reason this module is deliberately dumb about content:
//
//   1. ANONYMITY IS PRESERVED. An Analyze / Fusion document says R1 / R2 / R3, exactly what the UI
//      shows; a Send document names the columns because the columns are labelled on screen. The
//      label-to-slot map never leaves the backend and is in no API response, so this module never
//      asks for it, never names a slot and never touches a byte of the document: the
//      backend renders, this module copies. `renderPdf` prints with `displayHeaderFooter:false`
//      precisely so Chromium cannot stamp a title or a local path into the page either. The leak
//      test (`test/unit/main/export-anonymity.test.js`) asserts both: the module source mentions no
//      vendor, product or slot name, and every written file is byte-identical to what the backend
//      returned.
//   2. A SAVE DIALOG EVERY TIME, with a sensible default name. `defaultFileName` builds the stem
//      (`<title-slug>-<step>-<YYYY-MM-DD>`); "all three" asks ONCE for a BASE path and writes the
//      three extensions beside each other. `dialog.showSaveDialog` is called exactly once per
//      export — the count is a test — and its own overwrite confirmation covers the path it
//      returned; any OTHER file the base path would overwrite is confirmed with one message box
//      before anything is written (never a silent overwrite, never a second save dialog).
//
// Shape: pure where it can be (`slugify`, `defaultFileName`, `requireExportRequest`, `exportUrl`,
// the path helpers), electron injected everywhere else (`dialog`, `BrowserWindow`, `fetch`, `fs`,
// the clock, the timers), so `node --test` drives all of it without a binary. Errors are CODED —
// `bad_request` | `export_unavailable` | `export_fetch_failed` | `export_pdf_failed` |
// `export_pdf_timeout` | `export_dialog_failed` | `export_write_failed` — never a crash, and the
// offscreen PDF window is closed on every path (gracefully — see `closePrintWindow`).
//
// Backend seam (the sibling workstream owns the endpoint):
//   GET <backend>/api/conversations/<id>/export/<turnId>?format=md|html
// The body is taken verbatim when it is text (`text/markdown`, `text/html`, `text/plain`), and
// from `content` | `markdown` | `html` | `text` | `body` when the endpoint answers JSON.

import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_TITLE, logoDataUri } from './branding.js'

/** The formats a step can be written as, in the order files are written. */
export const FORMATS = Object.freeze(['md', 'html', 'pdf'])
export const EXTENSIONS = Object.freeze({ md: '.md', html: '.html', pdf: '.pdf' })
/** The turn kinds the UI can export (`schemas.Turn`); anything else is a bad_request. */
export const TURN_TYPES = Object.freeze(['send', 'continue', 'analyze', 'fusion'])
export const MAX_ID_CHARS = 200
export const MAX_TITLE_CHARS = 200
/** Bounds for the generated stem: the whole stem, and the title slug inside it. */
export const MAX_STEM_CHARS = 120
export const MAX_TITLE_SLUG = 80
export const MAX_STEP_SLUG = 16
/** Used when a title slugs to nothing (emoji-only, CJK-only, punctuation-only) — always ASCII. */
export const FALLBACK_TITLE = 'conversation'
export const FALLBACK_STEP = 'turn'
export const FETCH_TIMEOUT_MS = 30000
/** A pathological document must not hang the app: the load and the print are each bounded. */
export const PDF_TIMEOUT_MS = 20000
/** How long the offscreen window may take to close before it is destroyed outright. */
export const PDF_CLOSE_TIMEOUT_MS = 3000
export const PDF_PAGE_SIZE = 'A4'
export const PDF_MARGINS = Object.freeze({ top: 0.85, bottom: 0.6, left: 0.6, right: 0.6 })

/** The app's three theme states, the only values the export URL will carry. */
export const THEMES = Object.freeze(['light', 'dark', 'system'])

/**
 * The running page header: the mark and the product name, in the top margin of EVERY sheet.
 *
 * Chromium draws `headerTemplate` itself, once per page — the reliable way to do this. The CSS
 * alternative, a `position: fixed` block in the document, was measured on 2026-09-19 laying out at
 * the FOOT of the page instead, so `backend/export.py` hides its in-flow header for print and this
 * takes over. The template runs with no network and no file access, hence the inline image.
 *
 * Template quirks worth knowing: the default font-size is ~8px unless set, the template is clipped
 * to the page margin (so `margins.top` has to leave room), and an EMPTY footerTemplate is required
 * or Chromium stamps its own page numbers and URL.
 */
export function printHeaderTemplate(title, logoUri) {
  const name = escapeHtml(typeof title === 'string' && title.trim() ? title.trim() : '')
  const mark = logoUri ? `<img src="${escapeHtml(logoUri)}" style="width:17px;height:17px;display:block;border-radius:3px">` : ''
  return (
    '<div style="width:100%;margin:0 12mm;padding:0 0 2px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'font-size:8px;color:#5b6672;border-bottom:.5px solid #e4e9ee;">' +
    `<div style="display:flex;align-items:center;gap:5px;">${mark}<span>${name}</span></div>` +
    '</div>'
  )
}

/** Chromium needs a footer template or it stamps its own page number and file URL. */
export const PRINT_FOOTER_TEMPLATE = '<span></span>'

/** Minimal HTML escaping for the two values that reach the template. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** A coded error: `message` IS the code, so the renderer can switch on it. */
export function codedError(code, detail) {
  const e = new Error(code)
  e.code = code
  if (detail !== undefined && detail !== null && detail !== '') e.detail = String(detail)
  return e
}

export function badRequest() {
  return new Error('bad_request')
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * A file-name-safe ASCII slug: diacritics folded, everything outside [a-z0-9] collapsed to `-`,
 * trimmed, bounded. Path separators, dots, colons and control characters cannot survive it, so a
 * slug can never escape the directory the dialog returned or start with a dot.
 */
export function slugify(text, { max = MAX_TITLE_SLUG } = {}) {
  const raw = typeof text === 'string' ? text : ''
  let s = raw
  try {
    s = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // combining marks: é → e
  } catch (_e) {
    /* a string that cannot be normalized is slugged as-is */
  }
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  s = s.replace(/^-+/, '').replace(/-+$/, '')
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_TITLE_SLUG
  if (s.length > limit) s = s.slice(0, limit).replace(/-+$/, '')
  return s
}

/** `YYYY-MM-DD` (UTC, so the name a test predicts does not depend on the machine's zone). */
export function dateStamp(ts) {
  const n = Number(ts)
  const d = new Date(Number.isFinite(n) && n > 0 ? n : Date.now())
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
  return iso.slice(0, 10)
}

/**
 * The default file stem offered in the save dialog: `<title-slug>-<step>-<YYYY-MM-DD>`.
 * No path separator, no leading dot, ASCII only, at most MAX_STEM_CHARS characters — an
 * emoji-only or CJK-only title falls back to `conversation`, an unknown step to `turn`.
 */
export function defaultFileName({ title = '', turnType = '', ts = null } = {}) {
  const step = slugify(turnType, { max: MAX_STEP_SLUG }) || FALLBACK_STEP
  const stamp = dateStamp(ts)
  const room = MAX_STEM_CHARS - (step.length + stamp.length + 2) // two joining dashes
  const titleMax = Math.max(8, Math.min(MAX_TITLE_SLUG, room))
  const name = slugify(title, { max: titleMax }) || FALLBACK_TITLE
  return `${name}-${step}-${stamp}`
}

/** `<p><ext>` unless it already ends with it (case-insensitively). */
export function ensureExtension(filePath, ext) {
  const p = String(filePath)
  return p.toLowerCase().endsWith(String(ext).toLowerCase()) ? p : `${p}${ext}`
}

/** The base path the three formats hang off: a known extension (and trailing dots) removed. */
export function stripKnownExtension(filePath) {
  let p = String(filePath)
  for (const ext of Object.values(EXTENSIONS)) {
    if (p.toLowerCase().endsWith(ext)) {
      p = p.slice(0, -ext.length)
      break
    }
  }
  const base = path.basename(p)
  if (base !== '' && !/^\.+$/.test(base) && base.endsWith('.')) p = p.replace(/\.+$/, '')
  return p
}

// ---------------------------------------------------------------------------------------------
// Validation (the same discipline as every other panes:* payload — §2)
// ---------------------------------------------------------------------------------------------

function requireId(v) {
  if (typeof v !== 'string' || v === '' || v.length > MAX_ID_CHARS) throw badRequest()
  return v
}

/** formats ⊆ FORMATS, non-empty; de-duplicated and returned in FORMATS order. */
export function requireFormats(formats) {
  if (!Array.isArray(formats) || formats.length === 0) throw badRequest()
  const seen = new Set()
  for (const f of formats) {
    if (typeof f !== 'string' || !FORMATS.includes(f)) throw badRequest()
    seen.add(f)
  }
  const out = FORMATS.filter((f) => seen.has(f))
  if (out.length === 0) throw badRequest()
  return out
}

/**
 * The 'panes:export' payload: `{conversationId, turnId, formats, title?, turnType?}`.
 * `title` and `turnType` only shape the default file name (the UI knows both); they are never
 * sent to the backend. Anything else — a missing id, an oversize string, an unknown format or
 * turn kind, a non-object payload — is a bad_request.
 */
export function requireExportRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest()
  const conversationId = requireId(payload.conversationId)
  const turnId = requireId(payload.turnId)
  const formats = requireFormats(payload.formats)
  let title = ''
  if (payload.title !== undefined && payload.title !== null) {
    if (typeof payload.title !== 'string' || payload.title.length > MAX_TITLE_CHARS) throw badRequest()
    title = payload.title
  }
  let turnType = ''
  if (payload.turnType !== undefined && payload.turnType !== null) {
    if (typeof payload.turnType !== 'string' || !TURN_TYPES.includes(payload.turnType)) throw badRequest()
    turnType = payload.turnType
  }
  return { conversationId, turnId, formats, title, turnType }
}

// ---------------------------------------------------------------------------------------------
// The backend document
// ---------------------------------------------------------------------------------------------

/**
 * `GET <backend>/api/conversations/<id>/export/<turnId>?format=<md|html>[&theme=<t>]` — no slot, ever.
 *
 * `theme` is the app's own light/dark/system state, so a document looks like the window it came from
 * (user request, 2026-09-20). It is omitted entirely when it is absent or `light`, which is what the
 * endpoint has always rendered — so a light export is the same request, byte for byte, as before.
 */
export function exportUrl(backendUrl, conversationId, turnId, format, theme) {
  const base = String(backendUrl || '').replace(/\/+$/, '')
  if (base === '') throw codedError('export_unavailable', 'no backend URL')
  const url = `${base}/api/conversations/${encodeURIComponent(conversationId)}/export/${encodeURIComponent(turnId)}?format=${encodeURIComponent(format)}`
  const wanted = THEMES.includes(theme) ? theme : ''
  return wanted === '' || wanted === 'light' ? url : `${url}&theme=${encodeURIComponent(wanted)}`
}

/** The text of a JSON envelope, whichever field the endpoint uses; '' when there is none. */
function textFromJson(obj) {
  if (obj === null || typeof obj !== 'object') return ''
  for (const key of ['content', 'markdown', 'html', 'text', 'body']) {
    if (typeof obj[key] === 'string') return obj[key]
  }
  return ''
}

/**
 * fetchDocument({backendUrl, conversationId, turnId, format, theme, fetchImpl, timeoutMs}) → string
 * A non-2xx answer, a transport failure, a timeout or an empty document is `export_fetch_failed`.
 */
export async function fetchDocument({ backendUrl, conversationId, turnId, format, theme, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw codedError('export_unavailable', 'no fetch')
  const url = exportUrl(backendUrl, conversationId, turnId, format, theme)
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  let res
  try {
    res = await fetchImpl(url, controller ? { signal: controller.signal } : {})
  } catch (e) {
    throw codedError('export_fetch_failed', `${format}: ${(e && e.message) || e}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!res || res.ok === false) throw codedError('export_fetch_failed', `${format}: HTTP ${(res && res.status) || 'no response'}`)
  let raw
  try {
    raw = typeof res.text === 'function' ? await res.text() : ''
  } catch (e) {
    throw codedError('export_fetch_failed', `${format}: ${(e && e.message) || e}`)
  }
  const type = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : ''
  let content = raw
  if (/\bjson\b/i.test(type)) {
    try {
      content = textFromJson(JSON.parse(raw))
    } catch (_e) {
      content = ''
    }
  }
  if (typeof content !== 'string' || content === '') throw codedError('export_fetch_failed', `${format}: empty document`)
  return content
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

/**
 * renderPdf({html, BrowserWindow, ...}) → Buffer
 *
 * The HTML is printed by an OFFSCREEN window: `show:false`, not focusable, never shown, never
 * added to the deck's contentView (so it cannot appear between the panes or steal the keyboard),
 * sandboxed and context-isolated with scripting off — an exported document is static, and a
 * document that cannot run code cannot reach out of the print. The window is torn down in a
 * `finally` on EVERY path (load failure, print failure, timeout) together with the temp file, and
 * both the load and the print are bounded by `timeoutMs`. Teardown goes through
 * `closePrintWindow`, never a bare `destroy()` — see the note there.
 */
/**
 * Tear the offscreen print window down the way a window is meant to go: `close()`, wait for
 * `closed`, and only `destroy()` if it did not close within `timeoutMs`.
 *
 * Measured on this box with Electron 44.4.1 / Chromium 152 (2026-09-18, six teardown strategies):
 * `destroy()` on an offscreen window that had loaded a `file://` URL leaves the NEXT `file://` load
 * in a brand-new window failing with `ERR_FAILED (-2)`, and the third destroy takes the browser
 * process down with SIGTRAP — but ONLY while that window is the LAST one in the process. Keep any
 * other window open (`about:blank` is enough) and `destroy()` is harmless, which is why the app
 * spec never saw it: Triplex's own main window is always there. So this is robustness, not a live
 * bug fix — it drops the dependency on "some other window happens to be open", which would bite a
 * print during shutdown or from a future window-less mode, and it matches how `views.js` and
 * `analyst-views.js` already tear their webContents down (`wc.close()`, never destroy).
 * It reproduces with `printToPDF` removed, whether or not the temp directory is kept, and with the
 * destroy delayed by a tick or 100 ms, so the trigger is the abrupt teardown, not the print.
 * Returns how it went, for the caller's log: 'closed' | 'destroyed' | 'already' | 'none'.
 */
export async function closePrintWindow(win, { log = console, timeoutMs = PDF_CLOSE_TIMEOUT_MS, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout } = {}) {
  const warn = (line) => {
    if (log && typeof log.warn === 'function') log.warn(line)
  }
  const force = (why) => {
    try {
      if (typeof win.destroy === 'function' && !(typeof win.isDestroyed === 'function' && win.isDestroyed())) win.destroy()
    } catch (e) {
      warn(`[export] could not destroy the print window (${why}): ${(e && e.message) || e}`)
    }
    return 'destroyed'
  }

  if (!win) return 'none'
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return 'already'
  if (typeof win.close !== 'function') return force('no close()')

  let settle = null
  const done = new Promise((resolve) => {
    settle = resolve
  })
  let timer = setT(() => {
    timer = null
    settle('timeout')
  }, timeoutMs)
  if (typeof win.once === 'function') win.once('closed', () => settle('closed'))
  else settle('no_event') // a window without events: close() is all there is to wait for
  try {
    win.close()
  } catch (e) {
    warn(`[export] could not close the print window: ${(e && e.message) || e}`)
    settle('error')
  }
  const how = await done
  if (timer !== null) clearT(timer)
  if (how === 'timeout') {
    warn(`[export] the print window did not close within ${timeoutMs} ms; destroying it`)
    return force('timeout')
  }
  if (how === 'error') return force('close() threw')
  return how === 'no_event' ? 'closed' : how
}

export async function renderPdf({ html, BrowserWindow, fs = nodeFs, tmpdir = os.tmpdir, timeoutMs = PDF_TIMEOUT_MS, closeTimeoutMs = PDF_CLOSE_TIMEOUT_MS, pageSize = PDF_PAGE_SIZE, headerTemplate = null, log = console, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout } = {}) {
  if (typeof BrowserWindow !== 'function') throw codedError('export_unavailable', 'no BrowserWindow')
  if (typeof html !== 'string' || html === '') throw codedError('export_pdf_failed', 'empty document')

  const bound = (promise, code) =>
    new Promise((resolve, reject) => {
      let timer = setT(() => {
        timer = null
        reject(codedError(code, `nothing after ${timeoutMs} ms`))
      }, timeoutMs)
      Promise.resolve(promise).then(
        (v) => {
          if (timer === null) return
          clearT(timer)
          resolve(v)
        },
        (e) => {
          if (timer === null) return
          clearT(timer)
          reject(e)
        },
      )
    })

  let dir = null
  let win = null
  try {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'triplex-export-'))
    const file = path.join(dir, 'document.html')
    fs.writeFileSync(file, html, 'utf8')

    win = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 1024,
      height: 1400,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        javascript: false, // a printed document is static; nothing in it executes
        backgroundThrottling: false,
      },
    })
    const wc = win.webContents
    if (!wc) throw codedError('export_pdf_failed', 'no webContents')

    const loaded = new Promise((resolve, reject) => {
      if (typeof wc.once !== 'function') {
        resolve()
        return
      }
      wc.once('did-finish-load', () => resolve())
      wc.once('did-fail-load', (_event, errorCode, errorDescription) => reject(codedError('export_pdf_failed', `load failed: ${errorCode} ${errorDescription || ''}`.trim())))
      wc.once('render-process-gone', () => reject(codedError('export_pdf_failed', 'render process gone')))
    })
    const navigating = Promise.resolve()
      .then(() => wc.loadURL(pathToFileURL(file).href))
      .catch((e) => {
        throw codedError('export_pdf_failed', `load failed: ${(e && e.message) || e}`)
      })
    // Whichever settles first: Electron resolves loadURL on the finished load, the fakes emit the
    // event; a rejection from either path is the coded failure.
    await bound(Promise.race([loaded, navigating]), 'export_pdf_timeout')

    let data
    try {
      data = await bound(
        wc.printToPDF({
          pageSize,
          printBackground: true,
          margins: { ...PDF_MARGINS },
          // The ONLY thing stamped is our own header: the mark and the product name. Never a
          // title, a file path or a date — and the empty footer keeps Chromium's defaults off.
          displayHeaderFooter: Boolean(headerTemplate),
          ...(headerTemplate ? { headerTemplate, footerTemplate: PRINT_FOOTER_TEMPLATE } : {}),
          landscape: false,
        }),
        'export_pdf_timeout',
      )
    } catch (e) {
      if (e && (e.code === 'export_pdf_timeout' || e.code === 'export_pdf_failed')) throw e
      throw codedError('export_pdf_failed', (e && e.message) || e)
    }
    if (!data || typeof data.length !== 'number' || data.length === 0) throw codedError('export_pdf_failed', 'empty PDF')
    return data
  } finally {
    // Graceful close, never a bare destroy: destroying the last window in a process poisons the
    // next file:// load in it. See closePrintWindow.
    if (win) await closePrintWindow(win, { log, timeoutMs: closeTimeoutMs, setTimeout: setT, clearTimeout: clearT })
    if (dir) {
      try {
        if (typeof fs.rmSync === 'function') fs.rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        if (log && typeof log.warn === 'function') log.warn(`[export] could not remove ${dir}: ${(e && e.message) || e}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The whole export
// ---------------------------------------------------------------------------------------------

/** The dialog options for one format, or for the shared base path of several. */
export function saveDialogOptions({ formats, stem, defaultDir = '' }) {
  const single = formats.length === 1
  const name = single ? `${stem}${EXTENSIONS[formats[0]]}` : stem
  const defaultPath = defaultDir ? path.join(String(defaultDir), name) : name
  const options = {
    title: single ? `Export this step as ${formats[0].toUpperCase()}` : `Export this step (${formats.map((f) => f.toUpperCase()).join(', ')}) — choose the base name`,
    defaultPath,
    buttonLabel: 'Export',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  if (single) {
    const ext = EXTENSIONS[formats[0]].slice(1)
    options.filters = [{ name: formats[0].toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }]
  }
  return options
}

/** The file each format is written to, given what the dialog returned. */
export function targetPaths(formats, chosenPath) {
  const out = {}
  if (formats.length === 1) {
    out[formats[0]] = ensureExtension(chosenPath, EXTENSIONS[formats[0]])
    return out
  }
  const base = stripKnownExtension(chosenPath)
  for (const f of formats) out[f] = `${base}${EXTENSIONS[f]}`
  return out
}

/**
 * exportTurn(request + deps) → {cancelled, formats, files, paths, defaultName}
 *
 * Order: validate → fetch the document(s) the backend renders (html is fetched whenever a PDF is
 * wanted, even when no .html is written) → print the PDF → ONE save dialog → confirm any overwrite
 * the dialog itself did not cover → write. A cancel at either prompt writes nothing and answers
 * `{cancelled:true}`; every failure is a coded Error.
 */
export async function exportTurn({
  conversationId,
  turnId,
  formats,
  title = '',
  turnType = '',
  backendUrl = null,
  dialog = null,
  BrowserWindow = null,
  parentWindow = null,
  fetchImpl = globalThis.fetch,
  fs = nodeFs,
  now = Date.now,
  defaultDir = '',
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  pdfTimeoutMs = PDF_TIMEOUT_MS,
  pdfCloseTimeoutMs = PDF_CLOSE_TIMEOUT_MS,
  tmpdir = os.tmpdir,
  theme = 'light',
  log = console,
} = {}) {
  const req = requireExportRequest({ conversationId, turnId, formats, title, turnType })
  if (!dialog || typeof dialog.showSaveDialog !== 'function') throw codedError('export_unavailable', 'no save dialog')
  if (!backendUrl) throw codedError('export_unavailable', 'the backend is not running yet')
  if (req.formats.includes('pdf') && typeof BrowserWindow !== 'function') throw codedError('export_unavailable', 'no BrowserWindow for the PDF')

  // The document the backend renders — R1/R2/R3 for Analyze and Fusion, the labelled columns for a
  // Send — is fetched and copied verbatim. HTML is also the PDF's source.
  const wantMd = req.formats.includes('md')
  const wantHtml = req.formats.includes('html') || req.formats.includes('pdf')
  const docs = {}
  if (wantMd) docs.md = await fetchDocument({ backendUrl, conversationId: req.conversationId, turnId: req.turnId, format: 'md', theme, fetchImpl, timeoutMs: fetchTimeoutMs })
  if (wantHtml) docs.html = await fetchDocument({ backendUrl, conversationId: req.conversationId, turnId: req.turnId, format: 'html', theme, fetchImpl, timeoutMs: fetchTimeoutMs })

  let pdf = null
  if (req.formats.includes('pdf')) {
    pdf = await renderPdf({
      html: docs.html,
      BrowserWindow,
      fs,
      tmpdir,
      timeoutMs: pdfTimeoutMs,
      closeTimeoutMs: pdfCloseTimeoutMs,
      headerTemplate: printHeaderTemplate(APP_TITLE, logoDataUri()),
      log,
    })
  }

  const stem = defaultFileName({ title: req.title, turnType: req.turnType, ts: now() })
  let result
  try {
    const options = saveDialogOptions({ formats: req.formats, stem, defaultDir })
    result = parentWindow ? await dialog.showSaveDialog(parentWindow, options) : await dialog.showSaveDialog(options)
  } catch (e) {
    throw codedError('export_dialog_failed', (e && e.message) || e)
  }
  const cancelled = !result || result.canceled === true || result.cancelled === true || typeof result.filePath !== 'string' || result.filePath === ''
  if (cancelled) return { cancelled: true, formats: req.formats, files: {}, paths: [], defaultName: stem }

  const chosen = String(result.filePath)
  const files = targetPaths(req.formats, chosen)

  // The dialog confirmed the path it returned; a sibling extension it did not name is confirmed
  // here, once, before anything is written. Never a silent overwrite.
  const existing = req.formats
    .map((f) => files[f])
    .filter((p) => p !== chosen)
    .filter((p) => {
      try {
        return typeof fs.existsSync === 'function' && fs.existsSync(p)
      } catch (_e) {
        return false
      }
    })
  if (existing.length && !(await confirmOverwrite({ dialog, parentWindow, paths: existing, log }))) {
    return { cancelled: true, formats: req.formats, files: {}, paths: [], defaultName: stem }
  }

  const written = []
  for (const format of req.formats) {
    const target = files[format]
    try {
      const dir = path.dirname(target)
      if (dir && typeof fs.mkdirSync === 'function') fs.mkdirSync(dir, { recursive: true })
      if (format === 'pdf') fs.writeFileSync(target, pdf)
      else fs.writeFileSync(target, docs[format], 'utf8')
      written.push(target)
    } catch (e) {
      const err = codedError('export_write_failed', `${target}: ${(e && e.message) || e}`)
      err.written = written
      throw err
    }
  }
  if (log && typeof log.log === 'function') log.log(`[export] ${req.turnType || 'turn'} → ${req.formats.join('+')} (${written.length} file(s))`)
  return { cancelled: false, formats: req.formats, files, paths: written, defaultName: stem }
}

/** One confirmation for the files the save dialog did not itself confirm; true = go ahead. */
async function confirmOverwrite({ dialog, parentWindow, paths, log }) {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    if (log && typeof log.warn === 'function') log.warn('[export] no message box available; refusing to overwrite silently')
    return false
  }
  const options = {
    type: 'warning',
    buttons: ['Cancel', 'Replace'],
    defaultId: 1,
    cancelId: 0,
    title: 'Replace files?',
    message: paths.length === 1 ? 'One file already exists. Replace it?' : `${paths.length} files already exist. Replace them?`,
    detail: paths.map((p) => path.basename(p)).join('\n'),
  }
  try {
    const answer = parentWindow ? await dialog.showMessageBox(parentWindow, options) : await dialog.showMessageBox(options)
    return !!answer && answer.response === 1
  } catch (e) {
    if (log && typeof log.warn === 'function') log.warn(`[export] overwrite confirmation failed: ${(e && e.message) || e}`)
    return false
  }
}
