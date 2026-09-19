// desktop/scripts/check-pdf-render.mjs — prove that REPEATED PDF exports survive in one process.
//
//   cd desktop && npx electron scripts/check-pdf-render.mjs          # 3 renders (default)
//   PDF_CHECK_RUNS=6 npx electron scripts/check-pdf-render.mjs
//
// Why a script and not a unit test: what it watches is a Chromium behaviour, invisible to
// `node --test` (which drives `renderPdf` with a fake BrowserWindow). Measured on Electron 44.4.1 /
// Chromium 152, 2026-09-18: tearing the offscreen print window down with `destroy()` instead of
// `close()` made the SECOND render in a process fail with `ERR_FAILED (-2)` on its own `file://`
// document and the THIRD kill the browser process with SIGTRAP.
//
// Read the scope honestly: that only happens while the print window is the LAST window in the
// process — which is the shape THIS script has, and is never the shape of the running app, whose
// main window is always open. So this is a canary for the teardown behaviour itself (and for an
// Electron upgrade changing it), not a reproduction of a user-visible failure; the app spec's
// export test covers the app's own path and passes with either teardown.
//
// Self-contained: no backend, no ports, no site, its own userData directory. Needs a display.
// Exits 0 when every render succeeded and no window was left behind, 1 otherwise, 2 on bad input.

import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPdf } from '../main/export.js'

const RUNS = Number(process.env.PDF_CHECK_RUNS || 3)
if (!Number.isInteger(RUNS) || RUNS < 2 || RUNS > 25) {
  console.error('[pdf-check] PDF_CHECK_RUNS must be an integer 2..25 (the bug needs at least 2)')
  app.exit(2)
}

// A document with the shapes a real export has — headings, a table, a fenced block, enough prose
// to spill onto a second page — and no external reference of any kind, like the real one. It is
// BYTE-IDENTICAL on every run (the run number stays in the log, out of the page), so the printed
// sizes must match exactly: a second render that silently degrades is a failure too.
function document() {
  const para = 'Sensor fusion plus integrity monitoring: unresolved disagreement is surfaced, never averaged away. '
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Triplex PDF render check</title>
<style>body{font:12pt/1.5 Georgia,serif;margin:0}h1{font-size:20pt}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #888;padding:6px;text-align:left}pre{background:#f4f4f4;padding:10px;white-space:pre-wrap}</style>
</head><body><h1>Triplex PDF render check</h1>
<h2>Similar</h2><table><tr><th>label</th><th>claim</th></tr>
<tr><td>R1</td><td>A priority-inversion deadlock, reset by the watchdog.</td></tr>
<tr><td>R2</td><td>Default mutex protection left the scheduler exposed.</td></tr>
<tr><td>R3</td><td>The fix was uploaded in flight and enabled protection.</td></tr></table>
<h2>Differs</h2><pre>{"divergences":[{"id":"d1","materiality":"medium"}]}</pre>
<h2>Bodies</h2>${`<p>${para.repeat(12)}</p>`.repeat(6)}</body></html>`
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-pdfcheck-')))
app.disableHardwareAcceleration() // this box is software-rendered anyway (docs/decisions.md S4)

app.whenReady().then(async () => {
  const sizes = []
  let failed = 0
  for (let i = 1; i <= RUNS; i += 1) {
    const started = Date.now()
    try {
      const pdf = await renderPdf({ html: document(), BrowserWindow })
      const header = pdf.subarray(0, 5).toString('latin1')
      if (header !== '%PDF-') throw new Error(`not a PDF (starts "${header}")`)
      sizes.push(pdf.length)
      console.log(`[pdf-check] render ${i}/${RUNS} ok — ${pdf.length} bytes in ${Date.now() - started} ms`)
    } catch (e) {
      failed += 1
      console.error(`[pdf-check] render ${i}/${RUNS} FAILED — ${(e && e.code) || 'error'}: ${(e && e.detail) || (e && e.message) || e}`)
    }
  }

  const left = BrowserWindow.getAllWindows().length
  if (left !== 0) console.error(`[pdf-check] ${left} print window(s) left behind — teardown leaked`)
  const drifted = sizes.length > 1 && new Set(sizes).size !== 1
  if (drifted) console.error(`[pdf-check] identical documents printed to different sizes: ${sizes.join(', ')}`)

  const ok = failed === 0 && left === 0 && !drifted
  console.log(`[pdf-check] ${ok ? 'PASS' : 'FAIL'} — ${RUNS - failed}/${RUNS} rendered, ${left} window(s) left`)
  app.exit(ok ? 0 : 1)
})
