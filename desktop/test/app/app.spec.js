// desktop/test/app/app.spec.js — Playwright drives the real Electron app (project `app`).
//
// Integrator-only (`TRIPLEX_E2E_APP=1 npx playwright test --project app` on DISPLAY=:1): the
// config's webServers start the fake site (5199), Vite (5184) and the backend (8021). Every launch
// gets a temp TRIPLEX_USER_DATA_DIR, TRIPLEX_SITES_JSON pointing all three sites at the fake site,
// TRIPLEX_RENDERER_URL=http://localhost:5184 and the inherited DISPLAY. Views are reached through
// `global.__triplexTest = {views, orchestrator, settings}` (main.js under TRIPLEX_E2E_APP=1).
//
// Covers the plan's Stage 1 app-spec row: split → getBounds() = viewport rects ±1 px; tabs → two
// views hidden; one Send with backtick / quotes / ${} / newline → every fake page's
// window.__fake.submitted[0] byte-equal, all three in one Send; zoom button → 1.1; Ctrl+2 switches
// the tab; Reload / New chat navigate; window bounds restored after a relaunch.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron as electron, test, expect } from '@playwright/test'

test.skip(!process.env.TRIPLEX_E2E_APP, 'set TRIPLEX_E2E_APP=1 (integrator only, needs the Electron binary and a DISPLAY)')

const require = createRequire(import.meta.url)
const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FAKE_BASE = `http://127.0.0.1:${process.env.TRIPLEX_FAKE_PORT || '5199'}`
const RENDERER_URL = process.env.TRIPLEX_RENDERER_URL || 'http://localhost:5184'
const SLOTS = ['claude', 'chatgpt', 'grok']
// A real backtick, double quotes, a dollar-brace and a newline — the text every composer must receive verbatim.
const PROMPT = 'hello `x` "y" ${z}\nline2'
const BOUNDS_DEBOUNCE_MS = 500

function sitesJson() {
  const sites = {}
  for (const slot of SLOTS) {
    sites[slot] = { url: `${FAKE_BASE}/?site=${slot}`, newChatUrl: `${FAKE_BASE}/?site=${slot}`, hosts: ['127.0.0.1', 'localhost'] }
  }
  return JSON.stringify(sites)
}

function electronBinary() {
  try {
    return require('electron') // the path string when required from Node
  } catch (_e) {
    return undefined // let Playwright resolve it
  }
}

/** Launch the app on `userData`; resolves once the renderer shell, __triplexTest and the three fake pages are up. */
/** The renderer's page. Playwright's Electron driver also reports every WebContentsView (the three site
 *  pages) as a "window", so firstWindow() can hand back a fake-site page; pick the one served by Vite. */
async function rendererWindow(app) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    for (const p of app.windows()) if (p.url().startsWith(RENDERER_URL)) return p
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`renderer window (${RENDERER_URL}) not found among: ${app.windows().map((p) => p.url()).join(', ')}`)
}

async function launch(userData, logs) {
  const app = await electron.launch({
    args: ['.'],
    cwd: DESKTOP_DIR,
    executablePath: electronBinary(),
    timeout: 60_000,
    env: {
      ...process.env,
      TRIPLEX_E2E_APP: '1',
      TRIPLEX_SITES_JSON: sitesJson(),
      TRIPLEX_RENDERER_URL: RENDERER_URL,
      TRIPLEX_USER_DATA_DIR: userData,
    },
  })
  const proc = app.process()
  if (proc && logs) {
    proc.stdout?.on('data', (d) => logs.push(`[stdout] ${d}`))
    proc.stderr?.on('data', (d) => logs.push(`[stderr] ${d}`))
  }
  const page = await rendererWindow(app)
  page.on('console', (m) => logs && logs.push(`[renderer ${m.type()}] ${m.text()}\n`))
  await page.waitForSelector('[data-testid="desktop-shell"]', { timeout: 45_000 })
  await expect.poll(() => app.evaluate(() => !!(globalThis.__triplexTest && globalThis.__triplexTest.views)), { timeout: 20_000 }).toBe(true)
  for (const slot of SLOTS) {
    await expect.poll(() => fakeState(app, slot).then((s) => (s && s.site === slot ? 'ready' : JSON.stringify(s))), { timeout: 30_000 }).toBe('ready')
  }
  return { app, page }
}

/** Ctrl+<key> through Electron's own input path on the renderer ('renderer') or a site view's webContents. */
function sendKey(app, target, key) {
  return app.evaluate(({ BrowserWindow }, { target, key }) => {
    let wc
    if (target === 'renderer') wc = BrowserWindow.getAllWindows()[0].webContents
    else {
      const views = globalThis.__triplexTest.views
      const view = typeof views.get === 'function' ? views.get(target) : views.all()[target]
      wc = view && view.webContents
    }
    if (!wc) throw new Error(`no webContents for ${target}`)
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] })
  }, { target, key })
}

/** {url, site, submitted} straight from a site view's page (null while the view is still loading). */
function fakeState(app, slot) {
  return app.evaluate(async (_electron, s) => {
    const wc = globalThis.__triplexTest.views.webContents(s)
    if (!wc || wc.isDestroyed() || wc.isLoading()) return null
    try {
      return await wc.executeJavaScript(
        '(() => ({ url: location.href, site: window.__fake ? window.__fake.site : null, submitted: window.__fake ? window.__fake.submitted.slice() : null }))()',
      )
    } catch (_e) {
      return null
    }
  }, slot)
}

function viewState(app, slot) {
  return app.evaluate((_electron, s) => {
    const v = globalThis.__triplexTest.views.get(s)
    if (!v) return null
    return { bounds: v.getBounds(), visible: v.getVisible(), zoom: v.webContents.getZoomFactor() }
  }, slot)
}

function viewportRect(page, slot) {
  return page.evaluate((s) => {
    const el = document.querySelector(`[data-testid="pane-${s}-viewport"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }, slot)
}

/** 'ok' when the view's bounds equal the placeholder rect within 1 px (else a diagnostic string). */
async function boundsMatch(app, page, slot) {
  const [v, r] = await Promise.all([viewState(app, slot), viewportRect(page, slot)])
  if (!v || !r) return `pending ${JSON.stringify({ v, r })}`
  if (!v.visible) return `hidden ${JSON.stringify(v)}`
  if (r.width < 50 || r.height < 50) return `placeholder too small ${JSON.stringify(r)}`
  const d = Math.max(Math.abs(v.bounds.x - r.x), Math.abs(v.bounds.y - r.y), Math.abs(v.bounds.width - r.width), Math.abs(v.bounds.height - r.height))
  return d <= 1 ? 'ok' : `off by ${d}px view=${JSON.stringify(v.bounds)} rect=${JSON.stringify(r)}`
}

function windowBounds(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
}

async function ensureTargetChecked(page, slot) {
  const t = page.getByTestId(`prompt-target-${slot}`)
  await expect(t).toBeVisible()
  const state = await t.evaluate((el) => {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input[type="checkbox"]')
    if (input) return input.checked ? 'on' : 'off'
    const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed')
    if (aria === 'true') return 'on'
    if (aria === 'false') return 'off'
    return 'on'
  })
  if (state === 'off') await t.click()
}

const readSettings = (userData) => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))

// ---------------------------------------------------------------------------------------------

test.describe('desktop shell', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 })
  const logs = []
  let userData
  let app
  let page

  test.beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-e2e-app-'))
    ;({ app, page } = await launch(userData, logs))
  })

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {})
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && logs.length) {
      await testInfo.attach('electron-logs', { body: logs.join(''), contentType: 'text/plain' })
    }
  })

  test('split: every view is visible with getBounds() equal to its placeholder rect ±1 px', async () => {
    await page.getByTestId('deck-mode-split').click()
    for (const slot of SLOTS) {
      await expect.poll(() => boundsMatch(app, page, slot), { timeout: 15_000 }).toBe('ok')
    }
    // rects are disjoint: no two views overlap
    const rects = await Promise.all(SLOTS.map((s) => viewportRect(page, s)))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlap, `${SLOTS[i]} overlaps ${SLOTS[j]}`).toBe(false)
      }
    }
  })

  test('tabs: exactly two views are hidden and the active one fills its placeholder', async () => {
    await page.getByTestId('deck-mode-tabs').click()
    await expect
      .poll(async () => {
        const states = await Promise.all(SLOTS.map((s) => viewState(app, s)))
        return states.map((v) => (v && v.visible ? 'shown' : 'hidden')).join(',')
      }, { timeout: 15_000 })
      .toMatch(/^(shown,hidden,hidden|hidden,shown,hidden|hidden,hidden,shown)$/)
    const states = await Promise.all(SLOTS.map((s) => viewState(app, s)))
    const active = SLOTS[states.findIndex((v) => v.visible)]
    await expect.poll(() => boundsMatch(app, page, active), { timeout: 15_000 }).toBe('ok')
    expect(states.filter((v) => !v.visible)).toHaveLength(2)
  })

  test('Ctrl+2 switches the active tab to chatgpt (main handles the shortcut, the renderer re-lays out)', async () => {
    await page.getByTestId('deck-mode-tabs').click()
    await page.getByTestId('deck-tab-claude').click()
    await expect.poll(() => viewState(app, 'claude').then((v) => v && v.visible), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => viewState(app, 'chatgpt').then((v) => v && v.visible)).toBe(false)
    // Playwright's page.keyboard goes through CDP Input.dispatchKeyEvent, which Chromium marks as
    // skip-in-browser: it never reaches Electron's before-input-event (verified on this box), so the
    // shortcut path is exercised with webContents.sendInputEvent — first from the renderer, then
    // from a site view, which is the case main handles shortcuts for in the first place.
    await sendKey(app, 'renderer', '2')
    await expect.poll(() => viewState(app, 'chatgpt').then((v) => v && v.visible), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => viewState(app, 'claude').then((v) => v && v.visible)).toBe(false)
    await expect.poll(() => boundsMatch(app, page, 'chatgpt'), { timeout: 15_000 }).toBe('ok')
    await sendKey(app, 'chatgpt', '3') // typed while the ChatGPT view holds the keyboard focus
    await expect.poll(() => viewState(app, 'grok').then((v) => v && v.visible), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => viewState(app, 'chatgpt').then((v) => v && v.visible)).toBe(false)
  })

  test('one Send types the exact text into all three fake composers and submits each once', async () => {
    await page.getByTestId('deck-mode-split').click()
    for (const slot of SLOTS) await ensureTargetChecked(page, slot)
    for (const slot of SLOTS) expect((await fakeState(app, slot)).submitted).toEqual([])

    const composer = page.getByTestId('prompt-composer')
    await composer.fill(PROMPT)
    expect(await composer.inputValue()).toBe(PROMPT)
    await page.getByTestId('prompt-send').click()

    for (const slot of SLOTS) {
      await expect.poll(() => fakeState(app, slot).then((s) => s && s.submitted), { timeout: 45_000 }).toEqual([PROMPT])
    }
    for (const slot of SLOTS) {
      const line = page.getByTestId(`prompt-result-${slot}`)
      await expect(line).toBeVisible({ timeout: 15_000 })
      await expect(line).not.toContainText('✗')
    }
    // one Send, one submission per site — nothing typed twice, nothing typed elsewhere
    for (const slot of SLOTS) {
      const s = await fakeState(app, slot)
      expect(s.submitted, slot).toHaveLength(1)
      expect(Buffer.from(s.submitted[0], 'utf8').equals(Buffer.from(PROMPT, 'utf8')), `${slot} byte-equal`).toBe(true)
      // the fake site pushes /c/<id> 500 ms after the submit: poll, do not read once
      await expect.poll(() => fakeState(app, slot).then((st) => st && st.url), { timeout: 10_000 }).toMatch(/\/c\/[A-Za-z0-9]+/)
    }
  })

  test('the zoom-in button takes the pane to 1.1 and reset brings it back to 1', async () => {
    await page.getByTestId('pane-claude-zoom-in').click()
    await expect.poll(() => viewState(app, 'claude').then((v) => v && v.zoom), { timeout: 10_000 }).toBeCloseTo(1.1, 5)
    expect((await viewState(app, 'chatgpt')).zoom).toBeCloseTo(1, 5)
    await expect.poll(() => readSettings(userData).zoom.claude, { timeout: 5_000 }).toBeCloseTo(1.1, 5)
    await page.getByTestId('pane-claude-zoom-reset').click()
    await expect.poll(() => viewState(app, 'claude').then((v) => v && v.zoom), { timeout: 10_000 }).toBeCloseTo(1, 5)
  })

  test('Reload reloads the pane in place; New chat navigates it to newChatUrl', async () => {
    const before = await fakeState(app, 'claude')
    expect(before.submitted).toHaveLength(1)
    await page.getByTestId('pane-claude-reload').click()
    await expect.poll(() => fakeState(app, 'claude').then((s) => s && s.submitted), { timeout: 20_000 }).toEqual([])
    expect((await fakeState(app, 'claude')).url).toBe(before.url)

    await page.getByTestId('pane-chatgpt-newchat').click()
    await expect.poll(() => fakeState(app, 'chatgpt').then((s) => s && s.url), { timeout: 20_000 }).toBe(`${FAKE_BASE}/?site=chatgpt`)
    expect((await fakeState(app, 'chatgpt')).submitted).toEqual([])
  })
})

test.describe('window bounds persistence', () => {
  test.describe.configure({ timeout: 180_000 })

  test('bounds set before quitting are restored on the next launch', async ({}, testInfo) => {
    const logs = []
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-e2e-bounds-'))
    const wanted = { x: 40, y: 60, width: 1000, height: 640 }
    let { app } = await launch(userData, logs)
    try {
      await app.evaluate(({ BrowserWindow }, b) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (w.isMaximized()) w.unmaximize()
        w.setBounds(b)
      }, wanted)
      await expect.poll(() => windowBounds(app).then((b) => b.width), { timeout: 5_000 }).toBeGreaterThanOrEqual(wanted.width - 2)
      const applied = await windowBounds(app)
      // The defaults file already says maximized:false at launch, so wait for the debounced save
      // to carry the APPLIED size before reading it back.
      await expect
        .poll(() => {
          try {
            const w = readSettings(userData).window
            return Math.abs(w.width - applied.width) <= 2 && Math.abs(w.height - applied.height) <= 2 && w.maximized === false
          } catch (_e) {
            return false
          }
        }, { timeout: BOUNDS_DEBOUNCE_MS + 5_000 })
        .toBe(true)
      const saved = readSettings(userData).window
      expect(Math.abs(saved.width - applied.width)).toBeLessThanOrEqual(2)
      expect(Math.abs(saved.height - applied.height)).toBeLessThanOrEqual(2)
      await app.close()
      app = null

      ;({ app } = await launch(userData, logs))
      const restored = await windowBounds(app)
      expect(Math.abs(restored.width - applied.width), 'width').toBeLessThanOrEqual(2)
      expect(Math.abs(restored.height - applied.height), 'height').toBeLessThanOrEqual(2)
      expect(Math.abs(restored.x - applied.x), 'x').toBeLessThanOrEqual(40)
      expect(Math.abs(restored.y - applied.y), 'y').toBeLessThanOrEqual(40)
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && logs.length) {
        await testInfo.attach('electron-logs', { body: logs.join(''), contentType: 'text/plain' })
      }
      if (app) await app.close().catch(() => {})
    }
  })
})
