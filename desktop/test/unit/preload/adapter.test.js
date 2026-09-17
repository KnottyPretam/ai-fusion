// createAdapter over a fake document (no jsdom): health shape, the session-state order, the
// selector fallbacks, waitForComposer / ready / insertAndSubmit gates, countAssistant, the
// insertion cascade's verification and "never innerHTML/textContent", submit's confirmation rules
// and error codes. Timeouts are shortened through a selectors block; timers are real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAdapter, AdapterError, DEFAULT_SELECTORS, MESSAGE_SELECTORS, ASSISTANT_SELECTORS, ALERT_SELECTORS } = require('../../../preload/site.cjs')

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
    reply: null,
    stop: null,
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

test('observe and snapshot are stage 2: they reject site_error', async () => {
  const a = createAdapter({ document: fakeDocument(), site: 'chatgpt' })
  await rejects(a.observe({ baselineCount: 0 }), 'site_error', /stage 2/)
  await rejects(a.snapshot(), 'site_error', /stage 2/)
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
