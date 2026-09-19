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
// deterministic. The Playwright `adapters` project covers the same lifecycle in a real browser
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
  await clock.advance(1000)

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
  await clock.advance(2000) // the text is non-blank and has not moved for quietMs
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
  await clock.advance(1000)
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
  await clock.advance(1000)
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
  await clock.advance(1000)
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
  await clock.advance(1000)
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
  await clock.advance(1000)
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
  await clock.advance(1000)
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
