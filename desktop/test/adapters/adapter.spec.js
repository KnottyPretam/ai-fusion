// desktop/test/adapters/adapter.spec.js — the site adapter against the fake site (project `adapters`).
//
// Every test injects the REAL desktop/preload/site.cjs (read from disk, the very file Electron
// loads as the site preload) into a system-Chrome page with `page.addInitScript`, right after an
// init script that installs `window.__triplexFakeIpc` (the shape documented at the top of
// site.cjs) — see _harness.js. Ops are then driven exactly as main would drive them: a
// `{reqId, op, ...}` message on 'triplex:adapter', the answer read back from
// 'triplex:adapter:result'. The prompt text is always a message field — it is never spliced into
// code. Stage 1 coverage lives here (boot, insertion, health, ready, the session gates, retries,
// busy / cancel, config, grok's TipTap calibration); Stage 2 (observe, snapshot, ?reply=json,
// ready after a loadURL to /c/<id>) lives in observe.spec.js.

import { test, expect } from '@playwright/test'
import { DEFAULT_SELECTORS, SLOTS, CONFIRMED_BY, TRICKY, open, request, fake, ipcState, outerHtml, withOverride } from './_harness.js'

/** ≥ 4 KB (UTF-8 bytes) of numbered tricky lines, ending with a newline. */
function fourKb() {
  const line = 'line `code` "quoted" \'single\' ${tpl} — ünï 日本 🚀  double-space\n'
  let s = ''
  let i = 0
  while (Buffer.byteLength(s, 'utf8') < 4096) s += `${i++}: ${line}`
  return s
}
const FOUR_KB = fourKb()

/** grok (TipTap, as measured live on 2026-09-16): the submit button exists only once the editor holds text. */
const VOICE_BUTTON = "button[type='button'][aria-label='Enter voice mode']"
const GROK_TIPTAP = "div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']"
const GROK_SUBMIT = "button[data-testid='chat-submit']"

/** The grok cascade BEFORE that calibration: a bare `textarea` fallback and no chat-submit entry. */
const OLD_GROK = {
  composer: [
    "textarea[aria-label='Ask Grok anything']",
    "textarea[placeholder='Ask anything']",
    "textarea[placeholder*='Grok']",
    "textarea[data-testid='grok-compose-input']",
    "div[contenteditable='true'][data-lexical-editor='true']",
    'textarea',
  ],
  send: ["button[aria-label='Submit']", "button[aria-label='Send message']", "button[type='submit']"],
}

function expectSubmitted(res, sel) {
  expect(res).toMatchObject({ ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: sel.composer[0], sendSelector: sel.send[0] })
  expect(Number.isInteger(res.assistantCount)).toBe(true)
  expect(res.assistantCount).toBeGreaterThanOrEqual(0)
  expect(CONFIRMED_BY).toContain(res.confirmedBy)
  expect(Number.isInteger(res.ms)).toBe(true)
  expect(res.ms).toBeGreaterThanOrEqual(0)
  expect(res.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
}

for (const site of SLOTS) {
  const sel = DEFAULT_SELECTORS[site]
  // health.send while the composer is empty: grok renders no submit button until text is in
  const sendWhenEmpty = site !== 'grok'

  test.describe(site, () => {
    test('boots under the fake IPC: asks adapter:config once, registers one handler, publishes health', async ({ page }) => {
      await open(page, { site })
      const st = await ipcState(page)
      expect(st.invoked.filter((i) => i.channel === 'adapter:config')).toHaveLength(1)
      expect(await page.evaluate(() => window.__triplexFakeIpc.handlerCount('triplex:adapter'))).toBe(1)
      await expect.poll(async () => (await ipcState(page)).healths.some((h) => h.session === 'ok' && h.composer && h.send === sendWhenEmpty)).toBe(true)
      // nothing of the adapter leaks into the page
      expect(await page.evaluate(() => Object.keys(window).filter((k) => /^(SLOTS|DEFAULT_SELECTORS|createAdapter|attachIpc|boot)$/.test(k)))).toEqual([])
    })

    test('insertAndSubmit types backticks / quotes / ${} / newlines / unicode byte-for-byte and confirms', async ({ page }) => {
      await open(page, { site })
      const res = await request(page, { op: 'insertAndSubmit', text: TRICKY })
      expectSubmitted(res, sel)
      const f = await fake(page)
      expect(f.submitted).toEqual([TRICKY])
      expect(f.text).toBe('')
      await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
    })

    test('insertAndSubmit types a 4 KB text byte-for-byte', async ({ page }) => {
      await open(page, { site })
      const res = await request(page, { op: 'insertAndSubmit', text: FOUR_KB })
      expectSubmitted(res, sel)
      const f = await fake(page)
      expect(f.submitted).toHaveLength(1)
      expect(f.submitted[0]).toBe(FOUR_KB)
      expect(Buffer.byteLength(f.submitted[0], 'utf8')).toBeGreaterThanOrEqual(4096)
    })

    test('health: composer true, send as the empty composer renders it, reply/stop false on a fresh page (selectors v2), matched names the first cascade entries, session ok, error null', async ({ page }) => {
      await open(page, { site })
      const res = await request(page, { op: 'health' })
      expect(res).toMatchObject({ ok: true, op: 'health' })
      expect(res.health).toMatchObject({
        composer: true,
        send: sendWhenEmpty,
        reply: false,
        stop: false,
        session: 'ok',
        matched: { composer: sel.composer[0], send: sendWhenEmpty ? sel.send[0] : null, reply: null, stop: null, error: null },
        host: '127.0.0.1',
      })
      expect(Number.isInteger(res.health.ts)).toBe(true)
      expect(res.health.url).toContain(`site=${site}`)
      expect(typeof res.health.title).toBe('string')
      expect(Object.keys(res.health).sort()).toEqual(['composer', 'host', 'matched', 'reply', 'send', 'session', 'stop', 'title', 'ts', 'url'])
    })

    test('ready resolves with the matched composer selector', async ({ page }) => {
      await open(page, { site })
      const res = await request(page, { op: 'ready', timeoutMs: 2000 })
      expect(res).toEqual({ reqId: res.reqId, ok: true, op: 'ready', composerSelector: sel.composer[0] })
    })

    test('state=loggedout: insertAndSubmit and ready answer logged_out with no DOM write; health session logged_out', async ({ page }) => {
      await open(page, { site, state: 'loggedout' })
      const before = await outerHtml(page)
      const res = await request(page, { op: 'insertAndSubmit', text: 'must never be typed' })
      expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit', code: 'logged_out' })
      expect(typeof res.message).toBe('string')
      expect(await outerHtml(page)).toBe(before)
      expect((await fake(page)).submitted).toEqual([])
      const ready = await request(page, { op: 'ready', timeoutMs: 500 })
      expect(ready).toMatchObject({ ok: false, op: 'ready', code: 'logged_out' })
      const h = await request(page, { op: 'health' })
      expect(h.health).toMatchObject({ composer: false, send: false, session: 'logged_out' })
      expect(h.health.matched.composer).toBeNull()
      await expect.poll(async () => (await ipcState(page)).healths.some((x) => x.session === 'logged_out')).toBe(true)
    })

    test('state=challenge: challenge, no DOM write', async ({ page }) => {
      await open(page, { site, state: 'challenge' })
      const before = await outerHtml(page)
      const res = await request(page, { op: 'insertAndSubmit', text: 'must never be typed' })
      expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit', code: 'challenge' })
      expect(await outerHtml(page)).toBe(before)
      const h = await request(page, { op: 'health' })
      expect(h.health.session).toBe('challenge')
      expect((await request(page, { op: 'ready', timeoutMs: 300 })).code).toBe('challenge')
    })

    test('state=blocked: blocked although a composer is present; the composer is untouched', async ({ page }) => {
      await open(page, { site, state: 'blocked' })
      const before = await outerHtml(page)
      const res = await request(page, { op: 'insertAndSubmit', text: 'must never be typed' })
      expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit', code: 'blocked' })
      expect(await outerHtml(page)).toBe(before)
      const f = await fake(page)
      expect(f.text).toBe('')
      expect(f.submitted).toEqual([])
      const h = await request(page, { op: 'health' })
      expect(h.health).toMatchObject({ composer: true, session: 'blocked' })
      expect((await request(page, { op: 'ready', timeoutMs: 300 })).code).toBe('blocked')
    })

    test('thread=noise: "rate limit" / "Something went wrong" in the thread and /login, /sign-in, accounts.x.ai links inside messages keep the session ok; the next Send submits once', async ({ page }) => {
      await open(page, { site, thread: 'noise' })
      await expect(page.locator("article[data-message-author-role='user'] a[href='/login']")).toHaveCount(1)
      const h = await request(page, { op: 'health' })
      expect(h.health).toMatchObject({ composer: true, send: sendWhenEmpty, session: 'ok', matched: { composer: sel.composer[0] } })
      expect(await request(page, { op: 'ready', timeoutMs: 2000 })).toMatchObject({ ok: true, composerSelector: sel.composer[0] })
      const text = 'follow-up: what is a rate limit, and where is /login?'
      const res = await request(page, { op: 'insertAndSubmit', text })
      expectSubmitted(res, sel)
      expect(res.assistantCount).toBe(1) // the assistant turn only — the user's message is not counted
      const f = await fake(page)
      expect(f.submitted).toEqual([text])
      expect(f.text).toBe('')
      // the user's own prompt now sits in the thread as well: still ok, still ready
      expect((await request(page, { op: 'health' })).health.session).toBe('ok')
      expect((await request(page, { op: 'ready', timeoutMs: 2000 })).ok).toBe(true)
      // the health poll never reported a wall or banner (the boot sample before the mount is 'unknown')
      const healths = (await ipcState(page)).healths
      expect(healths.some((x) => x.session === 'ok')).toBe(true)
      expect(healths.filter((x) => ['logged_out', 'challenge', 'blocked'].includes(x.session))).toEqual([])
    })

    test('a retry after a failed submit is idempotent: the leftover prompt is not typed again and is submitted exactly once', async ({ page }) => {
      const text = `retry me \`x\` \${y}\nline 2 (${site})`
      await open(page, { site, sendDelayMs: 1500, selectors: withOverride(site, { sendWaitMs: 300, submitVerifyMs: 100 }) })
      const first = await request(page, { op: 'insertAndSubmit', text })
      expect(first).toMatchObject({ ok: false, op: 'insertAndSubmit' })
      expect(['send_not_found', 'not_submitted']).toContain(first.code)
      expect((await fake(page)).text).toBe(text) // the leftover: never cleared on failure
      expect((await fake(page)).submitted).toEqual([])
      await expect(page.locator(sel.send[0])).toBeEnabled({ timeout: 5000 }) // the site caught up
      const second = await request(page, { op: 'insertAndSubmit', text })
      expectSubmitted(second, sel)
      const f = await fake(page)
      expect(f.submitted).toEqual([text]) // once — not doubled
      expect(f.text).toBe('')
      await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
    })
  })
}

test('a no-op insertion on a different leftover draft (same 20-char tail) fails over to paste and ends site_error; the draft is untouched, nothing is submitted', async ({ page }) => {
  const draft = 'OLD draft sharing the tail: the quick brown fox'
  await open(page, { site: 'chatgpt' })
  await page.locator('#prompt-textarea').click()
  await page.keyboard.type(draft)
  expect((await fake(page)).text).toBe(draft)
  await page.evaluate(() => {
    document.execCommand = () => false // the editor rejects the insertion: nothing lands
  })
  const res = await request(page, { op: 'insertAndSubmit', text: 'NEW prompt sharing the tail: the quick brown fox' })
  expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit', code: 'site_error' })
  expect(res.message).toMatch(/^insertText: execCommand: did not run/)
  expect(res.message).toMatch(/paste/)
  const f = await fake(page)
  expect(f.text).toBe(draft)
  expect(f.submitted).toEqual([])
  await expect(page.locator('#prompt-textarea')).toHaveText(draft)
})

test('a login wall that appears while ready is waiting for the composer is reported logged_out, not composer_not_found', async ({ page }) => {
  await open(page, { site: 'claude', state: 'slow' })
  expect((await request(page, { op: 'health' })).health).toMatchObject({ composer: false, session: 'unknown' })
  const [res] = await Promise.all([
    request(page, { op: 'ready', timeoutMs: 1500 }),
    page.evaluate(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            const wall = document.getElementById('tpl-login').content.firstElementChild.cloneNode(true)
            wall.querySelector('a').setAttribute('href', '/login')
            document.getElementById('app').appendChild(wall)
            resolve()
          }, 300),
        ),
    ),
  ])
  expect(res).toMatchObject({ ok: false, op: 'ready', code: 'logged_out' })
  expect((await request(page, { op: 'health' })).health.session).toBe('logged_out')
})

test('state=slow: ready waits for the composer to mount, then insertAndSubmit works', async ({ page }) => {
  await open(page, { site: 'grok', state: 'slow' })
  expect((await request(page, { op: 'health' })).health).toMatchObject({ composer: false, session: 'unknown' })
  const t0 = Date.now()
  const ready = await request(page, { op: 'ready', timeoutMs: 8000 })
  expect(ready).toMatchObject({ ok: true, op: 'ready', composerSelector: DEFAULT_SELECTORS.grok.composer[0] })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2000)
  const res = await request(page, { op: 'insertAndSubmit', text: 'after the slow mount' })
  expectSubmitted(res, DEFAULT_SELECTORS.grok)
  expect((await fake(page)).submitted).toEqual(['after the slow mount'])
})

test('state=slow: a short ready timeout answers composer_not_found without touching the page', async ({ page }) => {
  await open(page, { site: 'claude', state: 'slow' })
  const res = await request(page, { op: 'ready', timeoutMs: 400 })
  expect(res).toMatchObject({ ok: false, op: 'ready', code: 'composer_not_found' })
  expect((await fake(page)).submitted).toEqual([])
})

test('sendDelayMs=1000: the send cascade is polled until the button enables, then submits', async ({ page }) => {
  await open(page, { site: 'chatgpt', sendDelayMs: 1000 })
  const res = await request(page, { op: 'insertAndSubmit', text: 'slow button' })
  expectSubmitted(res, DEFAULT_SELECTORS.chatgpt)
  expect(res.ms).toBeGreaterThanOrEqual(900)
  expect((await fake(page)).submitted).toEqual(['slow button'])
})

test('technique regression guard: an innerHTML write is reconciled away by the fake site, so an adapter using it fails and never submits', async ({ page }) => {
  await open(page, { site: 'chatgpt', selectors: withOverride('chatgpt', { sendWaitMs: 800, submitVerifyMs: 300 }) })
  // Replace the browser's insertText command with the wrong technique. site.cjs still runs its
  // whole cascade (focus, Range, "execCommand", InputEvent, verify, paste fallback, verify).
  await page.evaluate(() => {
    document.execCommand = (cmd, _ui, value) => {
      if (cmd !== 'insertText') return false
      const el = document.querySelector('#prompt-textarea')
      el.innerHTML = `<p>${value}</p>`
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      return true
    }
  })
  const res = await request(page, { op: 'insertAndSubmit', text: 'written with innerHTML' })
  expect(res.ok).toBe(false)
  expect(['site_error', 'send_not_found', 'not_submitted']).toContain(res.code)
  expect(res.message).toMatch(/execCommand|send/)
  const f = await fake(page)
  expect(f.text).toBe('') // the site's model never saw the text
  expect(f.submitted).toEqual([])
  await expect(page.locator('#prompt-textarea')).toHaveText('') // reconciled away
  await expect(page.locator(DEFAULT_SELECTORS.chatgpt.send[0])).toBeDisabled()
})

test('the composer is never cleared on failure: text stays when the send button never enables', async ({ page }) => {
  const text = 'kept in the composer `a` ${b}\nline 2'
  await open(page, { site: 'chatgpt', sendDelayMs: 60000, selectors: withOverride('chatgpt', { sendWaitMs: 900, submitVerifyMs: 300 }) })
  const t0 = Date.now()
  const res = await request(page, { op: 'insertAndSubmit', text })
  expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit' })
  expect(['send_not_found', 'not_submitted']).toContain(res.code)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  const f = await fake(page)
  expect(f.text).toBe(text) // model intact
  expect(f.submitted).toEqual([])
  await expect(page.locator('#prompt-textarea')).toContainText('kept in the composer')
  await expect(page).not.toHaveURL(/\/c\//)
})

test('Enter fallback: with no send button in the cascade, one Enter on the composer submits (sendSelector null)', async ({ page }) => {
  await open(page, { site: 'claude', selectors: withOverride('claude', { send: ['button.does-not-exist'], sendWaitMs: 400 }) })
  const res = await request(page, { op: 'insertAndSubmit', text: 'submitted by Enter' })
  expect(res).toMatchObject({ ok: true, submitted: true, composerSelector: DEFAULT_SELECTORS.claude.composer[0], sendSelector: null })
  expect(CONFIRMED_BY).toContain(res.confirmedBy)
  expect((await fake(page)).submitted).toEqual(['submitted by Enter'])
})

test('busy: a second op while insertAndSubmit is in flight answers busy; the first still completes', async ({ page }) => {
  await open(page, { site: 'claude', sendDelayMs: 1000 })
  const [first, second, third] = await page.evaluate(async () => {
    const ipc = window.__triplexFakeIpc
    const p1 = ipc.request({ reqId: 'first', op: 'insertAndSubmit', text: 'in flight' })
    const p2 = ipc.request({ reqId: 'second', op: 'ready', timeoutMs: 100 })
    const p3 = ipc.request({ reqId: 'third', op: 'insertAndSubmit', text: 'also rejected' })
    return Promise.all([p1, p2, p3])
  })
  expect(second).toMatchObject({ reqId: 'second', ok: false, op: 'ready', code: 'busy' })
  expect(second.message).toContain('first')
  expect(third).toMatchObject({ reqId: 'third', ok: false, op: 'insertAndSubmit', code: 'busy' })
  expectSubmitted(first, DEFAULT_SELECTORS.claude)
  expect((await fake(page)).submitted).toEqual(['in flight'])
  // the slot is free again
  expect((await request(page, { op: 'ready', timeoutMs: 1000 })).ok).toBe(true)
})

test('cancel: aborts the in-flight op (cancelled), keeps the composer text, frees the slot; unknown target → cancelled:false', async ({ page }) => {
  await open(page, { site: 'grok', sendDelayMs: 3000 })
  const [op, cancel] = await page.evaluate(async () => {
    const ipc = window.__triplexFakeIpc
    const p1 = ipc.request({ reqId: 'op-1', op: 'insertAndSubmit', text: 'to be cancelled' })
    await new Promise((r) => setTimeout(r, 400))
    const p2 = ipc.request({ reqId: 'c-1', op: 'cancel', target: 'op-1' })
    return Promise.all([p1, p2])
  })
  expect(cancel).toEqual({ reqId: 'c-1', ok: true, op: 'cancel', cancelled: true })
  expect(op).toMatchObject({ reqId: 'op-1', ok: false, op: 'insertAndSubmit', code: 'cancelled' })
  const f = await fake(page)
  expect(f.text).toBe('to be cancelled')
  expect(f.submitted).toEqual([])
  expect(await request(page, { op: 'cancel', target: 'nope' })).toMatchObject({ ok: true, op: 'cancel', cancelled: false })
  expect((await request(page, { op: 'ready', timeoutMs: 500 })).ok).toBe(true)
})

test('site:null from adapter:config keeps the preload inert: no health, no answers', async ({ page }) => {
  await open(page, { site: 'chatgpt', ipcSite: null })
  await page.evaluate(() => window.__triplexFakeIpc.emit('triplex:adapter', { reqId: 'h-1', op: 'health' }))
  await page.waitForTimeout(400)
  const st = await ipcState(page)
  expect(st.healths).toEqual([])
  expect(st.results).toEqual([])
})

test('config op hot-reloads the selectors (no reply) and health follows; open shadow roots are searched', async ({ page }) => {
  await open(page, { site: 'chatgpt' })
  // a composer look-alike that only exists inside an open shadow root
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'shadow-host'
    const root = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('div')
    inner.setAttribute('role', 'textbox')
    inner.setAttribute('aria-label', 'Chat with ChatGPT')
    inner.setAttribute('contenteditable', 'true')
    root.appendChild(inner)
    document.body.appendChild(host)
  })
  const shadowOnly = withOverride('chatgpt', { composer: ["div[role='textbox'][aria-label='Chat with ChatGPT']"] })
  const before = (await ipcState(page)).results.length
  await page.evaluate((selectors) => window.__triplexFakeIpc.emit('triplex:adapter', { op: 'config', selectors }), shadowOnly)
  expect((await ipcState(page)).results.length).toBe(before) // no reply to config
  const h = await request(page, { op: 'health' })
  expect(h.health).toMatchObject({ composer: true, session: 'ok', matched: { composer: "div[role='textbox'][aria-label='Chat with ChatGPT']" } })
  const none = withOverride('chatgpt', { composer: ['#does-not-exist'] })
  await page.evaluate((selectors) => window.__triplexFakeIpc.emit('triplex:adapter', { op: 'config', selectors }), none)
  const h2 = await request(page, { op: 'health' })
  expect(h2.health).toMatchObject({ composer: false, session: 'unknown', matched: { composer: null } })
  const last = (await ipcState(page)).healths.at(-1)
  expect(last).toMatchObject({ composer: false, session: 'unknown' }) // published on the change
})

test('protocol edges: unknown op → site_error; a message without reqId is ignored; snapshot answers on a fresh page', async ({ page }) => {
  await open(page, { site: 'grok' })
  expect(await request(page, { op: 'frobnicate' })).toMatchObject({ ok: false, op: 'frobnicate', code: 'site_error' })
  expect(await request(page, { op: 'snapshot' })).toMatchObject({ ok: true, op: 'snapshot' })
  const before = (await ipcState(page)).results.length
  await page.evaluate(() => window.__triplexFakeIpc.emit('triplex:adapter', { op: 'health' }))
  await page.waitForTimeout(100)
  expect((await ipcState(page)).results.length).toBe(before)
})

// ---------------------------------------------------------------------------------------------
// grok, calibrated against the live page (2026-09-16): a TipTap editor inside a form, a hidden
// 14 px helper <textarea>, and a submit button that is rendered only once the editor holds text
// ---------------------------------------------------------------------------------------------

test.describe('grok (TipTap)', () => {
  const sel = DEFAULT_SELECTORS.grok
  const helperText = (page) => page.evaluate(() => window.__fake.helperText())

  test('the composer is the TipTap editor, never the hidden helper textarea; the send cascade is polled after the insertion and the submit button is clicked once it renders', async ({ page }) => {
    await open(page, { site: 'grok', sendDelayMs: 1000 })
    await expect(page.locator('textarea')).toHaveCount(1) // the hidden helper is on the page
    await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
    await expect(page.locator(GROK_SUBMIT)).toHaveCount(0) // nothing to click before text is in
    const before = (await request(page, { op: 'health' })).health
    expect(before).toMatchObject({ composer: true, send: false, session: 'ok', matched: { composer: GROK_TIPTAP, send: null } })
    expect(before.matched.composer.startsWith('textarea')).toBe(false)
    expect((await request(page, { op: 'ready', timeoutMs: 2000 })).composerSelector).toBe(GROK_TIPTAP)

    const res = await request(page, { op: 'insertAndSubmit', text: TRICKY })
    expectSubmitted(res, sel)
    expect(res.composerSelector).toBe(GROK_TIPTAP)
    expect(res.composerSelector.startsWith('textarea')).toBe(false)
    expect(res.sendSelector).toBe(GROK_SUBMIT)
    expect(res.ms).toBeGreaterThanOrEqual(900) // polled until the button rendered (?sendDelayMs=1000)
    const f = await fake(page)
    expect(f.submitted).toEqual([TRICKY])
    expect(f.text).toBe('')
    expect(await helperText(page)).toBe('') // nothing ever went into the helper
    await expect(page.locator(GROK_SUBMIT)).toHaveCount(0) // voice mode is back
    await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
    expect((await request(page, { op: 'health' })).health).toMatchObject({ composer: true, send: false, session: 'ok', matched: { composer: GROK_TIPTAP, send: null } })
    await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
  })

  test('regression: the pre-calibration cascade (bare `textarea` fallback) picks the hidden helper — the prompt vanishes into it and nothing is submitted; the corrected cascade fixes it in place', async ({ page }) => {
    await open(page, { site: 'grok', selectors: withOverride('grok', { ...OLD_GROK, sendWaitMs: 800, submitVerifyMs: 200 }) })
    const h = await request(page, { op: 'health' })
    expect(h.health).toMatchObject({ composer: true, session: 'ok', matched: { composer: 'textarea' } }) // the helper, not the editor
    const text = 'typed into the wrong element `x` ${y}'
    const res = await request(page, { op: 'insertAndSubmit', text })
    expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit' })
    expect(['send_not_found', 'not_submitted', 'site_error']).toContain(res.code)
    expect(typeof res.message).toBe('string')
    const f = await fake(page)
    expect(f.submitted).toEqual([]) // never submitted
    expect(f.text).toBe('') // the editor never saw the prompt
    expect(await helperText(page)).toBe(text) // it vanished into the hidden helper
    await expect(page.locator(GROK_TIPTAP)).toHaveText('')
    await expect(page.locator(GROK_SUBMIT)).toHaveCount(0) // the submit button never rendered
    await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
    await expect(page).not.toHaveURL(/\/c\//)

    // hot-load the corrected cascade (contract §4) on the same page: the prompt now lands in the editor and is submitted once
    await page.evaluate((selectors) => window.__triplexFakeIpc.emit('triplex:adapter', { op: 'config', selectors }), DEFAULT_SELECTORS)
    expect((await request(page, { op: 'health' })).health).toMatchObject({ composer: true, send: false, matched: { composer: GROK_TIPTAP, send: null } })
    const fixed = await request(page, { op: 'insertAndSubmit', text })
    expectSubmitted(fixed, sel)
    expect(fixed.sendSelector).toBe(GROK_SUBMIT)
    const g = await fake(page)
    expect(g.submitted).toEqual([text])
    expect(g.text).toBe('')
    await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
  })

  test('?composer=textarea: the older textarea composer keeps the native-value-setter insertion path green (textarea[aria-label] + button[aria-label=Submit])', async ({ page }) => {
    await open(page, { site: 'grok', composer: 'textarea' })
    expect(await page.evaluate(() => window.__fake.variant)).toBe('textarea')
    await expect(page.locator(GROK_TIPTAP)).toHaveCount(0)
    const h = await request(page, { op: 'health' })
    expect(h.health).toMatchObject({
      composer: true,
      send: true,
      session: 'ok',
      matched: { composer: "textarea[aria-label='Ask Grok anything']", send: "button[aria-label='Submit']" },
    })
    expect((await request(page, { op: 'ready', timeoutMs: 2000 })).composerSelector).toBe("textarea[aria-label='Ask Grok anything']")
    const res = await request(page, { op: 'insertAndSubmit', text: TRICKY })
    expect(res).toMatchObject({ ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: "textarea[aria-label='Ask Grok anything']", sendSelector: "button[aria-label='Submit']" })
    expect(CONFIRMED_BY).toContain(res.confirmedBy)
    expect(Number.isInteger(res.assistantCount)).toBe(true)
    const f = await fake(page)
    // the React-style tracker only accepts the prototype value setter + input: this is the nativeValue path
    expect(f.submitted).toEqual([TRICKY])
    expect(f.text).toBe('')
    await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
  })

  test('?composer=textarea: a retry after a failed submit is idempotent on the textarea too', async ({ page }) => {
    const text = 'retry on the textarea `x` ${y}\nline 2'
    await open(page, { site: 'grok', composer: 'textarea', sendDelayMs: 1500, selectors: withOverride('grok', { sendWaitMs: 300, submitVerifyMs: 100 }) })
    const first = await request(page, { op: 'insertAndSubmit', text })
    expect(first).toMatchObject({ ok: false, op: 'insertAndSubmit' })
    expect(['send_not_found', 'not_submitted']).toContain(first.code)
    expect((await fake(page)).text).toBe(text)
    await expect(page.locator("button[aria-label='Submit']")).toBeEnabled({ timeout: 5000 })
    const second = await request(page, { op: 'insertAndSubmit', text })
    expect(second).toMatchObject({ ok: true, submitted: true, composerSelector: "textarea[aria-label='Ask Grok anything']", sendSelector: "button[aria-label='Submit']" })
    expect((await fake(page)).submitted).toEqual([text]) // once — not doubled
  })
})
