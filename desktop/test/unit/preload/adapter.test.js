// createAdapter over a fake document (no jsdom): health shape, the session-state order, the
// selector fallbacks, waitForComposer / ready / insertAndSubmit gates, countAssistant, the
// insertion cascade's verification and "never innerHTML/textContent", submit's confirmation rules
// and error codes. Timeouts are shortened through a selectors block; timers are real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAdapter, AdapterError, DEFAULT_SELECTORS, MESSAGE_SELECTORS } = require('../../../preload/site.cjs')

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
  const doc = fakeDocument({ match: { '#prompt-textarea': composer } })
  const a = createAdapter({ document: doc, site: 'chatgpt' })
  assert.equal(a.sessionState(), 'ok')
  doc.body.innerText = 'Oops. You\'ve reached our limit of messages.'
  assert.equal(a.sessionState(), 'blocked')
  doc.body.innerText = 'UNUSUAL ACTIVITY HAS BEEN DETECTED from your device' // case-insensitive
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

test('countAssistant(): distinct elements over the generic message selectors (+ a v2 assistant cascade), 0 when none', () => {
  const shared = {}
  const doc = fakeDocument({ match: {} })
  const a = createAdapter({ document: doc, site: 'claude' })
  assert.equal(a.countAssistant(), 0)
  doc.match['[data-message-author-role]'] = [shared, {}]
  doc.match['.font-claude-response'] = [shared]
  assert.equal(a.countAssistant(), 2)
  assert.ok(MESSAGE_SELECTORS.includes('[data-message-author-role]'))
  const b = createAdapter({ document: doc, site: 'claude', selectors: { ...DEFAULT_SELECTORS.claude, assistant: ['.custom-turn'] } })
  doc.match['.custom-turn'] = [{}, {}]
  assert.equal(b.countAssistant(), 4)
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
    slow.match['textarea'] = fakeTextarea()
  }, 100)
  assert.equal((await b.ready(1000)).selector, 'textarea')
  await rejects(createAdapter({ document: fakeDocument({ match: {} }), site: 'grok', selectors: fastSelectors('grok') }).ready(80), 'composer_not_found')

  const busy = fakeDocument({ match: { '#prompt-textarea': composer, 'button.stop': {} } })
  const c = createAdapter({ document: busy, site: 'chatgpt', selectors: fastSelectors('chatgpt', { stop: ['button.stop'] }) })
  await rejects(c.ready(150), 'timeout', /stop button/)
  assert.equal(c.health().stop, true)
  assert.equal(c.health().matched.stop, 'button.stop')
})

test('insertAndSubmit rejects empty text and every wall state without touching the composer', async () => {
  const composer = fakeComposer()
  const doc = fakeDocument({ match: { '#prompt-textarea': composer }, bodyText: 'Something went wrong' })
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  await rejects(a.insertAndSubmit(''), 'site_error', /non-empty/)
  await rejects(a.insertAndSubmit(42), 'site_error')
  await rejects(a.insertAndSubmit('hello'), 'blocked', /unusual activity|error banner/)
  doc.body.innerText = ''
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
  const doc = fakeDocument({ match: { textarea: ta } })
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

test('submit: click confirmed by a grown message count; assistantCount is the sample before the click', async () => {
  const composer = fakeComposer({ text: 'ready to go' })
  const doc = fakeDocument({ match: { '#prompt-textarea': composer, '[data-message-author-role]': [{}] } })
  const button = {
    click() {
      doc.match['[data-message-author-role]'].push({})
    },
  }
  doc.match["button[data-testid='send-button']"] = button
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: fastSelectors('chatgpt') })
  const r = await a.submit()
  assert.deepEqual(r, { method: 'click', sendSelector: "button[data-testid='send-button']", confirmedBy: 'assistant_count', assistantCount: 1 })
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
  const doc = fakeDocument({ match: { "textarea[aria-label='Ask Grok anything']": ta, '.message-bubble': [{}, {}] } })
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
