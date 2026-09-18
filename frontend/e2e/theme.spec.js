import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, SLOTS, messagesOf, runAnalyze, runFusion, snap } from './helpers.js'

// Dark-palette visual check (S7). Two runs of one checker:
//   1. the WEB app (Send / Analyze / Fusion / meter), which owns the `--on-accent` ink and every
//      shared token — a revert of that token to #fff is 2.53:1 on the dark --primary and fails here;
//   2. the DESKTOP chrome (deck bar, pane headers, prompt bar, drawer), whose own rules in
//      features/desktop/desktop.module.css are the ones the dark-ink work actually rewrote — the
//      badge/attention ink (`var(--bg)` on --err/--warn, the smallest text in the app at 10px) and
//      the raised `:disabled` opacity. Those rules never render in the web page: main.jsx picks the
//      shell on `window.triplex`, so this spec installs a fake preload (no Electron, no ports) and
//      lets the REAL DesktopShell render in this browser with the real stylesheet.
// The checker composites OPACITY (its own and every ancestor's) into both the ink and the ground:
// without that a faded-out label is scored as if fully opaque, so `:disabled { opacity }` — a rule
// whose whole job is legibility — could be regressed with every check still green.
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

const PROMPT = PROMPTS.planted_factual

/**
 * Every text node's PAINTED contrast against what is actually painted behind it, element by element.
 *
 * Two things the first version of this checker got wrong and the reason it is shaped like this:
 *  - `opacity` was ignored, so a faded label scored as if it were fully opaque — the one rule whose
 *    whole job is legibility (`:disabled { opacity }`) could not be regressed into a failure. Both
 *    the ink and the ground are now composited through every ancestor's opacity.
 *  - it returned only the failures at one hardcoded floor. It now returns every measurement and the
 *    caller picks the floor, so a spec can hold small text (the 10 px desktop badges) to 4.5:1 while
 *    the general sweep stays at the 3:1 "unreadable at any size" floor.
 *
 * `disabled: true` marks text inside an inactive control (WCAG 1.4.3 exempts those, so the general
 * sweep filters them out — but a rule that promises a disabled label stays readable can assert them).
 * `root` scopes the sweep to one subtree.
 */
async function measure(page, { root = null } = {}) {
  return page.evaluate((root) => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/)
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
    const num = (v, dflt) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : dflt)
    const over = (fg, bg, a) => ({ r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) })
    // `opacity` fades an element AND everything inside it: the effective alpha of any paint is the
    // product of its own opacity and every ancestor's.
    const chainOpacity = (el) => {
      let o = 1
      for (let n = el; n; n = n.parentElement) o *= num(getComputedStyle(n).opacity, 1)
      return o
    }
    // What is painted behind the text: every background from the outermost ancestor inwards (the
    // element's own included), each composited at its own effective alpha.
    const ground = (el) => {
      const chain = []
      for (let n = el; n; n = n.parentElement) chain.unshift(n)
      let base = { r: 255, g: 255, b: 255 }
      for (const n of chain) {
        const bg = parse(getComputedStyle(n).backgroundColor)
        if (!bg) continue
        const a = Math.min(1, bg.a * chainOpacity(n))
        if (a <= 0.01) continue
        base = over(bg, base, a)
      }
      return base
    }
    const rows = []
    const scope = root ? document.querySelector(root) : document
    if (!scope) return [{ text: `scope ${root} not found`, ratio: 0, size: 16, disabled: false, missingScope: true }]
    for (const el of scope.querySelectorAll('button, a, th, td, label, span, p, h1, h2, h3, li, option, strong, div')) {
      const text = (el.textContent || '').trim()
      if (!text || el.children.length) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
      const fg = parse(cs.color)
      if (!fg) continue
      const alpha = Math.min(1, fg.a * chainOpacity(el))
      if (alpha < 0.1) continue // painted away on purpose (a fade-out), not text anybody reads
      const bg = ground(el)
      rows.push({
        text: text.slice(0, 40),
        testid: el.getAttribute('data-testid') || (el.closest('[data-testid]') ? `in ${el.closest('[data-testid]').getAttribute('data-testid')}` : null),
        ratio: +ratio(over(fg, bg, alpha), bg).toFixed(2),
        size: num(cs.fontSize, 16),
        color: cs.color,
        opacity: +chainOpacity(el).toFixed(2),
        disabled: !!el.closest(':disabled, [aria-disabled="true"]'),
      })
    }
    return rows
  }, root)
}

/**
 * The rows under `floor`. Text inside an inactive control is dropped unless `includeDisabled`:
 * WCAG 1.4.3 exempts inactive components, so the general sweep does not fail on the UA's own
 * disabled ink — but a rule that promises a disabled label stays readable can assert those rows.
 */
function failures(rows, { floor = 3, includeDisabled = false } = {}) {
  return rows.filter((r) => (includeDisabled || !r.disabled) && r.ratio < floor)
}

/** Every element whose painted colours make it unreadable (the general 3:1 sweep). */
async function unreadable(page, opts = {}) {
  return failures(await measure(page, opts), opts)
}

test('the dark palette is legible across Send, Analyze, Fusion and the meter', async ({ page }) => {
  // Drive the palette the way a real viewer gets it, through the system preference — an
  // `addInitScript` that stamps `data-theme` can silently no-op (documentElement may not exist yet),
  // and this spec once passed on the bug it was meant to catch because something else stamped it.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByTestId('send-composer')).toBeVisible()
  // the palette really switched: the page ground is dark, and nothing stamped an explicit choice
  expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull()
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg, 'prefers-color-scheme: dark must paint the dark ground').toBe('rgb(13, 17, 23)')

  await page.getByTestId('send-composer').fill(PROMPT)
  await page.getByTestId('send-button').click()
  for (const slot of SLOTS) {
    await expect(messagesOf(page, slot, 'assistant').last()).toContainText('deg/s', { timeout: 30_000 })
  }
  await runAnalyze(page)
  await expect(page.getByTestId('analyze-report')).toBeVisible()
  await runFusion(page, 2)
  await expect(page.getByTestId('fusion-exit-reason')).toBeVisible()

  await snap(page, 'dark-flow')
  const rows = await measure(page)
  // Guard against a checker that silently measures nothing: the accent-ink elements this palette
  // change was about must be IN the sweep and enabled (with white ink `conv-new` / `analyze-run`
  // measure 2.53:1 on the dark --primary and fail the floor below).
  const accent = rows.filter((r) => ['conv-new', 'analyze-run', 'fusion-run'].includes(r.testid) && !r.disabled)
  expect(accent.map((r) => r.testid).sort(), 'the accent-ink buttons must be measured').toEqual(['analyze-run', 'conv-new', 'fusion-run'])
  // Inactive controls are exempt (WCAG 1.4.3), so `failures` drops them; the desktop chrome's
  // `:disabled` rules — which do promise a readable label — are asserted in the spec below.
  const bad = failures(rows)
  expect(bad, `unreadable text in dark (prefers-color-scheme): ${JSON.stringify(bad, null, 1)}`).toEqual([])

  // the explicit-choice path paints the same palette (data-theme wins over the media query)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(13, 17, 23)')
  const badExplicit = await unreadable(page)
  expect(badExplicit, `unreadable text in dark (data-theme): ${JSON.stringify(badExplicit, null, 1)}`).toEqual([])
})

// --- the desktop chrome ----------------------------------------------------------------------
// The rules the dark-ink work rewrote live in features/desktop/desktop.module.css: the badge and
// attention ink (`var(--bg)` on --err / --warn — the smallest text in the app, 10 px/700) and the
// raised `:disabled` opacity on the pane actions and "New chat everywhere". None of them renders in
// the web app: `main.jsx` picks DesktopApp only when `window.triplex` exists, so nothing in a
// browser run ever paints a deck tab, a pane header or the drawer. Electron cannot be launched from
// a spec (the app project owns that, and a running app owns the port), so the shell is rendered HERE
// with a fake preload: the same React tree, the same stylesheet, a real Chrome computing the real
// tokens — which is what a contrast check needs. `window.triplex` only has to be truthy and
// optional-chain-safe (features/desktop/index.jsx), so this fake is small.
const FAKE_PRELOAD = () => {
  const listeners = {}
  const sub = (channel) => (cb) => {
    ;(listeners[channel] = listeners[channel] || new Set()).add(cb)
    return () => listeners[channel].delete(cb)
  }
  const emit = (channel, ...args) => {
    for (const cb of listeners[channel] || []) cb(...args)
  }
  const health = (session) => ({
    composer: session === 'ok',
    send: session === 'ok',
    reply: false,
    stop: false,
    session,
    matched: { composer: null, send: null, reply: null, stop: null, error: null },
    url: 'https://example.invalid/',
    host: 'example.invalid',
    title: 'fake',
    ts: Date.now(),
  })
  // Tabs mode: the attention marker only renders on a HIDDEN tab (a pane the user cannot see).
  try {
    window.localStorage.setItem('triplex.panes.mode', 'tabs')
    window.localStorage.setItem('triplex.panes.active', 'chatgpt')
  } catch {
    /* storage blocked: the deck falls back to split and the badges still render */
  }
  window.triplex = {
    version: '0.1.0',
    slots: ['claude', 'chatgpt', 'grok'],
    getInfo: async () => ({ version: '0.1.0', dev: false, sites: {}, backend: null, layout: null, theme: 'dark' }),
    setLayout: () => {},
    setActive: () => {},
    newChat: async () => {},
    reload: async () => {},
    openExternal: async () => {},
    inspect: async () => {},
    focusPane: async () => {},
    zoom: async () => ({ factor: 1 }),
    onHealth: sub('health'),
    onShortcut: sub('shortcut'),
    onZoom: sub('zoom'),
    getCapture: async () => ({ claude: false, chatgpt: false, grok: false }),
    setCapture: async () => {},
    onBridge: sub('bridge'),
    onTurn: sub('turn'),
    openChats: async () => ({ claude: 'kept', chatgpt: 'kept', grok: 'kept' }),
    signOut: async () => {},
    saveDomSnapshot: async () => ({ path: '' }),
    setAnalyst: async () => {},
    showAnalyst: async () => {},
    onAnalyst: sub('analyst'),
    setTheme: async (theme) => {
      emit('theme', { theme })
      return { theme }
    },
    onTheme: sub('theme'),
  }
  // The test drives the states that own the changed rules: a session badge per slot, the attention
  // marker, a turn phase, and a disconnected bridge (the banner).
  window.__fake = {
    session: (slot, session) => emit('health', slot, health(session)),
    turn: (slot, phase) => emit('turn', { slot, phase }),
    bridge: (state) => emit('bridge', state),
    theme: (theme) => emit('theme', { theme }),
  }
}

const BADGES = new Set(['SIGN IN', 'CHALLENGE', 'BLOCKED', '!'])
const SHELL = '[data-testid="desktop-shell"]'

/** Every drawer tab in turn, so the panels' own ink is measured too, not just the deck. */
async function measureChrome(page) {
  const rows = []
  for (const tab of ['analyze', 'fusion', 'captured', 'settings']) {
    await page.getByTestId(`drawer-tab-${tab}`).click()
    await expect(page.getByTestId('desk-drawer')).toHaveAttribute('data-tab', tab)
    rows.push(...(await measure(page, { root: SHELL })))
  }
  return rows
}

test('the desktop chrome is legible in dark and in light (badges, disabled actions, drawer)', async ({ page }) => {
  await page.addInitScript(FAKE_PRELOAD)
  // Keeping `panes.sending` true is the only way the pane actions and "New chat everywhere" render
  // DISABLED — the state the raised opacity was written for. The send POST is left hanging; the
  // conversation create is not intercepted, so the shell behaves exactly as during a real send.
  await page.route('**/api/conversations/*/send', () => new Promise(() => {}))
  await page.goto('/')
  await expect(page.getByTestId('desktop-shell')).toBeVisible()
  // the shell really is the dark one main would hand it (getInfo().theme), not the web default
  expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBe('dark')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(13, 17, 23)')

  await page.evaluate(() => {
    window.__fake.session('claude', 'logged_out') // hidden tab -> SIGN IN + the ! marker
    window.__fake.session('chatgpt', 'challenge') // active tab -> CHALLENGE in the pane header too
    window.__fake.session('grok', 'blocked') // hidden tab -> BLOCKED + the ! marker
    window.__fake.turn('chatgpt', 'replying')
    window.__fake.bridge({ connected: false, error: 'port_in_use' })
  })
  await expect(page.getByTestId('pane-chatgpt-session')).toHaveText('CHALLENGE')

  // put the chrome in its disabled state (a send in flight) and open the drawer
  await page.getByTestId('prompt-composer').fill(PROMPT)
  await page.getByTestId('prompt-send').click()
  await expect(page.getByTestId('prompt-bar')).toHaveAttribute('data-sending', 'true')
  await expect(page.getByTestId('pane-chatgpt-reload')).toBeDisabled()
  await page.getByTestId('drawer-toggle').click()
  await expect(page.getByTestId('desk-drawer')).toHaveAttribute('data-open', 'true')

  for (const theme of ['dark', 'light']) {
    if (theme === 'light') {
      await page.evaluate(() => window.__fake.theme('light'))
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBe('light')
    }
    const rows = await measureChrome(page)
    expect(rows.length, 'the sweep must actually reach the desktop chrome').toBeGreaterThan(30)

    const bad = failures(rows, { floor: 3 })
    expect(bad, `unreadable desktop chrome in ${theme}: ${JSON.stringify(bad, null, 1)}`).toEqual([])

    // The session badges and the attention marker are 10 px/700 on a filled --err / --warn ground:
    // 3:1 is not enough for text that small, and this is the pair the ink change was about (white
    // was 3.3:1 on the dark --err, 2.5:1 on the dark --warn, 3.64:1 on the light one).
    const badges = rows.filter((r) => BADGES.has(r.text))
    expect(new Set(badges.map((r) => r.text)), `badge texts measured in ${theme}`).toEqual(BADGES)
    const dimBadges = failures(badges, { floor: 4.5 })
    expect(dimBadges, `badge ink under 4.5:1 in ${theme}: ${JSON.stringify(dimBadges, null, 1)}`).toEqual([])

    // The disabled pane actions and "New chat everywhere": their rule raises the fade to 0.8 for
    // exactly this reason, so they are held to the 3:1 floor WITH the fade composited in.
    const inactive = rows.filter((r) => r.disabled && /-(reload|newchat)$/.test(r.testid || ''))
    expect(inactive.length, `disabled deck/prompt buttons measured in ${theme}`).toBeGreaterThan(2)
    const dimDisabled = failures(inactive, { floor: 3, includeDisabled: true })
    expect(dimDisabled, `disabled chrome under 3:1 in ${theme}: ${JSON.stringify(dimDisabled, null, 1)}`).toEqual([])
  }

  // 'system' stamps NO attribute, so the third path through the palette is the media query. The
  // warn badge ground is light-only, and this is the branch that has to put the dark one back.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => window.__fake.theme('system'))
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull()
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(13, 17, 23)')
  const signIn = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="deck-tab-"] span')]
      .filter((n) => n.textContent.trim() === 'SIGN IN')
      .map((n) => getComputedStyle(n).backgroundColor),
  )
  expect(signIn, 'system + prefers-dark must fall back to the dark --warn, not the light-only ground').toEqual(['rgb(210, 153, 34)'])
  const dimSystem = failures(await measureChrome(page), { floor: 3 })
  expect(dimSystem, `unreadable desktop chrome in system+dark: ${JSON.stringify(dimSystem, null, 1)}`).toEqual([])
})

test('the web app is never force-themed: no data-theme without an explicit choice', async ({ page }) => {
  // main.jsx imports DesktopApp.jsx unconditionally, so its first-paint side effect runs here too.
  // It must no-op without `window.triplex`: a browser user has no theme control, so stamping
  // `data-theme` would override their `prefers-color-scheme` with a choice they never made.
  await page.goto('/')
  await expect(page.getByTestId('send-composer')).toBeVisible()
  const state = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme ?? null,
    stored: window.localStorage.getItem('triplex.theme'),
    body: getComputedStyle(document.body).backgroundColor,
  }))
  expect(state.attr, 'the browser must be left to prefers-color-scheme').toBeNull()
  expect(state.stored).toBeNull()
  // Playwright's default colour scheme is light, so the light palette must be what paints.
  expect(state.body).toBe('rgb(255, 255, 255)')
})
