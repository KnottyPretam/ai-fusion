// desktop/test/adapters/trusted.spec.js — TRUSTED input (2026-10-17), against the fake site in system Chrome with the
// real desktop/preload/site.cjs injected (see _harness.js).
//
// Why: gemini.google.com is publicly reported (2026-09-30, an Electron 44 embed) to ignore UNTRUSTED input — a synthetic
// insert plus `el.click()` showed the Stop state and produced no usable reply. The adapter's own submit confirmation
// takes a Stop control (with the composer emptied) for a submission, so a synthetic path that falls back on
// `not_submitted` would never fall back: the failure would surface minutes later as a capture timeout. So on a site whose
// `trustedInput` is true, main types the bridge request's own text with Electron's trusted `webContents.insertText` and a
// `sendInputEvent` Enter, bracketed by three adapter ops: `prepareInput` → (main types) → `verifyInput` → (main presses
// Enter) → `confirmSubmit`. Playwright's `page.keyboard` goes through the browser's Input domain and is TRUSTED, exactly
// as main's input is, while the adapter's `el.click()` and synthetic KeyboardEvents are not — so here the keyboard plays
// main's part. The fake site's `?untrusted=ignore|stall` is the site that refuses synthetic submits (`ignore`) or
// false-confirms them (`stall`, the public report).
//
// Pinned: (a) under `ignore` the synthetic insertAndSubmit answers not_submitted and nothing is sent; (b) under `stall`
// it CONFIRMS — and the capture then finds no reply with the stop control up: the reason trusted input is the primary
// path on gemini, not a fallback; (c) the full prepare → trusted insert → verify → trusted Enter → confirm → observe
// sequence captures the Echo on every look-alike under `ignore`; (d) nothing typed reads `none`, half of it `partial`;
// (e) `confirmSubmit{clickFallback}` confirms on a site that honours synthetic clicks and does not under `ignore`;
// (f) a leftover of exactly this prompt is `already_present` and main types nothing. What a spec cannot show is a HIDDEN
// WebContentsView — the app spec covers that (integrator, DISPLAY=:1).

import { test, expect } from '@playwright/test'
import { DEFAULT_SELECTORS, SLOTS, TRICKY, open, request, fake, trustState, withOverride } from './_harness.js'

const PROMPT = 'Trusted keystrokes only: what is the maximum gyroscope range of the BMI088?'
/** Short confirmation windows: every miss below costs one of them, and a miss is the expected answer in half the tests. */
const QUICK = { submitVerifyMs: 600, sendWaitMs: 1500 }

/** The sequence main runs on a trusted-input site, with Playwright's keyboard standing in for main's webContents input. */
async function trustedSubmit(page, text) {
  const prepared = await request(page, { op: 'prepareInput', text, timeoutMs: 5000 })
  expect(prepared).toMatchObject({ ok: true, op: 'prepareInput' })
  if (prepared.state !== 'already_present') await page.keyboard.insertText(text)
  const verified = await request(page, { op: 'verifyInput', text })
  expect(verified).toMatchObject({ ok: true, op: 'verifyInput', landed: 'all' })
  await page.keyboard.press('Enter')
  const confirmed = await request(page, { op: 'confirmSubmit', text })
  return { prepared, verified, confirmed }
}

test.describe('(a)/(b) why trusted input is PRIMARY on gemini: the synthetic path either fails or, worse, false-confirms', () => {
  test('gemini, untrusted=ignore: insertAndSubmit types the prompt but its click and Enters are dropped — not_submitted, nothing sent, the prompt left in the composer', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore', selectors: withOverride('gemini', QUICK) })
    const res = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    expect(res).toMatchObject({ ok: false, op: 'insertAndSubmit', code: 'not_submitted' })
    const f = await fake(page)
    expect(f.submitted).toEqual([])
    expect(f.text).toBe(PROMPT) // never cleared on failure
    const t = await trustState(page)
    expect(t.untrusted).toBe('ignore')
    expect(t.dropped).toBe(3) // the click, the Enter, and the one retry while the prompt was provably still there
  })

  test('gemini, untrusted=stall: insertAndSubmit CONFIRMS (the user turn mounted, the composer emptied, Stop up) — and the capture then finds no reply with the stop control still up', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'stall', replyMs: 100, selectors: withOverride('gemini', QUICK) })
    const sent = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    expect(sent).toMatchObject({ ok: true, op: 'insertAndSubmit', submitted: true })
    expect(['stop_button', 'composer_cleared', 'assistant_count']).toContain(sent.confirmedBy) // a false confirmation
    const t = await trustState(page)
    expect(t.stalled).toEqual([PROMPT])
    expect((await fake(page)).submitted).toEqual([]) // the site never really took it
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, firstTokenMs: 1500, timeoutMs: 3000 })
    expect(res.ok).toBe(false)
    expect(['reply_not_found', 'timeout']).toContain(res.code)
    expect(res.message).toMatch(/stopNow=true/) // the site is "still answering" forever
    await expect(page.locator(DEFAULT_SELECTORS.gemini.stop[0])).toHaveCount(1)
  })
})

test.describe('(c) the full trusted sequence captures the reply where synthetic submits are ignored', () => {
  for (const site of SLOTS) {
    test(`${site}, untrusted=ignore: prepareInput focuses the composer → trusted insert → verifyInput all → trusted Enter → confirmSubmit → observe returns the Echo`, async ({ page }) => {
      await open(page, { site, untrusted: 'ignore', replyMs: 300, selectors: withOverride(site, { ...QUICK, ...(site === 'claude' ? { stopGoneGraceMs: 0 } : {}) }) })
      const { prepared, verified, confirmed } = await trustedSubmit(page, PROMPT)
      expect(prepared).toMatchObject({ state: 'ready', composerSelector: DEFAULT_SELECTORS[site].composer[0], focused: true, composerChars: 0 })
      expect(verified.expectedChars).toBe(PROMPT.replace(/\s+/g, '').length)
      expect(verified.composerChars).toBe(verified.expectedChars)
      expect(confirmed).toMatchObject({ ok: true, op: 'confirmSubmit', sendSelector: null })
      expect(['stop_button', 'composer_cleared', 'assistant_count']).toContain(confirmed.confirmedBy)
      expect(confirmed.stillHeld).toBe(false)
      expect(confirmed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      // lengths, counts and booleans only: no result carries the prompt
      for (const r of [prepared, verified, confirmed]) expect(JSON.stringify(r)).not.toContain('gyroscope')
      expect((await fake(page)).submitted).toEqual([PROMPT])
      expect((await trustState(page)).dropped).toBe(0) // nothing synthetic was ever needed
      // observe anchors on the prompt prepareInput remembered (no `text` in the message), from the verify-time baseline
      const res = await request(page, { op: 'observe', baselineCount: confirmed.assistantCount })
      expect(res).toMatchObject({ ok: true, op: 'observe', text: 'Echo: ' + PROMPT })
    })
  }

  test('gemini: a multi-line prompt with tabs, runs of spaces, a blank line and unicode lands byte for byte through the trusted insert', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore', replyMs: 200, selectors: withOverride('gemini', QUICK) })
    const { confirmed } = await trustedSubmit(page, TRICKY)
    expect(confirmed.confirmedBy).not.toBeNull()
    expect((await fake(page)).submitted).toEqual([TRICKY])
    const res = await request(page, { op: 'observe', baselineCount: confirmed.assistantCount })
    expect(res).toMatchObject({ ok: true, text: 'Echo: ' + TRICKY, doneBy: 'done_selector' })
  })

  test('gemini: a second exchange in the same chat — the trusted path takes the new baseline and captures ITS reply (echoTurn numbers them)', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore', replyMs: 150, echoTurn: 1, selectors: withOverride('gemini', QUICK) })
    for (let i = 1; i <= 2; i += 1) {
      const text = `${PROMPT} (exchange ${i})`
      const { verified, confirmed } = await trustedSubmit(page, text)
      expect(verified.assistantCount).toBe(i - 1)
      const res = await request(page, { op: 'observe', baselineCount: confirmed.assistantCount })
      expect(res).toMatchObject({ ok: true, text: `Echo ${i}: ${text}` })
    }
  })
})

test.describe('(d) verifyInput reads what LANDED, as lengths', () => {
  test('gemini: nothing typed → `none` (main may fall back to ONE synthetic insertAndSubmit); half typed → `partial` (main stops: never typed twice)', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore' })
    await request(page, { op: 'prepareInput', text: PROMPT })
    const none = await request(page, { op: 'verifyInput', text: PROMPT, verifyMs: 300 })
    expect(none).toMatchObject({ ok: true, landed: 'none', composerChars: 0, sendReady: false })
    await page.keyboard.insertText(PROMPT.slice(0, 30))
    const partial = await request(page, { op: 'verifyInput', text: PROMPT, verifyMs: 300 })
    expect(partial).toMatchObject({ ok: true, landed: 'partial', sendReady: false })
    expect(partial.composerChars).toBe(PROMPT.slice(0, 30).replace(/\s+/g, '').length)
    expect(partial.composerChars).toBeLessThan(partial.expectedChars)
    // a partial reading never arms a confirmation
    expect(await request(page, { op: 'confirmSubmit', text: PROMPT })).toMatchObject({ ok: false, code: 'site_error' })
    expect((await fake(page)).submitted).toEqual([])
  })

  test('gemini: a leftover draft stays in front — the trusted text lands at the caret prepareInput put at the END, and `all` means "the draft followed by the prompt"', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore', replyMs: 150, selectors: withOverride('gemini', QUICK) })
    await page.locator(DEFAULT_SELECTORS.gemini.composer[0]).click()
    await page.keyboard.type('Draft first. ')
    await page.keyboard.press('Home') // the user's caret is at the START: prepareInput must move it
    const prepared = await request(page, { op: 'prepareInput', text: PROMPT })
    expect(prepared).toMatchObject({ ok: true, state: 'ready', composerChars: 'Draftfirst.'.length })
    await page.keyboard.insertText(PROMPT)
    expect(await request(page, { op: 'verifyInput', text: PROMPT })).toMatchObject({ ok: true, landed: 'all' })
    expect((await fake(page)).text).toBe('Draft first. ' + PROMPT)
  })
})

test.describe('(e)/(f) the click fallback and the idempotent retry', () => {
  test('gemini: confirmSubmit{clickFallback} — on a site that honours synthetic clicks the ONE click submits; under ignore it is dropped and the prompt is still held (main then answers not_submitted)', async ({ page }) => {
    await open(page, { site: 'gemini', replyMs: 150, selectors: withOverride('gemini', QUICK) })
    await request(page, { op: 'prepareInput', text: PROMPT })
    await page.keyboard.insertText(PROMPT)
    expect(await request(page, { op: 'verifyInput', text: PROMPT })).toMatchObject({ landed: 'all', sendReady: true })
    // no Enter was pressed: the first confirmation misses, the fallback clicks
    const clicked = await request(page, { op: 'confirmSubmit', text: PROMPT, clickFallback: true })
    expect(clicked).toMatchObject({ ok: true, sendSelector: DEFAULT_SELECTORS.gemini.send[0], stillHeld: false })
    expect(clicked.confirmedBy).not.toBeNull()
    expect((await fake(page)).submitted).toEqual([PROMPT])
  })

  test('gemini, untrusted=ignore: the click fallback is dropped — confirmedBy null, stillHeld true, the prompt still in the composer, nothing sent', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore', selectors: withOverride('gemini', QUICK) })
    await request(page, { op: 'prepareInput', text: PROMPT })
    await page.keyboard.insertText(PROMPT)
    await request(page, { op: 'verifyInput', text: PROMPT })
    const res = await request(page, { op: 'confirmSubmit', text: PROMPT, clickFallback: true })
    expect(res).toMatchObject({ ok: true, confirmedBy: null, stillHeld: true, sendSelector: DEFAULT_SELECTORS.gemini.send[0] })
    expect((await trustState(page)).dropped).toBe(1)
    const f = await fake(page)
    expect([f.submitted, f.text]).toEqual([[], PROMPT])
  })

  test('gemini: a leftover of EXACTLY this prompt (a failed attempt) is `already_present` — main types nothing — and a trusted Enter submits it once', async ({ page }) => {
    await open(page, { site: 'gemini', untrusted: 'ignore', replyMs: 150, selectors: withOverride('gemini', QUICK) })
    await page.locator(DEFAULT_SELECTORS.gemini.composer[0]).click()
    await page.keyboard.insertText(PROMPT)
    const { prepared, confirmed } = await trustedSubmit(page, PROMPT)
    expect(prepared.state).toBe('already_present')
    expect(confirmed.confirmedBy).not.toBeNull()
    expect((await fake(page)).submitted).toEqual([PROMPT]) // once — not doubled
  })

  test('a guest-mode gemini page refuses before anything is focused or typed: prepareInput answers logged_out', async ({ page }) => {
    await open(page, { site: 'gemini', state: 'loggedout' })
    expect(await request(page, { op: 'prepareInput', text: PROMPT })).toMatchObject({ ok: false, op: 'prepareInput', code: 'logged_out' })
    expect(await request(page, { op: 'verifyInput', text: PROMPT })).toMatchObject({ ok: false, code: 'site_error' })
    expect((await fake(page)).text).toBe('')
  })
})
