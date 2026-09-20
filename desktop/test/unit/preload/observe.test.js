// The `observe` sample logic of desktop/preload/site.cjs over a FAKE DOM (`_dom.js`) and a fake clock,
// so the chatgpt lifecycle measured live on 2026-09-17 can be single-stepped offline with no browser:
//
//   ~1 s   a SHORT placeholder assistant turn (about 12 characters, NO `.markdown` child) is mounted
//          while the stop button is visible
//   ~2 s   that placeholder is UNMOUNTED — zero `[data-message-author-role="assistant"]` — for ~10 s
//          while the stop button stays visible
//   ~13 s  the real reply container is mounted, `.markdown` child and all
//   ~14 s  the stop button goes and the copy-turn marker appears
//
// The rules that follow from it, and what the tests below pin:
//   1. a container whose `isConnected` went false is DROPPED. Holding the detached node freezes the text
//      at the placeholder, and the end signals then fire on it: `stop_gone` or `quiet` would hand main a
//      12-character placeholder AS THE MODEL'S REPLY (the worst outcome of the bug), and the `done`
//      marker — no longer reachable from a detached container — could never match at all;
//   2. the first-token deadline applies only until a container has been seen ONCE — a later gap is a
//      re-render — but a page that never mounts one still answers `reply_not_found`;
//   3. the gap is bounded by the overall budget: a placeholder that never comes back is a `timeout`
//      carrying the last text that was on the page, never an unbounded wait;
//   4. (S7 review) the reply is picked by NODE IDENTITY: the containers on the page when observe starts
//      are snapshotted, the reply is the LAST container outside that snapshot, and `length > baseline`
//      only picks a container until one has been followed. So a container from an EARLIER turn is never
//      reported as this turn's reply when the baseline is stale and the gap is open — and a reply that
//      mounts while the count still equals an INFLATED baseline (the placeholder counted into it, the
//      submit-side half of the same bug) is followed all the same.
//
// There is no layout and no MutationObserver here, so every sample is the OBSERVE_POLL_MS poll and every
// element counts as visible (see the _dom.js header) — which is exactly what makes the stepping
// deterministic. Every test below runs on a chatgpt-shaped page, so the wait after an end signal allows
// for chatgpt's own settle window (`settleMs: 1200` since S10, where it was a 400 ms constant). The Playwright `adapters` project covers the same lifecycle in a real browser
// (`test/adapters/observe.spec.js`, the fake site's `?remountMs`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { parseHtml, parseFragment } from './_dom.js'

const require = createRequire(import.meta.url)
const { createAdapter, DEFAULT_SELECTORS } = require('../../../preload/site.cjs')

/** A chatgpt-shaped page: a composer (so the session reads `ok`), an empty thread, a visible stop button. */
const PAGE = `<html><head><title>ChatGPT</title></head><body><div id="app">
  <main class="thread"></main>
  <form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"><p></p></div>
  <button data-testid="stop-button" aria-label="Stop answering">Stop</button></form>
</div></body></html>`

const PLACEHOLDER = 'Placeholder…' // ~12 characters, as measured
const ANSWER = 'The gyroscope full-scale range is selectable up to 2000 deg/s.'
const OLD_ANSWER = 'The accelerometer full-scale range is selectable up to 16 g.' // the PREVIOUS turn, already finished
const TOOL_TEXT = 'Searching the web…' // the finished tool container of the two-turn shape
const CHATGPT_DONE = '<button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button>'
/** A finished assistant turn: its own text in a `.markdown` child and its own copy-turn marker. */
const finished = (text) => `<article data-message-author-role="assistant"><div class="markdown">${text}</div>${CHATGPT_DONE}</article>`
const streaming = (text) => `<article data-message-author-role="assistant"><div class="markdown">${text}</div></article>`

/** Parse a snippet, re-own it onto `doc` and append it to `parent` (a real mount, so `isConnected` is true). */
function mount(doc, parent, html) {
  const node = parseFragment(html)
  const own = (n) => {
    n.ownerDocument = doc
    for (const c of n.childNodes || []) own(c)
  }
  own(node)
  parent.appendChild(node)
  return node
}

/**
 * A fake clock for `createAdapter({now, timers})`: `advance(ms)` runs every timer due in that window in
 * order, flushing microtasks between them, so a capture can be single-stepped. `now` never moves on its
 * own, so nothing is racy.
 */
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

function setup() {
  const doc = parseHtml(PAGE)
  const clock = fakeClock()
  const adapter = createAdapter({ document: doc, site: 'chatgpt', selectors: DEFAULT_SELECTORS, now: clock.now, timers: clock.timers })
  const thread = doc.querySelector('main.thread')
  const stop = doc.querySelector("button[data-testid='stop-button']")
  return { doc, clock, adapter, thread, stop }
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

test('the placeholder is mounted, UNMOUNTED and remounted: the detached container is dropped and the capture returns the REAL reply', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  assert.equal(adapter.sessionState(), 'ok')
  assert.equal(adapter.countAssistant(), 0)

  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 1000 }))

  // ~1 s: the short placeholder turn — no `.markdown` child, so a capture would read the container itself
  const placeholder = mount(doc, thread, `<article data-message-author-role="assistant">${PLACEHOLDER}</article>`)
  assert.equal(placeholder.querySelectorAll('.markdown').length, 0)
  await clock.advance(1000)
  assert.equal(state.done, false)
  assert.equal(adapter.countAssistant(), 1)

  // ~2 s: unmounted entirely — the node still exists, it is just no longer connected
  placeholder.remove()
  assert.equal(placeholder.isConnected, false)
  assert.equal(adapter.countAssistant(), 0)
  await clock.advance(9000) // the ~10 s gap, well past firstTokenMs, the stop button still up
  assert.equal(state.done, false, 'a gap after a container was seen is not reply_not_found')

  // ~13 s: the real container, with its `.markdown` child
  const real = mount(doc, thread, `<article data-message-author-role="assistant"><div class="markdown">${ANSWER}</div></article>`)
  await clock.advance(600)
  assert.equal(state.done, false, 'still streaming: the stop button is visible')

  // ~14 s: the stop button goes and the copy-turn marker appears
  stop.remove()
  mount(doc, real, CHATGPT_DONE)
  await clock.advance(2000) // one chatgpt settle window (S10: settleMs 1200) past the marker

  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.text, ANSWER) // the answer, never the placeholder
  assert.ok(!state.value.text.includes(PLACEHOLDER))
  assert.equal(state.value.doneBy, 'done_selector')
  assert.ok(state.value.ms >= 10000, `the capture spanned the gap (${state.value.ms} ms)`)
})

test('a page that never mounts a container still answers reply_not_found at firstTokenMs (the deadline is only lifted once a container HAS been seen)', async () => {
  const { clock, adapter } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 2000 }))
  await clock.advance(1500)
  assert.equal(state.done, false)
  await clock.advance(1000)
  assert.equal(state.done, true)
  assert.equal(state.value, null)
  assert.equal(state.error.code, 'reply_not_found')
  assert.match(state.error.message, /within 2000 ms/)
  assert.equal(state.error.partial, undefined) // nothing was ever on the page
})

test('a placeholder that never comes back is bounded by the BUDGET: timeout carrying the last text seen, never an unbounded wait', async () => {
  const { doc, clock, adapter, thread } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 4000, firstTokenMs: 1000 }))
  const placeholder = mount(doc, thread, `<article data-message-author-role="assistant">${PLACEHOLDER}</article>`)
  await clock.advance(500)
  placeholder.remove()
  await clock.advance(1000) // past firstTokenMs: seen once, so no reply_not_found
  assert.equal(state.done, false)
  await clock.advance(2000)
  assert.equal(state.done, false, 'still inside the budget')
  await clock.advance(1000)
  assert.equal(state.done, true)
  assert.equal(state.error.code, 'timeout')
  assert.match(state.error.message, /after 4000 ms/)
  assert.equal(state.error.partial, PLACEHOLDER) // the last text that was on the page, riding with an error
  assert.equal(clock.pending(), 0) // every timer was cleaned up
})

test('the worst case the drop prevents: the stop button goes while there is NO container — the capture times out instead of recording the placeholder as the model\'s reply', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 3000, firstTokenMs: 1000, quietMs: 10000 }))
  const placeholder = mount(doc, thread, `<article data-message-author-role="assistant">${PLACEHOLDER}</article>`)
  await clock.advance(400) // the stop button is seen while the placeholder is up
  placeholder.remove()
  stop.remove() // "seen then gone" — but there is nothing on the page to capture
  await clock.advance(1000)
  assert.equal(state.done, false, 'stop_gone must not resolve on a container that is no longer in the document')
  await clock.advance(2000)
  assert.equal(state.done, true)
  assert.equal(state.value, null)
  assert.equal(state.error.code, 'timeout') // a failure main can report, never a 12-character "answer"
  assert.equal(state.error.partial, PLACEHOLDER)
})

test('the same gap on a site with no stop button and no done marker (quiet detection): the placeholder never settles as the answer', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove() // as on claude / grok, whose stop + done cascades are empty — here: nothing to see
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 3000, quietMs: 1500 }))
  const placeholder = mount(doc, thread, `<article data-message-author-role="assistant">${PLACEHOLDER}</article>`)
  await clock.advance(1000) // under quietMs: the placeholder is not quiet yet
  assert.equal(state.done, false)
  placeholder.remove()
  await clock.advance(4000) // the gap: no container, so quiet cannot fire either
  assert.equal(state.done, false)
  mount(doc, thread, `<article data-message-author-role="assistant"><div class="markdown">${ANSWER}</div></article>`)
  await clock.advance(3000) // the text is non-blank and has not moved for quietMs, plus the settle window
  assert.equal(state.done, true)
  assert.equal(state.error, null)
  assert.deepEqual([state.value.text, state.value.doneBy], [ANSWER, 'quiet'])
})

// ---- S7 review: WHICH container is this turn's reply (node identity, not only the count) -----------

test("an EARLIER turn's container is never reported as this turn's reply: a stale baseline plus the measured gap waits for the real container instead of handing back the previous answer", async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  // the previous turn, finished and still on the page: its own text AND its own copy-turn marker
  mount(doc, thread, finished(OLD_ANSWER))
  assert.equal(adapter.countAssistant(), 1)

  // main's baseline is STALE — 0 while the page holds one container. Measured cause: the site unmounts
  // containers (the lifecycle above), so the `countAssistant()` sample taken at the submit can be lower
  // than what is on the page by the time the observe message arrives.
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 20000, firstTokenMs: 5000, quietMs: 800 }))

  // ~1 s: this turn's placeholder — mounted AFTER observe started, so identity marks it as ours
  const placeholder = mount(doc, thread, `<article data-message-author-role="assistant">${PLACEHOLDER}</article>`)
  await clock.advance(1000)
  assert.equal(state.done, false)

  // ~2 s: the placeholder is unmounted and the stop button goes while the gap is open — the moment the
  // count rule alone (1 container > baseline 0) falls back to the OLD turn, whose own copy-turn marker
  // then reads as a `done_selector` end signal and hands main the previous answer as this reply
  placeholder.remove()
  stop.remove()
  await clock.advance(3000)
  assert.equal(state.done, false, "the previous turn's container is not this turn's reply")

  // ~13 s: the real container, the only node that mounted after observe started
  mount(doc, thread, streaming(ANSWER))
  await clock.advance(2500)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.text, ANSWER)
  assert.ok(!state.value.text.includes(OLD_ANSWER), 'never the previous turn')
  assert.equal(state.value.doneBy, 'stop_gone') // the old turn's marker is BEFORE this container: it never counts
})

test('a baseline INFLATED by the placeholder (containers === baseline) still follows the fresh container: identity, not the count', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  // main sampled 1 because chatgpt's placeholder turn appeared inside submitVerifyMs while a submit
  // attempt was being confirmed; the page itself is empty again, and the real reply mounts AT that count
  const state = settled(adapter.observe({ baselineCount: 1, timeoutMs: 20000, firstTokenMs: 1500, quietMs: 800 }))
  const real = mount(doc, thread, streaming(ANSWER))
  await clock.advance(2000) // past firstTokenMs: the count rule alone (1 > 1 is false) answers reply_not_found here
  assert.equal(state.done, false, 'a container that mounted after observe started is the reply whatever the count says')
  stop.remove()
  mount(doc, real, CHATGPT_DONE)
  await clock.advance(2000)
  assert.equal(state.error, null)
  assert.deepEqual([state.value.text, state.value.doneBy], [ANSWER, 'done_selector'])
})

test('the two-turn (tool call) shape with a finished EARLIER turn on the page: the answer container is followed, never the tool turn and never the older turn', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  mount(doc, thread, finished(OLD_ANSWER)) // history
  const state = settled(adapter.observe({ baselineCount: 1, timeoutMs: 20000, firstTokenMs: 2000, quietMs: 800 }))
  // the tool turn: finished and marked done at once, under a visible stop button
  mount(doc, thread, finished(TOOL_TEXT))
  await clock.advance(1000)
  assert.equal(state.done, false, 'a finished tool turn under a visible stop button is not the end')
  mount(doc, thread, streaming(ANSWER)) // the answer container, last in document order
  await clock.advance(600)
  assert.equal(state.done, false)
  stop.remove()
  await clock.advance(2000)
  assert.equal(state.error, null)
  assert.equal(state.value.text, ANSWER)
  assert.ok(!state.value.text.includes(TOOL_TEXT) && !state.value.text.includes(OLD_ANSWER))
  assert.equal(state.value.doneBy, 'stop_gone')
})

// ---- S9: the fenced-reply capture defect, MEASURED live on 2026-09-18 ------------------------------
//
// A real Analyze against the hidden chatgpt analyst page degraded with `parse_error`, and its two raw
// attempts were, complete: "```JSON\n{\n```" (13 characters) and `{"agre` (6) — FRAGMENTS of a reply
// still being typed. The 13 characters are what `toMarkdown` makes of a code block holding one `{`.
// Since the analyst prompt asks a web session for a ```json fence, chatgpt opens a code block at the
// FIRST character of the answer, and it renders a copy control on that block as soon as it opens.
// The two rules that come out of it (the same ones test/adapters/observe.spec.js pins in a browser):
//   * a `done` match inside the reply BODY is never a turn-completion marker (the turn's action bar is
//     a sibling of `.markdown`, not a descendant of it);
//   * an end signal is never LATCHED: every sample re-reads the stop button and a visible one
//     withdraws it, because "no stop button" is one sample's reading of a DOM that re-renders.

/** The code block the first render of a fenced reply mounts: a header, its own copy control, one character. */
const openBlock = (body, done) =>
  `<article data-message-author-role="assistant"><div class="markdown"><pre><div class="code-header">json</div>${done}` +
  `<code class="language-json"><span>${body}</span></code></pre></div></article>`

test('S9: a copy control INSIDE the message body (the code block chatgpt opens at the first character of a fenced reply) is not the end of the turn — the capture waits for the whole body', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove() // the live sample that ended the capture saw no stop button either
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000 }))

  // the measured first render: an open code block holding `{`, with the turn marker's testid on the
  // block's own copy button — this is the DOM the 13-character capture came from
  const real = mount(doc, thread, openBlock('{', CHATGPT_DONE))
  await clock.advance(3000) // 7× SETTLE_MS, and the text has not moved: the old rule resolved here
  assert.equal(state.done, false, 'the capture must still be waiting for the body')

  const code = real.querySelector('code')
  mount(doc, code, '<span>"agreements": []}</span>')
  await clock.advance(1000)
  assert.equal(state.done, false, 'still no end signal: the only marker is inside the message')

  // the reply ends and the TURN's action bar is mounted — outside `.markdown`, where chrome lives
  mount(doc, real, CHATGPT_DONE)
  await clock.advance(2000)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.doneBy, 'done_selector') // the body rule did not kill the done path
  assert.match(state.value.text, /^```json\n\{"agreements": \[\]\}\n```$/)
  assert.ok(!state.value.text.includes('Copy'))
})

test('S9: the body rule needs a body — a container whose `assistantText` cascade matches nothing (chatgpt\'s placeholder shape) still ends on a done marker directly inside it', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000 }))
  // no `.markdown` child at all: the text comes from the container itself, so the body is not a
  // distinguishable subtree and only the `pre`/`code` half of the rule applies
  const real = mount(doc, thread, `<article data-message-author-role="assistant">${ANSWER}${CHATGPT_DONE}</article>`)
  await clock.advance(2000)
  assert.equal(state.error, null)
  assert.equal(state.value.doneBy, 'done_selector')
  assert.ok(state.value.text.startsWith(ANSWER))
})

test('S9: an end signal is never LATCHED — a stop button that comes back withdraws `stop_gone`, and the capture returns the whole reply', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  const form = stop.parentNode
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000 }))
  const real = mount(doc, thread, streaming('The gyroscope range is'))
  await clock.advance(600) // the stop button is up: the site says it is replying
  assert.equal(state.done, false)

  // ONE sample misses the button — a re-render, an animated swap, a frame behind — while the text
  // happens to sit still (the ordinary gap between two token batches)
  stop.remove()
  await clock.advance(300) // the sample that used to latch stop_gone for good
  form.appendChild(stop) // it is back, and the text still has not moved
  await clock.advance(2000)
  assert.equal(state.done, false, 'a missed button must never end a reply that is still arriving')

  // the rest of the reply arrives, and then the button goes for good
  mount(doc, real.querySelector('.markdown'), '<span> selectable up to 2000 deg/s.</span>')
  await clock.advance(300)
  stop.remove()
  await clock.advance(2000)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.doneBy, 'stop_gone') // the path claude and grok rely on, unchanged
  assert.equal(state.value.text, 'The gyroscope range is selectable up to 2000 deg/s.')
})

test('S9: the rule itself — `findDone` rejects a match inside the reply body and accepts the turn\'s action bar', () => {
  const { doc, adapter, thread } = setup()
  // an open code block with the turn marker's testid on the block's own copy control: no done match
  const streamingTurn = mount(doc, thread, openBlock('{', CHATGPT_DONE))
  assert.equal(adapter.replyBlocks(streamingTurn).length, 1) // the `.markdown` body
  assert.equal(adapter.findDone(streamingTurn), null)
  // the same page once the turn ends: the action bar is a SIBLING of `.markdown`, and it counts
  mount(doc, streamingTurn, CHATGPT_DONE)
  const done = adapter.findDone(streamingTurn)
  assert.ok(done !== null)
  assert.equal(done.selector, DEFAULT_SELECTORS.chatgpt.done[0])
  assert.equal(streamingTurn.querySelector('.markdown').contains(done.el), false) // outside the message
  // and with no body element at all (the placeholder shape) a marker inside the container still counts
  const bodyless = mount(doc, thread, `<article data-message-author-role="assistant">${ANSWER}${CHATGPT_DONE}</article>`)
  assert.equal(adapter.replyBlocks(bodyless).length, 0)
  assert.ok(adapter.findDone(bodyless) !== null)
})


// ---- S10: the capture must not end mid-reply, and a JSON reply is waited for ------------------------
//
// The same conversation as the S9 section, one effort level higher. With the effort raised inside
// ChatGPT the analyst's reply became long and slow, and Analyze degraded on two captures the bridge
// reported as `ok`: "```JSON\n{\n```" (13 characters) and `{"agre` (6). What the S9 rules did not
// cover:
//   * two of the three end signals accepted BLANK text — only `quiet` asked for any;
//   * the stillness clocks ran through the measured ~10 s container gap, and `findStop()` was not
//     sampled while the DOM was missing, so a pending signal matured with the withdraw guard blind;
//   * a NEW container node inherited the stillness of the node it replaced;
//   * nothing knew that an analyst reply is supposed to be a JSON DOCUMENT, so any end signal at all
//     could end the capture on a fragment that cannot parse.
// The settle window is a per-site value now (`settleMs`, chatgpt 1200), so these tests pass it
// explicitly wherever the timing is what is being asserted.

/** The rest of the fenced object, appended into the open code block as a streaming render would. */
const FENCE_TAIL = '<span>"agreements": []}</span>'
const FENCED = '```json\n{"agreements": []}\n```'
/** An assistant turn whose body is one empty `.markdown`: the turn exists, the answer has not started. */
const emptyTurn = `<article data-message-author-role="assistant"><div class="markdown"></div></article>`
const textTurn = (text) => `<article data-message-author-role="assistant"><div class="markdown">${text}</div></article>`

test('S10: looksComplete — an expected JSON reply is complete only once a {…} object BALANCES; braces inside strings and escaped quotes do not count', () => {
  const { looksComplete } = require('../../../preload/site.cjs')
  // the two captures that degraded live, and their shape in general
  assert.equal(looksComplete('```JSON\n{\n```', 'json'), false)
  assert.equal(looksComplete('{"agre', 'json'), false)
  assert.equal(looksComplete('', 'json'), false)
  assert.equal(looksComplete('no object at all', 'json'), false)
  assert.equal(looksComplete('}}}', 'json'), false)
  assert.equal(looksComplete(null, 'json'), false)
  // balanced, bare or fenced, with prose around it
  assert.equal(looksComplete('{}', 'json'), true)
  assert.equal(looksComplete('{"agreements": [], "divergences": [{"id": "d1"}]}', 'json'), true)
  assert.equal(looksComplete(FENCED, 'json'), true)
  assert.equal(looksComplete('Here it is: {"a": {"b": []}} — done', 'json'), true)
  assert.equal(looksComplete('} {"a": 1}', 'json'), true) // a stray closer never closes an object
  // string-aware: a brace inside a JSON string is data, and an escaped quote does not leave the string
  assert.equal(looksComplete('{"a": "} not the end"', 'json'), false)
  assert.equal(looksComplete('{"a": "}"}', 'json'), true)
  assert.equal(looksComplete('{"a": "x \\" } y"', 'json'), false)
  assert.equal(looksComplete('{"a": "x \\" } y"}', 'json'), true)
  assert.equal(looksComplete('{"a": "\\\\"} ', 'json'), true) // the string ends at an escaped BACKSLASH
  // anything else expects nothing: the capture behaves exactly as it always did
  assert.equal(looksComplete('{', undefined), true)
  assert.equal(looksComplete('{', null), true)
  assert.equal(looksComplete('', 'text'), true)
  assert.equal(looksComplete('prose', 'json    '), true) // only the exact kind counts
})

test('S10: `done_selector` needs non-blank text — a turn marked done over an EMPTY body is a reply that has not started', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove() // the sample that ended the live capture saw no stop button either
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000, settleMs: 400 }))
  // the TURN's action bar (outside the body, so `findDone` accepts it) while the body is still empty
  const real = mount(doc, thread, `<article data-message-author-role="assistant"><div class="markdown"></div>${CHATGPT_DONE}</article>`)
  await clock.advance(2000)
  assert.equal(state.done, false, 'nothing captured means the reply has not started: keep waiting')

  mount(doc, real.querySelector('.markdown'), `<span>${ANSWER}</span>`)
  await clock.advance(1000)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.deepEqual([state.value.text, state.value.doneBy], [ANSWER, 'done_selector'])
})

test('S10: `stop_gone` needs non-blank text — the button going while nothing is on the page is not a finished reply', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000, settleMs: 400 }))
  const real = mount(doc, thread, emptyTurn) // the container is mounted, its body still empty
  await clock.advance(400) // the stop button is seen while the empty container is up
  stop.remove()
  await clock.advance(2000)
  assert.equal(state.done, false, 'stop_gone over an empty body would hand main a zero-character reply')

  mount(doc, real.querySelector('.markdown'), `<span>${ANSWER}</span>`)
  await clock.advance(1000)
  assert.equal(state.error, null)
  assert.deepEqual([state.value.text, state.value.doneBy], [ANSWER, 'stop_gone'])
})

test('S10: the stillness clocks are FROZEN while there is no container — a quiet window cannot mature across the measured ~10 s gap', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove() // quiet is the only signal left
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 1500, settleMs: 400 }))
  const real = mount(doc, thread, openBlock('{', ''))
  await clock.advance(600)
  assert.equal(state.done, false)

  // the site unmounts the reply and re-attaches the SAME node three seconds later (a re-parent during a
  // re-render, so node identity is not what saves this capture): the text is unchanged across the gap
  real.remove()
  await clock.advance(3000)
  assert.equal(state.done, false, 'no container: there is nothing to be quiet about')
  thread.appendChild(real)
  await clock.advance(900)
  assert.equal(state.done, false, 'the quiet window restarts where the DOM went away, not where it came back')

  mount(doc, real.querySelector('code'), FENCE_TAIL)
  await clock.advance(2200)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.text, FENCED)
  assert.equal(state.value.doneBy, 'quiet')
})

test('S10: a stop button visible while there is NO container still withdraws a pending end signal — the text that lands when the DOM comes back is part of the reply', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  const form = stop.parentNode
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000, settleMs: 400 }))
  const real = mount(doc, thread, openBlock('{', ''))
  await clock.advance(400) // the stop button is up: the site says it is replying
  stop.remove() // ONE sample misses it → `stop_gone` is pending
  await clock.advance(300)

  // the container is unmounted (the measured gap) and the button is up for the whole gap, as it was
  // measured to be on chatgpt.com: the site is plainly still replying
  real.remove()
  form.appendChild(stop)
  await clock.advance(3000)
  assert.equal(state.done, false)

  // the gap ends: the container returns with the text it had, and the button goes
  stop.remove()
  thread.appendChild(real)
  await clock.advance(400)
  assert.equal(state.done, false, 'a signal the gap withdrew must be re-earned once the DOM is back')

  mount(doc, real.querySelector('code'), FENCE_TAIL)
  await clock.advance(1200)
  assert.equal(state.error, null)
  assert.equal(state.value.text, FENCED)
  assert.equal(state.value.doneBy, 'stop_gone')
})

test('S10: a NEW container node is a NEW reply body — it never inherits the stillness of the node it replaced', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 1500, settleMs: 400 }))
  const first = mount(doc, thread, openBlock('{', ''))
  await clock.advance(1200) // still under quietMs
  assert.equal(state.done, false)

  // the site re-renders the turn into a DIFFERENT node holding the same text so far
  first.remove()
  const second = mount(doc, thread, openBlock('{', ''))
  await clock.advance(1300) // past the point where the OLD node's stillness would have been quiet enough
  assert.equal(state.done, false, "the replacement's own quiet window starts at the swap")

  mount(doc, second.querySelector('code'), FENCE_TAIL)
  await clock.advance(2600)
  assert.equal(state.error, null)
  assert.equal(state.value.text, FENCED)
})

test('S10: expect "json" — an end signal never resolves on an unbalanced fragment, and the whole document is captured', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 600, settleMs: 400, expect: 'json' }))
  const real = mount(doc, thread, openBlock('{', ''))
  await clock.advance(3000) // quiet, settled, and long past where an unguarded capture ended
  assert.equal(state.done, false, 'a fragment that cannot parse is not the reply the analyst was asked for')

  mount(doc, real.querySelector('code'), FENCE_TAIL)
  await clock.advance(1500)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.text, FENCED)
  assert.equal(state.value.doneBy, 'quiet')
  assert.deepEqual(JSON.parse(state.value.text.slice('```json\n'.length, -'\n```'.length)), { agreements: [] })
})

test('S10: expect "json" never hangs — at the budget the capture hands back what is there with its doneBy, after ONE final re-read of the container', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 2000, firstTokenMs: 1000, quietMs: 600, settleMs: 400, expect: 'json' }))
  const real = mount(doc, thread, openBlock('{', ''))
  await clock.advance(2000) // the sample that spends the budget: the document is still unbalanced
  assert.equal(state.done, false, 'the budget return takes one last look first')

  // the last render lands in that window — a markdown renderer finishing a frame after the model stopped
  mount(doc, real.querySelector('code'), FENCE_TAIL)
  await clock.advance(300)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.text, FENCED, 'the re-read text, not the fragment the sample saw')
  assert.equal(state.value.doneBy, 'quiet') // the signal it had, never a timeout
})

test('S10: a reply that never becomes JSON FAILS, carrying the prose as the partial', async () => {
  // The user's decision (2026-09-20): an answer that did not take the shape it was asked for must
  // fail loudly, never come back as a finished reply. Returning it `ok` is what let a 13-character
  // fragment be compared as though it were a report. `expect` only ever rides a structured purpose
  // (orchestrator STRUCTURED_PURPOSES), so a pane's own prose chat never reaches this path.
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 1000, quietMs: 600, settleMs: 400, expect: 'json' }))
  mount(doc, thread, textTurn('I cannot answer that.'))
  await clock.advance(30000)
  assert.equal(state.value, null, 'it must not come back as a finished reply')
  assert.equal(state.error.code, 'timeout')
  assert.match(state.error.message, /never became a complete json document/)
  assert.equal(state.error.partial, 'I cannot answer that.')
})

test('S10: giving up on an unmet shape is bounded by the grace window, not the whole capture budget', async () => {
  // Without the grace it waits out captureTimeoutMs — five minutes of a held busy guard before a
  // failure that was knowable seconds after the site stopped typing.
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const started = clock.now()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 300000, firstTokenMs: 1000, quietMs: 600, settleMs: 400, expect: 'json' }))
  mount(doc, thread, textTurn('still prose'))
  await clock.advance(40000)
  assert.equal(state.error.code, 'timeout')
  assert.ok(clock.now() - started < 120000, `gave up after ${clock.now() - started} ms, not the 300000 ms budget`)
})

test('S10: settleMs is the per-site settle window: the selectors carry it (chatgpt 1200) and the observe message overrides it', async () => {
  assert.equal(DEFAULT_SELECTORS.chatgpt.settleMs, 1200)
  assert.equal(DEFAULT_SELECTORS.claude.settleMs, 400)
  assert.equal(DEFAULT_SELECTORS.grok.settleMs, 400)

  // the selector value applies when the message carries none: chatgpt holds the text for 1200 ms
  {
    const { doc, clock, adapter, thread, stop } = setup()
    const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000 }))
    mount(doc, thread, textTurn(ANSWER))
    await clock.advance(400)
    stop.remove() // stop_gone, pending
    await clock.advance(800)
    assert.equal(state.done, false, 'chatgpt settles for 1200 ms, not 400')
    await clock.advance(900)
    assert.equal(state.done, true)
    assert.equal(state.value.doneBy, 'stop_gone')
  }
  // and the message wins over the selectors
  {
    const { doc, clock, adapter, thread, stop } = setup()
    const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 30000, settleMs: 2500 }))
    mount(doc, thread, textTurn(ANSWER))
    await clock.advance(400)
    stop.remove()
    await clock.advance(2000)
    assert.equal(state.done, false, 'the observe message overrides the site value')
    await clock.advance(1000)
    assert.equal(state.done, true)
  }
})

test('S10: a container that never holds any text says so, instead of "still in progress"', async () => {
  // Measured 2026-09-20: a condense call ran its whole budget and came back `timeout … chars=0`
  // while its answer was sitting in that chat. "Still in progress" described none of it; the two
  // cases need different words because they need different fixes (a longer budget vs a selector).
  const { doc, clock, adapter, thread, stop } = setup()
  stop.remove()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 3000, firstTokenMs: 1000, quietMs: 600, settleMs: 200 }))
  mount(doc, thread, textTurn(''))  // a container appears, and stays empty
  await clock.advance(4000)
  assert.equal(state.value, null)
  assert.equal(state.error.code, 'reply_not_found')
  assert.match(state.error.message, /never held any text/)
})

test('S10: an empty container while the STOP control is up is a budget that ran out, not a missing reply', async () => {
  // The failure measured on 2026-09-20, twice: chatgpt.com with a reasoning mode switched on inside the
  // site held an empty reply container for the WHOLE capture budget (300 s, then 570 s) with its stop
  // control visible the entire time, and then wrote a correct 5,614-character answer into that same
  // container shortly after the capture gave up. `reply_not_found` sent the last reader hunting for a
  // broken selector; the selector was right and the model was still reasoning. The two cases must not
  // share a message, because a longer budget fixes one and only a new selector fixes the other.
  const { doc, clock, adapter, thread } = setup() // the stop button stays: the site is working
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 3000, firstTokenMs: 1000, quietMs: 600, settleMs: 200 }))
  mount(doc, thread, textTurn('')) // a container appears, and stays empty while the stop control is up
  await clock.advance(4000)
  assert.equal(state.value, null)
  assert.equal(state.error.code, 'timeout', 'the site was working, so this is a deadline, not a lost reply')
  assert.match(state.error.message, /stayed empty for the whole 3000 ms while the site was still working/)
  assert.match(state.error.message, /stop control visible now/)
  assert.match(state.error.message, /longer capture budget, not a different selector/)
})

test('S10: a stop control that was seen and then vanished still reads as the site having worked', async () => {
  // The same shape with the stop control gone by the time the budget runs out: the site DID work on this
  // turn, so an empty container is still a deadline. Only a page that never showed one at all is a reply
  // that could not be found.
  const { doc, clock, adapter, thread, stop } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 3000, firstTokenMs: 1000, quietMs: 600, settleMs: 200 }))
  mount(doc, thread, textTurn(''))
  await clock.advance(500)
  stop.remove() // the site stopped saying it was working, but never wrote anything
  await clock.advance(3500)
  assert.equal(state.value, null)
  assert.equal(state.error.code, 'timeout')
  assert.match(state.error.message, /stop control seen earlier/)
})
