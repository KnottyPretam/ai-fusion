// desktop/scripts/spike-hidden-insert.mjs — Stage 0 spike: can a HIDDEN WebContentsView
// (addChildView + setVisible(false)) receive text through the same insertion technique the site
// adapter uses (focus → Range at the end → execCommand('insertText'))?
//
//   cd desktop && npx electron scripts/spike-hidden-insert.mjs
//
// Starts the fake site in-process, loads http://127.0.0.1:<port>/?site=chatgpt into a VISIBLE
// control view and a HIDDEN view, then tries, in order, on the hidden one:
//   1. webContents.focus() + focus/Range/execCommand in the page
//   2. focus/Range/execCommand in the page only (no webContents.focus())
//   3. webContents.focus() + webContents.insertText()
//   4. setVisible(true) with 1×1 px bounds during (1), then hidden again
// Prints ONE JSON line {visible, hidden:[{method, ok, text, model}], winner} and exits 0 when
// some hidden method worked, 1 otherwise. The result goes into docs/decisions.md.

import { once } from 'node:events'
import { app, BrowserWindow, WebContentsView } from 'electron'
import { start } from '../test/fake-site/serve.js'

const PORT = Number(process.env.TRIPLEX_FAKE_PORT || 5199)
const PAGE = `http://127.0.0.1:${PORT}/?site=chatgpt`
const STEP_TIMEOUT_MS = 10000
const WIN = { width: 900, height: 600 }

const VIEW_PREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }

// Fixed marker strings only; still passed through JSON.stringify, never spliced raw into code.
const insertJs = (marker) => `(() => {
  const el = document.querySelector('#prompt-textarea');
  if (!el) return { error: 'composer not found' };
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const execOk = document.execCommand('insertText', false, ${JSON.stringify(marker)});
  return { execOk, hasFocus: document.hasFocus(), active: document.activeElement === el };
})()`

const READ_JS = `(() => {
  const el = document.querySelector('#prompt-textarea');
  return { text: el ? el.innerText : null, model: window.__fake && window.__fake.getText ? window.__fake.getText() : null };
})()`

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function load(view, url) {
  const wc = view.webContents
  const done = once(wc, 'did-finish-load')
  await wc.loadURL(url)
  await withTimeout(done, STEP_TIMEOUT_MS, 'load')
  // the composer mounts synchronously; give the page one tick anyway
  await sleep(50)
}

async function readBack(view) {
  await sleep(150) // let a pending reconciliation frame (if any) run first
  return view.webContents.executeJavaScript(READ_JS)
}

function verdict(marker, read) {
  const text = read && typeof read.text === 'string' ? read.text : ''
  const model = read && typeof read.model === 'string' ? read.model : ''
  return { ok: model.includes(marker) && text.includes(marker), text, model }
}

async function attempt(view, method, marker, run) {
  try {
    await load(view, PAGE)
    const detail = await withTimeout(run(), STEP_TIMEOUT_MS, method)
    const read = await withTimeout(readBack(view), STEP_TIMEOUT_MS, `${method} readback`)
    return { method, ...verdict(marker, read), detail }
  } catch (e) {
    return { method, ok: false, text: null, model: null, error: String((e && e.message) || e) }
  }
}

async function main() {
  const server = start(PORT, { quiet: true })
  await withTimeout(once(server, 'listening'), STEP_TIMEOUT_MS, 'fake site')

  const win = new BrowserWindow({ ...WIN, show: true, autoHideMenuBar: true, title: 'spike: hidden insert' })
  const full = { x: 0, y: 0, width: WIN.width, height: WIN.height }

  // --- visible control ------------------------------------------------------------------------
  const visible = new WebContentsView({ webPreferences: VIEW_PREFS })
  win.contentView.addChildView(visible)
  visible.setBounds(full)
  const control = await attempt(visible, 'visible:focus+range+execCommand', 'SPIKE-V', async () => {
    visible.webContents.focus()
    return visible.webContents.executeJavaScript(insertJs('SPIKE-V'))
  })

  // --- hidden view ----------------------------------------------------------------------------
  const hidden = new WebContentsView({ webPreferences: VIEW_PREFS })
  win.contentView.addChildView(hidden)
  hidden.setBounds(full)
  hidden.setVisible(false)

  const results = []
  results.push(
    await attempt(hidden, 'wcFocus+range+execCommand', 'SPIKE-1', async () => {
      hidden.webContents.focus()
      return hidden.webContents.executeJavaScript(insertJs('SPIKE-1'))
    }),
  )
  results.push(
    await attempt(hidden, 'range+execCommand', 'SPIKE-2', async () => {
      return hidden.webContents.executeJavaScript(insertJs('SPIKE-2'))
    }),
  )
  results.push(
    await attempt(hidden, 'wcFocus+insertText', 'SPIKE-3', async () => {
      hidden.webContents.focus()
      await hidden.webContents.executeJavaScript(`(() => { const el = document.querySelector('#prompt-textarea'); if (el) el.focus(); return !!el; })()`)
      await hidden.webContents.insertText('SPIKE-3')
      return { inserted: true }
    }),
  )
  results.push(
    await attempt(hidden, 'visible1x1+wcFocus+range+execCommand', 'SPIKE-4', async () => {
      hidden.setBounds({ x: 0, y: 0, width: 1, height: 1 })
      hidden.setVisible(true)
      try {
        await sleep(100)
        hidden.webContents.focus()
        return await hidden.webContents.executeJavaScript(insertJs('SPIKE-4'))
      } finally {
        hidden.setVisible(false)
        hidden.setBounds(full)
      }
    }),
  )

  const winner = (results.find((r) => r.ok) || { method: null }).method
  const out = { visible: control, hidden: results, winner }
  console.log(JSON.stringify(out))
  server.close()
  app.exit(winner ? 0 : 1)
}

app
  .whenReady()
  .then(main)
  .catch((e) => {
    console.log(JSON.stringify({ error: String((e && e.stack) || e) }))
    app.exit(1)
  })
