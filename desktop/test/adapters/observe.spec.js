// desktop/test/adapters/observe.spec.js — Stage 2 capture against the fake site (project `adapters`):
// the `observe` op (done by done-selector / stop-gone / quiet, the rewinding stream, timeout with a
// partial, reply_not_found, a blocked session mid-reply, cancel, busy), `?reply=json` (the
// planted_factual texts, verbatim), an end signal that lands before the last render (?doneLagMs), a
// second assistant container mid-observe (?twoTurns), `snapshot` (passes the fixture lint), the
// `config` re-merge and `ready` after a loadURL to /c/<id>. The real desktop/preload/site.cjs is
// injected through the fake IPC exactly as in adapter.spec.js (see _harness.js).

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
