// desktop/preload/site.cjs — the EXCHANGE fallback never echoes the prompt, and the observe result says how
// it read (2026-10-11). Measured on chatgpt.com on 2026-10-11 14:41: a turn that paused to ask the user a
// question in a widget mounted NO reply body, so `replyText` fell back to the whole exchange group — which
// holds the user turn behind a screen-reader-only "You said:" heading — and the captured "reply" was the
// user's own prompt. The capture counted as a success, so nothing was saved.
//
// What is pinned here, over the fake DOM of `_dom.js` (no layout: every element is visible, `innerText` is
// absent so `readText` is `textContent`, and nothing preserves whitespace):
//   1. `toMarkdown(el, {exclude})` leaves an excluded subtree out wherever the walk meets it; without the
//      option the render is byte-identical to the plain call; a throwing predicate excludes nothing;
//   2. `readTextExcluding` — the same predicate over the rendered-text fallback;
//   3. `replyReading` on an EXCHANGE container with no body: '' while the stop control is up (unchanged),
//      and once it is gone the exchange WITHOUT its user turn and its sr-only chrome;
//   4. the sr-only drop is scoped to that fallback: a matched BODY block keeps its sr-only text, and a
//      TURN-LEVEL container (no user turn) with no body still reads byte for byte as it always did;
//   5. the observe result carries `bodyMatched` / `heldUserTurn` / `echoesPrompt`; `echoesPrompt` is true
//      when the captured text carries the typed prompt (an echo in a turn-level body) and false for the
//      ask-the-user exchange once the fallback has stripped the prompt out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { parseHtml, parseFragment } from './_dom.js'

const require = createRequire(import.meta.url)
const { createAdapter, DEFAULT_SELECTORS, toMarkdown, readText, readTextExcluding, isScreenReaderOnly, isUserTurn, exchangeChrome, SR_ONLY_CLASSES, USER_TURN_SELECTORS } = require('../../../preload/site.cjs')

/** A chatgpt-shaped page: a composer (so the session reads `ok`), an empty thread, a visible stop button. */
const PAGE = `<html><head><title>ChatGPT</title></head><body><div id="app">
  <main class="thread"></main>
  <form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"><p></p></div>
  <button data-testid="stop-button" aria-label="Stop answering">Stop</button></form>
</div></body></html>`

const PROMPT = 'Give me investment advice for a ten year horizon with moderate risk and no crypto.'
const WIDGET_TEXT = 'Before I answer, one optional question about your timeline.'
const WIDGET_LABEL = 'Asking question'
const ANSWER = 'The gyroscope full-scale range is selectable up to 2000 deg/s.'

/** The measured exchange group's USER half: the turn twice nested under a screen-reader-only "You said:". */
const userHalf = (prompt) =>
  `<div class="block-fake"><div class="group/user-message flex flex-col items-end gap-2"><h5 class="sr-only">You said:</h5>` +
  `<div class="group/user-message flex w-full flex-col gap-1 items-end"><div class="text-size-chat whitespace-pre-wrap">${prompt}</div></div></div></div>`
/** The ask-the-user reply half: a bare text element no `assistantText` entry matches, then the widget form. */
const widgetHalf = () =>
  `<div class="block-fake"><h6 class="sr-only">ChatGPT said:</h6><div class="group flex min-w-0 flex-col"><div class="text-size-chat relative overflow-visible">${WIDGET_TEXT}</div></div>` +
  `<form class="ask-user"><div class="ask-user-label">${WIDGET_LABEL}</div><input type="text"><button type="submit">Send answer</button></form></div>`
/** A finished reply half: the MarkdownRoot body the second `assistantText` entry matches, under its sr-only heading. */
const bodyHalf = (text) =>
  `<div class="block-fake"><h6 class="sr-only">ChatGPT said:</h6><div class="group flex min-w-0 flex-col"><div class="MarkdownRoot-abc"><p>${text}</p></div></div></div>`
const group = (...halves) => `<div class="group flex flex-col">${halves.join('')}</div>`

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

// --- 1. toMarkdown's exclude option ---------------------------------------------------------------

test('toMarkdown(el, {exclude}): an excluded element is left out with its subtree wherever the walk meets it — a block, a list item, a table cell, an inline, an image', () => {
  const html =
    `<div class="markdown"><p>keep</p><div class="drop"><p>gone</p><ul><li>gone too</li></ul></div><ul><li>a</li><li class="drop">b</li><li>c</li></ul>` +
    `<p>x <span class="drop">y</span> z</p><table><tr><td>1</td><td class="drop">2</td><td>3</td></tr></table><img class="drop" alt="dropped"><img alt="kept"></div>`
  const drop = (el) => el.matches('.drop')
  const out = toMarkdown(parseFragment(html), { exclude: drop })
  assert.equal(out.includes('gone'), false)
  assert.equal(out.includes('b'), false, 'the excluded list item')
  assert.equal(out.includes('2'), false, 'the excluded table cell')
  assert.equal(out.includes('y'), false, 'the excluded inline')
  assert.equal(out.includes('dropped'), false, 'the excluded image')
  assert.match(out, /^keep\n\n- a\n- c\n\nx\s+z\n\n\| 1 \| 3 \|\n\| --- \| --- \|\n\n!\[kept\]\(\)$/)
})

test('toMarkdown without exclude is byte-identical to before: no option, an empty option bag, a predicate that answers false, and a predicate that THROWS all render the same', () => {
  const html = `<div class="markdown"><h5 class="sr-only">You said:</h5><p>one <strong>two</strong></p><pre><code class="language-json">{"a": 1}</code></pre><ul><li>x</li></ul></div>`
  const plain = toMarkdown(parseFragment(html))
  assert.equal(plain, '##### You said:\n\none **two**\n\n```json\n{"a": 1}\n```\n\n- x')
  assert.equal(toMarkdown(parseFragment(html), {}), plain)
  assert.equal(toMarkdown(parseFragment(html), { exclude: () => false }), plain)
  assert.equal(toMarkdown(parseFragment(html), { exclude: 'not a function' }), plain)
  assert.equal(
    toMarkdown(parseFragment(html), {
      exclude: () => {
        throw new Error('boom')
      },
    }),
    plain,
    'a throwing predicate excludes nothing',
  )
  // the sr-only heading is CONTENT to the plain walk: only the exchange fallback drops it (pinned below)
  assert.equal(toMarkdown(parseFragment(html), { exclude: isScreenReaderOnly }), 'one **two**\n\n```json\n{"a": 1}\n```\n\n- x')
})

// --- 2. readTextExcluding -------------------------------------------------------------------------

test('readTextExcluding: without a predicate, or with nothing excluded underneath, it IS readText; with one it skips the excluded subtrees and joins the rest by newlines', () => {
  const el = parseFragment(`<div>a<span class="drop">b</span><p>c<i class="drop">d</i>e</p><p class="drop">f</p><p>g</p></div>`)
  const drop = (x) => x.matches('.drop')
  assert.equal(readText(el), 'abcdefg', 'the fake DOM reads textContent')
  assert.equal(readTextExcluding(el), readText(el))
  assert.equal(readTextExcluding(el, () => false), readText(el))
  assert.equal(readTextExcluding(parseFragment('<div>plain <b>bold</b></div>'), drop), 'plain bold', 'nothing excluded underneath: whole')
  assert.equal(readTextExcluding(el, drop), 'a\nc\ne\ng')
  assert.equal(readTextExcluding(null, drop), '')
  assert.equal(
    readTextExcluding(el, () => {
      throw new Error('boom')
    }),
    readText(el),
    'a throwing predicate excludes nothing',
  )
})

// --- 3./4. replyReading: the exchange fallback and its scope ----------------------------------------

test('the predicates: isScreenReaderOnly keys on the class tokens sr-only / visually-hidden only; isUserTurn on USER_TURN_SELECTORS; exchangeChrome is their union', () => {
  assert.deepEqual([...SR_ONLY_CLASSES], ['sr-only', 'visually-hidden'])
  assert.equal(isScreenReaderOnly(parseFragment('<h5 class="sr-only">You said:</h5>')), true)
  assert.equal(isScreenReaderOnly(parseFragment('<span class="visually-hidden">x</span>')), true)
  assert.equal(isScreenReaderOnly(parseFragment('<div class="not-sr-only focus-within:not-sr-only">x</div>')), false, 'a token that merely contains it')
  assert.equal(isScreenReaderOnly(parseFragment('<div class="sr-only-ish">x</div>')), false)
  assert.equal(isScreenReaderOnly(parseFragment('<div>x</div>')), false)
  assert.equal(isScreenReaderOnly(null), false)
  for (const selector of USER_TURN_SELECTORS) {
    const attr = /^\[([a-z-]+)~?='(.+?)'\]$/.exec(selector)
    const html = attr[1] === 'class' ? `<div class="${attr[2]} flex">x</div>` : `<div ${attr[1]}="${attr[2]}">x</div>`
    assert.equal(isUserTurn(parseFragment(html)), true, selector)
  }
  assert.equal(isUserTurn(parseFragment('<article data-message-author-role="assistant">x</article>')), false)
  assert.equal(isUserTurn(null), false)
  assert.equal(exchangeChrome(parseFragment('<h5 class="sr-only">x</h5>')), true)
  assert.equal(exchangeChrome(parseFragment('<div class="group/user-message">x</div>')), true)
  assert.equal(exchangeChrome(parseFragment('<p>x</p>')), false)
})

test('an EXCHANGE container with no reply body: \'\' while the stop control is up (unchanged); once it is gone, the exchange WITHOUT its user turn and its sr-only chrome — the prompt is never the answer', () => {
  const { doc, adapter, thread, stop } = setup()
  const container = mount(doc, thread, group(userHalf(PROMPT), widgetHalf()))
  assert.deepEqual(adapter.assistantContainers(), [container], 'the group is the first assistant entry (it holds the user turn)')
  // the stop control is up: the reply has not started — '' as before
  assert.deepEqual(adapter.replyReading(container), { text: '', bodyMatched: false, heldUserTurn: true })
  assert.equal(adapter.replyText(container), '')
  stop.remove()
  const reading = adapter.replyReading(container)
  assert.deepEqual(reading, { text: `${WIDGET_TEXT}\n\n${WIDGET_LABEL}`, bodyMatched: false, heldUserTurn: true })
  assert.equal(reading.text.includes(PROMPT), false, 'the user turn is out')
  assert.equal(reading.text.includes('You said'), false, 'the sr-only heading over the user turn is out')
  assert.equal(reading.text.includes('said:'), false, 'the sr-only heading over the reply is out too')
  assert.equal(adapter.replyText(container), reading.text)
  // the plain render of the same node — what the fallback USED to return — carries both
  const plain = toMarkdown(container)
  assert.ok(plain.includes(PROMPT) && plain.includes('##### You said:'), plain)
  assert.equal(adapter.exchangeText(container), reading.text)
})

test('scope pin: a matched BODY block keeps its sr-only text (the body-matched path is untouched), and a TURN-LEVEL container with no body reads byte for byte as before, sr-only heading and all', () => {
  const { doc, adapter, thread, stop } = setup()
  stop.remove()
  // (a) a body match in the exchange: the body, sr-only text inside it INCLUDED, nothing from the user half
  const withBody = mount(doc, thread, group(userHalf(PROMPT), `<div class="block-fake"><div class="group flex min-w-0 flex-col"><div class="MarkdownRoot-abc"><span class="sr-only">hidden label</span><p>${ANSWER}</p></div></div></div>`))
  const body = adapter.replyReading(withBody)
  assert.deepEqual(body, { text: `hidden label\n\n${ANSWER}`, bodyMatched: true, heldUserTurn: true })
  assert.equal(body.text.includes(PROMPT), false)
  withBody.remove()
  // (b) a turn-level container (the article layout) with no body: the whole turn, exactly as today
  const turn = mount(doc, thread, `<article data-message-author-role="assistant"><h6 class="sr-only">ChatGPT said:</h6><div class="text-size-chat">${WIDGET_TEXT}</div></article>`)
  const level = adapter.replyReading(turn)
  assert.deepEqual(level, { text: `###### ChatGPT said:\n\n${WIDGET_TEXT}`, bodyMatched: false, heldUserTurn: false })
  assert.equal(level.text, toMarkdown(turn), 'byte for byte the plain render')
  assert.equal(adapter.replyText(turn), level.text)
  turn.remove()
  // (c) a turn-level container WITH a body: the body only, as today
  const turnBody = mount(doc, thread, `<article data-message-author-role="assistant"><h6 class="sr-only">ChatGPT said:</h6><div class="markdown"><p>${ANSWER}</p></div></article>`)
  assert.deepEqual(adapter.replyReading(turnBody), { text: ANSWER, bodyMatched: true, heldUserTurn: false })
})

test('the readText fallback of the exchange read honours the same predicate: a container the markdown walk cannot read (no block children) still drops the user turn', () => {
  const { doc, adapter, thread, stop } = setup()
  stop.remove()
  // a group whose only children are an excluded user turn and an INLINE text node: the markdown render of the
  // remainder is a bare paragraph — fine — so force the walk blank with an inline the walk skips (a button)
  const container = mount(doc, thread, group(userHalf(PROMPT), `<button>${WIDGET_LABEL}</button>`))
  const reading = adapter.replyReading(container)
  assert.equal(reading.bodyMatched, false)
  assert.equal(reading.heldUserTurn, true)
  assert.equal(reading.text.includes(PROMPT), false, 'the rendered-text fallback leaves the user turn out too')
  assert.equal(reading.text, WIDGET_LABEL, 'readText (textContent here) of what is left')
})

// --- 5. the observe result's flags -----------------------------------------------------------------

test('observe over the ask-the-user lifecycle: the exchange mounts with the user turn, the widget turn mounts with no body, the stop goes → stop_gone with the widget text only; bodyMatched false, heldUserTurn true, echoesPrompt false', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 10000, text: PROMPT }))
  // the submit tick: the exchange group is on the page with the user turn only, the stop control up
  const exchange = mount(doc, thread, group(userHalf(PROMPT)))
  await clock.advance(1000)
  assert.equal(state.done, false)
  // the model's line and its widget mount into the SAME group; no MarkdownRoot, no done marker
  mount(doc, exchange, widgetHalf())
  await clock.advance(600)
  assert.equal(state.done, false, 'still streaming: the stop control is visible')
  stop.remove()
  await clock.advance(2000) // one chatgpt settle window (settleMs 1200) past the vanished control
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.deepEqual(Object.keys(state.value).sort(), ['bodyMatched', 'doneBy', 'echoesPrompt', 'heldUserTurn', 'ms', 'text'])
  assert.equal(state.value.doneBy, 'stop_gone')
  assert.equal(state.value.text, `${WIDGET_TEXT}\n\n${WIDGET_LABEL}`)
  assert.equal(state.value.text.includes(PROMPT), false, 'never the prompt')
  assert.equal(state.value.text.includes('You said'), false)
  assert.deepEqual([state.value.bodyMatched, state.value.heldUserTurn, state.value.echoesPrompt], [false, true, false])
})

test('echoesPrompt is true when the captured text carries the typed prompt (an echo in a turn-level body; the probes over the projection), and the other two flags describe a body-matched turn-level read', async () => {
  const { doc, clock, adapter, thread, stop } = setup()
  const state = settled(adapter.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 10000, text: PROMPT }))
  mount(doc, thread, `<article data-message-author-role="user">${PROMPT}</article>`)
  const turn = mount(doc, thread, `<article data-message-author-role="assistant"><div class="markdown"><p>Echo: ${PROMPT}</p></div></article>`)
  await clock.advance(600)
  stop.remove()
  mount(doc, turn, '<button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button>')
  await clock.advance(2000)
  assert.equal(state.error, null)
  assert.equal(state.done, true)
  assert.equal(state.value.text, `Echo: ${PROMPT}`)
  assert.equal(state.value.doneBy, 'done_selector')
  assert.deepEqual([state.value.bodyMatched, state.value.heldUserTurn, state.value.echoesPrompt], [true, false, true])
})

test('the SAME ask-the-user exchange, read WITHOUT the fallback strip, would echo the prompt — so echoesPrompt is the net the strip removes the need for, and false is the strip working; with no typed text the flag is false', async () => {
  // the whole-exchange text, as the old fallback returned it, projected against the prompt's probes
  const { adapter, doc, thread, stop } = setup()
  stop.remove()
  const exchange = mount(doc, thread, group(userHalf(PROMPT), widgetHalf()))
  const { anchorProbes, anchorMatches } = require('../../../preload/site.cjs')
  assert.equal(anchorMatches(anchorProbes(PROMPT), toMarkdown(exchange)), true, 'the old read carried the prompt')
  assert.equal(anchorMatches(anchorProbes(PROMPT), adapter.replyText(exchange)), false, 'the new read does not')
  exchange.remove()
  // no typed text: nothing to echo
  const { doc: doc2, clock, adapter: a2, thread: t2, stop: stop2 } = setup()
  const state = settled(a2.observe({ baselineCount: 0, timeoutMs: 60000, firstTokenMs: 5000, quietMs: 10000 }))
  const turn = mount(doc2, t2, `<article data-message-author-role="assistant"><div class="markdown"><p>${ANSWER}</p></div></article>`)
  await clock.advance(600)
  stop2.remove()
  mount(doc2, turn, '<button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button>')
  await clock.advance(2000)
  assert.equal(state.done, true)
  assert.deepEqual([state.value.bodyMatched, state.value.heldUserTurn, state.value.echoesPrompt], [true, false, false])
})
