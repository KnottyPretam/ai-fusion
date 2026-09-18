// desktop/test/adapters/observe.spec.js — Stage 2 capture against the fake site (project `adapters`):
// the `observe` op (done by done-selector / stop-gone / quiet, the rewinding stream, timeout with a
// partial, reply_not_found, a blocked session mid-reply, cancel, busy), `?reply=json` (the
// planted_factual texts, verbatim), an end signal that lands before the last render (?doneLagMs), a
// second assistant container mid-observe (?twoTurns), `snapshot` (passes the fixture lint), the
// `config` re-merge and `ready` after a loadURL to /c/<id>. The real desktop/preload/site.cjs is
// injected through the fake IPC exactly as in adapter.spec.js (see _harness.js).
//
// S7 review adds the chatgpt placeholder-then-remount lifecycle and its placeholder chat url, both
// MEASURED live on chatgpt.com on 2026-09-17 and replayed by the fake site's ?remountMs /
// ?placeholderMs / ?webUrlMs — see the describe block near the end of this file.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { DEFAULT_SELECTORS, SLOTS, SNAPSHOT_KEEP_ATTRS, TRICKY, open, request, fake, replyState, ipcState, withOverride } from './_harness.js'
import { lintText } from '../unit/preload/_fixture-lint.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCENARIO = path.resolve(HERE, '..', '..', '..', 'backend', 'llm', 'fixtures', 'scenarios', 'planted_factual')

/** The assembled `content` of a planted_factual fixture (raw OpenRouter chunks, one JSON object per line). */
function fixtureText(name) {
  let out = ''
  for (const line of fs.readFileSync(path.join(SCENARIO, name), 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const chunk = JSON.parse(line)
    for (const choice of chunk.choices || []) if (choice.delta && typeof choice.delta.content === 'string') out += choice.delta.content
  }
  return out
}
const fenced = (json) => '```json\n' + json + '\n```'

/** The per-site stop button (selectors v2 `stop`, first entry) and the done signal each site ends on. */
const STOP = { chatgpt: DEFAULT_SELECTORS.chatgpt.stop[0], claude: DEFAULT_SELECTORS.claude.stop[0], grok: DEFAULT_SELECTORS.grok.stop[0] }
const DONE_BY = { chatgpt: 'done_selector', claude: 'stop_gone', grok: 'stop_gone' }
const CHATGPT_DONE = DEFAULT_SELECTORS.chatgpt.done[0]

/** A reply long enough that a partial taken a few hundred ms into a multi-second stream is non-empty. */
const LONG = 'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly. '.repeat(4).trim()

function expectObserved(res, text, doneBy) {
  expect(res).toMatchObject({ ok: true, op: 'observe', text, doneBy })
  expect(res.text).toBe(text) // exactly — no trim, no accumulation
  expect(Number.isInteger(res.ms)).toBe(true)
  expect(res.ms).toBeGreaterThanOrEqual(0)
  expect(res.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  expect(Object.keys(res).sort()).toEqual(['doneBy', 'ms', 'ok', 'op', 'reqId', 'text', 'url'])
}

function expectPartialOf(res, full) {
  expect(typeof res.partial).toBe('string')
  expect(res.partial.length).toBeGreaterThan(0)
  expect(res.partial.length).toBeLessThan(full.length)
  expect(full.startsWith(res.partial)).toBe(true) // a rewound prefix is still a prefix
}

for (const site of SLOTS) {
  const sel = DEFAULT_SELECTORS[site]

  test.describe(site, () => {
    test(`observe after insertAndSubmit returns exactly Echo: <text>; done by ${DONE_BY[site]}; health sees the stop button while streaming and the reply afterwards`, async ({ page }) => {
      await open(page, { site, replyMs: 2000 })
      const sent = await request(page, { op: 'insertAndSubmit', text: TRICKY })
      expect(sent).toMatchObject({ ok: true, op: 'insertAndSubmit', submitted: true })
      await expect(page.locator(STOP[site])).toHaveCount(1) // streaming: the stop button holds the send slot
      const streaming = await request(page, { op: 'health' })
      expect(streaming.health).toMatchObject({ stop: true, reply: true, session: 'ok', matched: { stop: sel.stop[0], reply: sel.assistant[0] } })
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, 'Echo: ' + TRICKY, DONE_BY[site])
      const r = await replyState(page)
      expect(r.done).toBe(true)
      expect(r.replyText).toBe('Echo: ' + TRICKY)
      await expect(page.locator(STOP[site])).toHaveCount(0)
      if (site === 'chatgpt') await expect(page.locator(CHATGPT_DONE)).toHaveCount(1)
      expect((await request(page, { op: 'ready', timeoutMs: 2000 })).ok).toBe(true)
      const after = await request(page, { op: 'health' })
      expect(after.health).toMatchObject({ reply: true, stop: false, session: 'ok', matched: { reply: sel.assistant[0], stop: null } })
    })

    test('?nostop=1 (+ ?nodone=1): no stop button and no marker — the reply is done once its text is quiet for quietMs', async ({ page }) => {
      await open(page, { site, replyMs: 500, nostop: 1, nodone: 1, selectors: withOverride(site, { quietMs: 400 }) })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'quiet please' })
      expect(sent.ok).toBe(true)
      await expect(page.locator(STOP[site])).toHaveCount(0)
      const t0 = Date.now()
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, 'Echo: quiet please', 'quiet')
      expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
      if (site === 'chatgpt') await expect(page.locator(CHATGPT_DONE)).toHaveCount(0)
    })

    test('?reply=json with replyMs=0: an instant reply is captured at once', async ({ page }) => {
      await open(page, { site, reply: 'json', replyMs: 0 })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'plain question, no key' })
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, quietMs: 300 })
      expectObserved(res, 'Echo: plain question, no key', site === 'chatgpt' ? 'done_selector' : 'quiet')
    })
  })
}

test('the rewinding stream (periodic full re-render) yields the final text exactly once', async ({ page }) => {
  await open(page, { site: 'claude', replyMs: 1500 })
  const sent = await request(page, { op: 'insertAndSubmit', text: LONG })
  const res = await request(page, { reqId: 'obs-1', op: 'observe', baselineCount: sent.assistantCount })
  expectObserved(res, 'Echo: ' + LONG, 'stop_gone')
  const r = await replyState(page)
  expect(r.rewinds).toBeGreaterThan(0) // the text went backwards at least once while it streamed
  expect(r.renders).toBeGreaterThan(5)
  const answers = (await ipcState(page)).results.filter((x) => x.reqId === 'obs-1')
  expect(answers).toHaveLength(1) // one answer, the final text — never a partial, never a concatenation
  expect(answers[0].text).toBe('Echo: ' + LONG)
})

test('replyMs > captureTimeoutMs → timeout carrying the partial text (a prefix of the reply); a message-level timeoutMs overrides the selector', async ({ page }) => {
  await open(page, { site: 'chatgpt', replyMs: 8000, selectors: withOverride('chatgpt', { captureTimeoutMs: 900 }) })
  const sent = await request(page, { op: 'insertAndSubmit', text: LONG })
  const full = 'Echo: ' + LONG
  const t0 = Date.now()
  const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
  expect(res).toMatchObject({ ok: false, op: 'observe', code: 'timeout' })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  expect(res.message).toMatch(/900 ms/)
  expectPartialOf(res, full)
  const t1 = Date.now()
  const again = await request(page, { op: 'observe', baselineCount: sent.assistantCount, timeoutMs: 400 })
  expect(again).toMatchObject({ ok: false, op: 'observe', code: 'timeout' })
  expect(again.message).toMatch(/400 ms/)
  expect(Date.now() - t1).toBeGreaterThanOrEqual(400)
  expect(Date.now() - t1).toBeLessThan(900)
  expectPartialOf(again, full)
  expect(again.partial.length).toBeGreaterThanOrEqual(res.partial.length - Math.ceil(res.partial.length * 0.5)) // later, modulo a rewind
})

test('observe with no reply within firstTokenMs answers reply_not_found without a partial', async ({ page }) => {
  await open(page, { site: 'chatgpt', selectors: withOverride('chatgpt', { firstTokenMs: 500 }) }) // no ?replyMs: the page never replies
  const sent = await request(page, { op: 'insertAndSubmit', text: 'nobody answers' })
  expect(sent.ok).toBe(true)
  const t0 = Date.now()
  const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
  expect(res).toMatchObject({ ok: false, op: 'observe', code: 'reply_not_found' })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(500)
  expect(res.message).toMatch(/500 ms/)
  expect('partial' in res).toBe(false)
  // the firstTokenMs in the message overrides the selector too, and is capped by the budget
  const t1 = Date.now()
  expect(await request(page, { op: 'observe', baselineCount: sent.assistantCount, firstTokenMs: 5000, timeoutMs: 300 })).toMatchObject({ code: 'reply_not_found' })
  expect(Date.now() - t1).toBeLessThan(2000)
})

test('observe on a page that already holds an assistant turn (thread=noise) waits for the NEW container beyond the baseline', async ({ page }) => {
  await open(page, { site: 'claude', thread: 'noise', replyMs: 600 })
  const sent = await request(page, { op: 'insertAndSubmit', text: 'after the noise' })
  expect(sent.assistantCount).toBe(1) // the noise article, sampled before the click
  const res = await request(page, { op: 'observe', baselineCount: 1 })
  expectObserved(res, 'Echo: after the noise', 'stop_gone')
  expect((await request(page, { op: 'health' })).health.session).toBe('ok') // the banner phrases inside the thread never block
})

test.describe('?reply=json', () => {
  const EXTRACTION = fenced(fixtureText('analyst.extraction.1.jsonl'))
  const CONVERGENCE = fenced(fixtureText('analyst.convergence.1.jsonl'))
  const DEFENSE = Object.fromEntries(SLOTS.map((s) => [s, fenced(fixtureText(`${s}.defense.1.jsonl`))]))

  // Stage 3: the fake site renders the fence as REAL code-block chrome (a header carrying the
  // language, a Copy button, the body in <pre><code>) — inside the <pre> on chatgpt, before it on
  // claude and grok, and with no language class at all on grok. `toMarkdown` rebuilds the fence
  // from that DOM, so the captured text is the fenced JSON, byte for byte, with no chrome in it.
  for (const site of SLOTS) {
    test(`${site}: the reply is rendered as a code block with a header and a Copy button; observe returns the fenced JSON verbatim, with none of the chrome`, async ({ page }) => {
      await open(page, { site, reply: 'json', replyMs: 200 })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'Decide which divergences are resolved.\n<<<DIVERGENCES>>>\n[{"id": "d1"}]\n<<<END DIVERGENCES>>>' })
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, CONVERGENCE, DONE_BY[site])
      // the page really rendered chrome, not text: a <pre>, a <code>, the language label and a copy button
      const container = DEFAULT_SELECTORS[site].assistant[0]
      await expect(page.locator(`${container} pre`)).toHaveCount(1)
      await expect(page.locator(`${container} code`)).toHaveCount(1)
      await expect(page.locator(`${container} .code-header`)).toContainText('json') // grok's header also holds its copy button
      expect(await page.locator(`${container} .md button`).count()).toBeGreaterThan(0)
      if (site === 'grok') await expect(page.locator(`${container} code[class]`)).toHaveCount(0) // the header is the only language clue
      else await expect(page.locator(`${container} code.language-json`)).toHaveCount(1)
      // the capture is the fence and nothing else — the chrome text IS in the container's innerText
      const shown = await replyState(page)
      expect(shown.replyText).toContain('Copy')
      expect(res.text).not.toContain('Copy')
      expect(res.text).toBe(CONVERGENCE)
      expect(JSON.parse(res.text.slice('```json\n'.length, -'\n```'.length)).statuses).toEqual([{ divergence_id: 'd1', status: 'resolved' }])
    })
  }

  test('chatgpt: <<<R1>>> → the Extraction, YOUR CLAIM → the DefenseReply (even with <<<R1>>> in the peer block), <<<DIVERGENCES>>> → the ConvergenceCheck, verbatim and fenced; no key → the echo', async ({ page }) => {
    await open(page, { site: 'chatgpt', reply: 'json', replyMs: 300 })
    const cases = [
      ['Compare the three responses.\n\n<<<R1>>>\nThe BMI088 gyroscope range is selectable up to 2000 deg/s.\n<<<END R1>>>\n<<<R2>>>\n1000 deg/s.\n<<<END R2>>>', EXTRACTION],
      ['<<<YOUR CLAIM>>>\nIts gyroscope tops out at 1000 deg/s.\n<<<END YOUR CLAIM>>>\n<<<R1>>>\nselectable up to 2000 deg/s\n<<<END R1>>>', DEFENSE.chatgpt],
      ['Decide which divergences are resolved.\n<<<DIVERGENCES>>>\n[{"id": "d1"}]\n<<<END DIVERGENCES>>>', CONVERGENCE],
      ['a plain question with no key', 'Echo: a plain question with no key'],
    ]
    for (const [prompt, expected] of cases) {
      const sent = await request(page, { op: 'insertAndSubmit', text: prompt })
      expect(sent.ok).toBe(true)
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, expected, 'done_selector')
    }
    expect((await fake(page)).submitted).toHaveLength(4)
    // the fenced bodies are the fixtures' JSON: they parse to the planted_factual shapes
    const body = (s) => JSON.parse(s.slice('```json\n'.length, -'\n```'.length))
    expect(body(EXTRACTION).divergences.map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(body(DEFENSE.chatgpt).stance).toBe('revise')
    expect(body(CONVERGENCE).statuses).toEqual([{ divergence_id: 'd1', status: 'resolved' }])
    expect(EXTRACTION.startsWith('```json\n{')).toBe(true)
    expect(EXTRACTION.endsWith('}\n```')).toBe(true)
  })

  for (const site of ['claude', 'grok']) {
    test(`${site}: YOUR CLAIM → this site's DefenseReply (${site}.defense.1), verbatim`, async ({ page }) => {
      await open(page, { site, reply: 'json', replyMs: 300 })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'Round 1 of 2.\n<<<YOUR CLAIM>>>\nselectable up to 2000 deg/s\n<<<END YOUR CLAIM>>>' })
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, DEFENSE[site], 'stop_gone')
      expect(JSON.parse(DEFENSE[site].slice('```json\n'.length, -'\n```'.length)).stance).toBe('defend')
    })
  }
})

test.describe('?reply=rich — a rendered markdown reply comes back as GFM (Stage 3 toMarkdown)', () => {
  /**
   * The fake site's CANNED_RICH, as the capture must read it back: the same markdown, with the link
   * flattened to its text (contract §3: a link renders as its text, the URL is dropped). Everything
   * else — the heading, the emphasis, the inline code, the two-level list, the GFM table and the
   * fenced block — round-trips through the DOM unchanged.
   */
  const RICH = [
    '## Gyroscope range',
    '',
    'The **BMI088** gyroscope selects its range through the `GYRO_RANGE` register, see the datasheet.',
    '',
    '- 2000 deg/s _default_',
    '  - 1000 deg/s',
    '  - 500 deg/s',
    '- 125 deg/s',
    '',
    '| Register | Value |',
    '| --- | --- |',
    '| GYRO_RANGE | 0x0F |',
    '| CHIP_ID | 0x1F |',
    '',
    '```json',
    '{"register": "0x0F", "max_dps": 2000}',
    '```',
  ].join('\n')

  for (const site of SLOTS) {
    test(`${site}: a reply with a heading, a nested list, a table, inline code, emphasis, a link and a code block comes back as GFM`, async ({ page }) => {
      await open(page, { site, reply: 'rich', replyMs: 400 })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'what is the gyroscope range?' })
      expect(sent.ok).toBe(true)
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, RICH, DONE_BY[site])
      // it really is a rendered document, not text: the blocks exist in the DOM
      const container = DEFAULT_SELECTORS[site].assistant[0]
      await expect(page.locator(`${container} h2`)).toHaveText('Gyroscope range')
      await expect(page.locator(`${container} ul > li`)).toHaveCount(4) // two top-level items + the two nested ones
      await expect(page.locator(`${container} ul ul > li`)).toHaveCount(2)
      await expect(page.locator(`${container} table th`)).toHaveCount(2)
      await expect(page.locator(`${container} table tbody tr`)).toHaveCount(2)
      await expect(page.locator(`${container} p code`)).toHaveText('GYRO_RANGE')
      await expect(page.locator(`${container} p strong`)).toHaveText('BMI088')
      await expect(page.locator(`${container} p em`)).toHaveCount(0) // the italic is in the list item
      await expect(page.locator(`${container} li em`)).toHaveText('default')
      // the link's URL was in the DOM and is NOT in the capture; its text is
      await expect(page.locator(`${container} a`)).toHaveAttribute('href', /example\.com/)
      expect(res.text).not.toContain('example.com')
      expect(res.text).toContain('see the datasheet.')
      // the source the site rendered carried the link syntax; the capture carries markdown
      const source = await page.evaluate(() => window.__fake.replySource())
      expect(source).toContain('](https://example.com/bmi088/datasheet.pdf)')
      expect(res.text).toBe(source.replace('[the datasheet](https://example.com/bmi088/datasheet.pdf)', 'the datasheet'))
    })
  }

  test('the rewinding stream never leaks a half-rendered document: one answer, the final GFM', async ({ page }) => {
    await open(page, { site: 'claude', reply: 'rich', replyMs: 1200 })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'rich and slow' })
    const res = await request(page, { reqId: 'rich-1', op: 'observe', baselineCount: sent.assistantCount })
    expectObserved(res, RICH, 'stop_gone')
    const r = await replyState(page)
    expect(r.rewinds).toBeGreaterThan(0) // the markdown was re-rendered from a shorter prefix at least once
    expect(r.renders).toBeGreaterThan(5)
    const answers = (await ipcState(page)).results.filter((x) => x.reqId === 'rich-1')
    expect(answers).toHaveLength(1)
    expect(answers[0].text).toBe(RICH)
  })
})

/**
 * ?reply=fidelity — ONE end-to-end guard for the S7 capture-fidelity fixes: a reply carrying a
 * paragraph, inline code that CONTAINS a backtick, a KaTeX formula (the accessible MathML copy with
 * its TeX annotation, hidden by clip, next to the aria-hidden glyph run), a nested list, a GFM table
 * and a fenced JSON block whose language sits in a header next to a Copy button and whose lines are
 * `div.cm-line` BLOCK elements. Every part has to come back — and the fenced body has to stay
 * JSON.parse-able, because that is what Analyze and Fusion read out of a captured reply.
 */
test.describe('?reply=fidelity — every capture-fidelity shape survives one observe (S7)', () => {
  /** The fake site's CANNED_FIDELITY: nothing in it is a link, so the capture must equal it verbatim. */
  const FIDELITY = [
    '## Capture fidelity',
    '',
    'The range register is `` `GYRO_RANGE` `` in prose, and the axis tolerance is $\\pm 0.5^\\circ$ at 25 C.',
    '',
    '- ranges',
    '  - 2000 deg/s',
    '  - 125 deg/s',
    '- registers',
    '',
    '| Register | Value |',
    '| --- | --- |',
    '| GYRO_RANGE | 0x0F |',
    '| CHIP_ID | 0x1F |',
    '',
    '```json',
    '{',
    '  "register": "0x0F",',
    '  "ranges": [2000, 125],',
    '  "note": "a ` backtick and a \\"quote\\" inside a string"',
    '}',
    '```',
  ].join('\n')
  const JSON_BODY = { register: '0x0F', ranges: [2000, 125], note: 'a ` backtick and a "quote" inside a string' }

  for (const site of SLOTS) {
    test(`${site}: the paragraph, the backtick-bearing inline code, the formula, the nested list, the table and the multi-line JSON fence all come back, and the fence still JSON.parses`, async ({ page }) => {
      await open(page, { site, reply: 'fidelity', replyMs: 400 })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'everything at once, please' })
      expect(sent.ok).toBe(true)
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, FIDELITY, DONE_BY[site])
      expect(res.text).toBe(await page.evaluate(() => window.__fake.replySource())) // verbatim, link-free

      // the DOM really carried the hard shapes (not markdown text dropped into the container)
      const container = DEFAULT_SELECTORS[site].assistant[0]
      await expect(page.locator(`${container} h2`)).toHaveText('Capture fidelity')
      await expect(page.locator(`${container} p code`)).toHaveText('`GYRO_RANGE`') // a backtick INSIDE the code span
      await expect(page.locator(`${container} .katex-mathml annotation`)).toHaveAttribute('encoding', 'application/x-tex')
      await expect(page.locator(`${container} .katex-html[aria-hidden="true"]`)).toHaveCount(1)
      await expect(page.locator(`${container} ul ul > li`)).toHaveCount(2)
      await expect(page.locator(`${container} table tbody tr`)).toHaveCount(2)
      await expect(page.locator(`${container} pre code div.cm-line`)).toHaveCount(5) // one BLOCK element per code line
      await expect(page.locator(`${container} pre`).first()).toBeVisible()
      // the code block's language header and its Copy button are on the page (chatgpt: inside the pre)
      const header = await page.locator(`${container} .code-header`).first().innerText() // grok's header also holds its Copy button
      expect(header.trim().split('\n')[0]).toBe('json')
      await expect(page.locator(`${container} button[aria-label^="Copy"]`).first()).toHaveCount(1)
      // the glyph run the reader sees is in the DOM and NOT in the capture: the TeX is there once
      expect(await page.locator(`${container} .katex-html`).innerText()).toContain('±')
      expect(res.text).not.toContain('±')
      expect(res.text.match(/\\pm/g)).toHaveLength(1)

      // what Analyze / Fusion do with a captured reply: parse the fenced body
      const fence = res.text.slice(res.text.indexOf('```json\n') + '```json\n'.length, res.text.lastIndexOf('\n```'))
      expect(fence.split('\n')).toHaveLength(5) // the lines survived the block elements
      expect(JSON.parse(fence)).toEqual(JSON_BODY)
    })
  }
})

test.describe('the end signal before the last render (?doneLagMs) and a second container mid-observe (?twoTurns)', () => {
  for (const site of SLOTS) {
    test(`${site}: ?doneLagMs=300 — the done marker / stop removal lands 300 ms before the last render; observe still returns the final text (${DONE_BY[site]})`, async ({ page }) => {
      await open(page, { site, replyMs: 1500, doneLagMs: 300 })
      const sent = await request(page, { op: 'insertAndSubmit', text: LONG })
      expect(sent.ok).toBe(true)
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, 'Echo: ' + LONG, DONE_BY[site])
      const r = await replyState(page)
      expect(r.done).toBe(true)
      expect(r.doneSignalAt).not.toBeNull()
      expect(r.lastRenderAt).toBeGreaterThan(r.doneSignalAt) // the site really rendered after its end signal
      expect(r.rendersAfterSignal).toBeGreaterThan(1) // several times, rewinds included
      expect(res.text).toBe(r.replyText)
      await expect(page.locator(STOP[site])).toHaveCount(0)
    })

    test(`${site}: ?twoTurns=1 — a finished tool container (marked done under the stop button), then the answer container: observe follows the LAST container and never ends on the tool turn`, async ({ page }) => {
      await open(page, { site, replyMs: 1200, twoTurns: 1 })
      const sent = await request(page, { op: 'insertAndSubmit', text: 'two turns' })
      expect(sent.ok).toBe(true)
      const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
      expectObserved(res, 'Echo: two turns', DONE_BY[site])
      expect(res.text).not.toContain('Searching')
      expect((await replyState(page)).containers).toBe(2)
      await expect(page.locator(DEFAULT_SELECTORS[site].assistant[0])).toHaveCount(2)
      if (site === 'chatgpt') await expect(page.locator(CHATGPT_DONE)).toHaveCount(2) // the tool turn's marker was up the whole time
      expect((await request(page, { op: 'ready', timeoutMs: 2000 })).ok).toBe(true)
    })
  }
})

/**
 * The chatgpt placeholder-then-remount lifecycle, MEASURED live on chatgpt.com with a real logged-in
 * session on 2026-09-17 and replayed by the fake site's ?remountMs / ?placeholderMs / ?webUrlMs:
 *   ~1 s   a SHORT placeholder assistant turn (~12 characters, no `.markdown` child) under a visible
 *          button[data-testid="stop-button"] (aria-label "Stop answering")
 *   ~2 s   the placeholder is UNMOUNTED — `[data-message-author-role="assistant"]` returns ZERO for
 *          roughly 10 s — while the stop button stays visible
 *   ~13 s  the real reply container is mounted, `.markdown` child and all
 *   ~14 s  the stop button goes and a second copy-turn-action-button appears
 * plus a PLACEHOLDER chat url `/c/WEB:<uuid>` that is only later replaced by the real `/c/<uuid>`.
 *
 * What the capture must do, and what these tests pin: drop a container that is no longer connected
 * (holding the detached placeholder freezes the text and makes `done` unmatchable, so the capture could
 * only ever end by timeout on the placeholder's text), apply the first-token deadline only until a
 * container has been seen ONCE (a later gap is a re-render, bounded by the overall budget) and report a
 * url the tightened `chatUrlPattern` accepts — the placeholder url matches nothing, so main never
 * records a link that 404s.
 */
test.describe('the chatgpt placeholder-then-remount lifecycle (measured live 2026-09-17)', () => {
  const ASSISTANT = DEFAULT_SELECTORS.chatgpt.assistant[0]
  const MARKDOWN = DEFAULT_SELECTORS.chatgpt.assistantText[0]

  test('observe waits through the gap and returns the REAL reply, never the placeholder; the stop button is never dropped in between', async ({ page }) => {
    await open(page, { site: 'chatgpt', replyMs: 500, placeholderMs: 300, remountMs: 900 })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'after the remount' })
    expect(sent).toMatchObject({ ok: true, submitted: true })
    const t0 = Date.now()
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expectObserved(res, 'Echo: after the remount', 'done_selector')
    const r = await replyState(page)
    expect(r.placeholderText).toBe('Placeholder…')
    expect(res.text).not.toContain(r.placeholderText) // the short placeholder turn is not the answer
    expect(r.containers).toBe(2) // the placeholder, then the real reply
    expect(r.remountedAt).toBeGreaterThan(t0) // the real container mounted only AFTER observe began
    expect(r.remountedAt - r.placeholderGoneAt).toBeGreaterThanOrEqual(800) // it waited out the whole gap
    expect(res.ms).toBeGreaterThanOrEqual(900)
    expect(r.stopEvents.map((e) => e.on)).toEqual([true, false]) // up before the placeholder, down at the end
    await expect(page.locator(ASSISTANT)).toHaveCount(1)
    await expect(page.locator(CHATGPT_DONE)).toHaveCount(1)
  })

  test('a gap LONGER than firstTokenMs still succeeds: the deadline only applies until a container has been seen once', async ({ page }) => {
    await open(page, { site: 'chatgpt', replyMs: 300, placeholderMs: 800, remountMs: 1200, selectors: withOverride('chatgpt', { firstTokenMs: 500 }) })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'a gap longer than the deadline' })
    expect(sent.assistantCount).toBe(0)
    await expect(page.locator(ASSISTANT)).toHaveCount(1) // the placeholder is up: observe starts with a container in view
    await expect(page.locator(ASSISTANT).locator(MARKDOWN)).toHaveCount(0) // …and it carries no `.markdown` child
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expectObserved(res, 'Echo: a gap longer than the deadline', 'done_selector')
    const r = await replyState(page)
    expect(r.remountedAt - r.placeholderGoneAt).toBeGreaterThanOrEqual(500) // the gap really outlasted firstTokenMs
    expect(r.containers).toBe(2)
    expect(res.text).not.toContain(r.placeholderText)
  })

  test('a page that NEVER mounts a container still fails reply_not_found within firstTokenMs (lifting the deadline after a container was seen did not disable it)', async ({ page }) => {
    await open(page, { site: 'chatgpt', selectors: withOverride('chatgpt', { firstTokenMs: 600 }) }) // no reply options: nothing ever mounts
    const sent = await request(page, { op: 'insertAndSubmit', text: 'nobody answers' })
    const t0 = Date.now()
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expect(res).toMatchObject({ ok: false, op: 'observe', code: 'reply_not_found' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600)
    expect(res.message).toMatch(/600 ms/)
    expect('partial' in res).toBe(false)
    expect((await replyState(page)).containers).toBe(0)
  })

  test('a placeholder that never comes back is bounded by the BUDGET: timeout (never reply_not_found, never a wait for the remount), its partial the placeholder text', async ({ page }) => {
    // the remount is 20 s away and the budget is 1.2 s: the capture must answer at the budget
    await open(page, { site: 'chatgpt', replyMs: 200, placeholderMs: 700, remountMs: 20000, selectors: withOverride('chatgpt', { firstTokenMs: 500 }) })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'gone for good' })
    await expect(page.locator(ASSISTANT)).toHaveCount(1) // the placeholder, seen before it is unmounted
    const t0 = Date.now()
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount, timeoutMs: 1200 })
    expect(res).toMatchObject({ ok: false, op: 'observe', code: 'timeout' })
    expect(res.message).toMatch(/1200 ms/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1200)
    expect(Date.now() - t0).toBeLessThan(6000) // and NOT 20 s: a gap with no container is still bounded
    const r = await replyState(page)
    expect(res.partial).toBe(r.placeholderText) // the last text that was on the page — a partial, with an error
    expect(r.remountedAt).toBeNull()
    await expect(page.locator(ASSISTANT)).toHaveCount(0)
  })

  test('the lifecycle composes with ?reply=json + ?doneLagMs: the fenced JSON comes back verbatim after the gap', async ({ page }) => {
    await open(page, { site: 'chatgpt', reply: 'json', replyMs: 900, placeholderMs: 300, remountMs: 700, doneLagMs: 300 })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'YOUR CLAIM: the gyroscope tops out at 1000 deg/s' })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expect(res).toMatchObject({ ok: true, op: 'observe', doneBy: 'done_selector' })
    const defense = fenced(fixtureText('chatgpt.defense.1.jsonl'))
    expect(res.text).toBe(defense)
    const r = await replyState(page)
    expect(r.rendersAfterSignal).toBeGreaterThan(1) // the end signal landed before the last render, as under ?doneLagMs alone
    expect(r.containers).toBe(2)
    expect(JSON.parse(res.text.replace(/^```json\n/, '').replace(/\n```$/, '')).stance).toBe('revise')
  })

  test('the lifecycle composes with ?nostop=1 + ?nodone=1: quiet detection settles on the REAL text, and the gap never reads as quiet', async ({ page }) => {
    await open(page, {
      site: 'chatgpt',
      replyMs: 300,
      placeholderMs: 200,
      remountMs: 900,
      nostop: 1,
      nodone: 1,
      selectors: withOverride('chatgpt', { quietMs: 500 }), // > placeholderMs: a placeholder sitting still is not "quiet"
    })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'quiet after the gap' })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expectObserved(res, 'Echo: quiet after the gap', 'quiet')
    const r = await replyState(page)
    expect(r.stopEvents).toEqual([]) // ?nostop=1: there was never a stop button to see
    expect(res.text).not.toContain(r.placeholderText)
    await expect(page.locator(CHATGPT_DONE)).toHaveCount(0)
  })

  test("a STALE baseline never turns an earlier turn into this reply: with ?thread=noise the gap waits for the real container instead of settling on the previous answer", async ({ page }) => {
    // ?nostop=1 + ?nodone=1 so the capture is on quiet detection — the state in which a container that
    // is not this turn's reply settles as the answer. quietMs (400) is longer than placeholderMs (200),
    // so the placeholder itself is never "quiet", and shorter than the gap (900), so picking the
    // pre-existing noise answer during the gap WOULD settle: the reply has to be chosen by node
    // identity (the noise container was on the page before this observe started), not by the count.
    await open(page, {
      site: 'chatgpt',
      thread: 'noise',
      replyMs: 300,
      placeholderMs: 200,
      remountMs: 900,
      nostop: 1,
      nodone: 1,
      selectors: withOverride('chatgpt', { quietMs: 400 }),
    })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'after the noise, through the gap' })
    expect(sent.assistantCount).toBe(1) // the noise answer, sampled before the click
    // main's baseline is STALE — 0 while the page holds the noise container (the site unmounts turns
    // mid-turn, so the sample taken at the submit can be behind what is on the page)
    const res = await request(page, { op: 'observe', baselineCount: 0, quietMs: 400 })
    expectObserved(res, 'Echo: after the noise, through the gap', 'quiet')
    expect(res.text).not.toContain('rate limit') // the noise answer's own text, never this reply
    expect(res.text).not.toContain('Unusual activity')
    const r = await replyState(page)
    expect(res.text).not.toContain(r.placeholderText)
    expect(r.containers).toBe(2) // the placeholder, then the real reply
    expect(r.remountedAt - r.placeholderGoneAt).toBeGreaterThanOrEqual(800) // it waited out the whole gap
    await expect(page.locator(ASSISTANT)).toHaveCount(2) // the noise turn is still there, and still not the answer
    expect((await request(page, { op: 'health' })).health.session).toBe('ok')
  })

  test('the recorded chat url: the placeholder /c/WEB:<uuid> matches no tightened chatUrlPattern, and the url the adapter reports after the capture is the REAL /c/<uuid>', async ({ page }) => {
    // the shape of DEFAULT_SELECTORS.chatgpt.chatUrlPattern (the id ends at the segment), pointed at the fake site
    const PATTERN = '^http://127\\.0\\.0\\.1:\\d+/c/[A-Za-z0-9-]+(?:[?#]|$)'
    await open(page, { site: 'chatgpt', replyMs: 1500, webUrlMs: 400, selectors: withOverride('chatgpt', { chatUrlPattern: PATTERN }) })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'mint a chat id' })
    expect(sent.ok).toBe(true)
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expect(res).toMatchObject({ ok: true, op: 'observe', doneBy: 'done_selector' })
    const { urls } = await replyState(page)
    expect(urls.map((u) => u.how)).toEqual(['push', 'replace'])
    const re = new RegExp(PATTERN)
    expect(new URL(urls[0].href).pathname).toContain('/c/WEB:')
    expect(re.test(urls[0].href)).toBe(false) // main records only matching urls: the placeholder is never one
    expect(re.test(urls[1].href)).toBe(true)
    expect(res.url).toBe(urls[1].href) // what the adapter reports after the capture is the real chat url
    expect(res.url).not.toContain('WEB:')
    expect(page.url()).toBe(urls[1].href)
    // the same rule on the real pattern, verbatim from the defaults
    const real = new RegExp(DEFAULT_SELECTORS.chatgpt.chatUrlPattern)
    const uuid = new URL(urls[1].href).pathname.replace('/c/', '')
    expect(real.test(`https://chatgpt.com/c/WEB:${uuid}`)).toBe(false)
    expect(real.test(`https://chatgpt.com/c/${uuid}`)).toBe(true)
    // and the placeholder url is not a chat at all: revisiting it 404s (chatgpt.com sends you home)
    expect((await page.request.get(new URL(urls[0].href).pathname)).status()).toBe(404)
  })
})

test('a second submit (and a snapshot) while observe is in flight answers busy; the observe still completes', async ({ page }) => {
  await open(page, { site: 'claude', replyMs: 1500 })
  const sent = await request(page, { op: 'insertAndSubmit', text: 'first' })
  const [obs, second, third] = await page.evaluate(async (baseline) => {
    const ipc = window.__triplexFakeIpc
    const p1 = ipc.request({ reqId: 'obs', op: 'observe', baselineCount: baseline })
    const p2 = ipc.request({ reqId: 'second', op: 'insertAndSubmit', text: 'second' })
    const p3 = ipc.request({ reqId: 'third', op: 'snapshot' })
    return Promise.all([p1, p2, p3])
  }, sent.assistantCount)
  expect(second).toMatchObject({ reqId: 'second', ok: false, op: 'insertAndSubmit', code: 'busy' })
  expect(second.message).toContain('observe')
  expect(third).toMatchObject({ reqId: 'third', ok: false, op: 'snapshot', code: 'busy' })
  expectObserved(obs, 'Echo: first', 'stop_gone')
  expect((await fake(page)).submitted).toEqual(['first']) // 'second' never reached the page
  expect((await request(page, { op: 'ready', timeoutMs: 1000 })).ok).toBe(true)
})

for (const site of ['chatgpt', 'claude']) {
  const phrase = DEFAULT_SELECTORS[site].errorText[0]
  test(`${site}: a blocked session mid-observe (?blockAfterMs) answers site_error carrying ONLY the configured phrase "${phrase}"`, async ({ page }) => {
    await open(page, { site, replyMs: 4000, blockAfterMs: 500 })
    const sent = await request(page, { op: 'insertAndSubmit', text: 'my prompt must not be echoed into the error: ' + LONG })
    const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
    expect(res).toMatchObject({ ok: false, op: 'observe', code: 'site_error' })
    expect(res.message).toBe(phrase) // never the banner's own text ("from your device…"), never the prompt
    if ('partial' in res) expectPartialOf(res, 'Echo: my prompt must not be echoed into the error: ' + LONG)
    await expect(page.locator('[role=alert]')).toContainText('Unusual activity has been detected from your device')
    expect((await request(page, { op: 'health' })).health.session).toBe('blocked')
    expect((await request(page, { op: 'ready', timeoutMs: 300 })).code).toBe('blocked')
    expect((await request(page, { op: 'insertAndSubmit', text: 'never typed' })).code).toBe('blocked')
    expect((await fake(page)).submitted).toHaveLength(1)
  })
}

test('cancel{target} during observe answers cancelled with the partial text and frees the slot', async ({ page }) => {
  await open(page, { site: 'grok', replyMs: 4000 })
  const sent = await request(page, { op: 'insertAndSubmit', text: LONG })
  const [obs, cancel] = await page.evaluate(async (baseline) => {
    const ipc = window.__triplexFakeIpc
    const p1 = ipc.request({ reqId: 'obs', op: 'observe', baselineCount: baseline })
    await new Promise((r) => setTimeout(r, 700))
    const p2 = ipc.request({ reqId: 'c', op: 'cancel', target: 'obs' })
    return Promise.all([p1, p2])
  }, sent.assistantCount)
  expect(cancel).toEqual({ reqId: 'c', ok: true, op: 'cancel', cancelled: true })
  expect(obs).toMatchObject({ reqId: 'obs', ok: false, op: 'observe', code: 'cancelled' })
  expectPartialOf(obs, 'Echo: ' + LONG)
  // the slot is free and the reply is still streaming: a fresh observe completes it
  const again = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
  expectObserved(again, 'Echo: ' + LONG, 'stop_gone')
})

test('config hot reload re-merges onto the defaults: a v1-shaped config (no v2 keys) keeps the stop cascade, so observe still ends stop_gone and health.stop is a boolean', async ({ page }) => {
  await open(page, { site: 'claude', replyMs: 1200 })
  const V1_KEYS = ['chatUrlPattern', 'composer', 'send', 'loggedOut', 'loggedOutUrl', 'challenge', 'challengeTitle', 'errorText', 'composerWaitMs', 'sendWaitMs', 'submitVerifyMs']
  const v1Only = Object.fromEntries(V1_KEYS.map((k) => [k, DEFAULT_SELECTORS.claude[k]]))
  const before = (await ipcState(page)).results.length
  await page.evaluate((selectors) => window.__triplexFakeIpc.emit('triplex:adapter', { op: 'config', selectors }), { version: 1, claude: { ...v1Only, composerWaitMs: 4321 } })
  expect((await ipcState(page)).results.length).toBe(before) // no reply to config
  const h = await request(page, { op: 'health' })
  expect(h.health).toMatchObject({ composer: true, stop: false, reply: false, session: 'ok', matched: { stop: null, reply: null } })
  const sent = await request(page, { op: 'insertAndSubmit', text: 'after the reload' })
  await expect(page.locator(STOP.claude)).toHaveCount(1)
  expect((await request(page, { op: 'health' })).health).toMatchObject({ stop: true, matched: { stop: STOP.claude } })
  const res = await request(page, { op: 'observe', baselineCount: sent.assistantCount })
  expectObserved(res, 'Echo: after the reload', 'stop_gone')
  // an override that empties stop + done switches the site to quiet detection
  await page.evaluate((selectors) => window.__triplexFakeIpc.emit('triplex:adapter', { op: 'config', selectors }), withOverride('claude', { stop: [], done: [], quietMs: 300 }))
  expect((await request(page, { op: 'health' })).health).toMatchObject({ stop: null, matched: { stop: null } })
  const sent2 = await request(page, { op: 'insertAndSubmit', text: 'quiet now' })
  expectObserved(await request(page, { op: 'observe', baselineCount: sent2.assistantCount }), 'Echo: quiet now', 'quiet')
})

test('snapshot: the scrubbed DOM passes the fixture lint, keeps structure and the selector attributes, and carries no text', async ({ page }) => {
  const prompt = 'contact someone@example.com about https://x.com/someone and /c/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d'
  await open(page, { site: 'chatgpt', thread: 'noise', replyMs: 0 })
  const sent = await request(page, { op: 'insertAndSubmit', text: prompt })
  expect((await request(page, { op: 'observe', baselineCount: sent.assistantCount })).ok).toBe(true)
  const res = await request(page, { op: 'snapshot' })
  expect(res).toMatchObject({ ok: true, op: 'snapshot' })
  expect(Object.keys(res).sort()).toEqual(['html', 'ok', 'op', 'reqId'])
  const html = res.html
  expect(html.startsWith('<!doctype html>\n<html')).toBe(true)
  expect(html.endsWith('</html>\n')).toBe(true)
  expect(lintText(html)).toEqual([])
  for (const s of ['Echo', 'someone', 'example.com', 'rate limit', 'Fake site', 'ChatGPT', '<script', '<style', '<link', '<meta', 'href=', 'src=', 'data-virtualkeyboard', 'data-placeholder', 'style=', 'lang=']) {
    expect(html).not.toContain(s)
  }
  for (const s of [
    '<title>…</title>',
    'id="prompt-textarea"',
    'class="ProseMirror',
    'contenteditable="true"',
    'translate="no"',
    'data-testid="send-button"',
    'aria-label="Send prompt"',
    'type="submit"',
    'data-message-author-role="user"',
    'data-message-author-role="assistant"',
    'class="markdown"',
    'data-testid="copy-turn-action-button"',
  ]) {
    expect(html).toContain(s)
  }
  // only the allowed attributes survive, and nothing but the placeholder stands between the tags
  const attrs = new Set([...html.matchAll(/ ([a-z-]+)="/g)].map((m) => m[1]))
  expect(attrs.size).toBeGreaterThan(5)
  for (const a of attrs) expect(SNAPSHOT_KEEP_ATTRS).toContain(a)
  const between = html.replace('<!doctype html>\n', '').replace(/<[^>]+>/g, '')
  expect(between.replace(/…/g, '').trim()).toBe('')
  expect((html.match(/…/g) || []).length).toBeGreaterThan(3) // title, header, the messages, the buttons
})

test('ready waits for the composer after a loadURL to /c/<id> (the page mounts late); a further loadURL re-boots the preload', async ({ page }) => {
  await open(page, { site: 'grok', state: 'slow', path: '/c/1a2b3c4d5e6f7a8b' })
  const h = await request(page, { op: 'health' })
  expect(h.health).toMatchObject({ composer: false, session: 'unknown' })
  expect(h.health.url).toContain('/c/1a2b3c4d5e6f7a8b')
  const t0 = Date.now()
  const ready = await request(page, { op: 'ready', timeoutMs: 8000 })
  expect(ready).toMatchObject({ ok: true, op: 'ready', composerSelector: DEFAULT_SELECTORS.grok.composer[0] })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2000)
  expect((await request(page, { op: 'health' })).health).toMatchObject({ composer: true, session: 'ok' })
  // another chat: the preload boots again (adapter:config asked once more) and ready is immediate on a mounted page
  await page.goto('/c/ffffeeeeddddcccc?site=grok')
  expect((await ipcState(page)).invoked.filter((i) => i.channel === 'adapter:config')).toHaveLength(1)
  expect((await request(page, { op: 'ready', timeoutMs: 2000 })).ok).toBe(true)
  expect((await request(page, { op: 'health' })).health.url).toContain('/c/ffffeeeeddddcccc')
})
