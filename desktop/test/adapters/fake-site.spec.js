// desktop/test/adapters/fake-site.spec.js — Stage 0 smoke for the fake site (project `adapters`).
// Proves the v1 cascades' FIRST entries match each look-alike, the login walls carry no composer,
// and the editing model behaves (typing enables send, submit records the text, foreign writes are
// reconciled away). Kept as the fake site's own smoke next to adapter.spec.js, which drives the real
// site.cjs through the fake IPC (Stage 1, site-adapters).
//
// grok mirrors the page measured live on 2026-09-16: a form-hosted TipTap editor, a hidden 14 px
// helper <textarea>, and a submit button that exists only once the editor holds text (an "Enter
// voice mode" button occupies the slot while it is empty). `?composer=textarea` keeps the older
// textarea composer around for the native-value-setter path.

import { createRequire } from 'node:module'
import { test, expect } from '@playwright/test'

const require = createRequire(import.meta.url)
const { DEFAULT_SELECTORS, SLOTS } = require('../../preload/site.cjs')

const LOGIN_LINK = { chatgpt: 'a[href="/auth/login"]', claude: 'a[href="/login"]', grok: 'a[href="/sign-in"]' }
/** grok (TipTap): the action slot while the editor is empty — the real page's voice-mode button. */
const VOICE_BUTTON = "button[type='button'][aria-label='Enter voice mode']"
/** grok (TipTap): the submit button, rendered only once the editor holds text. */
const GROK_SUBMIT = "button[type='submit'][aria-label='Submit'][data-testid='chat-submit']"
const GROK_HELPER = 'textarea.helper'

const fakeState = (page) =>
  page.evaluate(() => ({ site: window.__fake.site, state: window.__fake.state, submitted: window.__fake.submitted, text: window.__fake.getText() }))
const helperText = (page) => page.evaluate(() => window.__fake.helperText())

for (const site of SLOTS) {
  const sel = DEFAULT_SELECTORS[site]
  // grok renders the submit button only once the editor holds text; the others keep a disabled one
  const submitAppearsOnInput = site === 'grok'

  test.describe(site, () => {
    test('first cascade entries for composer and send exist; send starts disabled (grok: absent until input)', async ({ page }) => {
      await page.goto(`/?site=${site}`)
      await expect(page.locator(sel.composer[0])).toHaveCount(1)
      if (submitAppearsOnInput) {
        await expect(page.locator(sel.send[0])).toHaveCount(0)
        await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
      } else {
        await expect(page.locator(sel.send[0])).toHaveCount(1)
        await expect(page.locator(sel.send[0])).toBeDisabled()
      }
      expect(await fakeState(page)).toEqual({ site, state: 'ok', submitted: [], text: '' })
    })

    test('typing enables send; submit records the text, clears the composer and moves to /c/<id>', async ({ page }) => {
      const text = `hello from ${site}`
      await page.goto(`/?site=${site}`)
      await page.locator(sel.composer[0]).click()
      await page.keyboard.type(text)
      await expect(page.locator(sel.send[0])).toBeEnabled()
      expect((await fakeState(page)).text).toBe(text)
      await page.locator(sel.send[0]).click()
      await expect.poll(() => fakeState(page)).toEqual({ site, state: 'ok', submitted: [text], text: '' })
      if (submitAppearsOnInput) {
        await expect(page.locator(sel.send[0])).toHaveCount(0) // gone again: the voice button is back
        await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
      } else {
        await expect(page.locator(sel.send[0])).toBeDisabled()
      }
      await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
    })

    test('logged-out wall shows the login link and no composer', async ({ page }) => {
      await page.goto(`/?site=${site}&state=loggedout`)
      await expect(page.locator(LOGIN_LINK[site])).toHaveCount(1)
      await expect(page.locator(sel.loggedOut[0])).toHaveCount(1)
      for (const s of sel.composer) await expect(page.locator(s)).toHaveCount(0)
      expect((await fakeState(page)).state).toBe('loggedout')
    })
  })
}

test.describe('Stage 2 reply options the capture specs lean on', () => {
  const sel = DEFAULT_SELECTORS.chatgpt
  const replyState = (page) =>
    page.evaluate(() => ({
      replying: window.__fake.replying,
      done: window.__fake.done,
      containers: window.__fake.containers,
      doneSignalAt: window.__fake.doneSignalAt,
      lastRenderAt: window.__fake.lastRenderAt,
      rendersAfterSignal: window.__fake.rendersAfterSignal,
      replyText: window.__fake.replyText(),
    }))
  const submit = async (page, text) => {
    await page.locator(sel.composer[0]).click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  test('?doneLagMs: the copy marker mounts and the stop button goes while the reply is still re-rendering; the last render lands after the end signal', async ({ page }) => {
    await page.goto('/?site=chatgpt&replyMs=1500&doneLagMs=700')
    await submit(page, 'lag')
    await expect(page.locator(sel.stop[0])).toHaveCount(1)
    await expect.poll(async () => (await replyState(page)).doneSignalAt !== null).toBe(true)
    const mid = await replyState(page)
    expect(mid.replying).toBe(true) // the end signal is up, the stream is not over
    expect(mid.done).toBe(false)
    await expect(page.locator(sel.stop[0])).toHaveCount(0)
    await expect(page.locator(sel.done[0])).toHaveCount(1)
    await expect.poll(async () => (await replyState(page)).done).toBe(true)
    const end = await replyState(page)
    expect(end.replyText).toBe('Echo: lag')
    expect(end.rendersAfterSignal).toBeGreaterThan(1)
    expect(end.lastRenderAt).toBeGreaterThan(end.doneSignalAt)
    await expect(page.locator(sel.done[0])).toHaveCount(1) // mounted once, not again at the end
  })

  test('?twoTurns=1: a finished tool container (its copy marker up, the stop button up) first, the answer container 300 ms later; both stay', async ({ page }) => {
    await page.goto('/?site=chatgpt&replyMs=600&twoTurns=1')
    await submit(page, 'two')
    await expect(page.locator(sel.assistant[0])).toHaveCount(1)
    await expect(page.locator(sel.assistant[0]).first().locator(sel.assistantText[0])).toHaveText('Searching the web…')
    await expect(page.locator(sel.done[0])).toHaveCount(1)
    await expect(page.locator(sel.stop[0])).toHaveCount(1)
    expect((await replyState(page)).containers).toBe(1)
    await expect(page.locator(sel.assistant[0])).toHaveCount(2)
    await expect.poll(async () => (await replyState(page)).done).toBe(true)
    const end = await replyState(page)
    expect(end.containers).toBe(2)
    expect(end.replyText).toBe('Echo: two')
    await expect(page.locator(sel.assistant[0]).nth(1).locator(sel.assistantText[0])).toHaveText('Echo: two')
    await expect(page.locator(sel.assistant[0]).first().locator(sel.assistantText[0])).toHaveText('Searching the web…')
    await expect(page.locator(sel.done[0])).toHaveCount(2)
    await expect(page.locator(sel.stop[0])).toHaveCount(0)
  })
})

/**
 * The S7-review lifecycle options, replaying what was MEASURED on chatgpt.com with a real logged-in
 * session on 2026-09-17: a short placeholder assistant turn (~12 characters, no `.markdown` child),
 * then the placeholder UNMOUNTED so `[data-message-author-role=assistant]` returns ZERO for ~10 s
 * while the stop button stays visible, then the real reply container with its `.markdown` child; and a
 * PLACEHOLDER chat url `/c/WEB:<uuid>` that is only later replaced by the real `/c/<uuid>`.
 */
test.describe('the measured chatgpt placeholder/remount lifecycle (?remountMs, ?webUrlMs)', () => {
  const sel = DEFAULT_SELECTORS.chatgpt
  const lifecycle = (page) =>
    page.evaluate(() => ({
      done: window.__fake.done,
      containers: window.__fake.containers,
      placeholderText: window.__fake.placeholderText,
      placeholderAt: window.__fake.placeholderAt,
      placeholderGoneAt: window.__fake.placeholderGoneAt,
      remountedAt: window.__fake.remountedAt,
      stopEvents: window.__fake.stopEvents,
      urls: window.__fake.urls,
      replyText: window.__fake.replyText(),
    }))
  const submit = async (page, text) => {
    await page.locator(sel.composer[0]).click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  test('?remountMs: a short placeholder turn with no .markdown child, then ZERO assistant containers, then the real reply — with the stop button up across the whole gap', async ({ page }) => {
    await page.goto('/?site=chatgpt&replyMs=400&placeholderMs=600&remountMs=700')
    await submit(page, 'remount')
    // 1. the placeholder: one assistant container, short, and NO `.markdown` child (the measured shape)
    await expect(page.locator(sel.assistant[0])).toHaveCount(1)
    await expect(page.locator(sel.stop[0])).toHaveCount(1)
    const placeholder = await lifecycle(page)
    expect(placeholder.placeholderText.length).toBeLessThanOrEqual(16)
    await expect(page.locator(sel.assistant[0])).toHaveText(placeholder.placeholderText)
    await expect(page.locator(sel.assistant[0]).locator(sel.assistantText[0])).toHaveCount(0)
    expect(placeholder.containers).toBe(1)
    // 2. the gap: the container is unmounted entirely while the stop button stays visible
    await expect(page.locator(sel.assistant[0])).toHaveCount(0)
    await expect(page.locator(sel.stop[0])).toHaveCount(1)
    // 3. the real reply: a container with its `.markdown` child, then the end signal
    await expect(page.locator(sel.assistant[0])).toHaveCount(1)
    await expect(page.locator(sel.assistant[0]).locator(sel.assistantText[0])).toHaveCount(1)
    await expect.poll(async () => (await lifecycle(page)).done).toBe(true)
    await expect(page.locator(sel.stop[0])).toHaveCount(0)
    await expect(page.locator(sel.done[0])).toHaveCount(1)
    const end = await lifecycle(page)
    expect(end.replyText).toBe('Echo: remount')
    expect(end.containers).toBe(2) // the placeholder and the real reply
    expect(end.placeholderGoneAt - end.placeholderAt).toBeGreaterThanOrEqual(500)
    expect(end.remountedAt - end.placeholderGoneAt).toBeGreaterThanOrEqual(600)
    // one raise, one drop: the stop button was never taken down during the gap
    expect(end.stopEvents.map((e) => e.on)).toEqual([true, false])
  })

  test('?webUrlMs: the submit pushes the placeholder /c/WEB:<uuid> and replaces it with the real /c/<uuid>; the placeholder path is not a chat (404)', async ({ page }) => {
    await page.goto('/?site=chatgpt&replyMs=200&webUrlMs=700')
    await submit(page, 'url')
    await expect.poll(async () => (await lifecycle(page)).urls.length).toBe(2)
    const { urls } = await lifecycle(page)
    expect(urls.map((u) => u.how)).toEqual(['push', 'replace'])
    const placeholderPath = new URL(urls[0].href).pathname
    const realPath = new URL(urls[1].href).pathname
    expect(placeholderPath).toMatch(/^\/c\/WEB:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(realPath).toBe(placeholderPath.replace('/c/WEB:', '/c/')) // same uuid, the prefix gone
    expect(urls[1].ts - urls[0].ts).toBeGreaterThanOrEqual(600)
    expect(page.url()).toBe(urls[1].href) // the real url is the one the page is left on
    expect((await page.request.get(placeholderPath)).status()).toBe(404) // revisiting the placeholder is not a chat
    expect((await page.request.get(realPath)).status()).toBe(200)
  })
})

test('chatgpt: an innerHTML write is reconciled away and never enables send', async ({ page }) => {
  await page.goto('/?site=chatgpt')
  const composer = page.locator('#prompt-textarea')
  await composer.evaluate((el) => {
    el.innerHTML = '<p>injected</p>'
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await expect(composer).toHaveText('')
  expect((await fakeState(page)).text).toBe('')
  await expect(page.locator("button[data-testid='send-button']")).toBeDisabled()
})

test('grok (TipTap): the editor mirrors grok.com — a form-hosted div.tiptap.ProseMirror[role=textbox]; the hidden 14 px helper textarea is rendered but matches no cascade entry', async ({ page }) => {
  await page.goto('/?site=grok')
  expect(await page.evaluate(() => window.__fake.variant)).toBe('tiptap')
  const editor = page.locator(DEFAULT_SELECTORS.grok.composer[0])
  await expect(editor).toHaveCount(1)
  await expect(editor).toHaveAttribute('role', 'textbox')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  expect(await editor.evaluate((el) => el.closest('form') !== null)).toBe(true)
  await expect(page.locator('form.composer')).toHaveCount(1)
  // the helper: the only <textarea> on the page, no aria-label / placeholder, a rendered 14×14 px
  // box (client rects, display and visibility untouched) that is nonetheless invisible — so it
  // passes a layout-based visibility check, which is how a bare `textarea` entry picked it
  await expect(page.locator('textarea')).toHaveCount(1)
  const helper = page.locator(GROK_HELPER)
  await expect(helper).toHaveCount(1)
  expect(await helper.getAttribute('aria-label')).toBeNull()
  expect(await helper.getAttribute('placeholder')).toBeNull()
  const box = await helper.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { width: r.width, height: r.height, rects: el.getClientRects().length, display: cs.display, visibility: cs.visibility, opacity: cs.opacity }
  })
  expect(box.width).toBe(14)
  expect(box.height).toBe(14)
  expect(box.rects).toBeGreaterThan(0)
  expect(box.display).not.toBe('none')
  expect(box.visibility).not.toBe('hidden')
  expect(box.opacity).toBe('0')
  expect(await helperText(page)).toBe('')
  // no entry of the corrected cascade matches the helper (the old bare `textarea` entry did)
  for (const s of DEFAULT_SELECTORS.grok.composer) {
    expect(await page.locator(s).evaluateAll((els) => els.filter((e) => e.tagName === 'TEXTAREA').length)).toBe(0)
  }
  expect(await page.evaluate(() => document.querySelector('textarea') === document.querySelector('textarea.helper'))).toBe(true)
})

test('grok (TipTap): the submit button exists only once the editor holds text; Enter submits, clears the editor and restores the voice button', async ({ page }) => {
  await page.goto('/?site=grok')
  await expect(page.locator(GROK_SUBMIT)).toHaveCount(0)
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
  await page.locator(DEFAULT_SELECTORS.grok.composer[0]).click()
  await page.keyboard.type('voice → submit')
  await expect(page.locator(GROK_SUBMIT)).toHaveCount(1)
  await expect(page.locator(GROK_SUBMIT)).toBeEnabled()
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(0)
  expect((await fakeState(page)).text).toBe('voice → submit')
  expect(await helperText(page)).toBe('') // the helper never sees what is typed into the editor
  await page.keyboard.press('Enter')
  await expect.poll(() => fakeState(page)).toEqual({ site: 'grok', state: 'ok', submitted: ['voice → submit'], text: '' })
  await expect(page.locator(GROK_SUBMIT)).toHaveCount(0)
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
  await expect(page).toHaveURL(/\/c\/[A-Za-z0-9-]+/)
})

test('grok (TipTap): ?sendDelayMs delays the submit button, not the typing', async ({ page }) => {
  await page.goto('/?site=grok&sendDelayMs=800')
  await page.locator(DEFAULT_SELECTORS.grok.composer[0]).click()
  const t0 = Date.now()
  await page.keyboard.type('delayed')
  expect((await fakeState(page)).text).toBe('delayed')
  await expect(page.locator(GROK_SUBMIT)).toHaveCount(0)
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
  await expect(page.locator(GROK_SUBMIT)).toHaveCount(1, { timeout: 5000 })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(0)
})

test('grok (TipTap): an innerHTML write is reconciled away and never renders the submit button', async ({ page }) => {
  await page.goto('/?site=grok')
  const editor = page.locator(DEFAULT_SELECTORS.grok.composer[0])
  await editor.evaluate((el) => {
    el.innerHTML = '<p>injected</p>'
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await expect(editor).toHaveText('')
  expect((await fakeState(page)).text).toBe('')
  await expect(page.locator(GROK_SUBMIT)).toHaveCount(0)
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(1)
})

test('grok&composer=textarea: the older textarea composer — a direct value assignment is not tracked; the prototype setter + input is', async ({ page }) => {
  await page.goto('/?site=grok&composer=textarea')
  expect(await page.evaluate(() => window.__fake.variant)).toBe('textarea')
  await expect(page.locator(DEFAULT_SELECTORS.grok.composer[0])).toHaveCount(0) // no TipTap editor in this variant
  await expect(page.locator(VOICE_BUTTON)).toHaveCount(0)
  const ta = page.locator("textarea[aria-label='Ask Grok anything']")
  await expect(ta).toHaveCount(1)
  await expect(page.locator("button[aria-label='Submit']")).toBeDisabled()
  await ta.evaluate((el) => {
    el.value = 'direct'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect((await fakeState(page)).text).toBe('')
  await expect(page.locator("button[aria-label='Submit']")).toBeDisabled()
  await ta.evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'native')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect((await fakeState(page)).text).toBe('native')
  await expect(page.locator("button[aria-label='Submit']")).toBeEnabled()
  await page.locator("button[aria-label='Submit']").click()
  await expect.poll(() => fakeState(page)).toEqual({ site: 'grok', state: 'ok', submitted: ['native'], text: '' })
  await expect(page.locator("button[aria-label='Submit']")).toBeDisabled()
})

test('thread=noise renders a user and an assistant message carrying every banner phrase and wall link inside the thread; state stays ok', async ({ page }) => {
  await page.goto('/?site=claude&thread=noise')
  const thread = page.locator('main.thread')
  await expect(thread.locator('article[data-message-author-role]')).toHaveCount(2)
  await expect(thread.locator("article[data-message-author-role='user']")).toContainText('rate limit')
  await expect(thread.locator("article[data-message-author-role='user']")).toContainText('Something went wrong')
  await expect(thread.locator("article[data-message-author-role='assistant']")).toContainText('Unusual activity has been detected')
  for (const href of ['/auth/login', '/login', '/sign-in', 'https://accounts.x.ai/sign-in']) await expect(thread.locator(`a[href='${href}']`)).toHaveCount(1)
  await expect(page.locator('[role=alert]')).toHaveCount(0)
  await expect(page.locator(DEFAULT_SELECTORS.claude.composer[0])).toHaveCount(1)
  expect(await fakeState(page)).toEqual({ site: 'claude', state: 'ok', submitted: [], text: '' })
})

test('states: challenge renders the local Turnstile stand-in; blocked renders the alert; slow mounts late', async ({ page }) => {
  await page.goto('/?site=claude&state=challenge')
  await expect(page).toHaveTitle('Just a moment...')
  const iframe = page.locator("iframe[src*='challenges.cloudflare.com']")
  await expect(iframe).toHaveCount(1)
  expect(await iframe.getAttribute('src')).toMatch(/^\/challenges\.cloudflare\.com\//)

  await page.goto('/?site=chatgpt&state=blocked')
  await expect(page.locator('[role=alert]')).toContainText('Unusual activity has been detected from your device')

  await page.goto('/?site=grok&state=slow')
  await expect(page.locator(DEFAULT_SELECTORS.grok.composer[0])).toHaveCount(0)
  await expect(page.locator(GROK_HELPER)).toHaveCount(0) // the helper mounts with the composer
  await expect(page.locator(DEFAULT_SELECTORS.grok.composer[0])).toHaveCount(1, { timeout: 6000 })
  await expect(page.locator(GROK_HELPER)).toHaveCount(1)
})
