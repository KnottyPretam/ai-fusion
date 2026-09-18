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
//      carrying the last text that was on the page, never an unbounded wait.
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
const CHATGPT_DONE = '<button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button>'

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
