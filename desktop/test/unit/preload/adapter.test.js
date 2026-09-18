// createAdapter over a fake document (no jsdom): health shape, the session-state order, the
// selector fallbacks, waitForComposer / ready / insertAndSubmit gates, countAssistant, the
// insertion cascade's verification and "never innerHTML/textContent", submit's confirmation rules
// and error codes; Stage 2: observe (first token, done-selector / stop-gone / quiet, timeout with
// a partial, banner → site_error with the phrase only, wall, cancel, document order, text rules,
// the settle sample after an end signal, stop-over-done, opacity-0 / pointer-events:none markers,
// one shadow-root walk per sample, the mutation-tick / poll split), snapshot, the config re-merge
// and the boot IPC choice. Timeouts are shortened through a selectors block; timers are real (no
// MutationObserver under node unless a test injects one through `window`: observe then runs on
// its 300 ms poll alone).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAdapter, AdapterError, DEFAULT_SELECTORS, MESSAGE_SELECTORS, ASSISTANT_SELECTORS, ALERT_SELECTORS, scrubDom, OBSERVE_POLL_MS, OBSERVE_THROTTLE_MS, pickIpc, shouldBoot, boot } =
  require('../../../preload/site.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A fake document: `match` maps a selector to an element or a list; '*' lists nothing (no shadow
 * roots). `body.innerText`, `title` and `location` are plain fields the tests mutate.
 */
function fakeDocument({ title = 'ChatGPT', href = 'https://chatgpt.com/', hostname = 'chatgpt.com', bodyText = '', match = {} } = {}) {
  const doc = {
    title,
    body: { innerText: bodyText },
    location: { href, hostname },
    match,
    queried: [],
    querySelector(s) {
      doc.queried.push(s)
      const v = doc.match[s]
      return Array.isArray(v) ? v[0] || null : v || null
    },
    querySelectorAll(s) {
      if (s === '*') return []
      const v = doc.match[s]
      return v === undefined ? [] : Array.isArray(v) ? v : [v]
    },
  }
  return doc
}

/** A contenteditable look-alike that refuses innerHTML/textContent writes and records focus calls. */
function fakeComposer({ tagName = 'DIV', text = '' } = {}) {
  const el = {
    tagName,
    focused: 0,
    events: [],
    _text: text,
    focus() {
      el.focused += 1
    },
    dispatchEvent(ev) {
      el.events.push(ev && ev.type)
      return true
    },
    get innerText() {
      return el._text
    },
    get textContent() {
      return el._text
    },
    set textContent(_v) {
      throw new Error('textContent write is forbidden')
    },
    set innerHTML(_v) {
      throw new Error('innerHTML write is forbidden')
    },
  }
  return el
}

function fakeTextarea(initial = '') {
  const el = {
    tagName: 'TEXTAREA',
    value: initial,
    focused: 0,
    events: [],
    focus() {
      el.focused += 1
    },
    dispatchEvent(ev) {
      el.events.push(ev && ev.type)
      return true
    },
  }
  return el
}

const FAST = { composerWaitMs: 300, sendWaitMs: 300, submitVerifyMs: 200 }
const fastSelectors = (site, extra = {}) => ({ ...DEFAULT_SELECTORS, [site]: { ...DEFAULT_SELECTORS[site], ...FAST, ...extra } })

const rejects = async (promise, code, messageRe) => {
  let err = null
  try {
    await promise
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof AdapterError, `expected an AdapterError, got ${err}`)
  assert.equal(err.code, code)
  if (messageRe) assert.match(err.message, messageRe)
  return err
}

test('createAdapter requires a document and defaults to the site block of DEFAULT_SELECTORS', () => {
  assert.throws(() => createAdapter({}), /document is required/)
  const doc = fakeDocument({ match: { "textarea[aria-label='Ask Grok anything']": fakeTextarea() } })
  const a = createAdapter({ document: doc, site: 'grok' })
  assert.equal(a.site, 'grok')
  assert.equal(a.findComposer().selector, "textarea[aria-label='Ask Grok anything']")
  const b = createAdapter({ document: doc, site: 'grok', selectors: DEFAULT_SELECTORS.grok })
  assert.equal(b.findComposer().selector, "textarea[aria-label='Ask Grok anything']")
  const c = createAdapter({ document: doc, site: 'grok', selectors: { grok: { composer: ['textarea'], send: [] } } })
  assert.equal(c.findComposer(), null)
})

test('health(): the contract §1 shape, matched.error null, integer ts from the injected clock', () => {
  const composer = fakeComposer()
  const send = {}
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, "button[data-testid='send-button']": send } })
  const a = createAdapter({ document: doc, site: 'chatgpt', now: () => 1234.6 })
  const h = a.health()
  assert.deepEqual(h, {
    composer: true,
    send: true,
    reply: false, // selectors v2: an assistant container exists (none here)
    stop: false, // selectors v2: a visible stop button (none here); null only without a stop cascade
    session: 'ok',
    matched: { composer: '#prompt-textarea', send: "button[data-testid='send-button']", reply: null, stop: null, error: null },
    url: 'https://chatgpt.com/',
    host: 'chatgpt.com',
    title: 'ChatGPT',
    ts: 1235,
  })
  assert.ok(Number.isInteger(h.ts))
  assert.equal(a.url(), 'https://chatgpt.com/')
})

test('health() with nothing on the page: unknown session, nulls everywhere, still integers', () => {
  const doc = fakeDocument({ title: '', href: '', hostname: '', match: {} })
  const a = createAdapter({ document: doc, site: 'claude', now: () => NaN })
  const h = a.health()
  assert.equal(h.composer, false)
  assert.equal(h.send, false)
  assert.equal(h.session, 'unknown')
  assert.deepEqual(h.matched, { composer: null, send: null, reply: null, stop: null, error: null })
  assert.equal(h.ts, 0)
})

test('findComposer reports the cascade entry that matched, not the first one', () => {
  const el = fakeComposer()
  const doc = fakeDocument({ match: { "div[contenteditable='true'][role='textbox']": el } })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.deepEqual(a.findComposer(), { el, selector: "div[contenteditable='true'][role='textbox']" })
})

test('sessionState(): loggedOutUrl → challengeTitle → challenge → loggedOut → errorText → ok/unknown', () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': composer }, bodyText: 'Something went wrong is mentioned in a reply' })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.equal(a.sessionState(), 'ok') // body text is chat content, never a banner
  doc.match["[role='alert']"] = { innerText: 'Oops. You\'ve reached our limit of messages.' }
  assert.equal(a.sessionState(), 'blocked')
  doc.match["[role='alert']"] = { innerText: 'UNUSUAL ACTIVITY HAS BEEN DETECTED from your device' } // case-insensitive
  assert.equal(a.sessionState(), 'blocked')
  doc.match["a[href*='/auth/login']"] = {}
  assert.equal(a.sessionState(), 'logged_out') // a login link outranks error text
  doc.match["iframe[src*='challenges.cloudflare.com']"] = {}
  assert.equal(a.sessionState(), 'challenge') // a challenge outranks the login link
  doc.title = 'Just a moment...'
  delete doc.match["iframe[src*='challenges.cloudflare.com']"]
  assert.equal(a.sessionState(), 'challenge') // the title alone is enough
  doc.location.href = 'https://auth.openai.com/log-in'
  assert.equal(a.sessionState(), 'logged_out') // the URL outranks everything
  const empty = createAdapter({ document: fakeDocument({ match: {} }), site: 'chatgpt' })
  assert.equal(empty.sessionState(), 'unknown')
})

test('countMessages(): distinct elements over the generic message selectors (+ a v2 assistant cascade), 0 when none', () => {
  const shared = {}
  const doc = fakeDocument({ match: {} })
  const a = createAdapter({ document: doc, site: 'claude' })
  assert.equal(a.countMessages(), 0)
  doc.match['[data-message-author-role]'] = [shared, {}]
  doc.match['.font-claude-response'] = [shared]
  assert.equal(a.countMessages(), 2)
  assert.ok(MESSAGE_SELECTORS.includes('[data-message-author-role]'))
  const b = createAdapter({ document: doc, site: 'claude', selectors: { ...DEFAULT_SELECTORS.claude, assistant: ['.custom-turn'] } })
  doc.match['.custom-turn'] = [{}, {}]
  assert.equal(b.countMessages(), 4)
})

test('countAssistant(): assistant-role containers only — a user turn is never counted (+ a v2 assistant cascade)', () => {
  const userEl = { getAttribute: (n) => (n === 'data-message-author-role' ? 'user' : null) }
  const doc = fakeDocument({ match: { '[data-message-author-role]': [userEl], '.message-bubble': [{}, {}], "[data-testid='user-message']": [{}] } })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.equal(a.countAssistant(), 0)
  assert.equal(a.countMessages(), 4)
  const assistantEl = { getAttribute: (n) => (n === 'data-message-author-role' ? 'assistant' : null) }
  doc.match["[data-message-author-role='assistant']"] = [assistantEl]
  doc.match['[data-message-author-role]'] = [userEl, assistantEl]
  assert.equal(a.countAssistant(), 1)
  assert.equal(a.countMessages(), 5)
  const shared = {}
  doc.match['.font-claude-response'] = [shared]
  doc.match['.font-claude-message'] = [shared]
  doc.match["div[id^='response-']"] = [{}]
  assert.equal(a.countAssistant(), 3) // de-duplicated across the assistant selectors
  assert.deepEqual([...ASSISTANT_SELECTORS], ["[data-message-author-role='assistant']", '.font-claude-response', '.font-claude-message', "div[id^='response-']"])
  assert.ok(ASSISTANT_SELECTORS.every((s) => !MESSAGE_SELECTORS.includes(s) || s !== '[data-message-author-role]'))
  const b = createAdapter({ document: doc, site: 'chatgpt', selectors: { ...DEFAULT_SELECTORS.chatgpt, assistant: ['.custom-turn'] } })
  doc.match['.custom-turn'] = [{}, {}]
  assert.equal(b.countAssistant(), 5)
})

test('waitForComposer resolves once the composer appears, rejects composer_not_found on timeout, cancelled on abort', async () => {
  const doc = fakeDocument({ match: {} })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  const el = fakeComposer()
  setTimeout(() => {
    doc.match['#prompt-textarea'] = el
  }, 120)
  const found = await a.waitForComposer(1000)
  assert.deepEqual(found, { el, selector: '#prompt-textarea' })

  const empty = createAdapter({ document: fakeDocument({ match: {} }), site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  const t0 = Date.now()
  await rejects(empty.waitForComposer(), 'composer_not_found', /300 ms/)
  assert.ok(Date.now() - t0 >= 250)
  await rejects(empty.waitForComposer(50), 'composer_not_found', /50 ms/)

  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  await rejects(empty.waitForComposer(2000, { signal: ac.signal }), 'cancelled')
})

test('ready: rejects a wall state before polling, waits for the composer, times out while a stop button is visible', async () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, "a[href*='/auth/login']": {} } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  await rejects(a.ready(1000), 'logged_out', /login wall/)
  delete doc.match["a[href*='/auth/login']"]
  assert.deepEqual(await a.ready(1000), { el: composer, selector: '#prompt-textarea' })

  const slow = fakeDocument({ match: {} })
  const b = createAdapter({ document: slow, site: 'grok', selectors: fastSelectors('grok') })
  setTimeout(() => {
    slow.match["textarea[aria-label='Ask Grok anything']"] = fakeTextarea()
  }, 100)
  assert.equal((await b.ready(1000)).selector, "textarea[aria-label='Ask Grok anything']")
  await rejects(createAdapter({ document: fakeDocument({ match: {} }), site: 'grok', selectors: fastSelectors('grok') }).ready(80), 'composer_not_found')

  const busy = fakeDocument({ match: { '#prompt-textarea': composer, 'button.stop': {} } })
  const c = createAdapter({ document: busy, site: 'chatgpt', selectors: fastSelectors('chatgpt', { stop: ['button.stop'] }) })
  await rejects(c.ready(150), 'timeout', /stop button/)
  assert.equal(c.health().stop, true)
  assert.equal(c.health().matched.stop, 'button.stop')
})

test('insertAndSubmit rejects empty text and every wall state without touching the composer', async () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, "[role='alertdialog']": { innerText: 'Something went wrong' } } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  await rejects(a.insertAndSubmit(''), 'site_error', /non-empty/)
  await rejects(a.insertAndSubmit(42), 'site_error')
  await rejects(a.insertAndSubmit('hello'), 'blocked', /unusual activity|error banner/)
  delete doc.match["[role='alertdialog']"]
  doc.title = 'Just a moment...'
  await rejects(a.insertAndSubmit('hello'), 'challenge')
  doc.title = 'ChatGPT'
  doc.match["button[data-testid='login-button']"] = {}
  await rejects(a.insertAndSubmit('hello'), 'logged_out')
  assert.equal(composer.focused, 0)
  assert.deepEqual(composer.events, [])
  assert.equal(composer._text, '')
})

test('insertAndSubmit with no composer at all → composer_not_found after composerWaitMs', async () => {
  const a = createAdapter({ document: fakeDocument({ match: {} }), site: 'claude', selectors: fastSelectors('claude') })
  await rejects(a.insertAndSubmit('hello'), 'composer_not_found')
})

test('insertText on a text field: appends through the value setter, dispatches input, verifies (nativeValue)', async () => {
  const ta = fakeTextarea('draft ')
  const doc = fakeDocument({ match: { "textarea[aria-label='Ask Grok anything']": ta } })
  const a = createAdapter({ document: doc, site: 'grok', selectors: fastSelectors('grok') })
  assert.deepEqual(await a.insertText('hello `x` ${y}\nline 2 🚀'), { method: 'nativeValue' })
  assert.equal(ta.value, 'draft hello `x` ${y}\nline 2 🚀')
  assert.equal(ta.focused, 1)
  assert.deepEqual(ta.events, ['input'])
})

test('insertText on a contenteditable never writes innerHTML/textContent; when nothing lands it fails site_error naming both methods', async () => {
  const el = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': el } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  const err = await rejects(a.insertText('hello'), 'site_error', /execCommand/)
  assert.match(err.message, /paste/)
  assert.equal(el._text, '') // untouched: the fake forbids innerHTML/textContent writes and none was attempted
  await rejects(a.insertText(null), 'site_error', /must be a string/)
})

test('insertText succeeds through execCommand when the document supports it (fake Range/Selection/execCommand)', async () => {
  const el = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': el } })
  const calls = []
  doc.createRange = () => ({
    selectNodeContents: (n) => calls.push(['selectNodeContents', n === el]),
    collapse: (toStart) => calls.push(['collapse', toStart]),
  })
  doc.getSelection = () => ({ removeAllRanges: () => calls.push(['removeAllRanges']), addRange: () => calls.push(['addRange']) })
  doc.execCommand = (cmd, ui, text) => {
    calls.push(['execCommand', cmd, ui])
    el._text += text
    return true
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  assert.deepEqual(await a.insertText('typed text'), { method: 'execCommand' })
  assert.deepEqual(calls, [['selectNodeContents', true], ['collapse', false], ['removeAllRanges'], ['addRange'], ['execCommand', 'insertText', false]])
  assert.equal(el.focused, 1)
  assert.deepEqual(el.events, ['input'])
  assert.equal(el._text, 'typed text')
})

test('submit: click confirmed by a grown MESSAGE count (contract name assistant_count); assistantCount is the assistant-only sample before the click', async () => {
  const composer = fakeComposer({ text: 'ready to go' })
  const assistantEl = {}
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, '[data-message-author-role]': [{}, assistantEl], "[data-message-author-role='assistant']": [assistantEl] } })
  const button = {
    click() {
      doc.match['[data-message-author-role]'].push({}) // the user's own turn appears: that confirms the submission
    },
  }
  doc.match["button[data-testid='send-button']"] = button
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  const r = await a.submit()
  assert.deepEqual(r, { method: 'click', sendSelector: "button[data-testid='send-button']", confirmedBy: 'assistant_count', assistantCount: 1 })
  assert.equal(a.countMessages(), 3)
  assert.equal(a.countAssistant(), 1) // the appended user turn is not an assistant turn
})

test('submit: a click that empties the composer is confirmed composer_cleared; a stop button wins over both', async () => {
  const composer = fakeComposer({ text: 'ready to go' })
  const doc = fakeDocument({ match: { '#prompt-textarea': composer } })
  doc.match["button[aria-label='Send prompt']"] = {
    click() {
      composer._text = ''
    },
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  assert.deepEqual(await a.submit(), { method: 'click', sendSelector: "button[aria-label='Send prompt']", confirmedBy: 'composer_cleared', assistantCount: 0 })

  const composer2 = fakeComposer({ text: 'ready to go' })
  const doc2 = fakeDocument({ match: { '#prompt-textarea': composer2 } })
  doc2.match['#composer-submit-button'] = {
    click() {
      composer2._text = ''
      doc2.match['button.stop'] = {}
    },
  }
  const b = createAdapter({ document: doc2, site: 'chatgpt', selectors: fastSelectors('chatgpt', { stop: ['button.stop'] }) })
  assert.equal((await b.submit()).confirmedBy, 'stop_button')
})

test('submit skips disabled / aria-disabled / hidden buttons and waits for an enabled one (150 ms polling)', async () => {
  const composer = fakeComposer({ text: 'ready' })
  const disabled = { disabled: true, click: () => assert.fail('disabled button clicked') }
  const ariaDisabled = { getAttribute: (n) => (n === 'aria-disabled' ? 'true' : null), click: () => assert.fail('aria-disabled button clicked') }
  const hidden = { getClientRects: () => [], click: () => assert.fail('hidden button clicked') }
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, "button[data-testid='send-button']": [disabled, ariaDisabled, hidden] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt', { sendWaitMs: 1000 }) })
  let clicked = 0
  setTimeout(() => {
    disabled.disabled = false
    disabled.click = () => {
      clicked += 1
      composer._text = ''
    }
  }, 200)
  const t0 = Date.now()
  const r = await a.submit()
  assert.equal(r.method, 'click')
  assert.equal(clicked, 1)
  assert.ok(Date.now() - t0 >= 150)
})

test('submit: no button → one Enter (keydown/keypress/keyup, composed) on the composer; confirmed → method enter, sendSelector null', async () => {
  // Node has no KeyboardEvent; the fake window supplies one that keeps the init dict, so the
  // key/code/keyCode/composed the adapter sends can be asserted.
  class FakeKeyboardEvent extends Event {
    constructor(type, init) {
      super(type, init)
      Object.assign(this, { key: init.key, code: init.code, keyCode: init.keyCode, which: init.which, charCode: init.charCode })
    }
  }
  const composer = fakeComposer({ text: 'ready' })
  const seen = []
  composer.dispatchEvent = (ev) => {
    composer.events.push(ev.type)
    seen.push({ type: ev.type, key: ev.key, code: ev.code, keyCode: ev.keyCode, which: ev.which, charCode: ev.charCode, composed: ev.composed, bubbles: ev.bubbles, cancelable: ev.cancelable })
    if (ev.type === 'keydown') composer._text = ''
    return true
  }
  const doc = fakeDocument({ match: { '#prompt-textarea': composer } })
  const a = createAdapter({ document: doc, window: { KeyboardEvent: FakeKeyboardEvent }, site: 'chatgpt', selectors: fastSelectors('chatgpt', { sendWaitMs: 100 }) })
  const r = await a.submit()
  assert.deepEqual(r, { method: 'enter', sendSelector: null, confirmedBy: 'composer_cleared', assistantCount: 0 })
  assert.deepEqual(composer.events, ['keydown', 'keypress', 'keyup'])
  assert.deepEqual(seen, [
    { type: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 0, composed: true, bubbles: true, cancelable: true },
    { type: 'keypress', key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, composed: true, bubbles: true, cancelable: true },
    { type: 'keyup', key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 0, composed: true, bubbles: true, cancelable: true },
  ])
  assert.equal(composer.focused, 1)
})

test('submit: the assistantCount handed to main is the sample taken BEFORE the first attempt — a container that appears while a confirmation is being awaited never RAISES the observe baseline', async () => {
  const composer = fakeComposer({ text: 'ready' })
  const assistant = []
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, "[data-message-author-role='assistant']": assistant } })
  // The click lands but nothing the CONFIRMATION watches sees it within submitVerifyMs: no stop button,
  // the composer keeps its text, and `countMessages()` — which reads `[data-message-author-role]` under
  // this v1-shaped config (`assistant: []`, no v2 cascade) — never grows. What DOES appear is chatgpt's
  // short placeholder assistant turn (measured ~1 s after a submit, 2026-09-17), which only
  // `countAssistant()` reads here. It must not move the observe baseline: the placeholder is unmounted
  // again and the real reply remounts at the SAME count, so a baseline of 1 makes the capture answer
  // reply_not_found with the answer on screen.
  doc.match["button[data-testid='send-button']"] = {
    click() {
      setTimeout(() => assistant.push({}), 20)
    },
  }
  composer.dispatchEvent = (ev) => {
    composer.events.push(ev && ev.type)
    if (ev && ev.type === 'keydown') composer._text = '' // the Enter fallback is what finally confirms
    return true
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt', { submitVerifyMs: 150, assistant: [] }) })
  const r = await a.submit()
  assert.equal(a.countAssistant(), 1) // the placeholder really is on the page by the time the Enter branch ran
  assert.deepEqual(r, { method: 'enter', sendSelector: "button[data-testid='send-button']", confirmedBy: 'composer_cleared', assistantCount: 0 })
})

test('submit: a container that went AWAY while the click was being confirmed lowers the baseline (the sample is the minimum, never the later, higher one)', async () => {
  const composer = fakeComposer({ text: 'ready' })
  const assistant = [{}, {}]
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, "[data-message-author-role='assistant']": assistant } })
  doc.match["button[data-testid='send-button']"] = {
    click() {
      setTimeout(() => assistant.pop(), 20) // the site unmounts a turn mid-flight (the measured lifecycle)
    },
  }
  composer.dispatchEvent = (ev) => {
    composer.events.push(ev && ev.type)
    if (ev && ev.type === 'keydown') composer._text = ''
    return true
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt', { submitVerifyMs: 150, assistant: [] }) })
  const r = await a.submit()
  assert.equal(a.countAssistant(), 1)
  assert.equal(r.assistantCount, 1) // not the 2 sampled before the click: observe must not wait for a third container
})

test('submit: nothing confirms → send_not_found without a button, not_submitted after a click; the composer keeps its text', async () => {
  const composer = fakeComposer({ text: 'still here' })
  const doc = fakeDocument({ match: { '#prompt-textarea': composer } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt', { sendWaitMs: 100, submitVerifyMs: 50 }) })
  await rejects(a.submit(), 'send_not_found', /100 ms/)
  assert.equal(composer._text, 'still here')

  let clicks = 0
  doc.match["button[data-testid='send-button']"] = {
    click() {
      clicks += 1
    },
  }
  await rejects(a.submit(), 'not_submitted', /button\[data-testid='send-button'\]/)
  assert.equal(clicks, 1)
  assert.equal(composer._text, 'still here')
  assert.ok(composer.events.includes('keydown')) // the Enter fallback was tried after the click
})

test('submit honours an explicit timeoutMs and the abort signal', async () => {
  const composer = fakeComposer({ text: 'x' })
  const doc = fakeDocument({ match: { '#prompt-textarea': composer } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt', { sendWaitMs: 5000, submitVerifyMs: 30 }) })
  const t0 = Date.now()
  await rejects(a.submit(60), 'send_not_found', /60 ms/)
  assert.ok(Date.now() - t0 < 2000)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  await rejects(a.submit(5000, { signal: ac.signal }), 'cancelled')
})

test('insertAndSubmit end to end over the fake document: integer ms, composerSelector and assistantCount from the samples', async () => {
  const ta = fakeTextarea('')
  const doc = fakeDocument({ match: { "textarea[aria-label='Ask Grok anything']": ta, '.message-bubble': [{}, {}, {}], "div[id^='response-']": [{}, {}] } })
  doc.match["button[aria-label='Submit']"] = {
    click() {
      doc.match['.message-bubble'].push({})
      ta.value = ''
    },
  }
  let t = 1000
  const a = createAdapter({ document: doc, site: 'grok', selectors: fastSelectors('grok'), now: () => (t += 0.5) })
  const r = await a.insertAndSubmit('go')
  assert.equal(r.submitted, true)
  assert.equal(r.composerSelector, "textarea[aria-label='Ask Grok anything']")
  assert.equal(r.sendSelector, "button[aria-label='Submit']")
  assert.equal(r.assistantCount, 2)
  assert.ok(['composer_cleared', 'assistant_count'].includes(r.confirmedBy))
  assert.ok(Number.isInteger(r.ms) && r.ms > 0)
  assert.deepEqual(Object.keys(r).sort(), ['assistantCount', 'composerSelector', 'confirmedBy', 'ms', 'sendSelector', 'submitted'])
})

test('health(): reply/stop reflect the v2 cascades — reply true with an assistant container (matched.reply names the entry), stop true with a visible stop button, stop null without a stop cascade', () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': composer } })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.deepEqual([a.health().reply, a.health().stop], [false, false])
  doc.match["[data-message-author-role='assistant']"] = [{}]
  doc.match["button[aria-label='Stop streaming']"] = [{}]
  const h = a.health()
  assert.deepEqual([h.reply, h.stop], [true, true])
  assert.deepEqual([h.matched.reply, h.matched.stop], ["[data-message-author-role='assistant']", "button[aria-label='Stop streaming']"])
  doc.match["button[aria-label='Stop streaming']"] = [{ getClientRects: () => [] }] // hidden: not a visible stop button
  assert.equal(a.health().stop, false)
  const b = createAdapter({ document: doc, site: 'chatgpt', selectors: { composer: ['#prompt-textarea'], send: [] } }) // a bare block without a stop cascade
  assert.equal(b.health().stop, null)
  assert.equal(b.health().reply, true) // ASSISTANT_SELECTORS still count without a v2 cascade
})

test('setSelectors swaps the cascade in place (config hot reload) and ignores garbage', () => {
  const el = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': el, '#other': el } })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.equal(a.findComposer().selector, '#prompt-textarea')
  a.setSelectors({ ...DEFAULT_SELECTORS, chatgpt: { ...DEFAULT_SELECTORS.chatgpt, composer: ['#other'] } })
  assert.equal(a.findComposer().selector, '#other')
  a.setSelectors('garbage')
  assert.equal(a.findComposer().selector, '#other')
  a.setSelectors({ composer: ['#prompt-textarea'], send: [] })
  assert.equal(a.findComposer().selector, '#prompt-textarea')
})

test('an invalid selector string in a cascade is skipped, never thrown', async () => {
  const el = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': el } })
  const bad = 'div[unclosed'
  doc.querySelector = (s) => {
    if (s === bad) throw new SyntaxError('invalid selector')
    return doc.match[s] || null
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: { ...DEFAULT_SELECTORS.chatgpt, composer: [bad, '', 42, '#prompt-textarea'] } })
  assert.equal(a.findComposer().selector, '#prompt-textarea')
  assert.equal(a.health().session, 'ok')
  await sleep(0)
})

// ---------------------------------------------------------------------------------------------
// Review fixes (S5): session detection scoped to walls and banners, never chat content
// ---------------------------------------------------------------------------------------------

/** An element that reports itself inside a chat message container (MESSAGE_SELECTORS). */
const inMessage = (el = {}) => Object.assign(el, { closest: (s) => (s.includes('[data-message-author-role]') ? {} : null) })

test('session detection ignores chat content: rate-limit text in the thread/body and a /login link inside a message keep the session ok', async () => {
  const composer = fakeComposer()
  const doc = fakeDocument({
    title: 'Claude',
    href: 'https://claude.ai/chat/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
    hostname: 'claude.ai',
    bodyText: 'User: how do I handle an API rate limit?\nClaude: A rate limit is a cap on requests. Unusual activity would be a banner.',
    match: {
      "div[contenteditable='true'].ProseMirror": composer,
      "a[href*='/login']": [inMessage({ href: 'https://github.com/login' })],
      "[role='alert']": [inMessage({ innerText: 'a quoted banner: rate limit reached' })],
      '[data-message-author-role]': [{}, {}],
    },
  })
  const a = createAdapter({ document: doc, site: 'claude', selectors: fastSelectors('claude') })
  assert.equal(a.sessionState(), 'ok')
  assert.equal(a.health().session, 'ok')
  assert.deepEqual(await a.ready(200), { el: composer, selector: "div[contenteditable='true'].ProseMirror" })
  // the same link and banner OUTSIDE the thread are a wall / a banner
  doc.match["[role='alert']"] = [{ innerText: 'You have hit the rate limit for this model.' }]
  assert.equal(a.sessionState(), 'blocked')
  await rejects(a.insertAndSubmit('hello'), 'blocked')
  doc.match["a[href*='/login']"] = [inMessage({}), {}] // a second, wall-level link after the in-message one
  assert.equal(a.sessionState(), 'logged_out')
  assert.equal(composer.focused, 0)
  assert.deepEqual(composer.events, [])
})

test('errorText is looked for in alert-like containers only; a region wrapping the thread or the composer is a layout region, not a banner', () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': composer }, bodyText: 'Something went wrong' })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.deepEqual([...ALERT_SELECTORS], ["[role='alert']", "[role='status']", "[role='dialog']", "[role='alertdialog']", '[aria-live]'])
  assert.equal(a.sessionState(), 'ok')
  // an aria-live app root that contains the thread: skipped
  doc.match['[aria-live]'] = [{ innerText: 'Something went wrong', querySelector: () => ({}) }]
  assert.equal(a.sessionState(), 'ok')
  // a dialog that contains the composer (an edit dialog): skipped
  doc.match["[role='dialog']"] = [{ innerText: 'Something went wrong', contains: (el) => el === composer }]
  assert.equal(a.sessionState(), 'ok')
  // a status region with the phrase, contains nothing of the chat: blocked
  doc.match["[role='status']"] = [{ innerText: 'Something went wrong. Please try again.', querySelector: () => null, contains: () => false }]
  assert.equal(a.sessionState(), 'blocked')
  delete doc.match["[role='status']"]
  // textContent is the fallback for containers without layout
  doc.match["[role='alert']"] = [{ textContent: "You've reached the message limit" }]
  assert.equal(a.sessionState(), 'blocked')
  // the phrase list is per site: the chatgpt phrases do not block claude
  const b = createAdapter({ document: fakeDocument({ match: { "div[contenteditable='true']": composer, "[role='alert']": [{ innerText: 'Something went wrong' }] } }), site: 'claude' })
  assert.equal(b.sessionState(), 'ok')
})

test('loggedOut counts only when the match is visible and outside a message', () => {
  const composer = fakeTextarea()
  const doc = fakeDocument({ title: 'Grok', href: 'https://grok.com/', hostname: 'grok.com', match: { "textarea[aria-label='Ask Grok anything']": composer } })
  const a = createAdapter({ document: doc, site: 'grok' })
  doc.match["a[href*='accounts.x.ai']"] = [{ getClientRects: () => [] }] // hidden (a collapsed menu)
  assert.equal(a.sessionState(), 'ok')
  doc.match["a[href*='accounts.x.ai']"] = [{ getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 0, height: 0 }) }] // zero-size
  assert.equal(a.sessionState(), 'ok')
  doc.match["a[href*='accounts.x.ai']"] = [inMessage({ getClientRects: () => [{ width: 10, height: 10 }] })] // in a reply
  assert.equal(a.sessionState(), 'ok')
  doc.match["a[href*='/sign-in']"] = [{ getClientRects: () => [{ width: 10, height: 10 }], closest: () => null }] // the wall
  assert.equal(a.sessionState(), 'logged_out')
})

test('challengeTitle: a substring hit in the tab title needs the exact Cloudflare title, no composer, or a challenge element', () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ title: 'Just a moment of your time - Claude', match: { "div[contenteditable='true'].ProseMirror": composer } })
  const a = createAdapter({ document: doc, site: 'claude' })
  assert.equal(a.sessionState(), 'ok') // a conversation title, composer present
  doc.match["iframe[src*='challenges.cloudflare.com']"] = {}
  assert.equal(a.sessionState(), 'challenge') // corroborated by the challenge element
  delete doc.match["iframe[src*='challenges.cloudflare.com']"]
  delete doc.match["div[contenteditable='true'].ProseMirror"]
  assert.equal(a.sessionState(), 'challenge') // corroborated by the missing composer
  doc.match["div[contenteditable='true'].ProseMirror"] = composer
  doc.title = 'Just a moment...'
  assert.equal(a.sessionState(), 'challenge') // the exact interstitial title alone is enough
  doc.title = '  Just a moment… '
  assert.equal(a.sessionState(), 'challenge')
  doc.title = 'Just a moment, a poem'
  assert.equal(a.sessionState(), 'ok')
})

test('ready / waitForComposer / insertAndSubmit report a wall that appeared while polling, not composer_not_found', async () => {
  const doc = fakeDocument({ match: {} })
  const a = createAdapter({ document: doc, site: 'claude', selectors: fastSelectors('claude') })
  setTimeout(() => {
    doc.match["a[href*='/login']"] = {}
  }, 50)
  await rejects(a.ready(300), 'logged_out', /login wall/)

  const doc2 = fakeDocument({ match: {} })
  const b = createAdapter({ document: doc2, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  setTimeout(() => {
    doc2.match["[role='alert']"] = [{ innerText: 'Unusual activity has been detected' }]
  }, 50)
  await rejects(b.waitForComposer(300), 'blocked')

  const doc3 = fakeDocument({ match: {} })
  const c = createAdapter({ document: doc3, site: 'grok', selectors: fastSelectors('grok') })
  setTimeout(() => {
    doc3.match["iframe[src*='challenges.cloudflare.com']"] = {}
  }, 50)
  await rejects(c.insertAndSubmit('hello'), 'challenge')

  // a stop button that never goes away while a wall appears: the wall is the reason
  const composer = fakeComposer()
  const doc4 = fakeDocument({ match: { '#prompt-textarea': composer, 'button.stop': {} } })
  const d = createAdapter({ document: doc4, site: 'chatgpt', selectors: fastSelectors('chatgpt', { stop: ['button.stop'] }) })
  setTimeout(() => {
    doc4.match["button[data-testid='login-button']"] = {}
  }, 50)
  await rejects(d.ready(300), 'logged_out')
  // and a plain timeout still says composer_not_found
  await rejects(createAdapter({ document: fakeDocument({ match: {} }), site: 'grok', selectors: fastSelectors('grok') }).ready(80), 'composer_not_found')
})

test('findComposer prefers a rendered match; a hidden or collapsed editor earlier in the DOM never wins; all hidden → presence still reported', () => {
  const hidden = fakeComposer()
  hidden.getClientRects = () => []
  const collapsed = fakeComposer()
  collapsed.getClientRects = () => [{}]
  collapsed.getBoundingClientRect = () => ({ width: 0, height: 0 })
  const visible = fakeComposer()
  visible.getClientRects = () => [{ width: 300, height: 24 }]
  visible.getBoundingClientRect = () => ({ width: 300, height: 24 })
  const doc = fakeDocument({ match: { "div[contenteditable='true'].ProseMirror": [hidden, collapsed, visible] } })
  const a = createAdapter({ document: doc, site: 'claude' })
  assert.equal(a.findComposer().el, visible)
  assert.equal(a.health().matched.composer, "div[contenteditable='true'].ProseMirror")
  // a visible match of a LATER cascade entry beats a hidden match of an earlier one
  doc.match["div[contenteditable='true'].ProseMirror"] = [hidden]
  doc.match["div[contenteditable='true']"] = [visible]
  assert.deepEqual(a.findComposer(), { el: visible, selector: "div[contenteditable='true']" })
  // nothing rendered yet (mounting): the unfiltered fallback still reports presence
  delete doc.match["div[contenteditable='true']"]
  assert.deepEqual(a.findComposer(), { el: hidden, selector: "div[contenteditable='true'].ProseMirror" })
  assert.equal(a.health().composer, true)
})

// ---------------------------------------------------------------------------------------------
// Review fixes (S5): idempotent insertion with full verification
// ---------------------------------------------------------------------------------------------

test('insertText is idempotent: a composer that already holds exactly the text is left alone (already_present), never doubled', async () => {
  const ta = fakeTextarea('hello world')
  const doc = fakeDocument({ match: { "textarea[aria-label='Ask Grok anything']": ta } })
  const a = createAdapter({ document: doc, site: 'grok', selectors: fastSelectors('grok') })
  assert.deepEqual(await a.insertText('hello world'), { method: 'already_present' })
  assert.equal(ta.value, 'hello world')
  assert.equal(ta.focused, 0)
  assert.deepEqual(ta.events, [])
  // whitespace-insensitive, like the verification rule (editors re-render whitespace)
  ta.value = 'hello  world\n'
  assert.deepEqual(await a.insertText('hello world'), { method: 'already_present' })
  assert.equal(ta.value, 'hello  world\n')
  // a different draft is still appended to
  ta.value = 'hello'
  assert.deepEqual(await a.insertText(' world'), { method: 'nativeValue' })
  assert.equal(ta.value, 'hello world')
  assert.deepEqual(ta.events, ['input'])

  const el = fakeComposer({ text: 'hello world' })
  const doc2 = fakeDocument({ match: { '#prompt-textarea': el } })
  doc2.execCommand = () => assert.fail('execCommand must not run when the text is already present')
  const b = createAdapter({ document: doc2, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  assert.deepEqual(await b.insertText('hello world'), { method: 'already_present' })
  assert.equal(el.focused, 0)
  assert.deepEqual(el.events, [])
})

test('insertText verifies previous text + inserted text: a no-op execCommand on a leftover with the same tail fails over to paste and ends site_error', async () => {
  const leftover = 'OLD PROMPT that shares the tail: the quick brown fox jumps'
  const el = fakeComposer({ text: leftover })
  const doc = fakeDocument({ match: { '#prompt-textarea': el } })
  doc.createRange = () => ({ selectNodeContents() {}, collapse() {} })
  doc.getSelection = () => ({ removeAllRanges() {}, addRange() {} })
  let execCalls = 0
  doc.execCommand = () => {
    execCalls += 1
    return false // ProseMirror rejected it: nothing inserted
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  const err = await rejects(a.insertText('NEW PROMPT that shares the tail: the quick brown fox jumps'), 'site_error', /insertText: execCommand: did not run/)
  assert.match(err.message, /paste/)
  assert.match(err.message, /previous text followed by the inserted text/)
  assert.equal(execCalls, 1)
  assert.equal(el._text, leftover) // untouched, never cleared
  // an execCommand that reports success but inserts nothing is a failed attempt too
  doc.execCommand = () => true
  await rejects(a.insertText('NEW PROMPT that shares the tail: the quick brown fox jumps'), 'site_error', /execCommand: ran;/)
  // an insertion that lands only partially is a failed attempt as well
  doc.execCommand = (_cmd, _ui, text) => {
    el._text += text.slice(0, 5)
    return true
  }
  await rejects(a.insertText('NEW PROMPT that shares the tail: the quick brown fox jumps'), 'site_error')
})

test('insertText verification: a correct append after a draft still passes (whitespace re-rendered by the editor)', async () => {
  const el = fakeComposer({ text: 'draft line' })
  const doc = fakeDocument({ match: { '#prompt-textarea': el } })
  doc.createRange = () => ({ selectNodeContents() {}, collapse() {} })
  doc.getSelection = () => ({ removeAllRanges() {}, addRange() {} })
  doc.execCommand = (_cmd, _ui, text) => {
    el._text = el._text + '\n' + text.replace(/\n/g, '\n\n') // paragraphs re-rendered
    return true
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  assert.deepEqual(await a.insertText('line one\nline two'), { method: 'execCommand' })
  assert.equal(el._text, 'draft line\nline one\n\nline two')
})

test('insertAndSubmit retry after a failed submit sends the prompt exactly once', async () => {
  const ta = fakeTextarea('')
  const doc = fakeDocument({ match: { "textarea[aria-label='Ask Grok anything']": ta } })
  const a = createAdapter({ document: doc, site: 'grok', selectors: fastSelectors('grok', { sendWaitMs: 100, submitVerifyMs: 50 }) })
  await rejects(a.insertAndSubmit('hello world'), 'send_not_found') // no button yet
  assert.equal(ta.value, 'hello world') // the leftover, never cleared
  const received = []
  doc.match["button[aria-label='Submit']"] = {
    click() {
      received.push(ta.value)
      ta.value = ''
    },
  }
  const r = await a.insertAndSubmit('hello world')
  assert.equal(r.submitted, true)
  assert.deepEqual(received, ['hello world']) // once, not 'hello worldhello world'
  assert.equal(ta.value, '')
})

// ---------------------------------------------------------------------------------------------
// Selector calibration (S4): grok.com measured live on 2026-09-16 — a TipTap editor in a form, a
// hidden 14 px helper <textarea>, and a submit button that exists only once the editor holds text
// ---------------------------------------------------------------------------------------------

const GROK_TIPTAP = "div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']"
const grokDoc = (match) => fakeDocument({ title: 'Grok', href: 'https://grok.com/', hostname: 'grok.com', match })

test('grok: the hidden helper <textarea> is never the composer — the TipTap editor wins, and without it a bare textarea is no fallback', async () => {
  const helper = fakeTextarea('')
  const editor = fakeComposer()
  const doc = grokDoc({
    textarea: helper, // what a bare `textarea` entry would pick
    [GROK_TIPTAP]: editor,
    "div[role='textbox'][aria-label='Ask Grok anything']": editor,
    "div.ProseMirror[contenteditable='true']": editor,
  })
  const a = createAdapter({ document: doc, site: 'grok', selectors: fastSelectors('grok') })
  assert.deepEqual(a.findComposer(), { el: editor, selector: GROK_TIPTAP })
  assert.equal(a.health().matched.composer, GROK_TIPTAP)
  assert.equal(a.health().session, 'ok')

  // only the helper is on the page (the editor is not mounted yet): no composer, never the helper
  const doc2 = grokDoc({ textarea: helper })
  const b = createAdapter({ document: doc2, site: 'grok', selectors: fastSelectors('grok') })
  assert.equal(b.findComposer(), null)
  assert.equal(b.health().session, 'unknown')
  await rejects(b.insertAndSubmit('hello'), 'composer_not_found', /tried:/)
  assert.equal(helper.value, '') // nothing was typed into the helper
  assert.equal(helper.focused, 0)
  assert.ok(!doc2.queried.includes('textarea'), 'a bare `textarea` is never even queried')
})

test('grok: the submit button that exists only once the editor holds text is found — the send cascade is polled after the insertion, never before', async () => {
  const editor = fakeComposer()
  const submitButton = {
    clicks: 0,
    click() {
      submitButton.clicks += 1
      editor._text = '' // the site clears the editor (and the voice button comes back)
    },
  }
  const voice = { click: () => assert.fail('the voice-mode button must never be clicked') }
  const match = { [GROK_TIPTAP]: editor, "button[type='button'][aria-label='Enter voice mode']": voice }
  // like grok.com: button[data-testid='chat-submit'] is rendered only while the editor holds text
  Object.defineProperty(match, "button[data-testid='chat-submit']", { enumerable: true, get: () => (editor._text !== '' ? [submitButton] : undefined) })
  const doc = grokDoc(match)
  doc.createRange = () => ({ selectNodeContents() {}, collapse() {} })
  doc.getSelection = () => ({ removeAllRanges() {}, addRange() {} })
  doc.execCommand = (_cmd, _ui, text) => {
    editor._text += text
    return true
  }
  const a = createAdapter({ document: doc, site: 'grok', selectors: fastSelectors('grok') })
  assert.equal(a.findSendButton(), null) // nothing to click before the insertion
  assert.equal(a.health().send, false)
  assert.equal(a.health().matched.send, null)
  const r = await a.insertAndSubmit('hello grok')
  assert.equal(r.submitted, true)
  assert.equal(r.composerSelector, GROK_TIPTAP)
  assert.equal(r.sendSelector, "button[data-testid='chat-submit']")
  assert.equal(r.confirmedBy, 'composer_cleared')
  assert.equal(submitButton.clicks, 1)
  assert.equal(a.health().send, false) // the editor is empty again: the voice button holds the slot
})

// ---------------------------------------------------------------------------------------------
// Stage 2 (capture-adapters): observe / snapshot / config re-merge over the fake document
// ---------------------------------------------------------------------------------------------

/**
 * An assistant container: `text` is its innerText (reads counted in `reads`); `parts` maps an
 * assistantText selector to an inner element or a list of them; `inside` lists the elements it
 * contains; `parentNode` its parent (the thread) when a test needs one.
 */
function container(text, { parts = {}, inside = [], parentNode = null } = {}) {
  const el = {
    tagName: 'DIV',
    _text: text,
    reads: 0,
    parentNode,
    get innerText() {
      el.reads += 1
      return el._text
    },
    querySelector: (s) => {
      const v = parts[s]
      return Array.isArray(v) ? v[0] || null : v || null
    },
    querySelectorAll: (s) => {
      if (s === '*') return []
      const v = parts[s]
      return v === undefined ? [] : Array.isArray(v) ? v : [v]
    },
    contains: (x) => inside.includes(x),
  }
  return el
}
/** Short capture timings: first token 250 ms, quiet 120 ms, budget 1500 ms (the poll runs every 300 ms). */
const CAPTURE = { firstTokenMs: 250, quietMs: 120, captureTimeoutMs: 1500 }
const captureSelectors = (site, extra = {}) => fastSelectors(site, { ...CAPTURE, ...extra })

test('observe constants: mutations are throttled to 100 ms and the poll runs every 300 ms', () => {
  assert.equal(OBSERVE_THROTTLE_MS, 100)
  assert.equal(OBSERVE_POLL_MS, 300)
})

test('observe: no container beyond the baseline within firstTokenMs → reply_not_found without a partial; a missing baseline means the current count; the message firstTokenMs is capped by the budget', async () => {
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer() } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  const t0 = Date.now()
  const err = await rejects(a.observe({ baselineCount: 0 }), 'reply_not_found', /beyond 0 within 250 ms/)
  assert.ok(Date.now() - t0 >= 200)
  assert.ok(!('partial' in err))
  doc.match["[data-message-author-role='assistant']"] = [container('an old reply')]
  await rejects(a.observe({ baselineCount: 1 }), 'reply_not_found', /beyond 1/)
  await rejects(a.observe({}), 'reply_not_found', /beyond 1/) // omitted = the current count
  await rejects(a.observe({ baselineCount: 'nonsense' }), 'reply_not_found', /beyond 1/)
  const t1 = Date.now()
  await rejects(a.observe({ baselineCount: 1, firstTokenMs: 5000, timeoutMs: 100 }), 'reply_not_found', /within 100 ms/)
  assert.ok(Date.now() - t1 < 1000)
})

test('observe: done_selector — a visible done match on or after the last container ends the capture; the text is the first assistantText match; an older turn\'s marker never counts', async () => {
  const md = { tagName: 'DIV', innerText: 'the reply\nline 2' }
  const copy = {}
  const reply = container('the reply\nline 2\nCopy', { parts: { '.markdown': md }, inside: [copy] })
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [container('older'), reply] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  setTimeout(() => {
    doc.match["button[data-testid='copy-turn-action-button']"] = [copy]
  }, 150)
  const r = await a.observe({ baselineCount: 1 })
  assert.deepEqual(Object.keys(r).sort(), ['doneBy', 'ms', 'text'])
  assert.equal(r.text, 'the reply\nline 2') // the .markdown part, not the container's own innerText
  assert.equal(r.doneBy, 'done_selector')
  assert.ok(Number.isInteger(r.ms) && r.ms >= 100)
  // a done match that is not the last container, inside it or after it (an older turn's copy button) is ignored
  const olderCopy = {}
  doc.match["button[data-testid='copy-turn-action-button']"] = [olderCopy]
  const stale = container('streaming…', { parts: { '.markdown': { innerText: 'streaming…' } } })
  doc.match["[data-message-author-role='assistant']"].push(stale)
  const err = await rejects(a.observe({ baselineCount: 2, quietMs: 100000, timeoutMs: 400 }), 'timeout', /400 ms/)
  assert.equal(err.partial, 'streaming…')
  // a hidden done match does not count either
  doc.match["button[data-testid='copy-turn-action-button']"] = [{ getClientRects: () => [] }]
  stale.contains = () => true
  await rejects(a.observe({ baselineCount: 2, quietMs: 100000, timeoutMs: 400 }), 'timeout')
})

test('observe: stop_gone — the stop button seen then gone; the text is the container\'s innerText when assistantText is empty (claude); a rewinding text is harmless', async () => {
  const reply = container('')
  const doc = fakeDocument({ match: { "div[contenteditable='true'].ProseMirror": fakeComposer(), '.font-claude-response:not(#markdown-artifact)': [reply], "button[aria-label='Stop response']": [{}] } })
  const a = createAdapter({ document: doc, site: 'claude', selectors: captureSelectors('claude') })
  const frames = ['Hel', 'Hello wo', 'Hello', 'Hello world'] // the third frame rewinds
  frames.forEach((s, i) =>
    setTimeout(() => {
      reply._text = s
    }, 50 + i * 80),
  )
  setTimeout(() => {
    delete doc.match["button[aria-label='Stop response']"]
  }, 450)
  const r = await a.observe({ baselineCount: 0 })
  assert.equal(r.text, 'Hello world')
  assert.equal(r.doneBy, 'stop_gone')
  assert.ok(r.ms >= 400)
})

test('observe: quiet — with no stop button and no done marker the text unchanged for quietMs ends the capture; blank text never counts as quiet', async () => {
  const md = { innerText: '' }
  const reply = container('', { parts: { '.response-content-markdown': md } })
  const doc = fakeDocument({ match: { [GROK_TIPTAP]: fakeComposer(), "div[id^='response-']": [reply] } })
  const a = createAdapter({ document: doc, site: 'grok', selectors: captureSelectors('grok', { stop: [], done: [] }) })
  setTimeout(() => {
    md.innerText = 'final answer'
  }, 500) // blank for 500 ms, well beyond quietMs: still waiting
  const t0 = Date.now()
  const r = await a.observe({ baselineCount: 0 })
  assert.deepEqual([r.text, r.doneBy], ['final answer', 'quiet'])
  assert.ok(Date.now() - t0 >= 500 + 120)
  assert.equal(a.health().stop, null) // an empty stop cascade: no stop signal at all
})

test('observe: a visible stop button suppresses quiet (the site is still replying) even when the text is stable', async () => {
  const reply = container('stable text')
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply], "button[data-testid='stop-button']": [{}] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  setTimeout(() => {
    delete doc.match["button[data-testid='stop-button']"]
  }, 700)
  const t0 = Date.now()
  const r = await a.observe({ baselineCount: 0 })
  assert.equal(r.doneBy, 'stop_gone') // not quiet at 120 ms
  assert.equal(r.text, 'stable text')
  assert.ok(Date.now() - t0 >= 700)
})

test('observe: the budget (timeoutMs, default captureTimeoutMs) → timeout carrying the partial text while the text keeps changing under a stop button', async () => {
  const reply = container('a')
  const doc = fakeDocument({ match: { "div[contenteditable='true'].ProseMirror": fakeComposer(), '.font-claude-response:not(#markdown-artifact)': [reply], "button[aria-label='Stop response']": [{}] } })
  const a = createAdapter({ document: doc, site: 'claude', selectors: captureSelectors('claude', { captureTimeoutMs: 400 }) })
  const grow = setInterval(() => {
    reply._text += 'a'
  }, 50)
  try {
    const t0 = Date.now()
    const err = await rejects(a.observe({ baselineCount: 0 }), 'timeout', /400 ms/)
    assert.ok(Date.now() - t0 >= 400)
    assert.ok(typeof err.partial === 'string' && err.partial.length > 1 && /^a+$/.test(err.partial))
    const t1 = Date.now()
    const err2 = await rejects(a.observe({ baselineCount: 0, timeoutMs: 150 }), 'timeout', /150 ms/)
    assert.ok(Date.now() - t1 < 400)
    assert.ok(err2.partial.length >= err.partial.length)
  } finally {
    clearInterval(grow)
  }
})

test('observe: a banner mid-reply → site_error whose message is ONLY the configured phrase (never the banner text); a wall → logged_out; a challenge → challenge; each with the partial', async () => {
  const reply = container('half a reply')
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply], "button[data-testid='stop-button']": [{}] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  setTimeout(() => {
    doc.match["[role='alert']"] = [{ innerText: 'Oops: UNUSUAL ACTIVITY HAS BEEN DETECTED from your device (user 4711). Try again later.' }]
  }, 100)
  const err = await rejects(a.observe({ baselineCount: 0 }), 'site_error')
  assert.equal(err.message, 'Unusual activity has been detected') // the config phrase in the config's case
  assert.equal(err.partial, 'half a reply')
  delete doc.match["[role='alert']"]
  setTimeout(() => {
    doc.match["button[data-testid='login-button']"] = [{}]
  }, 100)
  const wall = await rejects(a.observe({ baselineCount: 0 }), 'logged_out', /login wall/)
  assert.equal(wall.partial, 'half a reply')
  delete doc.match["button[data-testid='login-button']"]
  setTimeout(() => {
    doc.match['#challenge-form'] = [{}]
  }, 100)
  assert.equal((await rejects(a.observe({ baselineCount: 0 }), 'challenge')).partial, 'half a reply')
  delete doc.match['#challenge-form']
  // a blank partial is omitted
  reply._text = ''
  doc.match["[role='status']"] = [{ innerText: "You've reached the message limit", querySelector: () => null, contains: () => false }]
  const blank = await rejects(a.observe({ baselineCount: 0 }), 'site_error')
  assert.equal(blank.message, "You've reached")
  assert.ok(!('partial' in blank))
})

test('observe: an abort → cancelled with the partial text; an already-aborted signal is answered at once; the poll stops afterwards', async () => {
  const reply = container('partial so far')
  const doc = fakeDocument({ match: { [GROK_TIPTAP]: fakeComposer(), "div[id^='response-']": [reply], "button[aria-label='Stop']": [{}] } })
  let polls = 0
  const timers = {
    setTimeout: (fn, ms) => {
      polls += 1
      return setTimeout(fn, ms)
    },
    clearTimeout,
  }
  const a = createAdapter({ document: doc, site: 'grok', selectors: captureSelectors('grok'), timers })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 120)
  const err = await rejects(a.observe({ baselineCount: 0, signal: ac.signal }), 'cancelled')
  assert.equal(err.partial, 'partial so far')
  const after = polls
  await sleep(700)
  assert.equal(polls, after) // no poll scheduled after the settle
  const done = new AbortController()
  done.abort()
  await rejects(a.observe({ baselineCount: 0, signal: done.signal }), 'cancelled')
})

test('observe: the LAST container in document order is followed (compareDocumentPosition), whatever cascade entry matched it', async () => {
  const first = container('newest')
  const second = container('older')
  first.compareDocumentPosition = (other) => (other === second ? 2 : 0) // second PRECEDES first
  second.compareDocumentPosition = (other) => (other === first ? 4 : 0) // first FOLLOWS second
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [first], '.font-claude-response': [second] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt', { stop: [], done: [] }) })
  assert.equal(a.countAssistant(), 2)
  assert.deepEqual(a.assistantContainers(), [second, first])
  const r = await a.observe({ baselineCount: 1 })
  assert.deepEqual([r.text, r.doneBy], ['newest', 'quiet'])
  first.compareDocumentPosition = (other) => (other === second ? 4 : 0)
  second.compareDocumentPosition = (other) => (other === first ? 2 : 0)
  assert.deepEqual(a.assistantContainers(), [first, second])
  assert.equal((await a.observe({ baselineCount: 1 })).text, 'older')
})

test('observe / replyText: the first assistantText match wins, else the container; CRLF → LF and NBSP → space, nothing trimmed; a throwing querySelector is skipped', async () => {
  const md = { innerText: 'a\r\nb\u00a0c ' }
  const reply = container('outer text', { parts: { '.whitespace-pre-wrap': md } }) // no .markdown: the second entry matches
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt', { stop: [], done: [] }) })
  const r = await a.observe({ baselineCount: 0 })
  assert.equal(r.text, 'a\nb c ')
  assert.equal(r.doneBy, 'quiet')
  assert.equal(a.replyText(container('plain')), 'plain')
  assert.equal(a.replyText(container('plain', { parts: { '.markdown': { textContent: 'from textContent' } } })), 'from textContent')
  const throwing = container('fallback')
  throwing.querySelector = throwing.querySelectorAll = () => {
    throw new SyntaxError('bad selector')
  }
  assert.equal(a.replyText(throwing), 'fallback')
})

test('observe / replyText: EVERY match of the first assistantText entry that matches is joined in document order by a blank line (a summary block before the answer is not dropped); a nested match is skipped; the cascade is a fallback, never a union', async () => {
  const summary = { innerText: 'thinking summary' }
  const inner = { innerText: 'nested' }
  const answer = { innerText: 'the answer\nnested', contains: (x) => x === inner }
  const reply = container('thinking summary\nthe answer\nnested', { parts: { '.markdown': [summary, answer, inner] } })
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt', { stop: [], done: [] }) })
  const r = await a.observe({ baselineCount: 0 })
  assert.deepEqual([r.text, r.doneBy], ['thinking summary\n\nthe answer\nnested', 'quiet'])
  assert.equal(a.replyText(reply), 'thinking summary\n\nthe answer\nnested')
  const pre = { innerText: 'pre-wrap text' }
  assert.equal(a.replyText(container('c', { parts: { '.markdown': [], '.whitespace-pre-wrap': [pre] } })), 'pre-wrap text')
  assert.equal(a.replyText(container('c', { parts: { '.markdown': [summary], '.whitespace-pre-wrap': [pre] } })), 'thinking summary')
  assert.equal(a.replyText(container('only the container')), 'only the container')
})

/** A fake element with a real-looking box whose computed style is `style` (through its own document's view). */
const styled = (style) => ({
  getClientRects: () => [{}],
  getBoundingClientRect: () => ({ width: 20, height: 20 }),
  ownerDocument: { defaultView: { getComputedStyle: () => style } },
})

test('observe: a done match painted at opacity 0 (a hover-revealed action bar) never ends the capture — the reply waits for stop_gone; once opaque it counts; a stop button under pointer-events:none is no stop button (quiet applies, health.stop false)', async () => {
  const copyStyle = { opacity: '0' }
  const copy = styled(copyStyle)
  const md = { innerText: 'streaming' }
  const reply = container('', { parts: { '.markdown': md }, inside: [copy] })
  const doc = fakeDocument({
    match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply], "button[data-testid='copy-turn-action-button']": [copy], "button[data-testid='stop-button']": [{}] },
  })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  const grow = setInterval(() => {
    md.innerText += '.'
  }, 60)
  setTimeout(() => clearInterval(grow), 400)
  setTimeout(() => {
    delete doc.match["button[data-testid='stop-button']"]
  }, 450)
  const t0 = Date.now()
  const r = await a.observe({ baselineCount: 0 })
  assert.equal(r.doneBy, 'stop_gone') // never done_selector while the marker is invisible
  assert.ok(Date.now() - t0 >= 450)
  assert.equal(r.text, md.innerText)
  copyStyle.opacity = '1'
  const t1 = Date.now()
  assert.equal((await a.observe({ baselineCount: 0 })).doneBy, 'done_selector')
  assert.ok(Date.now() - t1 < 300) // the first sample saw it, one settle sample later it resolved
  delete doc.match["button[data-testid='copy-turn-action-button']"]
  doc.match["button[data-testid='stop-button']"] = [styled({ pointerEvents: 'none' })]
  assert.equal(a.health().stop, false)
  const t2 = Date.now()
  const q = await a.observe({ baselineCount: 0 })
  assert.equal(q.doneBy, 'quiet') // the unpressable stop button was never "seen"
  assert.ok(Date.now() - t2 < 1000)
  clearInterval(grow)
})

test('one shadow-root walk per sample: health() walks the document once; every observe sample walks it at most once', async () => {
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [container('settled')] } })
  let walks = 0
  const qsa = doc.querySelectorAll
  doc.querySelectorAll = (s) => {
    if (s === '*') walks += 1
    return qsa(s)
  }
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  a.health()
  assert.equal(walks, 1)
  assert.equal(a.sessionState(), 'ok')
  walks = 0
  let samples = 1 // the initial run
  const timers = {
    setTimeout: (fn, ms) =>
      setTimeout(() => {
        samples += 1
        fn()
      }, ms),
    clearTimeout,
  }
  const b = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt'), timers })
  const r = await b.observe({ baselineCount: 0 })
  assert.equal(r.doneBy, 'quiet')
  assert.ok(walks >= 1 && walks <= samples, `${walks} walks over ${samples} samples`)
})

test('observe: a mutation tick only reads the thread (the session is re-checked on the 300 ms poll), and the MutationObserver is re-scoped from the document to the reply\'s parent once the container is known', async () => {
  const observers = []
  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb
      this.targets = []
      this.disconnects = 0
      observers.push(this)
    }
    observe(target, opts) {
      this.targets.push({ target, opts })
    }
    disconnect() {
      this.disconnects += 1
    }
  }
  const thread = { tagName: 'MAIN' }
  const reply = container('streaming', { parentNode: thread })
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply], "button[data-testid='stop-button']": [{}] } })
  const CHALLENGE = DEFAULT_SELECTORS.chatgpt.challenge[0]
  const sessionChecks = () => doc.queried.filter((s) => s === CHALLENGE).length
  const a = createAdapter({ document: doc, window: { MutationObserver: FakeMutationObserver }, site: 'chatgpt', selectors: captureSelectors('chatgpt') })
  const done = a.observe({ baselineCount: 0 })
  assert.equal(observers.length, 1)
  const mo = observers[0]
  assert.equal(sessionChecks(), 1) // the initial (full) sample
  assert.deepEqual(mo.targets.map((t) => t.target), [doc, thread]) // re-scoped as soon as the container was known
  assert.deepEqual(mo.targets[1].opts, { childList: true, characterData: true, subtree: true, attributes: true })
  assert.equal(mo.disconnects, 1)
  const readsBefore = reply.reads
  for (let i = 0; i < 5; i++) mo.cb([]) // five mutations → one throttled sample
  await sleep(200)
  assert.ok(reply.reads > readsBefore, 'the mutation tick sampled the thread')
  assert.equal(sessionChecks(), 1) // …without re-checking the session
  await sleep(200) // the 300 ms poll ran
  assert.equal(sessionChecks(), 2)
  delete doc.match["button[data-testid='stop-button']"]
  const r = await done
  assert.equal(r.doneBy, 'stop_gone')
  assert.equal(mo.disconnects, 2) // the re-scope, then the cleanup
})

test('observe: a done marker on the last container does not count while a stop button is visible (a finished tool turn under a streaming answer); a second container appended mid-observe becomes the followed one', async () => {
  const toolCopy = {}
  const tool = container('', { parts: { '.markdown': { innerText: 'Searching the web…' } }, inside: [toolCopy] })
  const doc = fakeDocument({
    match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [tool], "button[data-testid='copy-turn-action-button']": [toolCopy], "button[data-testid='stop-button']": [{}] },
  })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt', { quietMs: 100000 }) })
  const md = { innerText: 'the ans' }
  const answerCopy = {}
  const answer = container('', { parts: { '.markdown': md }, inside: [answerCopy] })
  setTimeout(() => doc.match["[data-message-author-role='assistant']"].push(answer), 200)
  setTimeout(() => {
    md.innerText = 'the answer'
  }, 400)
  setTimeout(() => {
    delete doc.match["button[data-testid='stop-button']"]
    doc.match["button[data-testid='copy-turn-action-button']"] = [toolCopy, answerCopy]
  }, 700)
  const t0 = Date.now()
  const r = await a.observe({ baselineCount: 0 })
  assert.deepEqual([r.text, r.doneBy], ['the answer', 'done_selector'])
  assert.ok(Date.now() - t0 >= 700)
  // without a stop button at all the tool turn's marker ends the capture at once (the existing done rule)
  doc.match["[data-message-author-role='assistant']"] = [tool]
  doc.match["button[data-testid='copy-turn-action-button']"] = [toolCopy]
  assert.deepEqual(await a.observe({ baselineCount: 0 }).then((x) => [x.text, x.doneBy]), ['Searching the web…', 'done_selector'])
})

test('observe: an end signal never resolves on the sample that saw it — a render landing after the done marker (or after the stop button went) still wins, the text must hold still across two samples; past the budget the latest text is returned with that doneBy, not timeout', async () => {
  const md = { innerText: 'almost' }
  const copy = {}
  const reply = container('', { parts: { '.markdown': md }, inside: [copy] })
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt', { quietMs: 100000 }) })
  setTimeout(() => {
    doc.match["button[data-testid='copy-turn-action-button']"] = [copy]
  }, 150) // seen by the poll at ~300 ms
  setTimeout(() => {
    md.innerText = 'almost done'
  }, 330) // after the sample that saw the marker, before its settle sample
  setTimeout(() => {
    md.innerText = 'almost done.'
  }, 430)
  const t0 = Date.now()
  const r = await a.observe({ baselineCount: 0 })
  assert.deepEqual([r.text, r.doneBy], ['almost done.', 'done_selector'])
  assert.ok(Date.now() - t0 >= 550, `resolved after ${Date.now() - t0} ms`)
  // stop_gone with a text that never holds still: the budget ends the settling with the latest text, not a timeout
  const growing = container('a')
  const doc2 = fakeDocument({ match: { "div[contenteditable='true'].ProseMirror": fakeComposer(), '.font-claude-response:not(#markdown-artifact)': [growing], "button[aria-label='Stop response']": [{}] } })
  const b = createAdapter({ document: doc2, site: 'claude', selectors: captureSelectors('claude', { captureTimeoutMs: 700 }) })
  const grow = setInterval(() => {
    growing._text += 'a'
  }, 50)
  setTimeout(() => {
    delete doc2.match["button[aria-label='Stop response']"]
  }, 100)
  try {
    const t1 = Date.now()
    const s = await b.observe({ baselineCount: 0 })
    assert.equal(s.doneBy, 'stop_gone')
    assert.ok(Date.now() - t1 >= 700)
    assert.ok(/^a{8,}$/.test(s.text), s.text)
    assert.equal(s.text, growing._text.slice(0, s.text.length)) // the latest read
  } finally {
    clearInterval(grow)
  }
})

test('boot(): under Electron the ipc is ALWAYS require("electron").ipcRenderer — a page-defined window.__triplexFakeIpc is ignored and a broken electron require boots nothing; outside Electron the fake is the ipc, and only inside a page', async () => {
  const calls = []
  const ipcNamed = (name) => ({
    invoke(channel) {
      calls.push(`${name}:${channel}`)
      return Promise.resolve({ site: 'chatgpt', selectors: DEFAULT_SELECTORS, dev: false })
    },
    on() {},
    send() {},
  })
  const electronIpc = ipcNamed('electron')
  const pageFake = ipcNamed('fake')
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer() } })
  const electron = {
    window: { __triplexFakeIpc: pageFake },
    document: doc,
    process: { versions: { electron: '44.4.1' } },
    require: (name) => (name === 'electron' ? { ipcRenderer: electronIpc } : null),
  }
  assert.equal(pickIpc(electron), electronIpc)
  assert.equal(shouldBoot(electron), true)
  const attached = boot(electron)
  assert.ok(attached && typeof attached.dispose === 'function')
  assert.equal(await attached.ready, true)
  attached.dispose()
  assert.deepEqual(calls, ['electron:adapter:config']) // the fake was never consulted
  assert.equal(pickIpc({ ...electron, require: () => { throw new Error('no electron module') } }), null)
  assert.equal(pickIpc({ ...electron, require: () => ({}) }), null)
  assert.equal(boot({ ...electron, require: () => ({}) }), null)
  assert.equal(shouldBoot({ ...electron, window: {} }), true) // Electron boots without any page global
  assert.deepEqual(calls, ['electron:adapter:config'])
  // outside Electron: the fake, and only with a window AND a document
  const chrome = { window: { __triplexFakeIpc: pageFake }, document: doc, process: { versions: { node: '22' } }, require: () => { throw new Error('unreachable') } }
  assert.equal(pickIpc(chrome), pageFake)
  assert.equal(shouldBoot(chrome), true)
  assert.equal(shouldBoot({ ...chrome, window: {} }), false)
  assert.equal(shouldBoot({ ...chrome, document: undefined }), false)
  assert.equal(shouldBoot({ ...chrome, window: undefined }), false)
  const b = boot(chrome)
  assert.equal(await b.ready, true)
  b.dispose()
  assert.deepEqual(calls, ['electron:adapter:config', 'fake:adapter:config'])
  assert.equal(pickIpc({ window: undefined, document: undefined, process: undefined }), null)
  assert.equal(boot({ window: undefined, document: undefined, process: undefined }), null)
})

test('observe honours a message-level quietMs over the selectors', async () => {
  const reply = container('settled')
  const doc = fakeDocument({ match: { '#prompt-textarea': fakeComposer(), "[data-message-author-role='assistant']": [reply] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: captureSelectors('chatgpt', { stop: [], done: [], quietMs: 100000 }) })
  const t0 = Date.now()
  const r = await a.observe({ baselineCount: 0, quietMs: 100 })
  assert.equal(r.doneBy, 'quiet')
  assert.ok(Date.now() - t0 < 1400)
})

test('snapshot returns {html} from scrubDom over the adapter\'s document and honours an aborted signal', async () => {
  const doc = fakeDocument({ match: {} })
  doc.documentElement = {
    nodeType: 1,
    localName: 'html',
    attributes: [],
    childNodes: [{ nodeType: 1, localName: 'body', attributes: [{ name: 'class', value: 'x' }], childNodes: [{ nodeType: 3, data: 'secret' }] }],
  }
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.deepEqual(await a.snapshot(), { html: '<!doctype html>\n<html><body class="x">…</body></html>\n' })
  assert.equal((await a.snapshot()).html, scrubDom(doc))
  const ac = new AbortController()
  ac.abort()
  await rejects(a.snapshot({ signal: ac.signal }), 'cancelled')
})

test('createAdapter / setSelectors re-merge a full config onto the defaults (every v1 and v2 key present, unknown keys dropped, override replaces per key); a bare block is taken as-is', () => {
  const el = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': el, '#other': el, 'button.stop': [{}] } })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: { version: 1, chatgpt: { composer: ['#other'], bogus: ['x'] } } })
  assert.equal(a.findComposer().selector, '#other')
  assert.equal(a.health().stop, false) // the default stop cascade survived the merge: present, nothing visible
  a.setSelectors({ version: 1, chatgpt: { stop: ['button.stop'] } })
  assert.equal(a.findComposer().selector, '#prompt-textarea') // composer back to the default: only `stop` was overridden
  assert.equal(a.health().stop, true)
  assert.equal(a.health().matched.stop, 'button.stop')
  a.setSelectors({ composer: ['#other'], send: [] }) // a bare block: no stop cascade at all
  assert.equal(a.findComposer().selector, '#other')
  assert.equal(a.health().stop, null)
  a.setSelectors({ version: 1, claude: { composer: ['#nope'] } }) // no block for this site and not a bare block: ignored, the current block stays
  assert.equal(a.findComposer().selector, '#other')
  assert.equal(a.health().stop, null)
  a.setSelectors(null)
  a.setSelectors(['#list'])
  assert.equal(a.findComposer().selector, '#other')
})
