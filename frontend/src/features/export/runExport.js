// Export: the two paths one menu choice can take.
//
//   DESKTOP (window.triplex present) — ONE IPC call per choice, even for "all three": Electron
//   fetches the documents, renders the PDF from the HTML, shows ONE save dialog for a base path and
//   writes the .md / .html / .pdf beside each other (binding decision: a dialog each time, with a
//   sensible default name). The renderer never names the file: `title` and `turnType` are what the
//   desktop builds its default name from.
//       triplex.exportTurn({conversationId, turnId, formats, title, turnType})
//           -> {cancelled: boolean, formats, files: {[format]: path}, paths: string[], defaultName}
//           -> throws a coded Error (export_unavailable | export_fetch_failed | export_dialog_failed |
//              export_write_failed | export_pdf_failed | bad_request) on failure
//   The payload and the result shape are `desktop/main/export.js` (`requireExportRequest`,
//   `exportTurn`) over the `panes:export` channel; the `triplex.exportTurn` NAME is the one line of
//   this that still needs the frozen `desktop/preload/renderer.cjs` to expose it (see this
//   workstream's frozen_change_requests). Every call is optional-chained and every field is read
//   defensively, so a preload without the method degrades to one result line instead of throwing.
//
//   BROWSER (no window.triplex) — GET the document and hand it to the browser as a Blob download:
//       GET /api/conversations/{id}/export/{turn_id}?format=md|html   (backend/routers/export.py)
//   PDF is not offered here, and the backend has no `pdf` format: the PDF is printed from the HTML
//   document by the shell that owns a printer (see formats.availableFormats). The file name comes
//   from the endpoint's own suggestion (`X-Triplex-Export-Filename`, else `Content-Disposition`) so
//   both shells name a document the same way; `formats.defaultBaseName` is the fallback.
//
// The request carries a conversation id, a turn id and a format — never a slot id, never the anon
// map (the renderer has never seen one).
import { ApiError, BASE, safeJson } from '../../api/http.js'
import { FORMAT_MIME, baseNameOf, fileNameFor } from './formats.js'

/** True when the Electron preload surface is present. */
export function isDesktop(w = typeof window === 'undefined' ? undefined : window) {
  return !!(w && w.triplex)
}

export function exportPath(conversationId, turnId, format) {
  return `/api/conversations/${encodeURIComponent(conversationId)}/export/${encodeURIComponent(turnId)}?format=${encodeURIComponent(format)}`
}

/**
 * A server-suggested download name is only used when it is a plain file name with the extension we
 * asked for: a header is not a trustworthy path, and `<a download>` must never carry one.
 */
export function safeSuggestedName(name, format) {
  const s = String(name == null ? '' : name).trim()
  if (!s || s.length > 200) return null
  if (s !== baseNameOf(s) || s.startsWith('.')) return null
  return s.toLowerCase().endsWith(`.${format}`) ? s : null
}

/** The name the endpoint suggests for this document, or null. */
export function suggestedName(headers, format) {
  const get = headers && typeof headers.get === 'function' ? (k) => headers.get(k) : () => null
  const direct = safeSuggestedName(get('x-triplex-export-filename'), format)
  if (direct) return direct
  const cd = get('content-disposition')
  const m = cd ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd) : null
  return m ? safeSuggestedName(decodeURIComponent(m[1]), format) : null
}

/** `{text, suggested}` for one format. Failures raise ApiError (the frozen http.js envelope). */
export async function fetchDocument(conversationId, turnId, format) {
  const r = await fetch(BASE + exportPath(conversationId, turnId, format), { headers: { Accept: 'text/markdown, text/html, text/plain, application/json' } })
  if (!r.ok) throw new ApiError(r.status, await safeJson(r))
  const text = typeof r.text === 'function' ? await r.text() : ''
  return { text, suggested: suggestedName(r.headers, format) }
}

/** Hand one document to the browser's own download machinery. */
export function triggerDownload(text, filename, format, doc = document) {
  const type = FORMAT_MIME[format] || 'text/plain;charset=utf-8'
  const blob = new Blob([text], { type })
  const make = typeof URL !== 'undefined' && URL.createObjectURL
  const url = make ? URL.createObjectURL(blob) : `data:${type},`
  const a = doc.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  doc.body.appendChild(a)
  a.click()
  a.remove()
  if (make && URL.revokeObjectURL) URL.revokeObjectURL(url)
  return filename
}

function errorOutcome(code, message) {
  return { state: 'error', code: code || 'export_failed', message: message || null, names: [], paths: [] }
}

/** The error code of any failure shape, for the one-line result. */
export function codeOf(e) {
  if (!e) return 'export_failed'
  if (e.code) return e.code
  if (e.status) return `http_${e.status}`
  return 'export_failed'
}

/**
 * ONE desktop call for the whole choice: `formats` is the full list, so "all three" is one dialog
 * and one write pass, never three calls.
 */
export async function exportViaDesktop({ conversationId, turnId, formats, title, turnType }, w = typeof window === 'undefined' ? undefined : window) {
  const triplex = w && w.triplex
  if (!triplex || typeof triplex.exportTurn !== 'function') return errorOutcome('export_unsupported', 'this desktop build cannot export turns')
  let res
  try {
    res = await triplex.exportTurn?.({ conversationId, turnId, formats: [...formats], title: title || '', turnType: turnType || '' })
  } catch (e) {
    return errorOutcome(codeOf(e), e && e.message)
  }
  if (!res || typeof res !== 'object') return errorOutcome('export_failed', 'the desktop returned no result')
  if (res.cancelled || res.canceled) return { state: 'cancelled', code: null, message: null, names: [], paths: [] }
  const paths = (Array.isArray(res.paths) && res.paths) || (Array.isArray(res.files) && res.files) || (res.files && typeof res.files === 'object' ? Object.values(res.files).filter((p) => typeof p === 'string') : [])
  if (res.ok === false || res.error || (res.code && !paths.length)) return errorOutcome(res.code || res.error, res.message)
  if (!paths.length) return errorOutcome('export_failed', 'the desktop wrote no files')
  return { state: 'done', code: null, message: null, paths, names: paths.map(baseNameOf), downloaded: false }
}

/** One fetch + one download per format (a browser download is per file by nature). */
export async function exportViaBrowser({ conversationId, turnId, formats, baseName }, doc = typeof document === 'undefined' ? undefined : document) {
  const names = []
  try {
    for (const format of formats) {
      const { text, suggested } = await fetchDocument(conversationId, turnId, format)
      names.push(triggerDownload(text, suggested || fileNameFor(baseName, format), format, doc))
    }
  } catch (e) {
    return errorOutcome(codeOf(e), e && e.message)
  }
  if (!names.length) return errorOutcome('no_format', 'nothing to export in this shell')
  return { state: 'done', code: null, message: null, paths: names, names, downloaded: true }
}

/**
 * Run one menu choice. `formats` is already resolved for the shell (formats.formatsFor), so the
 * caller decides what "all" means here and the two paths only obey.
 */
export async function runExport({ conversationId, turnId, formats, baseName, title, turnType }, { w = typeof window === 'undefined' ? undefined : window, doc = typeof document === 'undefined' ? undefined : document } = {}) {
  if (!conversationId || !turnId) return errorOutcome('nothing_to_export', 'no turn to export')
  if (!formats || !formats.length) return errorOutcome('no_format', 'nothing to export in this shell')
  return isDesktop(w) ? exportViaDesktop({ conversationId, turnId, formats, title, turnType }, w) : exportViaBrowser({ conversationId, turnId, formats, baseName }, doc)
}

/** The one-line result under the trigger. `null` after a cancelled dialog: the user said no. */
export function resultLine(outcome) {
  if (!outcome) return null
  if (outcome.state === 'cancelled') return null
  if (outcome.state === 'error') return `Export failed: ${outcome.code || 'export_failed'}`
  const names = outcome.names || []
  if (!names.length) return null
  return `${outcome.downloaded ? 'Downloaded' : 'Wrote'} ${names.join(', ')}`
}
