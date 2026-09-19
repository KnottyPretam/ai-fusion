// Export (user request, 2026-09-18): every completed Send, Analyze and Fusion turn can be written
// out as Markdown, HTML, PDF — or all three at once. This module is the pure half: the format
// table and the default file name. No React, no fetch, no window.
//
// ANONYMITY (binding decision): an Analyze or Fusion document is R1 / R2 / R3 exactly as the pane
// shows it. The renderer never holds the anon map (`to_public` strips it from every response) and
// an export request carries nothing but a conversation id, a turn id and the formats — so there is
// no path by which this control could name a slot for those two features. A Send document names
// the columns (Claude / ChatGPT / Grok) because the Send columns are labelled that way on screen.
// `features/export/leak.test.jsx` is the gate.

/** The three document formats, in menu order. `all` is a choice, never a format. */
export const FORMATS = ['md', 'html', 'pdf']

/** Formats the browser can produce on its own. PDF is rendered by Electron, so it is desktop-only. */
export const BROWSER_FORMATS = ['md', 'html']

export const FORMAT_LABELS = { md: 'Markdown (.md)', html: 'HTML (.html)', pdf: 'PDF (.pdf)' }
/** What each format is good for, for the hover description on the menu item. */
export const FORMAT_TIPS = {
  md: 'Plain GitHub-flavoured Markdown: the model bodies verbatim, for pasting into an editor or a repo.',
  html: 'One self-contained page with no external reference of any kind. Opens anywhere, prints as it looks.',
  pdf: 'Printed from that same HTML by the desktop app, A4 with page breaks. Fixed layout, for sending on.',
}

/** Blob type per format (browser downloads only; the desktop writes the bytes itself). */
export const FORMAT_MIME = { md: 'text/markdown;charset=utf-8', html: 'text/html;charset=utf-8', pdf: 'application/pdf' }

/** What the pane is exporting, for the trigger's title and the disabled hint. */
export const FEATURE_TURN_LABEL = { send: 'send turn', analyze: 'analyze report', fusion: 'fusion report' }

/** Formats available in this shell: PDF only where Electron can render it. */
export function availableFormats(desktop) {
  return desktop ? [...FORMATS] : [...BROWSER_FORMATS]
}

/** A menu choice ('md' | 'html' | 'pdf' | 'all') resolved against the shell's capabilities. */
export function formatsFor(choice, desktop) {
  const available = availableFormats(desktop)
  if (choice === 'all') return available
  return available.includes(choice) ? [choice] : []
}

/** Label for the "all" item: it must never promise a PDF the browser cannot make. */
export function allLabel(desktop) {
  return desktop ? 'All three (.md + .html + .pdf)' : 'Both (.md + .html)'
}

/**
 * A file-system-safe stem from free text (the conversation title, which is the user's own prompt
 * prefix — user text, never a model identity). Diacritics and punctuation collapse to '-'.
 */
export function slugify(text, max = 40) {
  const s = String(text == null ? '' : text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!s) return 'conversation'
  return s.slice(0, max).replace(/-+$/g, '') || 'conversation'
}

/** The short turn discriminator: the first 8 safe characters of the turn id. */
export function shortId(turnId) {
  const s = String(turnId == null ? '' : turnId).replace(/[^A-Za-z0-9]/g, '')
  return s.slice(0, 8) || 'turn'
}

/**
 * FALLBACK file name, without an extension: `triplex-<title>-<step>-<turn>`. Both shells normally
 * name a document themselves — the desktop from the `title` / `turnType` it is handed
 * (`desktop/main/export.js defaultFileName`), the browser from the endpoint's own
 * `X-Triplex-Export-Filename` — and this is what the browser falls back to when the endpoint
 * suggests nothing.
 */
export function defaultBaseName({ title, feature, turnId }) {
  return `triplex-${slugify(title)}-${feature}-${shortId(turnId)}`
}

export function fileNameFor(base, format) {
  return `${base}.${format}`
}

/** Just the file name of a path the desktop reported (POSIX or Windows separators). */
export function baseNameOf(path) {
  const s = String(path == null ? '' : path)
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return cut >= 0 ? s.slice(cut + 1) : s
}

/** The last turn of `type` (a string or a list of them) in a loaded ConversationPublic, or null. */
export function latestTurnOfType(conversation, type) {
  const types = Array.isArray(type) ? type : [type]
  const turns = (conversation && conversation.turns) || []
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && types.includes(turns[i].type)) return turns[i]
  return null
}

/**
 * The chat turn the Send columns are showing: the newest Send OR solo Continue. A continue is a
 * turn of its own in `turns[]` and the backend renders it as its own document, so after "continue
 * in one column" the newest step really is that continue, not the Send before it.
 */
export function latestChatTurn(conversation) {
  return latestTurnOfType(conversation, ['send', 'continue'])
}
