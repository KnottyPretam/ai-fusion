// desktop/test/adapters/exchange.spec.js — the EXCHANGE fallback never echoes the prompt (2026-10-11), against
// the fake site in system Chrome with the real desktop/preload/site.cjs injected (see _harness.js).
//
// Measured on chatgpt.com on 2026-10-11 14:41: a pane Send ended OK by `stop_gone` after 291 s — and the
// captured text was `#### You said:` followed by the user's whole prompt, then the one line the model said
// before it paused to ask the user a question in a widget. The turn mounted NO reply body, so `replyText`
// fell back to the whole exchange group, which HOLDS the user turn. The fake site's `?chatgptLayout=group`
// is that exchange-group layout (fixture chatgpt-oct10-done) and `?askUser=1` that widget turn: a fixed line
// (never an echo), then a small form, the stop control gone, no done marker.
//
// Pinned: the capture text is the model's line and the widget label only — never the prompt, never the
// screen-reader-only headings — with `bodyMatched:false`, `heldUserTurn:true`, `echoesPrompt:false`; the same
// layout with a MarkdownRoot body reads the body alone (`bodyMatched:true`), and with the body cascade
// overridden to match nothing the exchange fallback still leaves the user turn out (`bodyMatched:false`); the
// article layout's widget turn reads its `.markdown` body (`heldUserTurn:false`). `echoesPrompt` is honest:
// an echo of the prompt in a body sets it, the stripped exchange does not.

import { test, expect } from '@playwright/test'
import { DEFAULT_SELECTORS, TRICKY, open, request, fake, replyState, withOverride } from './_harness.js'

const PROMPT = 'Give me investment advice for a ten year horizon with moderate risk and no crypto.'
const GROUP = DEFAULT_SELECTORS.chatgpt.assistant[0] // div.group.flex.flex-col:has([class^='block-']) — 2026-10-18; the user-turn entry is [1]
const STOP = DEFAULT_SELECTORS.chatgpt.stop[0]
const RATE = "button[aria-label='Rate response']"
const FLAGS = ['bodyMatched', 'echoesPrompt', 'heldUserTurn']

function expectCapture(res, { text, doneBy, flags }) {
  expect(res).toMatchObject({ ok: true, op: 'observe', text, doneBy })
  expect(res.text).toBe(text)
  expect(Object.keys(res).sort()).toEqual(['bodyMatched', 'bodyMissed', 'doneBy', 'echoesPrompt', 'heldUserTurn', 'ms', 'ok', 'op', 'reqId', 'text', 'url'])
  expect(FLAGS.map((f) => res[f])).toEqual(flags)
  // 2026-10-17: chatgpt (every capture here) has a body cascade, so `bodyMissed` is exactly "no body matched"
  expect(res.bodyMissed).toBe(!res.bodyMatched)
}

test.describe('chatgpt exchange-group layout (?chatgptLayout=group)', () => {
  test('the group holds the user turn from the submit tick, the reply block mounts into it, and a MarkdownRoot body reads the body alone: bodyMatched true, heldUserTurn true — and an echo honestly sets echoesPrompt', async ({ page }) => {
    await open(page, { site: 'chatgpt', chatgptLayout: 'group', replyMs: 400 })
    const sent = await request(page, { op: 'insertAndSubmit', text: TRICKY })
    expect(sent).toMatchObject({ ok: true, submitted: true })
    await expect(page.locator(GROUP)).toHaveCount(1)
    await expect(page.locator(`${GROUP} [class~='group/user-message'] h5.sr-only`)).toHaveText('You said:')
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: TRICKY })
    expectCapture(res, { text: 'Echo: ' + TRICKY, doneBy: 'done_selector', flags: [true, true, true] })
    expect(res.text.includes('You said')).toBe(false)
    expect(res.text.includes('ChatGPT said')).toBe(false)
    await expect(page.locator(RATE)).toHaveCount(1)
    const r = await replyState(page)
    expect(r.chatgptLayout).toBe('group')
    expect(r.done).toBe(true)
    expect((await fake(page)).submitted).toEqual([TRICKY])
  })

  test('?askUser=1: the model\'s line, then the widget, the stop control gone and NO marker → stop_gone with the line and the widget label only; never the prompt, never the sr-only headings; bodyMatched false, heldUserTurn true, echoesPrompt false', async ({ page }) => {
    await open(page, { site: 'chatgpt', chatgptLayout: 'group', replyMs: 400, askUser: 1 })
    const sent = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    expect(sent).toMatchObject({ ok: true, submitted: true })
    await expect(page.locator(STOP)).toHaveCount(1)
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: PROMPT })
    const { askUser, askedAt, done } = await replyState(page)
    expect(askUser).toEqual({ text: 'Before I answer, one optional question about your timeline.', label: 'Asking question' })
    expect(askedAt).not.toBeNull()
    expect(done).toBe(true)
    expectCapture(res, { text: `${askUser.text}\n\n${askUser.label}`, doneBy: 'stop_gone', flags: [false, false, true] })
    expect(res.text.includes(PROMPT)).toBe(false)
    expect(res.text.includes('investment')).toBe(false)
    expect(res.text.includes('said:')).toBe(false)
    await expect(page.locator(STOP)).toHaveCount(0)
    await expect(page.locator(RATE)).toHaveCount(0)
    await expect(page.locator(`${GROUP} form.ask-user input`)).toHaveCount(1)
    // the page itself still holds the prompt inside the group — the capture left it out, it is not gone
    await expect(page.locator(`${GROUP} [class~='group/user-message']`).first()).toContainText(PROMPT)
    // the same text with no body cascade match would once have been the whole exchange: prove the old read carried the prompt
    const whole = await page.evaluate((sel) => document.querySelector(sel).innerText, GROUP)
    expect(whole).toContain(PROMPT)
    expect(whole).toContain(askUser.label)
  })

  test('the body cascade overridden to match nothing: the exchange fallback reads the echo WITHOUT the user turn — the prompt appears once (the echo), never twice; bodyMatched false', async ({ page }) => {
    await open(page, { site: 'chatgpt', chatgptLayout: 'group', replyMs: 400, selectors: withOverride('chatgpt', { assistantText: ['.nope'] }) })
    const sent = await request(page, { op: 'insertAndSubmit', text: TRICKY })
    expect(sent).toMatchObject({ ok: true, submitted: true })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: TRICKY })
    // the echo carries the prompt (echoesPrompt true, honestly) but the user turn's copy and the headings are out
    expectCapture(res, { text: 'Echo: ' + TRICKY, doneBy: 'done_selector', flags: [false, true, true] })
    expect(res.text.split(TRICKY).length - 1).toBe(1)
    expect(res.text.includes('You said')).toBe(false)
    expect(res.text.includes('ChatGPT said')).toBe(false)
  })

  test('two exchanges in one chat: the second turn\'s capture anchors on ITS group and reads its own widget line, never the first exchange\'s echo or either prompt', async ({ page }) => {
    await open(page, { site: 'chatgpt', chatgptLayout: 'group', replyMs: 300, askUser: 1 })
    const first = await request(page, { op: 'insertAndSubmit', text: 'first question about bonds' })
    const r1 = await request(page, { op: 'observe', baselineCount: first.assistantCount, text: 'first question about bonds' })
    expect(r1.ok).toBe(true)
    const second = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    expect(second).toMatchObject({ ok: true, submitted: true })
    await expect(page.locator(GROUP)).toHaveCount(2)
    const r2 = await request(page, { op: 'observe', baselineCount: second.assistantCount, text: PROMPT })
    const { askUser } = await replyState(page)
    expectCapture(r2, { text: `${askUser.text}\n\n${askUser.label}`, doneBy: 'stop_gone', flags: [false, false, true] })
    expect(r2.text.includes('bonds')).toBe(false)
    expect(r2.text.includes(PROMPT)).toBe(false)
  })
})

test.describe('chatgpt article layout', () => {
  test('?askUser=1 on the per-turn article: the `.markdown` body is read alone (the widget beside it is chrome) — bodyMatched true, heldUserTurn false, echoesPrompt false, stop_gone', async ({ page }) => {
    await open(page, { site: 'chatgpt', replyMs: 400, askUser: 1 })
    const sent = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    expect(sent).toMatchObject({ ok: true, submitted: true })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: PROMPT })
    const { askUser } = await replyState(page)
    expectCapture(res, { text: askUser.text, doneBy: 'stop_gone', flags: [true, false, false] })
    expect(res.text.includes(askUser.label)).toBe(false)
    await expect(page.locator("article[data-message-author-role='assistant'] form.ask-user")).toHaveCount(1)
    await expect(page.locator(DEFAULT_SELECTORS.chatgpt.done[0])).toHaveCount(0)
  })

  test('the plain echo on the article layout reports bodyMatched true, heldUserTurn false and echoesPrompt true (the body quotes the typed text)', async ({ page }) => {
    await open(page, { site: 'chatgpt', replyMs: 300 })
    const sent = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: PROMPT })
    expectCapture(res, { text: 'Echo: ' + PROMPT, doneBy: 'done_selector', flags: [true, true, false] })
  })
})

test.describe('claude, grok and gemini', () => {
  // 2026-10-17: gemini's `model-response` is a turn-level row with a matched body (`.markdown-main-panel`), like grok's
  for (const site of ['claude', 'grok', 'gemini']) {
    test(`${site}: ?askUser=1 reads the line alone from the site's own body element; heldUserTurn false (a turn-level row), echoesPrompt false`, async ({ page }) => {
      await open(page, { site, replyMs: 300, askUser: 1 })
      const sent = await request(page, { op: 'insertAndSubmit', text: PROMPT })
      expect(sent).toMatchObject({ ok: true, submitted: true })
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: PROMPT })
      const { askUser } = await replyState(page)
      expect(res.ok).toBe(true)
      expect(res.doneBy).toBe('stop_gone')
      expect(res.text.includes(PROMPT)).toBe(false)
      expect(res.text.startsWith(askUser.text)).toBe(true)
      expect([res.heldUserTurn, res.echoesPrompt]).toEqual([false, false])
      // claude's assistantText is `.prose`, which the plain echo row does not render — its fallback is the whole
      // turn-level row, widget label included; grok's body is `.response-content-markdown`, matched
      if (site === 'grok' || site === 'gemini') expect([res.bodyMatched, res.text]).toEqual([true, askUser.text])
      else expect([res.bodyMatched, res.text]).toEqual([false, `${askUser.text}\n\n${askUser.label}`])
    })
  }
})

// 2026-10-18 — measured that day (fixture chatgpt-oct18-unmounted-user): a 9-minute reply in a 413 px pane had scrolled the
// prompt out of view and chatgpt.com's virtualizer UNMOUNTED the exchange's user block; the `:has(user turn)` entry then
// matched nothing (`containers=0 anchor=0`). Here in real Chrome: the group-by-block entry still names the group after
// the drop, the old entry does not, and the capture reads the whole answer.
test.describe('chatgpt exchange group whose USER block is unmounted mid-reply (?dropUserMs, 2026-10-18)', () => {
  test('the user block goes 500 ms into a 2.5 s reply: entry 0 still matches the group (entry 1 no longer does), no user turn is left, and the capture is the whole echo by the done marker', async ({ page }) => {
    test.setTimeout(60000)
    await open(page, { site: 'chatgpt', chatgptLayout: 'group', replyMs: 2500, dropUserMs: 500, selectors: withOverride('chatgpt', { quietMs: 400, settleMs: 400 }) })
    const sent = await request(page, { op: 'insertAndSubmit', text: PROMPT })
    expect(sent).toMatchObject({ ok: true, submitted: true })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, text: PROMPT })
    const r = await replyState(page)
    expect(r.userDroppedAt).not.toBeNull()
    await expect(page.locator("[class~='group/user-message']")).toHaveCount(0)
    await expect(page.locator(DEFAULT_SELECTORS.chatgpt.assistant[0])).toHaveCount(1)
    await expect(page.locator(DEFAULT_SELECTORS.chatgpt.assistant[1])).toHaveCount(0)
    expectCapture(res, { text: r.replySource, doneBy: 'done_selector', flags: [true, true, false] })
    expect(res.text.length).toBe(r.replySource.length)
  })
})
