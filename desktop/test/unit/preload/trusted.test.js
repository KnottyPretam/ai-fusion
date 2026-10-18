// The trusted-input ops of desktop/preload/site.cjs (2026-10-17): `prepareInput` / `verifyInput` / `confirmSubmit`,
// over a fake document (no jsdom) and through attachIpc.
//
// Why they exist: gemini.google.com is publicly reported (2026-09-30, an Electron 44 embed) to ignore UNTRUSTED input —
// a synthetic insert plus `el.click()` showed the Stop state and no usable reply, which the adapter's own submit
// confirmation would take for a submission. So on a site whose `trustedInput` is true main types the bridge request's
// text itself with Electron's trusted `webContents.insertText` and a `sendInputEvent` Enter, and these three ops bracket
// its keystrokes: the session gate + focus + caret, what landed (all / partial / none), and whether the Enter submitted.
// "Main typed it" is simulated here by writing the composer's text between the ops. Pinned: the session gate rejects
// before anything is focused or remembered; lengths, counts and booleans only — never a character of the prompt or the
// page — in any result or error; `already_present` (a leftover of exactly this prompt) asks main to type nothing;
// `none` only when the composer provably did not change (a vanished composer is `partial`, the answer on which main never
// types again); the pre-submit baseline and the message count are taken once ALL of it landed, as submit() takes them;
// confirmSubmit re-baselines after a miss, only ever LOWERS the observe baseline, clicks the send button once on
// request while the prompt is still held, and consumes the prepared input once confirmed; insertAndSubmit ends any
// prepared input; the three ops occupy the one-in-flight slot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAdapter, AdapterError, attachIpc, DEFAULT_SELECTORS, TRUSTED_VERIFY_MS, SLOT_OPS } = require('../../../preload/site.cjs')

const G = DEFAULT_SELECTORS.gemini
const COMPOSER = G.composer[0]
const SEND = G.send[0]
const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A prompt that is easy to find if any result ever leaked it, and a draft that is easy to find as well. */
const PROMPT = 'Zyxwvut prompt: what is the maximum gyroscope range of the BMI088?'
const DRAFT = 'Qqqqq leftover draft'

/**
 * A fake document whose `match` maps a selector to an element or a list ('*' lists nothing: no shadow roots), with the
 * selection API `placeCaretAtEnd` uses (recorded) and an `activeElement` that `focus()` moves.
 */
function fakeWorld({ composerText = '', loggedOut = false, withSend = true, containers = 0, now } = {}) {
  const ranges = []
  const doc = {
    title: 'Gemini',
    location: { href: 'https://gemini.google.com/app', hostname: 'gemini.google.com' },
    activeElement: null,
    match: {},
    createRange() {
      const r = {
        node: null,
        collapsed: null,
        selectNodeContents(n) {
          r.node = n
        },
        collapse(toStart) {
          r.collapsed = toStart ? 'start' : 'end'
        },
      }
      return r
    },
    getSelection() {
      return {
        removeAllRanges() {
          ranges.length = 0
        },
        addRange(r) {
          ranges.push(r)
        },
      }
    },
    querySelector(s) {
      const v = doc.match[s]
      return Array.isArray(v) ? v[0] || null : v || null
    },
    querySelectorAll(s) {
      if (s === '*') return []
      const v = doc.match[s]
      return v === undefined ? [] : Array.isArray(v) ? v : [v]
    },
  }
  const composer = {
    tagName: 'DIV',
    ownerDocument: doc,
    focused: 0,
    _text: composerText,
    focus() {
      composer.focused += 1
      doc.activeElement = composer
    },
    contains: (n) => n === composer,
    get innerText() {
      return composer._text
    },
    get textContent() {
      return composer._text
    },
    set innerHTML(_v) {
      throw new Error('innerHTML write is forbidden')
    },
  }
  const send = {
    tagName: 'BUTTON',
    clicks: 0,
    onClick: null,
    click() {
      send.clicks += 1
      if (send.onClick) send.onClick()
    },
  }
  doc.match[COMPOSER] = composer
  if (withSend) doc.match[SEND] = send
  if (loggedOut) doc.match["a[aria-label='Sign in']"] = { tagName: 'A' }
  const turns = Array.from({ length: containers }, () => ({ tagName: 'MODEL-RESPONSE', textContent: 'an earlier reply' }))
  doc.match['model-response'] = turns
  const adapter = createAdapter({
    document: doc,
    site: 'gemini',
    selectors: { ...DEFAULT_SELECTORS, gemini: { ...G, composerWaitMs: 200, sendWaitMs: 150, submitVerifyMs: 150 } },
    now, // undefined → the adapter's own Date.now; a test that must place an event between two polls passes a clock
  })
  return { doc, composer, send, adapter, ranges, turns }
}

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

/** No result or error may carry a character of the prompt or of the page's text. */
function assertNoText(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  for (const leak of ['Zyxwvut', 'gyroscope', 'Qqqqq', 'earlier reply']) assert.ok(!s.includes(leak), `leaked "${leak}" in ${s}`)
}

test('the trio is exported where main and the in-flight rule can see it: TRUSTED_VERIFY_MS is 1 s, and SLOT_OPS holds the three beside the four older ops', () => {
  assert.equal(TRUSTED_VERIFY_MS, 1000)
  assert.deepEqual([...SLOT_OPS], ['ready', 'insertAndSubmit', 'observe', 'snapshot', 'prepareInput', 'verifyInput', 'confirmSubmit'])
  assert.ok(Object.isFrozen(SLOT_OPS))
  const { adapter } = fakeWorld()
  for (const op of ['prepareInput', 'verifyInput', 'confirmSubmit']) assert.equal(typeof adapter[op], 'function', op)
})

test('prepareInput: session gate first — a guest-mode page (composer present, Sign-in link) rejects logged_out before anything is focused or remembered, and the later ops find no prepared input', async () => {
  const { adapter, composer, ranges } = fakeWorld({ loggedOut: true })
  assert.equal(adapter.sessionState(), 'logged_out')
  await rejects(adapter.prepareInput(PROMPT), 'logged_out')
  assert.equal(composer.focused, 0)
  assert.equal(ranges.length, 0)
  await rejects(adapter.verifyInput(PROMPT), 'site_error', /^verifyInput: no prepared input/)
  await rejects(adapter.confirmSubmit(PROMPT), 'site_error', /^confirmSubmit: no prepared input/)
})

test('prepareInput: focuses the composer and collapses a Range at its END (main\'s trusted text lands after any draft); answers lengths and booleans only', async () => {
  const { adapter, composer, ranges, doc } = fakeWorld({ composerText: DRAFT })
  const r = await adapter.prepareInput(PROMPT)
  assert.deepEqual(Object.keys(r).sort(), ['composerChars', 'composerSelector', 'focused', 'ms', 'state'])
  assert.equal(r.state, 'ready')
  assert.equal(r.composerSelector, COMPOSER)
  assert.equal(r.composerChars, DRAFT.replace(/\s+/g, '').length) // non-whitespace characters
  assert.equal(r.focused, true)
  assert.ok(Number.isInteger(r.ms))
  assert.equal(composer.focused >= 1, true)
  assert.equal(doc.activeElement, composer)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].node, composer)
  assert.equal(ranges[0].collapsed, 'end')
  assertNoText(r)
  // the bad text guard writes nothing either
  await rejects(adapter.prepareInput(''), 'site_error', /non-empty string/)
  await rejects(adapter.prepareInput(42), 'site_error', /non-empty string/)
})

test('prepareInput: a composer already holding exactly this prompt (the leftover of a failed attempt) is `already_present` — main types nothing — and verifyInput then reads `all` at once', async () => {
  const { adapter } = fakeWorld({ composerText: PROMPT })
  const r = await adapter.prepareInput(PROMPT)
  assert.equal(r.state, 'already_present')
  const v = await adapter.verifyInput(PROMPT, { verifyMs: 50 })
  assert.equal(v.landed, 'all')
  assert.equal(v.composerChars, v.expectedChars)
})

test('prepareInput: a composer holding only the START of this prompt (what a `partial` insert leaves) is `partial_present` — nothing focused, no caret, no prepared input, so main types nothing (review 2026-10-17)', async () => {
  const fragment = PROMPT.slice(0, Math.max(3, Math.floor(PROMPT.length / 2)))
  const { adapter, ranges } = fakeWorld({ composerText: fragment })
  const r = await adapter.prepareInput(PROMPT)
  assert.equal(r.state, 'partial_present')
  assert.equal(r.composerChars, fragment.replace(/\s+/g, '').length)
  assert.equal(ranges.length, 0, 'no caret placed')
  assertNoText(r)
  await rejects(adapter.verifyInput(PROMPT), 'site_error', /^verifyInput: no prepared input/)
  // a draft that is NOT a prefix of the prompt is still `ready` (the trusted text lands after it)
  const other = fakeWorld({ composerText: DRAFT })
  assert.equal((await other.adapter.prepareInput(PROMPT)).state, 'ready')
})

test('verifyInput: ALL of it landed (the previous text followed by the prompt, whitespace-insensitive) → `all`, the send button seen, the observe baseline and the message count taken; lengths only', async () => {
  const { adapter, composer } = fakeWorld({ composerText: DRAFT, containers: 2 })
  await adapter.prepareInput(PROMPT)
  composer._text = DRAFT + '\n' + PROMPT.replace(/ /g, '  ') // an editor re-renders whitespace; every other character survives
  const v = await adapter.verifyInput(PROMPT, { verifyMs: 300 })
  assert.deepEqual(Object.keys(v).sort(), ['assistantCount', 'composerChars', 'expectedChars', 'landed', 'ms', 'sendReady'])
  assert.equal(v.landed, 'all')
  assert.equal(v.expectedChars, (DRAFT + PROMPT).replace(/\s+/g, '').length)
  assert.equal(v.composerChars, v.expectedChars)
  assert.equal(v.sendReady, true)
  assert.equal(v.assistantCount, 2) // the pre-submit containers: the observe's baselineCount
  assertNoText(v)
})

test('verifyInput: the text arriving a little LATE still reads `all` inside the window; a send button that never shows is not fatal (sendReady false)', async () => {
  const { adapter, composer, doc } = fakeWorld({ withSend: false })
  await adapter.prepareInput(PROMPT)
  setTimeout(() => (composer._text = PROMPT), 120)
  const v = await adapter.verifyInput(PROMPT, { verifyMs: 600, sendWaitMs: 50 })
  assert.equal(v.landed, 'all')
  assert.equal(v.sendReady, false)
  assert.equal(doc.match[SEND], undefined)
})

test('verifyInput: nothing changed → `none` (after the window); part of it → `partial`; a composer that VANISHED → `partial`, never `none` (on `none` main types the prompt again)', async () => {
  const none = fakeWorld({ composerText: DRAFT })
  await none.adapter.prepareInput(PROMPT)
  const t0 = Date.now()
  const n = await none.adapter.verifyInput(PROMPT, { verifyMs: 120 })
  assert.equal(n.landed, 'none')
  assert.ok(Date.now() - t0 >= 100, 'the whole window was watched')
  assert.equal(n.sendReady, false)
  assert.equal(n.composerChars, DRAFT.replace(/\s+/g, '').length)
  assertNoText(n)

  const partial = fakeWorld()
  await partial.adapter.prepareInput(PROMPT)
  partial.composer._text = PROMPT.slice(0, 20)
  const p = await partial.adapter.verifyInput(PROMPT, { verifyMs: 80 })
  assert.equal(p.landed, 'partial')
  assert.equal(p.composerChars, PROMPT.slice(0, 20).replace(/\s+/g, '').length)

  const reformatted = fakeWorld()
  await reformatted.adapter.prepareInput(PROMPT)
  reformatted.composer._text = PROMPT + ' and something the editor added'
  assert.equal((await reformatted.adapter.verifyInput(PROMPT, { verifyMs: 80 })).landed, 'partial')

  const gone = fakeWorld()
  await gone.adapter.prepareInput(PROMPT)
  delete gone.doc.match[COMPOSER]
  const g = await gone.adapter.verifyInput(PROMPT, { verifyMs: 80 })
  assert.equal(g.landed, 'partial')
  assert.equal(g.composerChars, 0)
})

test('verifyInput / confirmSubmit refuse a message naming another text (`site_error`, no text in the message); a message with no text uses the prepared one', async () => {
  const { adapter, composer } = fakeWorld()
  await adapter.prepareInput(PROMPT)
  const e = await rejects(adapter.verifyInput('a different prompt'), 'site_error', /the text is not the prepared input/)
  assertNoText(e.message)
  composer._text = PROMPT
  assert.equal((await adapter.verifyInput(undefined, { verifyMs: 50 })).landed, 'all')
  await rejects(adapter.confirmSubmit('a different prompt'), 'site_error', /the text is not the prepared input/)
})

test('confirmSubmit before the input was seen to land in full is `site_error` (verifyInput first): a `none` / `partial` reading never arms a confirmation', async () => {
  const { adapter } = fakeWorld()
  await adapter.prepareInput(PROMPT)
  assert.equal((await adapter.verifyInput(PROMPT, { verifyMs: 50 })).landed, 'none')
  await rejects(adapter.confirmSubmit(PROMPT), 'site_error', /not seen to land in full/)
})

test('confirmSubmit: main\'s Enter emptied the composer → `composer_cleared`, stillHeld false, no click; the prepared input is consumed (a stray second confirm is site_error)', async () => {
  const { adapter, composer, send } = fakeWorld()
  await adapter.prepareInput(PROMPT)
  composer._text = PROMPT
  await adapter.verifyInput(PROMPT, { verifyMs: 50 })
  composer._text = '' // main pressed Enter and the site took it
  const c = await adapter.confirmSubmit(PROMPT)
  assert.deepEqual(Object.keys(c).sort(), ['assistantCount', 'confirmedBy', 'ms', 'sendSelector', 'stillHeld'])
  assert.equal(c.confirmedBy, 'composer_cleared')
  assert.equal(c.stillHeld, false)
  assert.equal(c.sendSelector, null)
  assert.equal(send.clicks, 0)
  assertNoText(c)
  await rejects(adapter.confirmSubmit(PROMPT), 'site_error', /no prepared input/)
})

test('confirmSubmit: a stop control alone is no submission while the composer still holds the prompt (submit()\'s 2026-09-27 rule); a new message counted against the verify-time baseline is one', async () => {
  const { adapter, composer, doc, turns } = fakeWorld({ containers: 1 })
  await adapter.prepareInput(PROMPT)
  composer._text = PROMPT
  await adapter.verifyInput(PROMPT, { verifyMs: 50 })
  doc.match[G.stop[0]] = { tagName: 'BUTTON' } // a stop control, the prompt still in the composer
  const held = await adapter.confirmSubmit(PROMPT)
  assert.equal(held.confirmedBy, null)
  assert.equal(held.stillHeld, true)
  // the next Enter lands: the user turn mounts (one more message than the re-baselined count)
  delete doc.match[G.stop[0]]
  doc.match['user-query'] = [{ tagName: 'USER-QUERY', textContent: 'x' }]
  const landed = await adapter.confirmSubmit(PROMPT)
  assert.equal(landed.confirmedBy, 'assistant_count')
  assert.equal(landed.assistantCount, turns.length)
})

test('confirmSubmit: a miss re-baselines for main\'s next Enter and only ever LOWERS the observe baseline — a placeholder that mounts later confirms the submission but never lifts the baseline', async () => {
  const { adapter, composer, send, doc } = fakeWorld({ containers: 3 })
  await adapter.prepareInput(PROMPT)
  composer._text = PROMPT
  const v = await adapter.verifyInput(PROMPT, { verifyMs: 50 })
  assert.equal(v.assistantCount, 3)
  // a container went away while the Enter was being confirmed: the baseline follows it down
  doc.match['model-response'] = doc.match['model-response'].slice(0, 2)
  const miss = await adapter.confirmSubmit(PROMPT)
  assert.deepEqual([miss.confirmedBy, miss.stillHeld, miss.assistantCount], [null, true, 2])
  // main's second Enter lands and the site mounts two rows: a new message against the RE-BASELINED count confirms it,
  // and the observe baseline stays where it was lowered to (submit()'s placeholder note)
  doc.match['model-response'] = [...doc.match['model-response'], { tagName: 'MODEL-RESPONSE', textContent: '' }, { tagName: 'MODEL-RESPONSE', textContent: '' }]
  const landed = await adapter.confirmSubmit(PROMPT)
  assert.equal(landed.confirmedBy, 'assistant_count')
  assert.equal(landed.assistantCount, 2)
  assert.equal(send.clicks, 0)
})

test('confirmSubmit: a miss NEVER LIFTS the observe baseline — a placeholder that mounts after the confirm poll\'s last sample and before the re-baseline is not counted, and the next confirm keeps the baseline at 3 (review 2026-10-17: the decrease alone left `Math.min` untested)', async () => {
  // A manual clock: the confirm poll runs until ITS clock says the window is over, and the clock call that ends it is
  // the moment the placeholder mounts — after the poll's last sample (which saw 3 rows, so nothing confirmed), before
  // the re-baseline reads the rows again. Deterministic: no sample of the poll can see the fourth row.
  let virtual = 0
  let ended = false
  const now = () => {
    if (virtual >= 1000) ended = true
    return virtual
  }
  const { adapter, composer, send, doc, turns } = fakeWorld({ containers: 3, now })
  const placeholder = { tagName: 'MODEL-RESPONSE', textContent: '' }
  Object.defineProperty(doc.match, 'model-response', { configurable: true, enumerable: true, get: () => (ended ? [...turns, placeholder] : turns) })
  await adapter.prepareInput(PROMPT)
  composer._text = PROMPT
  const v = await adapter.verifyInput(PROMPT, { verifyMs: 50 })
  assert.equal(v.assistantCount, 3)
  const pending = adapter.confirmSubmit(PROMPT)
  await sleep(40) // the poll is sampling: three rows, the prompt still held, no stop control
  assert.equal(ended, false)
  virtual = 1000 // the next clock read ends the poll's window — and mounts the placeholder
  const miss = await pending
  assert.equal(ended, true)
  assert.equal(adapter.countAssistant(), 4, 'the placeholder is on the page when the re-baseline samples')
  assert.deepEqual([miss.confirmedBy, miss.stillHeld, miss.assistantCount], [null, true, 3])
  // main's second Enter lands: the composer empties, and the observe baseline handed back is still the one taken before
  composer._text = ''
  const landed = await adapter.confirmSubmit(PROMPT)
  assert.equal(landed.confirmedBy, 'composer_cleared')
  assert.equal(landed.assistantCount, 3)
  assert.equal(send.clicks, 0)
})

test('confirmSubmit{clickFallback}: when main\'s Enter did not submit and the prompt is still held, ONE click on the send button — and that click can confirm', async () => {
  const { adapter, composer, send } = fakeWorld()
  await adapter.prepareInput(PROMPT)
  composer._text = PROMPT
  await adapter.verifyInput(PROMPT, { verifyMs: 50 })
  send.onClick = () => (composer._text = '')
  const clicked = await adapter.confirmSubmit(PROMPT, { clickFallback: true })
  assert.equal(send.clicks, 1)
  assert.deepEqual([clicked.confirmedBy, clicked.stillHeld, clicked.sendSelector], ['composer_cleared', false, SEND])
})

test('confirmSubmit{clickFallback}: no click when the composer no longer holds the prompt, or when there is no send button; a click the site ignores leaves confirmedBy null and the prompt held', async () => {
  const noButton = fakeWorld({ withSend: false })
  await noButton.adapter.prepareInput(PROMPT)
  noButton.composer._text = PROMPT
  await noButton.adapter.verifyInput(PROMPT, { verifyMs: 50, sendWaitMs: 20 })
  const a = await noButton.adapter.confirmSubmit(PROMPT, { clickFallback: true })
  assert.deepEqual([a.confirmedBy, a.stillHeld, a.sendSelector], [null, true, null])

  const ignored = fakeWorld()
  await ignored.adapter.prepareInput(PROMPT)
  ignored.composer._text = PROMPT
  await ignored.adapter.verifyInput(PROMPT, { verifyMs: 50 })
  const b = await ignored.adapter.confirmSubmit(PROMPT, { clickFallback: true }) // the click does nothing (?untrusted=ignore)
  assert.equal(ignored.send.clicks, 1)
  assert.deepEqual([b.confirmedBy, b.stillHeld, b.sendSelector], [null, true, SEND])
  // a later confirm without the fallback clicks nothing more
  await ignored.adapter.confirmSubmit(PROMPT)
  assert.equal(ignored.send.clicks, 1)

  // the composer holds something else now (not empty, not the prompt): unconfirmed, and no click — the prompt is not provably there
  const replaced = fakeWorld()
  await replaced.adapter.prepareInput(PROMPT)
  replaced.composer._text = PROMPT
  await replaced.adapter.verifyInput(PROMPT, { verifyMs: 50 })
  replaced.composer._text = 'something else entirely'
  const c = await replaced.adapter.confirmSubmit(PROMPT, { clickFallback: true })
  assert.deepEqual([c.confirmedBy, c.stillHeld, c.sendSelector, replaced.send.clicks], [null, false, null, 0])
})

test('insertAndSubmit (main\'s synthetic fallback after a `none`) ends the prepared input: verifyInput afterwards finds none', async () => {
  const { adapter, composer } = fakeWorld()
  await adapter.prepareInput(PROMPT)
  // the synthetic path's insertion needs a real editor; it fails here, but the prepared input is gone all the same
  await assert.rejects(adapter.insertAndSubmit(PROMPT))
  composer._text = PROMPT
  await rejects(adapter.verifyInput(PROMPT, { verifyMs: 20 }), 'site_error', /no prepared input/)
})

test('the ops honour cancel: an aborted signal rejects `cancelled` from inside the verify poll', async () => {
  const { adapter } = fakeWorld()
  await adapter.prepareInput(PROMPT)
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 50)
  await rejects(adapter.verifyInput(PROMPT, { verifyMs: 2000, signal: ctrl.signal }), 'cancelled')
})

// ---- through attachIpc -----------------------------------------------------------------------------------------------

function fakeIpc() {
  const handlers = new Map()
  const ipc = {
    sent: [],
    invoke: (channel) => (channel === 'adapter:config' ? Promise.resolve({ site: 'gemini', selectors: {} }) : Promise.reject(new Error(channel))),
    on(channel, h) {
      if (!handlers.has(channel)) handlers.set(channel, [])
      handlers.get(channel).push(h)
    },
    send(channel, payload) {
      ipc.sent.push({ channel, payload })
    },
    emit: (msg) => (handlers.get('triplex:adapter') || []).forEach((h) => h({}, msg)),
    result: (reqId) => (ipc.sent.find((s) => s.channel === 'triplex:adapter:result' && s.payload.reqId === reqId) || {}).payload || null,
  }
  return ipc
}

async function until(fn, ms = 2000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until: timed out')
    await sleep(5)
  }
}

test('attachIpc: the three ops dispatch with their message fields, answer the result shapes (confirmSubmit with the url), never echo the prompt — and each OCCUPIES the one-in-flight slot', async () => {
  const world = fakeWorld()
  const ipc = fakeIpc()
  const attached = attachIpc(ipc, () => world.adapter, { setInterval: () => 0, clearInterval: () => {} })
  assert.equal(await attached.ready, true)

  ipc.emit({ reqId: 'p', op: 'prepareInput', text: PROMPT, timeoutMs: 200 })
  const p = await until(() => ipc.result('p'))
  assert.deepEqual({ ok: p.ok, op: p.op, state: p.state, composerSelector: p.composerSelector, focused: p.focused }, { ok: true, op: 'prepareInput', state: 'ready', composerSelector: COMPOSER, focused: true })

  // a long verify window holds the slot: a second op of ANY slot kind answers busy naming it
  ipc.emit({ reqId: 'v', op: 'verifyInput', text: PROMPT, verifyMs: 300 })
  ipc.emit({ reqId: 'o', op: 'observe', baselineCount: 0 })
  ipc.emit({ reqId: 'c0', op: 'confirmSubmit', text: PROMPT })
  await tick()
  assert.deepEqual(ipc.result('o'), { reqId: 'o', ok: false, op: 'observe', code: 'busy', message: 'op verifyInput (v) in flight' })
  assert.equal(ipc.result('c0').code, 'busy')
  // health is never blocked
  ipc.emit({ reqId: 'h', op: 'health' })
  assert.equal(ipc.result('h').ok, true)
  world.composer._text = PROMPT
  const v = await until(() => ipc.result('v'))
  assert.equal(v.landed, 'all')

  world.composer._text = ''
  ipc.emit({ reqId: 'c', op: 'confirmSubmit', text: PROMPT, clickFallback: true })
  const c = await until(() => ipc.result('c'))
  assert.deepEqual({ ok: c.ok, op: c.op, confirmedBy: c.confirmedBy, stillHeld: c.stillHeld, sendSelector: c.sendSelector, url: c.url }, { ok: true, op: 'confirmSubmit', confirmedBy: 'composer_cleared', stillHeld: false, sendSelector: null, url: 'https://gemini.google.com/app' })
  for (const r of [p, v, c]) assertNoText(r)

  // an op error travels as the usual error result, still without the prompt
  ipc.emit({ reqId: 'v2', op: 'verifyInput', text: PROMPT })
  const v2 = await until(() => ipc.result('v2'))
  assert.deepEqual({ ok: v2.ok, code: v2.code }, { ok: false, code: 'site_error' })
  assertNoText(v2)
  attached.dispose()
})

test('attachIpc: cancel{target} aborts an in-flight verifyInput (it answers cancelled) and frees the slot', async () => {
  const world = fakeWorld()
  const ipc = fakeIpc()
  const attached = attachIpc(ipc, () => world.adapter, { setInterval: () => 0, clearInterval: () => {} })
  await attached.ready
  ipc.emit({ reqId: 'p', op: 'prepareInput', text: PROMPT })
  await until(() => ipc.result('p'))
  ipc.emit({ reqId: 'v', op: 'verifyInput', text: PROMPT, verifyMs: 5000 })
  await sleep(30)
  ipc.emit({ reqId: 'x', op: 'cancel', target: 'v' })
  const cancel = await until(() => ipc.result('x'))
  assert.deepEqual(cancel, { reqId: 'x', ok: true, op: 'cancel', cancelled: true })
  assert.equal(ipc.result('v').code, 'cancelled')
  ipc.emit({ reqId: 'h2', op: 'snapshot' })
  assert.notEqual((await until(() => ipc.result('h2'))).code, 'busy')
  attached.dispose()
})
