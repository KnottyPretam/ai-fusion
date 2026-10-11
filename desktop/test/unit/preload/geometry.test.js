// desktop/test/unit/preload/geometry.test.js — reply adjacency by GEOMETRY (2026-10-11), offline.
//
// Measured that day from a plain Send on a FRESH grok.com chat (fixture `grok-oct11-fresh`, README): the chat's
// user row and assistant row sat in the scroller's absolutely positioned slots in OLDEST-first document order,
// where the 58-row chat of 2026-09-27 (`grok-virtualized`) read newest-first — grok.com's virtualizer reuses a
// POOL of slots and places rows by transform, so document order carries no transcript order at all. Under
// `transcriptOrder: 'newest-first'` rule (b) of `containerForAnchor` stepped BACKWARDS from the anchor, found
// nothing, and the capture waited 90 s for a 6,865-character reply that was already there (`reply_not_found`,
// `containers=1 anchor=1 order=newest presubmit=0 … maxContainer=6865`). Pinned here, on the unit DOM's
// `data-rect="top,height"` layout stand-in (_dom.js): rule (b) reads the laid-out positions first — the reply is
// the lowest row below the prompt, bounded by the next prompt — `newestOf` likewise, zero or missing rects fall
// back to the DOM step, the anchored-but-no-container case falls through to the identity + text rule instead of
// waiting, the diag's `geom` field, and the failure itself on the fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FIXTURES_DIR } from './_fixture-lint.js'
import { parseHtml, parseFragment } from './_dom.js'

const require = createRequire(import.meta.url)
const { createAdapter, DEFAULT_SELECTORS, mergeSelectors } = require('../../../preload/site.cjs')

const S = DEFAULT_SELECTORS
const FOLLOWING = 4
const fixture = (name) => parseHtml(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.html`), 'utf8'))

/** Parse a snippet, re-own it onto `doc` and mount it (appended, or before `before`) so `isConnected` is true. */
function mount(doc, parent, html, before = null) {
  const node = parseFragment(html)
  const own = (n) => {
    n.ownerDocument = doc
    for (const c of n.childNodes || []) own(c)
  }
  own(node)
  if (before) parent.insertBefore(node, before)
  else parent.appendChild(node)
  return node
}

function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map()
  const timers = {
    setTimeout(fn, ms) {
      const id = ++seq
      pending.set(id, { at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
  }
  const advance = async (ms) => {
    const target = now + ms
    for (;;) {
      let next = null
      for (const [id, t] of pending) if (t.at <= target && (next === null || t.at < pending.get(next).at)) next = id
      if (next === null) break
      const timer = pending.get(next)
      pending.delete(next)
      now = Math.max(now, timer.at)
      timer.fn()
      await Promise.resolve()
      await Promise.resolve()
    }
    now = target
    await Promise.resolve()
  }
  return { now: () => now, timers, advance, pending: () => pending.size }
}

const settled = (promise) => {
  const out = { done: false, value: null, error: null }
  promise.then(
    (v) => {
      out.done = true
      out.value = v
    },
    (e) => {
      out.done = true
      out.error = e
    },
  )
  return out
}

const CLAUDE_PAGE = `<html><head><title>Claude</title></head><body><div id="app"><main class="thread"></main><form><div contenteditable="true" class="ProseMirror" role="textbox"><p></p></div><button aria-label="Stop response">Stop</button></form></div></body></html>`
const CHATGPT_PAGE = `<html><head><title>ChatGPT</title></head><body><div id="app"><main class="thread"></main><form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"><p></p></div><button data-testid="stop-button" aria-label="Stop answering">Stop</button></form></div></body></html>`
const GROK_PAGE = `<html><head><title>Grok</title></head><body><div id="app"><main class="thread" data-testid="chat-transcript-scroller"></main><form><div class="tiptap ProseMirror" contenteditable="true" role="textbox" aria-label="Ask Grok anything"><p></p></div><button aria-label="Stop">Stop</button></form></div></body></html>`
/** A claude-shaped user turn / reply row, laid out at `rect` ("top,height") when given — the unit DOM's only layout; null / undefined = no rect. */
const rectAttr = (rect) => (rect === undefined || rect === null ? '' : ` data-rect="${rect}"`)
const user = (text, rect) => `<div data-testid="user-message"${rectAttr(rect)}><p class="whitespace-pre-wrap">${text}</p></div>`
const reply = (text, rect) => `<div class="font-claude-response"${rectAttr(rect)}><div class="prose"><p>${text}</p></div></div>`
const article = (text, rect) => `<article data-message-author-role="assistant"${rectAttr(rect)}><div class="markdown">${text}</div></article>`
/** grok.com's rows (measured): every row is a `div[id^='response-']`; the user's bubble carries the SAME markdown class as a reply's. */
const grokUserRow = (text, rect) =>
  `<div id="response-u" class="relative group flex flex-col"${rectAttr(rect)}><div role="article" aria-label="You" data-testid="user-message" class="message-bubble relative"><div class="relative"><div class="response-content-markdown">${text}</div></div></div></div>`
const grokReplyRow = (text, rect) =>
  `<div id="response-a" class="relative group flex flex-col"${rectAttr(rect)}><div role="article" aria-label="Grok" data-testid="assistant-message" class="message-bubble relative"><div class="relative"><div class="response-content-markdown">${text}</div></div></div></div>`

function setup(page, site, extra = {}) {
  const doc = parseHtml(page)
  const clock = fakeClock()
  const selectors = mergeSelectors(DEFAULT_SELECTORS, extra).merged
  const adapter = createAdapter({ document: doc, site, selectors, now: clock.now, timers: clock.timers })
  const thread = doc.querySelector('main.thread')
  const stop = doc.querySelector('form button')
  return { doc, clock, adapter, thread, stop }
}

/** Three exchanges laid out top to bottom: U1 A1 U2 A2 U3 A3 — the rects are the transcript, the DOM order is the test's. */
const RECT = { U1: '0,40', A1: '50,100', U2: '160,40', A2: '210,100', U3: '320,40', A3: '370,100' }
/** `rect` undefined = the row's RECT; null = NO rect (the sentinel, so a default parameter never re-applies the layout). */
const ROW = (key, rect) => {
  const r = rect === undefined ? RECT[key] : rect
  return key[0] === 'U' ? user(`question ${key[1]} about the BMI088 gyroscope`, r) : reply(`Answer ${key[1]}.`, r)
}
const DOM_ORDERS = {
  'oldest-first DOM': ['U1', 'A1', 'U2', 'A2', 'U3', 'A3'],
  'newest-first DOM': ['A3', 'U3', 'A2', 'U2', 'A1', 'U1'],
  'shuffled DOM (user rows prepended, replies appended)': ['U3', 'U2', 'U1', 'A1', 'A2', 'A3'],
  'interleaved DOM (reply before its own prompt)': ['A1', 'U1', 'A2', 'U2', 'A3', 'U3'],
}
/** Mount `keys` in that document order; `rect(key)` overrides the laid-out rect (null = none). */
function page(site, keys, { rect = (k) => RECT[k], extra = {} } = {}) {
  const s = setup(site === 'chatgpt' ? CHATGPT_PAGE : CLAUDE_PAGE, site, extra)
  const nodes = {}
  for (const key of keys) nodes[key] = mount(s.doc, s.thread, ROW(key, rect(key)))
  return { ...s, nodes }
}

// ---- the layout stand-in itself ---------------------------------------------------------------------------

test('_dom.js: an element carrying data-rect answers getBoundingClientRect from it; one without has NO such method (not zeros — isVisible would hide every fixture); "0,0" is an explicit degenerate rect', () => {
  const doc = parseHtml('<html><body><div id="a" data-rect="160,40"></div><div id="b"></div><div id="z" data-rect="0,0"></div><button id="s" data-rect="0,0">x</button></body></html>')
  const a = doc.querySelector('#a').getBoundingClientRect()
  assert.deepEqual([a.top, a.height, a.bottom, a.width > 0], [160, 40, 200, true])
  assert.equal(typeof doc.querySelector('#b').getBoundingClientRect, 'undefined')
  const z = doc.querySelector('#z').getBoundingClientRect()
  assert.deepEqual([z.top, z.height, z.bottom, z.width], [0, 0, 0, 0])
  // the fixtures are scrubbed: none carries data-rect, so every fixture element reads as "no geometry"
  const fx = fixture('grok-oct11-fresh')
  assert.ok(fx.querySelectorAll('[data-rect]').length === 0)
  for (const el of fx.querySelectorAll("div[id^='response-']")) assert.equal(typeof el.getBoundingClientRect, 'undefined')
})

// ---- rule (b) by geometry ----------------------------------------------------------------------------------

test('containerForAnchor: with the rows laid out, each prompt\'s reply is the row BELOW it whatever the document order and whatever `transcriptOrder` says; newestOf is the lowest row', () => {
  for (const [name, keys] of Object.entries(DOM_ORDERS)) {
    for (const order of ['oldest-first', 'newest-first']) {
      const { adapter, nodes } = page('claude', keys, { extra: { claude: { transcriptOrder: order } } })
      for (const i of [1, 2, 3]) assert.equal(adapter.containerForAnchor(nodes[`U${i}`]), nodes[`A${i}`], `${name} / ${order}: U${i} → A${i}`)
      assert.equal(adapter.newestOf(adapter.userTurns()), nodes.U3, `${name} / ${order}: the newest turn is the lowest`)
      assert.equal(adapter.newestOf(adapter.assistantContainers()), nodes.A3, `${name} / ${order}: the newest container is the lowest`)
      assert.equal(adapter.newestOf([nodes.A2, nodes.A1]), nodes.A2)
    }
  }
})

test('containerForAnchor: a laid-out user turn between the prompt and a lower row BLOCKS it (that row is the next exchange: null, the reply has not mounted); a row ABOVE the prompt is never its reply; a tool turn then the answer under one prompt → the answer (the lowest of the run), never the tool turn', () => {
  // A2 is missing: U3's exchange sits right under U2
  const { adapter, nodes } = page('claude', ['A3', 'U3', 'U2', 'A1', 'U1'], { extra: { claude: { transcriptOrder: 'newest-first' } } })
  assert.equal(adapter.containerForAnchor(nodes.U2), null, 'A3 is below U2, but U3 lies between')
  assert.equal(adapter.containerForAnchor(nodes.U3), nodes.A3)
  assert.equal(adapter.containerForAnchor(nodes.U1), nodes.A1, 'A3 is far below U1 too, and U2 / U3 block it')
  // the ±1 px tolerance: a reply whose top is exactly the prompt's bottom − 1 still counts as below it
  const touching = page('claude', ['U1', 'A1'], { rect: (k) => ({ U1: '0,40', A1: '39,100' })[k] })
  assert.equal(touching.adapter.containerForAnchor(touching.nodes.U1), touching.nodes.A1)
  const overlapping = page('claude', ['U1', 'A1'], { rect: (k) => ({ U1: '0,40', A1: '38,100' })[k] })
  assert.equal(overlapping.adapter.containerForAnchor(overlapping.nodes.U1), null, 'two pixels into the prompt is not below it')
  // the tool-turn dance: U(0,40) tool(50,30) answer(90,100), the DOM order scrambled
  const { doc, thread, adapter: tools } = setup(CLAUDE_PAGE, 'claude')
  const answer = mount(doc, thread, reply('The answer.', '90,100'))
  const turn = mount(doc, thread, user('a question about the BMI088', '0,40'))
  const tool = mount(doc, thread, reply('Searching the web…', '50,30'))
  assert.equal(tools.containerForAnchor(turn), answer)
  assert.notEqual(tools.containerForAnchor(turn), tool)
})

test('zero or missing rects (the unit DOM, a 0×0 view that lays nothing out; every top equal) fall back to the DOM step — the pre-10-11 answer, direction and all', () => {
  const cases = [
    ['no data-rect at all', () => null],
    ['every rect degenerate ("0,0")', () => '0,0'],
    ['every row at the same top (a pool whose transforms have not applied)', () => '0,40'],
  ]
  for (const [name, rect] of cases) {
    // a newest-first DOM read with the oldest-first key steps FORWARD from U3 and lands on A2 — wrong, but it is
    // the DOM step's answer, and what the DOM step answered before geometry existed
    const wrong = page('claude', DOM_ORDERS['newest-first DOM'], { rect, extra: { claude: { transcriptOrder: 'oldest-first' } } })
    assert.equal(wrong.adapter.containerForAnchor(wrong.nodes.U3), wrong.nodes.A2, `${name}: the DOM step under the wrong key`)
    const right = page('claude', DOM_ORDERS['newest-first DOM'], { rect, extra: { claude: { transcriptOrder: 'newest-first' } } })
    assert.equal(right.adapter.containerForAnchor(right.nodes.U3), right.nodes.A3, `${name}: the DOM step under the right key`)
    assert.equal(right.adapter.newestOf(right.adapter.assistantContainers()), right.nodes.A3, `${name}: newestOf by direction`)
    assert.equal(wrong.adapter.newestOf(wrong.adapter.assistantContainers()), wrong.nodes.A1, `${name}: newestOf by the (wrong) direction`)
  }
  // the anchor laid out but NO candidate laid out: still the DOM step
  const mixed = page('claude', DOM_ORDERS['newest-first DOM'], { rect: (k) => (k[0] === 'U' ? RECT[k] : null), extra: { claude: { transcriptOrder: 'oldest-first' } } })
  assert.equal(mixed.adapter.containerForAnchor(mixed.nodes.U3), mixed.nodes.A2)
  // …and a candidate laid out but the anchor not
  const anchorless = page('claude', DOM_ORDERS['newest-first DOM'], { rect: (k) => (k[0] === 'A' ? RECT[k] : null), extra: { claude: { transcriptOrder: 'oldest-first' } } })
  assert.equal(anchorless.adapter.containerForAnchor(anchorless.nodes.U3), anchorless.nodes.A2)
})

test('a full capture: geometry overrides a WRONG transcriptOrder — on an appended (oldest-first) page read with the newest-first key the DOM step names the PREVIOUS reply, and the laid-out row below the prompt is followed instead', async () => {
  const { doc, clock, adapter, thread, stop } = setup(CLAUDE_PAGE, 'claude', { claude: { transcriptOrder: 'newest-first' } })
  for (const key of ['U1', 'A1', 'U2', 'A2']) mount(doc, thread, ROW(key))
  await adapter.submit(0)
  const u3 = mount(doc, thread, user('question 3 about the BMI088 gyroscope', RECT.U3))
  const row = mount(doc, thread, reply('', RECT.A3))
  const a2 = adapter.assistantContainers()[1]
  assert.equal(adapter.containerForAnchor(u3), row)
  // the DOM step alone (no rects) would have said A2: pin it by reading the same page through a rect-less twin
  const twin = setup(CLAUDE_PAGE, 'claude', { claude: { transcriptOrder: 'newest-first' } })
  for (const key of ['U1', 'A1', 'U2', 'A2', 'U3']) mount(twin.doc, twin.thread, ROW(key, null))
  const twinRow = mount(twin.doc, twin.thread, reply('', null))
  assert.equal(twin.adapter.containerForAnchor(twin.adapter.userTurns()[2]), twin.adapter.assistantContainers()[1], 'the DOM step under the wrong key: the previous reply')
  assert.notEqual(twin.adapter.containerForAnchor(twin.adapter.userTurns()[2]), twinRow)
  const state = settled(adapter.observe({ baselineCount: 2, timeoutMs: 60000, firstTokenMs: 3000, quietMs: 1000, settleMs: 400, text: 'question 3 about the BMI088 gyroscope' }))
  await clock.advance(1000)
  assert.equal(state.done, false)
  mount(doc, row.querySelector('.prose'), '<span>The third answer.</span>')
  await clock.advance(500)
  stop.remove()
  await clock.advance(16000)
  assert.equal(state.error, null, state.error && state.error.message)
  assert.deepEqual([state.value.text, state.value.doneBy], ['The third answer.', 'stop_gone'])
  assert.ok(a2.isConnected && adapter.replyText(a2) === 'Answer 2.', 'the previous reply was never the one followed')
})

test('newestOf by geometry through the fallback rule (no text): of two fresh rows the LOWER one is the reply, although it comes FIRST in document order on an oldest-first page', async () => {
  const { doc, clock, adapter, thread, stop } = setup(CHATGPT_PAGE, 'chatgpt', { chatgpt: { done: [] } })
  await adapter.submit(0)
  const lower = mount(doc, thread, article('The answer, under the tool turn.', '300,100'))
  const upper = mount(doc, thread, article('Searching the web…', '100,60'))
  assert.equal(adapter.newestOf([lower, upper]), lower)
  assert.equal(adapter.newestOf([upper, lower]), lower)
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 3000, quietMs: 800, settleMs: 400 }))
  await clock.advance(500)
  stop.remove()
  await clock.advance(3000)
  assert.equal(state.error, null, state.error && state.error.message)
  assert.equal(state.value.text, 'The answer, under the tool turn.')
  assert.ok(upper.isConnected)
})

// ---- rule 3: the anchored-but-no-container fall-through -----------------------------------------------------

test('a fresh grok chat read OLDEST-first under the newest-first key, no geometry: rule (b) is null (the bug), and the capture falls through to the reply row instead of waiting — followed while empty, captured when done', async () => {
  const PROMPT = 'What is the maximum gyroscope range of the BMI088?'
  const { doc, clock, adapter, thread, stop } = setup(GROK_PAGE, 'grok')
  assert.equal(S.grok.transcriptOrder, 'newest-first')
  const sent = await adapter.submit(0)
  assert.equal(sent.assistantCount, 0)
  // the measured shape: the user row FIRST, the assistant row SECOND, both appended (a reused slot pool)
  const turnRow = mount(doc, thread, grokUserRow(PROMPT))
  const row = mount(doc, thread, grokReplyRow(''))
  const [turn] = adapter.userTurns()
  assert.ok((turn.compareDocumentPosition(row) & FOLLOWING) !== 0, 'the reply row follows the user row in document order')
  assert.equal(adapter.containerForAnchor(turn), null, 'rule (b) under the newest-first key steps backwards and finds nothing')
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 3000, quietMs: 800, settleMs: 200, text: PROMPT }))
  await clock.advance(3500) // past firstTokenMs: a blind wait would have ended here with reply_not_found
  assert.equal(state.done, false, 'the reply row is followed')
  mount(doc, row.querySelector('.response-content-markdown'), '<span>The answer about the BMI088.</span>')
  await clock.advance(500)
  stop.remove()
  await clock.advance(1500)
  assert.equal(state.error, null, state.error && state.error.message)
  assert.deepEqual([state.value.text, state.value.doneBy], ['The answer about the BMI088.', 'stop_gone'])
  assert.ok(turnRow.isConnected)
})

test('the fall-through never takes an OLDER row: on a long chat a remounted old row (new node, old text) is skipped, the anchor\'s own row and its holder are skipped, and nothing left is still a wait (reply_not_found at the deadline, `geom=no`)', async () => {
  const PROMPT = 'What is the maximum gyroscope range of the BMI088?'
  const OLD = 'An older answer about accelerometers.'
  const { doc, clock, adapter, thread } = setup(GROK_PAGE, 'grok')
  mount(doc, thread, grokUserRow('an earlier question'))
  const old = mount(doc, thread, grokReplyRow(OLD))
  assert.equal((await adapter.submit(0)).assistantCount, 1)
  mount(doc, thread, grokUserRow(PROMPT))
  old.remove()
  mount(doc, thread, grokReplyRow(OLD)) // the virtualizer remounts the older row as a new node
  assert.equal(adapter.countAssistant(), 1)
  const state = settled(adapter.observe({ baselineCount: 1, timeoutMs: 60000, firstTokenMs: 1500, quietMs: 800, settleMs: 200, text: PROMPT }))
  await clock.advance(2000)
  assert.equal(state.error && state.error.code, 'reply_not_found')
  assert.match(state.error.message, /\[containers=1 followed=- connected=false anchor=1 order=newest geom=no presubmit=1 stopNow=true stopSeen=true end=- /)
  // the same under a bare `div[id^='response-']` override, where the user's own row IS a container: still never followed
  const bare = setup(GROK_PAGE, 'grok', { grok: { assistant: ["div[id^='response-']"] } })
  await bare.adapter.submit(0)
  mount(bare.doc, bare.thread, grokUserRow(PROMPT))
  assert.equal(bare.adapter.countAssistant(), 1)
  const own = settled(bare.adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 1500, quietMs: 800, settleMs: 200, text: PROMPT }))
  await clock.advance(2000)
  await bare.clock.advance(2000)
  assert.equal(own.error && own.error.code, 'reply_not_found', 'the anchor\'s own row is not its reply')
})

// ---- the diag ------------------------------------------------------------------------------------------------

test('the diag says `geom=yes` when the laid-out geometry decided the last sample, `geom=no` when the DOM order had to, `geom=-` while no sample had anything to measure', async () => {
  const TEXT = 'question 2 about the BMI088 gyroscope'
  // yes: the anchor and the earlier reply are laid out, nothing below the anchor → null, the fallback has nothing fresh
  {
    const { doc, clock, adapter, thread } = setup(CLAUDE_PAGE, 'claude')
    mount(doc, thread, ROW('U1'))
    mount(doc, thread, ROW('A1'))
    await adapter.submit(0)
    mount(doc, thread, user(TEXT, RECT.U2))
    const state = settled(adapter.observe({ baselineCount: 1, timeoutMs: 60000, firstTokenMs: 1000, quietMs: 500, settleMs: 200, text: TEXT }))
    await clock.advance(1500)
    assert.equal(state.error && state.error.code, 'reply_not_found')
    assert.match(state.error.message, /\[containers=1 followed=- connected=false anchor=1 order=oldest geom=yes presubmit=1 /)
  }
  // no: the same page with no rects at all
  {
    const { doc, clock, adapter, thread } = setup(CLAUDE_PAGE, 'claude')
    mount(doc, thread, ROW('U1', null))
    mount(doc, thread, ROW('A1', null))
    await adapter.submit(0)
    mount(doc, thread, user(TEXT))
    const state = settled(adapter.observe({ baselineCount: 1, timeoutMs: 60000, firstTokenMs: 1000, quietMs: 500, settleMs: 200, text: TEXT }))
    await clock.advance(1500)
    assert.match(state.error.message, / anchor=1 order=oldest geom=no presubmit=1 /)
  }
  // -: an empty page, no text — nothing to measure on any sample
  {
    const { clock, adapter } = setup(CLAUDE_PAGE, 'claude')
    const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 1000, quietMs: 500, settleMs: 200 }))
    await clock.advance(1500)
    assert.match(state.error.message, /\[containers=0 followed=- connected=false anchor=no order=oldest geom=- presubmit=0 /)
  }
})

// ---- the fixture: the failure itself ---------------------------------------------------------------------------

test('grok-oct11-fresh: four slots — empty, USER, ASSISTANT, empty — in oldest-first document order under the newest-first key; with no rects `containerForAnchor(userTurn)` is null (the bug), and an observe on that page still captures through the fall-through', async () => {
  const doc = fixture('grok-oct11-fresh')
  const clock = fakeClock()
  const adapter = createAdapter({ document: doc, site: 'grok', selectors: DEFAULT_SELECTORS, now: clock.now, timers: clock.timers })
  const slots = doc.querySelectorAll("[data-testid='chat-transcript-scroller'] > div > div.absolute.inset-x-0.top-0")
  assert.equal(slots.length, 4)
  assert.deepEqual(
    slots.map((s) => (s.querySelector("[data-testid='user-message']") ? 'U' : s.querySelector("[data-testid='assistant-message']") ? 'A' : '-')),
    ['-', 'U', 'A', '-'],
    'the user row precedes the assistant row: a reused pool, not a newest-first transcript',
  )
  assert.equal(adapter.countAssistant(), 1)
  const [container] = adapter.assistantContainers()
  const turns = adapter.userTurns()
  assert.equal(turns.length, 1)
  assert.ok((turns[0].compareDocumentPosition(container) & FOLLOWING) !== 0)
  assert.equal(S.grok.transcriptOrder, 'newest-first')
  assert.equal(adapter.containerForAnchor(turns[0]), null, 'the bug: the DOM step under the newest-first key finds nothing')
  assert.equal(adapter.health().matched.stop, null, 'the page was settled when the failure was saved')
  // the scrubbed text is `…`; give the parsed bubbles the prompt and a reply so the anchor can match
  const PROMPT = 'What is the maximum gyroscope full-scale range of the BMI088?'
  const userBody = turns[0].querySelector('.response-content-markdown')
  const replyBody = container.querySelector('.response-content-markdown')
  userBody.childNodes = []
  replyBody.childNodes = []
  mount(doc, userBody, `<p>${PROMPT}</p>`)
  mount(doc, replyBody, '<p>The gyroscope range is selectable up to 2000 deg/s.</p>')
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 3000, quietMs: 500, settleMs: 200, text: PROMPT }))
  await clock.advance(2000)
  assert.equal(state.error, null, state.error && state.error.message)
  assert.deepEqual([state.value.text, state.value.doneBy], ['The gyroscope range is selectable up to 2000 deg/s.', 'quiet'])
})
