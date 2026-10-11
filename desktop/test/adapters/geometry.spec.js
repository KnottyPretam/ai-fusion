// desktop/test/adapters/geometry.spec.js — reply adjacency by GEOMETRY (2026-10-11), against the fake site in a
// real browser (project `adapters`; the real desktop/preload/site.cjs injected, see _harness.js). The failure it
// replays: a plain Send on a FRESH grok.com chat waited 90 s for a 6,865-character reply that was on the page —
// the chat's two rows sat in the scroller's absolutely positioned slots in OLDEST-first document order where the
// 58-row chat of 2026-09-27 read newest-first (grok.com reuses a POOL of slots and places rows by transform), so
// `transcriptOrder: 'newest-first'` stepped backwards from the anchor and found nothing. The fake's ?order=forward
// (appended, oldest-first DOM — that failing shape on the grok look-alike), ?order=reverse (prepended, placed by
// translateY) and the new ?order=shuffle (alternating DOM positions under the same placement) replay the shapes;
// what the adapter does — rule (b) of `containerForAnchor` and `newestOf` read the laid-out positions first, the
// reply is the lowest row below the prompt, `transcriptOrder` is only the DOM fallback — is in the capture section
// of site.cjs and in test/unit/preload/geometry.test.js (where the fall-through for a page WITHOUT geometry lives).
import { test, expect } from '@playwright/test'
import { FAKE_ASSISTANT, DEFAULT_SELECTORS, open, request, replyState, withOverride } from './_harness.js'

const DONE_BY = { chatgpt: 'done_selector', claude: 'stop_gone', grok: 'stop_gone' }
/** claude's 15 s `stopGoneGraceMs` is zeroed for the multi-exchange runs (as virtualized.spec.js does); it is not what is measured here. */
const FAST = (site, extra = {}) => withOverride(site, { ...(site === 'claude' ? { stopGoneGraceMs: 0 } : {}), ...extra })
const CONTAINER = FAKE_ASSISTANT
const SCROLLER = "[data-testid='chat-transcript-scroller']"
const USER_TURN = { chatgpt: "[data-message-author-role='user']", claude: "[data-testid='user-message']", grok: "[data-testid='user-message']" }
const PROMPT = (i) => `prompt ${i}: what is the maximum gyroscope full-scale range of the BMI088, and which register selects it?`

function expectObserved(res, text, doneBy) {
  expect(res).toMatchObject({ ok: true, op: 'observe', text, doneBy })
  expect(res.text).toBe(text) // byte-exact: the Echo of ITS OWN prompt, never an earlier one
}

/** One exchange as main drives it: insertAndSubmit, then observe from the submit's baseline. */
async function exchange(page, text) {
  const sent = await request(page, { op: 'insertAndSubmit', text })
  expect(sent).toMatchObject({ ok: true, op: 'insertAndSubmit', submitted: true })
  const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
  return { sent, res }
}

/** The user turns and containers as the page LAYS THEM OUT: their texts in document order and sorted by top. */
const layout = (page, site) =>
  page.evaluate(
    ([userSel, containerSel]) => {
      const read = (sel) => [...document.querySelectorAll(sel)].map((el) => ({ text: el.innerText.trim().slice(0, 12), top: el.getBoundingClientRect().top }))
      const byTop = (rows) => [...rows].sort((a, b) => a.top - b.top).map((r) => r.text)
      const turns = read(userSel)
      const containers = read(containerSel)
      return { turnsDom: turns.map((r) => r.text), turnsByTop: byTop(turns), containersDom: containers.map((r) => r.text), containersByTop: byTop(containers) }
    },
    [USER_TURN[site], CONTAINER[site]],
  )

test.describe('the 2026-10-11 failure: a FRESH grok chat whose rows read OLDEST-first under the newest-first key (?order=forward on the grok look-alike)', () => {
  test('grok: order=forward — the user row precedes the reply row in document order, DEFAULT_SELECTORS.grok.transcriptOrder is newest-first, and the reply is still captured byte-exact; so are the next two', async ({ page }) => {
    test.setTimeout(60000)
    await open(page, { site: 'grok', replyMs: 150, order: 'forward' })
    expect((await replyState(page)).order).toBe('oldest-first')
    await expect(page.locator(SCROLLER)).toHaveCount(0) // appended, no slots: the plain flex column
    expect(DEFAULT_SELECTORS.grok.transcriptOrder).toBe('newest-first')
    const { res } = await exchange(page, PROMPT(1))
    expectObserved(res, 'Echo: ' + PROMPT(1), 'stop_gone')
    const precedes = await page.evaluate(
      ([u, a]) => (document.querySelector(u).compareDocumentPosition(document.querySelector(a)) & 4) !== 0,
      [USER_TURN.grok, CONTAINER.grok],
    )
    expect(precedes).toBe(true) // the failing shape: the reply FOLLOWS the prompt, where the key says it precedes it
    for (let i = 2; i <= 3; i += 1) expectObserved((await exchange(page, PROMPT(i))).res, 'Echo: ' + PROMPT(i), 'stop_gone')
    const l = await layout(page, 'grok')
    expect(l.turnsDom).toEqual(l.turnsByTop) // appended: document order and geometry agree …
    expect(l.containersDom).toEqual(l.containersByTop)
    expect(l.turnsByTop).toEqual(['prompt 1: wh', 'prompt 2: wh', 'prompt 3: wh']) // … and both are oldest at the top
  })
})

test.describe('a SHUFFLED transcript (?order=shuffle): the document order is neither direction — only the laid-out positions say which row follows which', () => {
  test('grok: order=shuffle + keepLast=7 + echoTurn over nine exchanges — each reply is the Echo of ITS prompt, while the user rows read newest-first and the reply rows oldest-first in document order', async ({ page }) => {
    test.setTimeout(120000)
    await open(page, { site: 'grok', replyMs: 150, keepLast: 7, order: 'shuffle', echoTurn: 1 })
    await expect(page.locator(SCROLLER)).toHaveCount(1)
    expect((await replyState(page)).order).toBe('shuffle')
    for (let i = 1; i <= 9; i += 1) expectObserved((await exchange(page, PROMPT(i))).res, `Echo ${i}: ` + PROMPT(i), 'stop_gone')
    const r = await replyState(page)
    expect(r.mountedAssistants).toBe(7)
    expect(r.trimmed).toBe(2)
    await expect(page.locator(`${SCROLLER} > .slot`)).toHaveCount(14)
    const l = await layout(page, 'grok')
    expect(l.turnsDom).toEqual(['prompt 9: wh', 'prompt 8: wh', 'prompt 7: wh', 'prompt 6: wh', 'prompt 5: wh', 'prompt 4: wh', 'prompt 3: wh']) // prepended
    expect(l.containersDom).toEqual(['Echo 3: prom', 'Echo 4: prom', 'Echo 5: prom', 'Echo 6: prom', 'Echo 7: prom', 'Echo 8: prom', 'Echo 9: prom']) // appended
    expect(l.turnsByTop).toEqual([...l.turnsDom].reverse()) // the geometry is the transcript: oldest at the top
    expect(l.containersByTop).toEqual(l.containersDom)
  })

  for (const site of ['chatgpt', 'claude']) {
    test(`${site}: order=shuffle under a transcriptOrder override that is WRONG for the DOM (newest-first) — nine exchanges, each its own Echo: geometry wins over the key`, async ({ page }) => {
      test.setTimeout(120000)
      await open(page, { site, replyMs: 150, keepLast: 7, order: 'shuffle', echoTurn: 1, selectors: FAST(site, { transcriptOrder: 'newest-first' }) })
      await expect(page.locator(SCROLLER)).toHaveCount(1)
      for (let i = 1; i <= 9; i += 1) expectObserved((await exchange(page, PROMPT(i))).res, `Echo ${i}: ` + PROMPT(i), DONE_BY[site])
      expect((await replyState(page)).mountedAssistants).toBe(7)
      const l = await layout(page, site)
      expect(l.turnsDom).not.toEqual(l.turnsByTop) // the DOM order is not the transcript …
      expect(l.turnsByTop).toEqual([...l.turnsDom].reverse())
      expect(l.containersByTop).toEqual(l.containersDom) // … for the replies it happens to be, which is exactly why a key cannot say
    })

    test(`${site}: order=forward (appended) under the WRONG key (newest-first), four exchanges — the DOM step names the PREVIOUS reply, the laid-out row below the prompt is captured`, async ({ page }) => {
      test.setTimeout(60000)
      await open(page, { site, replyMs: 150, order: 'forward', echoTurn: 1, selectors: FAST(site, { transcriptOrder: 'newest-first' }) })
      await expect(page.locator(SCROLLER)).toHaveCount(0)
      for (let i = 1; i <= 4; i += 1) expectObserved((await exchange(page, PROMPT(i))).res, `Echo ${i}: ` + PROMPT(i), DONE_BY[site])
      await expect(page.locator(CONTAINER[site])).toHaveCount(4)
      await expect(page.locator(CONTAINER[site]).last()).toContainText('Echo 4:') // appended: the newest is LAST, where the key says first
    })
  }

  test('claude: order=shuffle + twoTurns under the DEFAULT key, four exchanges — the DOM step hands back another exchange\'s row, the geometry takes the lowest row of THIS exchange (the answer), never the tool turn', async ({ page }) => {
    test.setTimeout(90000)
    await open(page, { site: 'claude', replyMs: 150, order: 'shuffle', twoTurns: 1, echoTurn: 1, selectors: FAST('claude') })
    for (let i = 1; i <= 4; i += 1) {
      const { res } = await exchange(page, PROMPT(i))
      expectObserved(res, `Echo ${i}: ` + PROMPT(i), 'stop_gone')
      expect(res.text).not.toContain('Searching the web')
    }
    await expect(page.locator(CONTAINER.claude)).toHaveCount(8) // a tool row and an answer row per exchange
    await expect(page.locator(`${SCROLLER} > .slot`)).toHaveCount(12)
  })
})

test.describe('a newest-first transcript (?order=reverse) placed by translateY: still the NEWEST reply every time, now by geometry (virtualized.spec.js keeps the nine-exchange runs)', () => {
  test('grok: order=reverse + echoTurn, three exchanges — the first container in document order is the newest AND the lowest on the page', async ({ page }) => {
    test.setTimeout(60000)
    await open(page, { site: 'grok', replyMs: 150, order: 'reverse', echoTurn: 1 })
    for (let i = 1; i <= 3; i += 1) expectObserved((await exchange(page, PROMPT(i))).res, `Echo ${i}: ` + PROMPT(i), 'stop_gone')
    const l = await layout(page, 'grok')
    expect(l.containersDom).toEqual(['Echo 3: prom', 'Echo 2: prom', 'Echo 1: prom'])
    expect(l.containersByTop).toEqual(['Echo 1: prom', 'Echo 2: prom', 'Echo 3: prom'])
    expect(l.turnsByTop).toEqual(['prompt 1: wh', 'prompt 2: wh', 'prompt 3: wh'])
  })
})
