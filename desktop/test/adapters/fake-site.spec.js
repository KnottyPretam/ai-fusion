// desktop/test/adapters/fake-site.spec.js — Stage 0 smoke for the fake site (project `adapters`).
// Proves the v1 cascades' FIRST entries match each look-alike, the login walls carry no composer,
// and the editing model behaves (typing enables send, submit records the text, foreign writes are
// reconciled away). Kept as the fake site's own smoke next to adapter.spec.js, which drives the real
// site.cjs through the fake IPC (Stage 1, site-adapters).

import { createRequire } from 'node:module'
import { test, expect } from '@playwright/test'

const require = createRequire(import.meta.url)
const { DEFAULT_SELECTORS, SLOTS } = require('../../preload/site.cjs')

const LOGIN_LINK = { chatgpt: 'a[href="/auth/login"]', claude: 'a[href="/login"]', grok: 'a[href="/sign-in"]' }

const fakeState = (page) =>
  page.evaluate(() => ({ site: window.__fake.site, state: window.__fake.state, submitted: window.__fake.submitted, text: window.__fake.getText() }))

for (const site of SLOTS) {
  const sel = DEFAULT_SELECTORS[site]

  test.describe(site, () => {
    test('first cascade entries for composer and send exist; send starts disabled', async ({ page }) => {
      await page.goto(`/?site=${site}`)
      await expect(page.locator(sel.composer[0])).toHaveCount(1)
      await expect(page.locator(sel.send[0])).toHaveCount(1)
      await expect(page.locator(sel.send[0])).toBeDisabled()
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
      await expect(page.locator(sel.send[0])).toBeDisabled()
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

test('grok: a direct value assignment is not tracked; the prototype setter + input is', async ({ page }) => {
  await page.goto('/?site=grok')
  const ta = page.locator("textarea[aria-label='Ask Grok anything']")
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
  await expect(page.locator("textarea[aria-label='Ask Grok anything']")).toHaveCount(0)
  await expect(page.locator("textarea[aria-label='Ask Grok anything']")).toHaveCount(1, { timeout: 6000 })
})
