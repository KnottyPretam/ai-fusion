// desktop/test/app/app.spec.js — Playwright drives the real Electron app (project `app`).
//
// Integrator-only (`TRIPLEX_E2E_APP=1 npx playwright test --project app` on DISPLAY=:1): the
// config's webServers start the fake site (5199), Vite (5184) and the backend (8021, with
// TRIPLEX_DESKTOP=1 BRIDGE_TOKEN=e2e SLOT_*_MODEL=web:*). Every launch gets a temp
// TRIPLEX_USER_DATA_DIR, TRIPLEX_SITES_JSON pointing all three sites at the fake site,
// TRIPLEX_RENDERER_URL=http://localhost:5184, the inherited DISPLAY and — from Stage 2 —
// TRIPLEX_BACKEND_URL=http://127.0.0.1:8021 + BRIDGE_TOKEN=e2e so the app ATTACHES to the config's
// backend instead of spawning one. Views are reached through `global.__triplexTest =
// {views, orchestrator, settings, selectors, bridge, chats, backend}` (main.js under TRIPLEX_E2E_APP=1).
//
// Two Playwright facts learned on this box: WebContentsViews are reported as windows (pick the
// renderer page by URL), and CDP-dispatched keys never reach before-input-event (use
// webContents.sendInputEvent — `sendKey`).
//
// Stage 1 rows: split → getBounds() = viewport rects ±1 px; tabs → two views hidden; one Send with
// backtick / quotes / ${} / newline → every fake page's window.__fake.submitted[0] byte-equal;
// zoom button → 1.1; Ctrl+2 switches the tab; Reload / New chat navigate; window bounds restored
// after a relaunch. Stage 2 rows (describe 'desktop send (bridge)'): the app attaches to the
// backend (GET /api/bridge/status connected, no banner); a Send from the PromptBar persists a
// SendTurn with not_captured errors; capture on for all three (pane-<slot>-capture) → the next
// Send persists the three fake replies; the fake page URLs land in chats.json; selecting the
// older conversation in the sidebar navigates the views back; the bridge banner appears when the
// socket is closed from inside (__triplexTest.bridge.close()) and clears on reconnect. Stage 3 rows
// (describe 'desktop analyze + fusion (hidden analyst page)'): settings.analyst = chatgpt reaches the
// backend as hello.analyst with no view created yet; a conversation POSTed with
// slot_config.analyst_model = 'web:chatgpt:analyst' and captured on all three gets three replies;
// Analyze renders analyze-report from the HIDDEN analyst view (the fake site's ?reply=json answers
// the extraction) while the chatgpt pane types nothing; Fusion(1) challenges the three panes, checks
// convergence on the analyst view and reaches fusion-exit-reason converged; navigating the analyst
// view to ?state=challenge auto-reveals it as deck-tab-analyst.

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
const BACKEND_URL = process.env.TRIPLEX_BACKEND_URL || 'http://127.0.0.1:8021'
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'e2e'
const SLOTS = ['claude', 'chatgpt', 'grok']
// A real backtick, double quotes, a dollar-brace and a newline — the text every composer must receive verbatim.
const PROMPT = 'hello `x` "y" ${z}\nline2'
const BOUNDS_DEBOUNCE_MS = 500
/** The fake site's chat URLs (`/c/<id>?site=…`) for the selectors override the Stage 2 block installs. */
const FAKE_CHAT_URL_PATTERN = `^${FAKE_BASE.replace(/[.]/g, '\\.')}/c/[A-Za-z0-9]+`
/** The port the app should report for the backend it attached to. */
const BACKEND_PORT = Number(new URL(BACKEND_URL).port || '80')

/** `query` is appended to every site URL (Stage 2: `replyMs=150` makes the fake site stream `Echo: <text>`). */
function sitesJson(query = '') {
  const sites = {}
  for (const slot of SLOTS) {
    const url = `${FAKE_BASE}/?site=${slot}${query}`
    sites[slot] = { url, newChatUrl: url, hosts: ['127.0.0.1', 'localhost'] }
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

/** Launch the app on `userData`; resolves once the renderer shell, __triplexTest and the three fake pages are up. */
async function launch(userData, logs, { sites = sitesJson() } = {}) {
  const app = await electron.launch({
    args: ['.'],
    cwd: DESKTOP_DIR,
    executablePath: electronBinary(),
    timeout: 60_000,
    env: {
      ...process.env,
      TRIPLEX_E2E_APP: '1',
      TRIPLEX_SITES_JSON: sites,
      TRIPLEX_RENDERER_URL: RENDERER_URL,
      TRIPLEX_USER_DATA_DIR: userData,
      TRIPLEX_BACKEND_URL: BACKEND_URL, // attach to the config's backend (never spawn one under Playwright)
      BRIDGE_TOKEN,
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
    if (!wc || wc.isDestroyed() || wc.isLoading()) {
      console.log(`[fakeState ${s}] unavailable: ${!wc ? 'no webContents' : wc.isDestroyed() ? 'destroyed' : `loading ${wc.getURL()}`}`)
      return null
    }
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

/** 'on' | 'off' for a checkbox-like control (an <input>, or aria-checked / aria-pressed on the element). */
function toggleState(locator) {
  return locator.evaluate((el) => {
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input[type="checkbox"]')
    if (input) return input.checked ? 'on' : 'off'
    const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed')
    if (aria === 'true') return 'on'
    if (aria === 'false') return 'off'
    return 'on'
  })
}

async function ensureTargetChecked(page, slot) {
  const t = page.getByTestId(`prompt-target-${slot}`)
  await expect(t).toBeVisible()
  if ((await toggleState(t)) === 'off') await t.click()
}

const readSettings = (userData) => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
const readChats = (userData) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, 'chats.json'), 'utf8'))
  } catch (_e) {
    return {}
  }
}

/** The backend, from the test process (the app attaches to the same one). */
async function backend(pathname, init) {
  const res = await fetch(`${BACKEND_URL}${pathname}`, init)
  if (!res.ok) throw new Error(`${init && init.method ? init.method : 'GET'} ${pathname} → ${res.status}`)
  return res.json()
}

/** Type a prompt into the PromptBar and click Send. */
async function sendFromPromptBar(page, text) {
  const composer = page.getByTestId('prompt-composer')
  await expect(composer).toBeEditable({ timeout: 30_000 })
  await composer.fill(text)
  expect(await composer.inputValue()).toBe(text)
  await page.getByTestId('prompt-send').click()
}

/** The newest conversation whose first Send turn typed `prompt` (null until the backend has it). */
async function conversationByFirstPrompt(prompt) {
  const list = await backend('/api/conversations')
  for (const summary of list) {
    const conv = await backend(`/api/conversations/${summary.id}`)
    const first = (conv.turns || []).find((t) => t.type === 'send')
    if (first && first.prompt === prompt) return conv
  }
  return null
}

const lastSendTurn = (conv) => [...(conv.turns || [])].reverse().find((t) => t.type === 'send') || null

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

    await sendFromPromptBar(page, PROMPT)

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

  // The tooltip is the first thing this shell paints that FLOATS, so it is the first that can land
  // inside a pane rect — where the native site view would simply cover it. What matters is not
  // which side it picks (the pane header leaves a band of chrome, and below is fine when it fits)
  // but that it never ends up behind a view. Both pane-header controls are checked, including the
  // capture switch, which is the last chrome above the viewport.
  test('a pane-header button shows its description after a beat, and it never lands behind a site view', async () => {
    await page.getByTestId('deck-mode-split').click()
    await expect.poll(() => boundsMatch(app, page, 'claude'), { timeout: 15_000 }).toBe('ok')

    /** '' when the tooltip is clear of every viewport, else which one it overlaps. */
    const overlap = () =>
      page.evaluate(() => {
        const t = document.querySelector('[data-testid="tooltip"]')
        if (!t) return 'no tooltip'
        const a = t.getBoundingClientRect()
        for (const el of document.querySelectorAll('[data-testid$="-viewport"]')) {
          const b = el.getBoundingClientRect()
          if (b.width < 1 || b.height < 1) continue
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) return el.dataset.testid
        }
        return ''
      })

    const tip = page.getByTestId('tooltip')
    expect(await tip.count(), 'nothing floating before a hover').toBe(0)

    const reload = page.getByTestId('pane-claude-reload')
    await reload.hover()
    await page.waitForTimeout(300)
    expect(await tip.count(), 'and nothing until the pointer has rested').toBe(0)
    await expect(tip).toBeVisible({ timeout: 5_000 })
    expect((await tip.textContent()).trim().length).toBeGreaterThan(5)
    expect(await overlap()).toBe('')
    // The browser's own tooltip is out of the way while ours is up.
    expect(await reload.getAttribute('title')).toBeNull()

    // The capture switch sits hard against the top of the site view: below is not an option there.
    await page.getByTestId('pane-claude-capture').hover()
    await expect(tip).toBeVisible({ timeout: 5_000 })
    expect(await overlap()).toBe('')
    expect(await tip.getAttribute('data-placement'), 'flipped out of the view').toBe('top')

    // Moving away puts the native title back and takes the bubble down.
    await page.getByTestId('prompt-composer').hover()
    await expect(tip).toBeHidden()
    expect(await reload.getAttribute('title')).not.toBeNull()
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

// ---------------------------------------------------------------------------------------------
// Stage 2: the unified prompt is a Triplex Send over the bridge
// ---------------------------------------------------------------------------------------------

test.describe('desktop send (bridge)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })
  const logs = []
  const FIRST = 'first prompt'
  const SECOND = 'second prompt'
  let userData
  let app
  let page
  let convId = null

  test.beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-e2e-bridge-'))
    // chats.json records a link only for a navigation matching chatUrlPattern: point it at the fake site
    const override = {}
    for (const slot of SLOTS) override[slot] = { chatUrlPattern: FAKE_CHAT_URL_PATTERN }
    fs.writeFileSync(path.join(userData, 'selectors.json'), JSON.stringify(override))
    ;({ app, page } = await launch(userData, logs, { sites: sitesJson('&replyMs=150') }))
  })

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {})
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && logs.length) {
      await testInfo.attach('electron-logs', { body: logs.join(''), contentType: 'text/plain' })
    }
  })

  test('the app attaches to the backend: GET /api/bridge/status is connected, no bridge banner', async () => {
    await expect.poll(() => backend('/api/bridge/status').then((s) => s.connected), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => app.evaluate(() => globalThis.__triplexTest.bridge.status().connected), { timeout: 5_000 }).toBe(true)
    await expect(page.getByTestId('bridge-banner')).toBeHidden({ timeout: 10_000 })
    const info = await page.evaluate(() => window.triplex.getInfo())
    expect(info.backend).toEqual({ port: BACKEND_PORT, url: BACKEND_URL })
  })

  test('a Send from the PromptBar persists a SendTurn with not_captured errors (capture off by default)', async () => {
    await page.getByTestId('deck-mode-split').click()
    for (const slot of SLOTS) await ensureTargetChecked(page, slot)
    expect(readSettings(userData).capture).toEqual({ claude: false, chatgpt: false, grok: false })
    await sendFromPromptBar(page, FIRST)

    for (const slot of SLOTS) {
      await expect.poll(() => fakeState(app, slot).then((s) => s && s.submitted), { timeout: 45_000 }).toEqual([FIRST])
    }
    let conv = null
    await expect
      .poll(async () => {
        conv = await conversationByFirstPrompt(FIRST)
        const turn = conv && lastSendTurn(conv)
        return turn ? SLOTS.filter((s) => turn.errors && turn.errors[s]).length : -1
      }, { timeout: 60_000 })
      .toBe(3)
    convId = conv.id
    const turn = lastSendTurn(conv)
    for (const slot of SLOTS) {
      expect(turn.responses[slot], slot).toBeNull()
      expect(turn.errors[slot], slot).toMatch(/capture is off/)
      expect(conv.threads[slot], `${slot} thread stays empty`).toEqual([])
    }
    for (const slot of SLOTS) {
      const line = page.getByTestId(`prompt-result-${slot}`)
      await expect(line).toBeVisible({ timeout: 15_000 })
      await expect(line).not.toContainText('✗')
    }
  })

  test('toggling capture on for all three via the pane headers → the next Send persists the three fake replies', async () => {
    for (const slot of SLOTS) {
      const sw = page.getByTestId(`pane-${slot}-capture`)
      await expect(sw).toBeVisible({ timeout: 10_000 })
      if ((await toggleState(sw)) === 'off') await sw.click()
    }
    await expect.poll(() => readSettings(userData).capture, { timeout: 10_000 }).toEqual({ claude: true, chatgpt: true, grok: true })
    await expect.poll(() => backend('/api/bridge/status').then((s) => SLOTS.every((x) => s.sites && s.sites[x] && s.sites[x].capture === true)), { timeout: 10_000 }).toBe(true)

    await sendFromPromptBar(page, SECOND)
    for (const slot of SLOTS) {
      await expect.poll(() => fakeState(app, slot).then((s) => s && s.submitted), { timeout: 45_000 }).toEqual([FIRST, SECOND])
    }
    let conv = null
    await expect
      .poll(async () => {
        conv = await backend(`/api/conversations/${convId}`)
        const turn = lastSendTurn(conv)
        if (!turn || turn.prompt !== SECOND) return 'no turn yet'
        return SLOTS.map((s) => (turn.responses[s] === null ? 'pending' : 'done')).join(',')
      }, { timeout: 120_000 })
      .toBe('done,done,done')
    const turn = lastSendTurn(conv)
    for (const slot of SLOTS) {
      expect(turn.responses[slot], slot).toBe(`Echo: ${SECOND}`)
      expect(turn.errors[slot], slot).toBeUndefined()
      expect(conv.threads[slot].map((m) => m.role), `${slot} thread`).toEqual(['user', 'assistant'])
      expect(conv.threads[slot][1].content, slot).toBe(`Echo: ${SECOND}`)
    }
  })

  test('the fake page URLs land in chats.json under the conversation id', async () => {
    await expect.poll(() => Object.keys(readChats(userData)[convId] || {}).sort(), { timeout: 20_000 }).toEqual([...SLOTS].sort())
    const links = readChats(userData)[convId]
    for (const slot of SLOTS) {
      expect(links[slot], slot).toMatch(/\/c\/[A-Za-z0-9]+/)
      expect(links[slot], `${slot} = the pane's chat`).toBe((await fakeState(app, slot)).url)
    }
  })

  test('New chat everywhere opens fresh chats; selecting the older conversation in the sidebar navigates the views back', async () => {
    const links = readChats(userData)[convId]
    await page.getByTestId('prompt-newchat').click()
    for (const slot of SLOTS) {
      await expect.poll(() => fakeState(app, slot).then((s) => s && s.url), { timeout: 20_000 }).toBe(`${FAKE_BASE}/?site=${slot}&replyMs=150`)
    }
    const sidebar = page.getByTestId('sidebar')
    await expect(sidebar).toBeVisible()
    const older = sidebar.getByTestId('conv-row').filter({ hasText: FIRST }).first()
    await expect(older).toBeVisible({ timeout: 15_000 })
    await older.getByTestId('conv-select').click()
    for (const slot of SLOTS) {
      await expect.poll(() => fakeState(app, slot).then((s) => s && s.url), { timeout: 20_000 }).toBe(links[slot])
    }
    // the recorded chats show their two prompts again (the fake site renders /c/<id> from scratch, so
    // only the URL round-trips); the link itself is untouched by the navigation
    expect(readChats(userData)[convId]).toEqual(links)
  })

  test('the bridge banner appears when the socket drops and clears on reconnect', async () => {
    // The backend is the Playwright webServer (out of reach from here), so the drop is simulated
    // from inside: close the bridge client's socket, then let it connect again.
    await app.evaluate(() => globalThis.__triplexTest.bridge.close())
    await expect(page.getByTestId('bridge-banner')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => backend('/api/bridge/status').then((s) => s.connected), { timeout: 10_000 }).toBe(false)
    await app.evaluate(() => globalThis.__triplexTest.bridge.connect())
    await expect.poll(() => app.evaluate(() => globalThis.__triplexTest.bridge.status().connected), { timeout: 15_000 }).toBe(true)
    await expect(page.getByTestId('bridge-banner')).toBeHidden({ timeout: 10_000 })
    await expect.poll(() => backend('/api/bridge/status').then((s) => s.connected), { timeout: 10_000 }).toBe(true)
  })
})


// ---------------------------------------------------------------------------------------------
// Stage 3: Analyze and Fusion through the hidden analyst page
// ---------------------------------------------------------------------------------------------
//
// The analyst choice is per conversation (`slot_config.analyst_model`), and playwright.config.js
// (frozen) gives the app-project backend no ANALYST_MODEL, so this block POSTs its conversation to
// `/api/conversations` with `analyst_model: 'web:chatgpt:analyst'` and selects it in the sidebar —
// rather than going through the drawer's Settings tab, which would couple these rows to the
// renderer's analyst chooser. Everything else is the real path: capture on for all three panes, one
// Send over the bridge, then Analyze (one analyst call on the HIDDEN view, answered by the fake
// site's `?reply=json` Extraction) and Fusion(1) (three defense prompts typed into the three PANES,
// one convergence check on the analyst view) → `fusion-exit-reason` converged. Last row: the
// analyst view is navigated to `?state=challenge`, whose health report auto-reveals it as the
// fourth tab (`deck-tab-analyst`).

test.describe('desktop analyze + fusion (hidden analyst page)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 })
  const logs = []
  const PROMPT_A = 'what is the gyroscope full-scale range'
  let userData
  let app
  let page
  let convId = null

  /** The desktop slot_config: web: models for the panes, the hidden ChatGPT page as the analyst. */
  const desktopSlotConfig = () => ({
    slots: {
      claude: { model: 'web:claude', effort: 'off' },
      chatgpt: { model: 'web:chatgpt', effort: 'off' },
      grok: { model: 'web:grok', effort: 'off' },
    },
    analyst_model: 'web:chatgpt:analyst',
    max_iterations: 1,
    materiality_min: 'medium', // planted_factual: only d1 is material, and the fixture resolves d1
    grounded: false,
  })

  /** {url, site, submitted} from the hidden analyst view's page (null while it is still loading). */
  function analystFakeState() {
    return app.evaluate(async () => {
      const wc = globalThis.__triplexTest.analystViews.webContents()
      if (!wc || wc.isDestroyed() || wc.isLoading()) return null
      try {
        return await wc.executeJavaScript('(() => ({ url: location.href, site: window.__fake ? window.__fake.site : null, submitted: window.__fake ? window.__fake.submitted.slice() : null }))()')
      } catch (_e) {
        return null
      }
    })
  }

  /** The analyst manager's own state: the chosen slot, the reveal flag, the cached health, the view. */
  function analystState() {
    return app.evaluate(() => {
      const a = globalThis.__triplexTest.analystViews
      const view = a.get()
      return { slot: a.slot(), visible: a.visible(), session: a.getHealth() ? a.getHealth().session : null, hasView: !!view, viewVisible: view ? view.getVisible() : null }
    })
  }

  async function openDrawerTab(tab) {
    const drawer = page.getByTestId('desk-drawer')
    if (!(await drawer.isVisible().catch(() => false))) await page.getByTestId('drawer-toggle').click()
    await expect(drawer).toBeVisible({ timeout: 15_000 })
    await page.getByTestId(`drawer-tab-${tab}`).click()
  }

  test.beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-e2e-analyst-'))
    const override = {}
    for (const slot of SLOTS) override[slot] = { chatUrlPattern: FAKE_CHAT_URL_PATTERN }
    fs.writeFileSync(path.join(userData, 'selectors.json'), JSON.stringify(override))
    // ?reply=json answers the analyst prompts (keyed on <<<R1>>> / <<<DIVERGENCES>>> / YOUR CLAIM)
    // with the planted_factual fixtures and everything else with the echo.
    ;({ app, page } = await launch(userData, logs, { sites: sitesJson('&replyMs=150&reply=json') }))
  })

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {})
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && logs.length) {
      await testInfo.attach('electron-logs', { body: logs.join(''), contentType: 'text/plain' })
    }
  })

  test('settings.analyst defaults to chatgpt, hello.analyst carries it and no analyst view exists yet', async () => {
    expect(readSettings(userData).analyst).toBe('chatgpt')
    expect(readSettings(userData).analystVisible).toBe(false)
    await expect.poll(() => backend('/api/bridge/status').then((s) => s.connected), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => backend('/api/bridge/status').then((s) => s.analyst), { timeout: 10_000 }).toBe('chatgpt')
    expect(await analystState()).toMatchObject({ slot: 'chatgpt', visible: false, hasView: false })
    await expect(page.getByTestId('deck-tab-analyst')).toBeHidden()
  })

  test('a conversation whose analyst_model is web:chatgpt:analyst, captured on all three, gets three replies', async () => {
    const created = await backend('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'analyst run', slot_config: desktopSlotConfig() }),
    })
    convId = created.id
    expect(created.slot_config.analyst_model).toBe('web:chatgpt:analyst')

    await page.reload()
    await page.waitForSelector('[data-testid="desktop-shell"]', { timeout: 45_000 })
    const row = page.getByTestId('sidebar').getByTestId('conv-row').filter({ hasText: 'analyst run' }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.getByTestId('conv-select').click()

    await page.getByTestId('deck-mode-split').click()
    for (const slot of SLOTS) {
      await ensureTargetChecked(page, slot)
      const sw = page.getByTestId(`pane-${slot}-capture`)
      await expect(sw).toBeVisible({ timeout: 10_000 })
      if ((await toggleState(sw)) === 'off') await sw.click()
    }
    await expect.poll(() => readSettings(userData).capture, { timeout: 10_000 }).toEqual({ claude: true, chatgpt: true, grok: true })

    await sendFromPromptBar(page, PROMPT_A)
    await expect
      .poll(async () => {
        const conv = await backend(`/api/conversations/${convId}`)
        const turn = lastSendTurn(conv)
        if (!turn || turn.prompt !== PROMPT_A) return 'no turn yet'
        return SLOTS.map((s) => (turn.responses[s] === null ? 'pending' : 'done')).join(',')
      }, { timeout: 180_000 })
      .toBe('done,done,done')
    const conv = await backend(`/api/conversations/${convId}`)
    for (const slot of SLOTS) expect(lastSendTurn(conv).responses[slot], slot).toBe(`Echo: ${PROMPT_A}`)
  })

  test('Analyze runs on the hidden analyst view and renders analyze-report; the chatgpt PANE never sees the analyst prompt', async () => {
    const paneBefore = (await fakeState(app, 'chatgpt')).submitted.length
    await openDrawerTab('analyze')
    const run = page.getByTestId('analyze-run')
    await expect(run).toBeEnabled({ timeout: 20_000 })
    await run.click()

    await expect(page.getByTestId('analyze-report')).toBeVisible({ timeout: 180_000 })
    const conv = await backend(`/api/conversations/${convId}`)
    const analyze = [...conv.turns].reverse().find((t) => t.type === 'analyze')
    expect(analyze, 'an analyze turn was persisted').toBeTruthy()
    expect(analyze.status).toBe('ok')
    expect(analyze.extraction.divergences.map((d) => d.id)).toContain('d1')

    // the analyst prompt was typed into the HIDDEN view, on its own chat, not into the pane
    await expect.poll(() => analystFakeState().then((s) => (s && s.submitted ? 'ready' : 'pending')), { timeout: 30_000 }).toBe('ready')
    const analyst = await analystFakeState()
    expect(analyst, 'the analyst view has a page').toBeTruthy()
    expect(analyst.site).toBe('chatgpt')
    expect(analyst.submitted.length).toBeGreaterThanOrEqual(1)
    expect(analyst.submitted.at(-1)).toContain('<<<R1>>>')
    expect((await fakeState(app, 'chatgpt')).submitted.length, 'the pane typed nothing extra').toBe(paneBefore)
    expect(await analystState()).toMatchObject({ slot: 'chatgpt', hasView: true, viewVisible: false })
    // the analyst page is the hidden fourth view, so it is never a pane chat link
    expect(Object.keys(readChats(userData)[convId] || {}).sort()).toEqual([...SLOTS].sort())
  })

  test('Fusion(1) challenges the three panes, checks convergence on the analyst view and exits converged', async () => {
    const before = {}
    for (const slot of SLOTS) before[slot] = (await fakeState(app, slot)).submitted.length
    await expect.poll(() => analystFakeState().then((s) => (s ? 'ready' : 'pending')), { timeout: 30_000 }).toBe('ready')
    const analystChatBefore = (await analystFakeState()).url

    await openDrawerTab('fusion')
    const iterations = page.getByTestId('fusion-iterations')
    await expect(iterations).toBeVisible({ timeout: 15_000 })
    await iterations.fill('1')
    await iterations.blur()
    const run = page.getByTestId('fusion-run')
    await expect(run).toBeEnabled({ timeout: 20_000 })
    await run.click()

    const exit = page.getByTestId('fusion-exit-reason')
    await expect(exit).toBeVisible({ timeout: 240_000 })
    await expect.poll(() => exit.getAttribute('data-exit-reason'), { timeout: 240_000 }).toBe('converged')

    const conv = await backend(`/api/conversations/${convId}`)
    const fusion = [...conv.turns].reverse().find((t) => t.type === 'fusion')
    expect(fusion.exit_reason).toBe('converged')
    // one challenge per label with a position on d1 → one more submission in each PANE
    for (const slot of SLOTS) {
      const s = await fakeState(app, slot)
      expect(s.submitted.length, `${slot} was challenged in its own chat`).toBeGreaterThan(before[slot])
      expect(s.submitted.at(-1), slot).toContain('YOUR CLAIM')
    }
    // the convergence check is the analyst's, on the hidden view — and `fresh:true` means it is a
    // NEW chat there, so the fake page's `submitted` starts over rather than growing
    await expect.poll(() => analystFakeState().then((s) => (s && s.submitted && s.submitted.length ? 'ready' : 'pending')), { timeout: 30_000 }).toBe('ready')
    const analyst = await analystFakeState()
    expect(analyst.submitted.at(-1)).toContain('<<<DIVERGENCES>>>')
    expect(analyst.url, 'a fresh analyst chat, not the extraction one').not.toBe(analystChatBefore)
  })

  // The export path had no app-level cover: `node --test` drives main/export.js with a fake
  // BrowserWindow, and the vitest suite never reaches IPC. This is the whole path — the renderer's
  // invoke, one save dialog per export, the offscreen print, the files on disk, the anonymity of an
  // Analyze document, and a cancel writing nothing. The repeated pdf exports are cheap insurance on
  // print-window reuse; they do NOT reproduce the Chromium teardown behaviour that
  // `scripts/check-pdf-render.mjs` watches, because that needs the print window to be the last one
  // in the process and this app's main window is always open (measured 2026-09-18).
  test('Export writes md + html + pdf for a step, keeps Analyze anonymous, and repeats without failing', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-e2e-export-'))
    // One save dialog per export, so stub it in main: no modal, and a record of what was asked.
    await app.evaluate(({ dialog }, dir) => {
      globalThis.__exportDialogs = []
      dialog.showSaveDialog = async (...args) => {
        const options = args[args.length - 1]
        globalThis.__exportDialogs.push({ defaultPath: options && options.defaultPath, filters: options && options.filters })
        return { canceled: false, filePath: `${dir}/step-${globalThis.__exportDialogs.length}` }
      }
      dialog.showMessageBox = async () => ({ response: 0 }) // an overwrite confirmation, if one comes
    }, outDir)

    const conv = await backend(`/api/conversations/${convId}`)
    const send = lastSendTurn(conv)
    const analyze = [...conv.turns].reverse().find((t) => t.type === 'analyze' && t.status === 'ok')
    expect(send && analyze, 'the Send and the ok Analyze this describe produced').toBeTruthy()

    const exportTurn = (req) => page.evaluate((r) => window.triplex.exportTurn(r), req)

    // 1. All three formats for the Send step: ONE dialog, three files beside each other.
    const first = await exportTurn({ conversationId: convId, turnId: send.id, formats: ['md', 'html', 'pdf'], title: PROMPT_A, turnType: 'send' })
    expect(first.cancelled).toBe(false)
    expect(first.formats).toEqual(['md', 'html', 'pdf'])
    expect(await app.evaluate(() => globalThis.__exportDialogs.length), 'one dialog for all three').toBe(1)
    const asked = await app.evaluate(() => globalThis.__exportDialogs[0])
    expect(asked.defaultPath, 'the default stem carries the title and the step').toMatch(/gyroscope.*send/)

    const paths = { md: `${outDir}/step-1.md`, html: `${outDir}/step-1.html`, pdf: `${outDir}/step-1.pdf` }
    for (const [format, file] of Object.entries(paths)) {
      expect(fs.existsSync(file), `${format} written`).toBe(true)
      expect(fs.statSync(file).size, `${format} not empty`).toBeGreaterThan(200)
    }
    expect(fs.readFileSync(paths.pdf).subarray(0, 5).toString('latin1'), 'a real PDF').toBe('%PDF-')
    const md = fs.readFileSync(paths.md, 'utf8')
    expect(md, 'the Send export names the slots, as its columns do').toMatch(/Claude/)
    expect(md).toContain(PROMPT_A)
    const html = fs.readFileSync(paths.html, 'utf8')
    expect(html, 'self-contained: no external reference of any kind').not.toMatch(/<(script|link)\b|\bsrc=|https?:\/\/(?!www\.w3\.org)/i)

    // 2. The Analyze step keeps R1/R2/R3 all the way out to the files the shell wrote.
    const second = await exportTurn({ conversationId: convId, turnId: analyze.id, formats: ['md', 'pdf'], title: PROMPT_A, turnType: 'analyze' })
    expect(second.cancelled).toBe(false)
    const analyzeMd = fs.readFileSync(`${outDir}/step-2.md`, 'utf8')
    expect(analyzeMd).toMatch(/\bR1\b/)
    for (const name of ['Claude', 'ChatGPT', 'Grok', 'claude', 'chatgpt', 'grok', 'anthropic', 'openai', 'anon_map']) {
      expect(analyzeMd, `the Analyze export must not name ${name}`).not.toContain(name)
    }
    expect(fs.readFileSync(`${outDir}/step-2.pdf`).subarray(0, 5).toString('latin1')).toBe('%PDF-')

    // 3. The regression: a third and fourth PDF in the SAME app process still render. With the old
    //    teardown the second already failed with ERR_FAILED and the third took the app down.
    for (const n of [3, 4]) {
      const again = await exportTurn({ conversationId: convId, turnId: send.id, formats: ['pdf'], title: PROMPT_A, turnType: 'send' })
      expect(again.cancelled, `pdf export ${n}`).toBe(false)
      const file = `${outDir}/step-${n}.pdf`
      expect(fs.existsSync(file), `pdf export ${n} written`).toBe(true)
      expect(fs.readFileSync(file).subarray(0, 5).toString('latin1'), `pdf export ${n} is a PDF`).toBe('%PDF-')
    }
    // Every print window closed: none is left attached to the app.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 'only the app window remains').toBe(1)

    // 4. A cancelled dialog writes nothing.
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
    })
    const cancelled = await exportTurn({ conversationId: convId, turnId: send.id, formats: ['md'], title: PROMPT_A, turnType: 'send' })
    expect(cancelled.cancelled).toBe(true)
    expect(fs.readdirSync(outDir).filter((f) => f.endsWith('.md')).sort()).toEqual(['step-1.md', 'step-2.md'])

    fs.rmSync(outDir, { recursive: true, force: true })
  })

  test('a challenge on the analyst page auto-reveals it as the fourth tab (deck-tab-analyst)', async () => {
    await app.evaluate((_electron, url) => globalThis.__triplexTest.analystViews.loadUrl(url), `${FAKE_BASE}/?site=chatgpt&state=challenge`)
    await expect.poll(() => analystState().then((s) => s.session), { timeout: 30_000 }).toBe('challenge')
    await expect.poll(() => analystState().then((s) => s.visible), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => readSettings(userData).analystVisible, { timeout: 10_000 }).toBe(true)

    // `deck-tab-analyst` is a TOGGLE (renderer-drawer: a click hides the pane). The auto-reveal
    // already showed it, so the tab is only asserted, never clicked — clicking would hide it.
    const tab = page.getByTestId('deck-tab-analyst')
    await expect(tab).toBeVisible({ timeout: 20_000 })
    // shown as a real view: the renderer reports an `analyst` rect and main gives it those bounds
    await expect
      .poll(async () => {
        const [state, rect] = await Promise.all([
          app.evaluate(() => {
            const v = globalThis.__triplexTest.analystViews.get()
            return v ? { bounds: v.getBounds(), visible: v.getVisible() } : null
          }),
          page.evaluate(() => {
            const el = document.querySelector('[data-testid="pane-analyst-viewport"]') || document.querySelector('[data-testid="desk-analyst-viewport"]')
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: r.left, y: r.top, width: r.width, height: r.height }
          }),
        ])
        if (!state) return 'no analyst view'
        if (!state.visible) return `hidden ${JSON.stringify(state)}`
        if (!rect) return 'shown (no named viewport placeholder to compare)'
        const d = Math.max(Math.abs(state.bounds.x - rect.x), Math.abs(state.bounds.y - rect.y), Math.abs(state.bounds.width - rect.width), Math.abs(state.bounds.height - rect.height))
        return d <= 1 ? 'shown (bounds match the placeholder)' : `off by ${d}px`
      }, { timeout: 20_000 })
      .toMatch(/^shown/)
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
