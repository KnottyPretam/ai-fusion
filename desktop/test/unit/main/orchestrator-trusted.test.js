// orchestrator.js — the TRUSTED submit sequence (2026-10-17) for a site whose selectors say `trustedInput`
// (gemini): focus → prepareInput → main's trusted insertText → verifyInput → trusted Enter → confirmSubmit, all
// under ONE mutex hold; `already_present` types nothing; `none` → one synthetic insertAndSubmit; `partial` →
// not_submitted + the failure snapshot, never re-typed; an unconfirmed Enter with the prompt still held → one more
// Enter + confirmSubmit{clickFallback}; two misses → not_submitted; an abort during the insert ends the turn with
// no Enter; a timed-out insert still asks the page what landed; the analyst view types into ('analyst', slot); the
// budgets; no log line ever carries the text; and the classic three stay byte-identical (payloads, budgets, line).
// Every collaborator is a fake; the adapter answers by script.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrchestrator, createMutex, insertAndSubmitBudgetMs, trustedSubmitBudgetMs, TIMEOUT_GRACE_MS, TRUSTED_INSERT_MS, TRUSTED_VERIFY_MS, INSERT_SETTLE_MS, CAPTURE_CEILING_MARGIN_MS } from '../../../main/orchestrator.js'
import { TRUSTED_PAINT_MS } from '../../../main/trusted-input.js'
import { AdapterRequestError } from '../../../main/adapter-client.js'
import { validate } from '../../../main/protocol.js'
import { fakeLog, fakeTimers, tick } from './_fakes.js'

const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const TEXT = 'PROMPT-SECRET-42 `x`'
const T = { composerWaitMs: 1000, sendWaitMs: 2000, submitVerifyMs: 500 }
const C = { quietMs: 250, settleMs: 200, firstTokenMs: 3000, captureTimeoutMs: 4000 }

const DEFAULTS = {
  ready: () => ({ ok: true, op: 'ready', composerSelector: '.ql-editor' }),
  prepareInput: () => ({ ok: true, op: 'prepareInput', state: 'ready', composerSelector: 'rich-textarea div.ql-editor', composerChars: 0, focused: true, ms: 1 }),
  verifyInput: () => ({ ok: true, op: 'verifyInput', landed: 'all', composerChars: 18, expectedChars: 18, sendReady: true, assistantCount: 3, ms: 2 }),
  confirmSubmit: () => ({ ok: true, op: 'confirmSubmit', confirmedBy: 'composer_cleared', stillHeld: false, sendSelector: null, assistantCount: 3, ms: 3, url: 'https://gemini.test/app/abc123' }),
  insertAndSubmit: () => ({ ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: '#c', sendSelector: 'button.send', assistantCount: 2, confirmedBy: 'stop_button', ms: 4, url: 'https://x.test/c/1' }),
  observe: () => ({ ok: true, op: 'observe', text: 'Echo: hi', doneBy: 'done_selector', ms: 5, url: 'https://gemini.test/app/abc123' }),
}

/**
 * harness(opts): one orchestrator with a scripted adapter client for every slot and a recording trusted input.
 *   script        {op: (payload, opts, n) => result | throws | Promise} overriding DEFAULTS (n = the op's call index)
 *   trusted       trustedInputFor(slot) (default: gemini only); `wired:false` → no trustedInput dep at all
 *   insertText / pressEnter   behaviour of the trusted deps (default: resolve)
 *   capture       the pane capture switch for every slot (default on); timeouts / captures override T / C
 */
function harness({ script = {}, trusted = (slot) => slot === 'gemini', wired = true, insertText = null, pressEnter = null, capture = true, timeouts = T, captures = C, analyst = false } = {}) {
  const trace = [] // one ordered list: adapter ops, focus, trusted keystrokes
  const deps = [] // trusted deps + focus, each with mutex.locked() at call time
  const calls = [] // {slot, op, payload, opts}
  const counts = {}
  const snapshots = []
  const log = fakeLog()
  const timers = fakeTimers()
  const mutex = createMutex()
  const clientFor = (slot) => ({
    slot,
    request: (op, payload = {}, opts = {}) => {
      calls.push({ slot, op, payload, opts })
      trace.push(`op:${op}`)
      counts[op] = (counts[op] || 0) + 1
      const fn = script[op] || DEFAULTS[op]
      if (!fn) return Promise.reject(new AdapterRequestError('site_error', `unscripted op ${op}`))
      try {
        return Promise.resolve(fn(payload, opts, counts[op]))
      } catch (e) {
        return Promise.reject(e)
      }
    },
  })
  const clients = {}
  const client = (slot) => (clients[slot] = clients[slot] || clientFor(slot))
  const trustedInput = wired
    ? {
        insertText: (view, slot, text) => {
          deps.push(['insertText', view, slot, text, mutex.locked()])
          trace.push('insertText')
          return insertText ? insertText(view, slot, text) : Promise.resolve()
        },
        pressEnter: (view, slot) => {
          deps.push(['pressEnter', view, slot, mutex.locked()])
          trace.push('pressEnter')
          return pressEnter ? pressEnter(view, slot) : Promise.resolve()
        },
      }
    : null
  let clock = 1000
  const orch = createOrchestrator({
    adapterFor: (slot) => client(slot),
    ...(analyst ? { analystAdapterFor: (slot) => client(`analyst:${slot}`) } : {}),
    analystView: analyst
      ? {
          focus: () => {
            deps.push(['focus', 'analyst', mutex.locked()])
            trace.push('focus')
          },
          currentUrl: () => 'https://gemini.test/app',
        }
      : null,
    focusView: (slot) => {
      deps.push(['focus', slot, mutex.locked()])
      trace.push('focus')
    },
    restoreRendererFocus: () => trace.push('renderer:focus'),
    timeoutsFor: () => timeouts,
    captureTimeoutsFor: () => captures,
    chatUrlPatternFor: () => '',
    getCapture: () => ({ claude: capture, chatgpt: capture, grok: capture, gemini: capture }),
    currentUrl: (slot) => `https://${slot}.test/`,
    saveFailureSnapshot: async (view, slot, opts) => {
      snapshots.push(opts === undefined ? [view, slot] : [view, slot, opts])
      return `/tmp/snapshots/${slot}-failed-1.html`
    },
    trustedInputFor: trusted,
    ...(trustedInput ? { trustedInput } : {}),
    mutex,
    log,
    now: () => (clock += 10),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  const emitted = []
  const run = (req) => orch.run(req, (f) => emitted.push(f))
  const ops = (slot = 'gemini') => calls.filter((c) => c.slot === slot).map((c) => c.op)
  const call = (op, n = 1, slot = 'gemini') => calls.filter((c) => c.slot === slot && c.op === op)[n - 1]
  return { orch, run, trace, deps, calls, ops, call, snapshots, log, timers, mutex, emitted }
}

const request = (slot = 'gemini', extra = {}) => ({ type: 'request', req_id: `req-${slot}`, model: `web:${slot}`, slot, view: 'pane', fresh: false, text: TEXT, role: slot, purpose: 'chat', conversation_id: CONV, timeout_s: 600, ...extra })
const assertValid = (frame) => {
  const r = validate(frame)
  assert.equal(r.ok, true, `${r.error} — ${JSON.stringify(frame)}`)
}
const infoLines = (log) => log.lines.filter(([l]) => l === 'log').map(([, m]) => m)
const warnLines = (log) => log.lines.filter(([l]) => l === 'warn').map(([, m]) => m)

// 1 --------------------------------------------------------------------------------------------------
test('1. a classic site never takes the trusted path: ops exactly [ready, insertAndSubmit, observe], the trusted deps are never called, payloads / budget / log line byte-identical', async () => {
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    const h = harness()
    const final = await h.run(request(slot))
    assert.equal(final.ok, true, JSON.stringify(final))
    assertValid(final)
    assert.deepEqual(h.ops(slot), ['ready', 'insertAndSubmit', 'observe'])
    assert.deepEqual(h.deps, [['focus', slot, true]], 'only the focus — never insertText / pressEnter')
    assert.deepEqual(h.call('insertAndSubmit', 1, slot).payload, { text: TEXT })
    assert.equal(h.call('insertAndSubmit', 1, slot).opts.timeoutMs, insertAndSubmitBudgetMs({ ...T, insertSettleMs: INSERT_SETTLE_MS }) + TIMEOUT_GRACE_MS)
    assert.deepEqual(h.call('observe', 1, slot).payload, { quietMs: 250, settleMs: 200, timeoutMs: 4000, firstTokenMs: 3000, text: TEXT, baselineCount: 2 })
    assert.ok(infoLines(h.log).includes(`[orchestrator] ${slot}: submitted by stop_button (send: button.send)`), 'the S11 line, unchanged')
  }
})

// 2 --------------------------------------------------------------------------------------------------
test('2. gemini: ops [ready, prepareInput, verifyInput, confirmSubmit, observe]; deps [focus, insertText(text), pressEnter] all under the mutex; observe.baselineCount = verifyInput.assistantCount; the result is a normal capture', async () => {
  const h = harness()
  const final = await h.run(request())
  assert.deepEqual(final, { type: 'result', req_id: 'req-gemini', ok: true, captured: true, text: 'Echo: hi', url: 'https://gemini.test/app/abc123', ms: final.ms, done_by: 'done_selector' })
  assertValid(final)
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit', 'observe'])
  assert.deepEqual(h.deps, [
    ['focus', 'gemini', true],
    ['insertText', 'pane', 'gemini', TEXT, true],
    ['pressEnter', 'pane', 'gemini', true],
  ])
  assert.deepEqual(h.trace.filter((t) => t !== 'renderer:focus'), ['op:ready', 'focus', 'op:prepareInput', 'insertText', 'op:verifyInput', 'pressEnter', 'op:confirmSubmit', 'op:observe'])
  assert.deepEqual(h.call('prepareInput').payload, { text: TEXT, timeoutMs: T.composerWaitMs })
  assert.deepEqual(h.call('verifyInput').payload, { text: TEXT, verifyMs: TRUSTED_VERIFY_MS, sendWaitMs: T.sendWaitMs })
  assert.deepEqual(h.call('confirmSubmit').payload, { text: TEXT }, 'the first confirmation asks for no click')
  assert.equal(h.call('observe').payload.baselineCount, 3, 'verifyInput\'s pre-Enter sample is the observe baseline')
  assert.equal(h.call('observe').payload.text, TEXT, 'the anchor rides along as for every site')
  assert.ok(infoLines(h.log).includes('[orchestrator] gemini: submitted by composer_cleared (insert: trusted, send: trusted-enter)'))
  assert.equal(h.mutex.locked(), false, 'the mutex is released once the submit is done')
  assert.equal(h.trace.indexOf('renderer:focus') > h.trace.indexOf('op:confirmSubmit'), true, 'renderer focus restored after the whole trusted sequence')
})

// 3 --------------------------------------------------------------------------------------------------
test('3. already_present: the composer already holds exactly this prompt — main types NOTHING, then verifies, Enter, confirms', async () => {
  const h = harness({ script: { prepareInput: () => ({ state: 'already_present', composerSelector: '.ql-editor', composerChars: 18, focused: true }) } })
  const final = await h.run(request())
  assert.equal(final.ok, true)
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus', 'pressEnter'], 'no insertText')
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit', 'observe'])
})

// 4 --------------------------------------------------------------------------------------------------
test('4. landed none: provably nothing typed → ONE synthetic insertAndSubmit (its own budget), no trusted Enter; the line says so', async () => {
  const h = harness({ script: { verifyInput: () => ({ landed: 'none', composerChars: 0, expectedChars: 18, sendReady: false, assistantCount: 3 }) } })
  const final = await h.run(request())
  assert.equal(final.ok, true, JSON.stringify(final))
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput', 'insertAndSubmit', 'observe'])
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus', 'insertText'], 'no pressEnter after a synthetic submit')
  assert.deepEqual(h.call('insertAndSubmit').payload, { text: TEXT })
  assert.equal(h.call('insertAndSubmit').opts.timeoutMs, insertAndSubmitBudgetMs({ ...T, insertSettleMs: INSERT_SETTLE_MS }) + TIMEOUT_GRACE_MS)
  assert.equal(h.call('observe').payload.baselineCount, 2, 'the synthetic submit\'s own baseline')
  assert.ok(warnLines(h.log).some((m) => m.includes('gemini: the trusted insert landed nothing; one synthetic insertAndSubmit')))
  assert.ok(infoLines(h.log).includes('[orchestrator] gemini: submitted by stop_button (insert: synthetic (trusted landed nothing), send: button.send)'))
})

// 5 --------------------------------------------------------------------------------------------------
test('5. landed partial: not_submitted, the failure snapshot of the pane, nothing re-typed, no Enter', async () => {
  const h = harness({ script: { verifyInput: () => ({ landed: 'partial', composerChars: 7, expectedChars: 18, sendReady: false, assistantCount: 3 }) } })
  const final = await h.run(request())
  assert.equal(final.ok, false)
  assert.equal(final.code, 'not_submitted')
  assert.match(final.message, /landed only part of the prompt \(composer 7 chars, 18 expected\); not re-typed/)
  assertValid(final)
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput'])
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus', 'insertText'], 'typed once, never again')
  assert.deepEqual(h.snapshots, [['pane', 'gemini']])
})

test('5b. partial_present: the composer holds the start of this prompt (an earlier partial insert) — not_submitted, nothing typed, no Enter, the snapshot follows (review 2026-10-17)', async () => {
  const h = harness({ script: { prepareInput: () => ({ state: 'partial_present', composerSelector: '.ql-editor', composerChars: 7, focused: true }) } })
  const final = await h.run(request())
  assert.equal(final.ok, false)
  assert.equal(final.code, 'not_submitted')
  assert.match(final.message, /already holds the start of this prompt/)
  assertValid(final)
  assert.deepEqual(h.ops(), ['ready', 'prepareInput'])
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus'], 'nothing typed')
  assert.deepEqual(h.snapshots, [['pane', 'gemini']])
})

// 6 --------------------------------------------------------------------------------------------------
test('6. an unconfirmed Enter with the prompt still held: one more trusted Enter, then confirmSubmit{clickFallback}; a click that confirms names the button', async () => {
  const h = harness({
    script: {
      confirmSubmit: (payload, _opts, n) =>
        n === 1
          ? { confirmedBy: null, stillHeld: true, sendSelector: null, assistantCount: 2 }
          : { confirmedBy: 'stop_button', stillHeld: false, sendSelector: "button[aria-label='Send message']", assistantCount: 2, url: 'https://gemini.test/app/abc123' },
    },
  })
  const final = await h.run(request())
  assert.equal(final.ok, true, JSON.stringify(final))
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit', 'confirmSubmit', 'observe'])
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus', 'insertText', 'pressEnter', 'pressEnter'])
  assert.ok(h.deps.every((d) => d[d.length - 1] === true), 'every dep under the mutex')
  assert.deepEqual(h.call('confirmSubmit', 2).payload, { text: TEXT, clickFallback: true })
  assert.equal(h.call('confirmSubmit', 2).opts.timeoutMs, 2 * T.submitVerifyMs + TIMEOUT_GRACE_MS, 'the Enter window and the click window')
  assert.equal(h.call('observe').payload.baselineCount, 2, 'the baseline as confirmSubmit lowered it (the adapter re-baselines DOWN only)')
  assert.ok(infoLines(h.log).includes("[orchestrator] gemini: submitted by stop_button (insert: trusted, send: button[aria-label='Send message'] click-fallback)"))
  // the second Enter alone confirming: no click, still trusted-enter
  const h2 = harness({ script: { confirmSubmit: (p, o, n) => (n === 1 ? { confirmedBy: null, stillHeld: true, sendSelector: null, assistantCount: 3 } : { confirmedBy: 'assistant_count', stillHeld: false, sendSelector: null, assistantCount: 3 }) } })
  assert.equal((await h2.run(request())).ok, true)
  assert.ok(infoLines(h2.log).includes('[orchestrator] gemini: submitted by assistant_count (insert: trusted, send: trusted-enter)'))
})

// 7 --------------------------------------------------------------------------------------------------
test('7. two misses → not_submitted (the snapshot follows); a miss with the prompt GONE from the composer → not_submitted at once, no second Enter', async () => {
  const h = harness({ script: { confirmSubmit: () => ({ confirmedBy: null, stillHeld: true, sendSelector: null, assistantCount: 3 }) } })
  const final = await h.run(request())
  assert.equal(final.code, 'not_submitted')
  assert.match(final.message, /neither two trusted Enters nor the send button submitted the prompt/)
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit', 'confirmSubmit'])
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus', 'insertText', 'pressEnter', 'pressEnter'])
  assert.deepEqual(h.snapshots, [['pane', 'gemini']])
  const gone = harness({ script: { confirmSubmit: () => ({ confirmedBy: null, stillHeld: false, sendSelector: null, assistantCount: 3 }) } })
  const f2 = await gone.run(request())
  assert.equal(f2.code, 'not_submitted')
  assert.match(f2.message, /no longer holds the prompt; not pressed again/)
  assert.deepEqual(gone.deps.map((d) => d[0]), ['focus', 'insertText', 'pressEnter'], 'one Enter only')
  assert.deepEqual(gone.ops(), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit'])
})

// 8 --------------------------------------------------------------------------------------------------
test('8. a bridge cancel during the trusted insert: the turn ends cancelled — no verify, no Enter, no observe; the mutex is released', async () => {
  const h = harness({ insertText: () => new Promise(() => {}) }) // an insert that never returns
  const done = h.run(request())
  for (let i = 0; i < 12; i++) await tick()
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus', 'insertText'])
  assert.equal(h.orch.cancel('req-gemini'), true)
  const final = await done
  assert.equal(final.ok, false)
  assert.equal(final.code, 'cancelled')
  assertValid(final)
  assert.deepEqual(h.ops(), ['ready', 'prepareInput'])
  assert.equal(h.deps.some((d) => d[0] === 'pressEnter'), false)
  assert.equal(h.mutex.locked(), false)
  assert.equal(h.timers.pending(), 0, 'the insert timer was cleared')
})

// 9 --------------------------------------------------------------------------------------------------
test('9. a trusted insert that does not return within TRUSTED_INSERT_MS (or rejects) still asks the page what landed, and the rules apply', async () => {
  const h = harness({ insertText: () => new Promise(() => {}) })
  const done = h.run(request())
  for (let i = 0; i < 12; i++) await tick()
  assert.deepEqual(h.ops(), ['ready', 'prepareInput'], 'waiting on the insert')
  h.timers.advance(TRUSTED_INSERT_MS - 1)
  for (let i = 0; i < 6; i++) await tick()
  assert.deepEqual(h.ops(), ['ready', 'prepareInput'])
  h.timers.advance(1)
  const final = await done
  assert.equal(final.ok, true, 'all of it had landed: Enter, confirmed')
  assert.deepEqual(h.ops(), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit', 'observe'])
  assert.ok(warnLines(h.log).some((m) => m.includes(`gemini: trusted insert timeout — the trusted insert did not return within ${TRUSTED_INSERT_MS} ms; asking the page what landed`)))
  // a rejected insert that typed nothing: the one synthetic fallback
  const r = harness({
    insertText: () => Promise.reject(new AdapterRequestError('view_crashed', 'trusted input: the pane view of gemini is gone')),
    script: { verifyInput: () => ({ landed: 'none', composerChars: 0, expectedChars: 18, sendReady: false, assistantCount: 1 }) },
  })
  const f2 = await r.run(request())
  assert.equal(f2.ok, true)
  assert.deepEqual(r.ops(), ['ready', 'prepareInput', 'verifyInput', 'insertAndSubmit', 'observe'])
  assert.ok(warnLines(r.log).some((m) => m.includes('gemini: trusted insert view_crashed — trusted input: the pane view of gemini is gone; asking the page what landed')))
})

// 10 -------------------------------------------------------------------------------------------------
test('10. the hidden analyst view: the trusted deps are called with (\'analyst\', \'gemini\'); the analyst always observes', async () => {
  const h = harness({ analyst: true, capture: false })
  const final = await h.run(request('gemini', { model: 'web:gemini:analyst', view: 'analyst', role: 'analyst', purpose: 'extraction', fresh: false }))
  assert.equal(final.ok, true, JSON.stringify(final))
  assert.equal(final.captured, true)
  assertValid(final)
  assert.deepEqual(h.ops('analyst:gemini'), ['ready', 'prepareInput', 'verifyInput', 'confirmSubmit', 'observe'])
  assert.deepEqual(h.deps, [
    ['focus', 'analyst', true],
    ['insertText', 'analyst', 'gemini', TEXT, true],
    ['pressEnter', 'analyst', 'gemini', true],
  ])
  assert.deepEqual(h.ops('gemini'), [], 'the gemini PANE is never touched by an analyst turn')
  assert.ok(infoLines(h.log).includes('[orchestrator] analyst page (gemini): submitted by composer_cleared (insert: trusted, send: trusted-enter)'))
})

// 11 -------------------------------------------------------------------------------------------------
test('11. budgets: each trusted op its own window + grace; a trusted site\'s submit budget = the trusted sequence + one synthetic insertAndSubmit, and the capture ceiling leaves room for it', async () => {
  // + two pre-Enter captures of at most TRUSTED_PAINT_MS each (trusted-input.js paintOnce, 2026-10-17)
  assert.equal(trustedSubmitBudgetMs(T), T.composerWaitMs + TRUSTED_INSERT_MS + TRUSTED_VERIFY_MS + T.sendWaitMs + 3 * T.submitVerifyMs + 2 * TRUSTED_PAINT_MS)
  assert.equal(trustedSubmitBudgetMs({ ...T, trustedInsertMs: 1, trustedVerifyMs: 2, trustedPaintMs: 3 }), T.composerWaitMs + 1 + 2 + T.sendWaitMs + 3 * T.submitVerifyMs + 6)
  const h = harness({ script: { confirmSubmit: (p, o, n) => (n === 1 ? { confirmedBy: null, stillHeld: true, sendSelector: null, assistantCount: 3 } : { confirmedBy: 'stop_button', stillHeld: false, sendSelector: null, assistantCount: 3 }) } })
  await h.run(request())
  assert.equal(h.call('ready').opts.timeoutMs, T.composerWaitMs + TIMEOUT_GRACE_MS, 'ready unchanged')
  assert.equal(h.call('prepareInput').opts.timeoutMs, T.composerWaitMs + TIMEOUT_GRACE_MS)
  assert.equal(h.call('verifyInput').opts.timeoutMs, TRUSTED_VERIFY_MS + T.sendWaitMs + TIMEOUT_GRACE_MS)
  assert.equal(h.call('confirmSubmit', 1).opts.timeoutMs, T.submitVerifyMs + TIMEOUT_GRACE_MS)
  assert.equal(h.call('confirmSubmit', 2).opts.timeoutMs, 2 * T.submitVerifyMs + TIMEOUT_GRACE_MS)
  for (const c of h.calls) assert.ok(c.opts.signal instanceof AbortSignal, `${c.op} carries the turn signal`)
  // the capture ceiling: a grant tight enough that the submit budget decides the observe window
  const wide = { ...C, captureTimeoutMs: 600000 }
  const grant = 100 // s
  const ceiling = Math.max(Math.floor((grant * 1000) / 2), grant * 1000 - CAPTURE_CEILING_MARGIN_MS)
  const synthetic = insertAndSubmitBudgetMs({ ...T, insertSettleMs: INSERT_SETTLE_MS })
  const g = harness({ captures: wide })
  await g.run(request('gemini', { timeout_s: grant }))
  assert.equal(g.call('observe').payload.timeoutMs, Math.max(Math.floor(ceiling / 2), ceiling - T.composerWaitMs - (trustedSubmitBudgetMs(T) + synthetic)))
  const c = harness({ captures: wide })
  await c.run(request('chatgpt', { timeout_s: grant }))
  assert.equal(c.call('observe', 1, 'chatgpt').payload.timeoutMs, Math.max(Math.floor(ceiling / 2), ceiling - T.composerWaitMs - synthetic), 'a classic site keeps its own budget')
})

// 12 -------------------------------------------------------------------------------------------------
test('12. no log line ever carries the text — success, synthetic fallback, partial, cancel, timeout', async () => {
  const runs = [
    harness(),
    harness({ script: { verifyInput: () => ({ landed: 'none', composerChars: 0, expectedChars: 18, sendReady: false, assistantCount: 0 }) } }),
    harness({ script: { verifyInput: () => ({ landed: 'partial', composerChars: 3, expectedChars: 18, sendReady: false, assistantCount: 0 }) } }),
    harness({ script: { confirmSubmit: () => ({ confirmedBy: null, stillHeld: true, sendSelector: null, assistantCount: 0 }) } }),
    harness({ insertText: () => Promise.reject(new Error('boom')) }),
  ]
  for (const h of runs) await h.run(request())
  for (const h of runs) {
    assert.ok(h.log.lines.length > 0)
    for (const [, line] of h.log.lines) assert.equal(line.includes('PROMPT-SECRET-42'), false, line)
  }
})

// the switch and its absence ------------------------------------------------------------------------
test('trustedInputFor true but no trusted input wired → the synthetic path plus one warning per turn; a throwing trustedInputFor → synthetic, warned', async () => {
  const h = harness({ wired: false })
  const final = await h.run(request())
  assert.equal(final.ok, true)
  assert.deepEqual(h.ops(), ['ready', 'insertAndSubmit', 'observe'])
  assert.deepEqual(warnLines(h.log).filter((m) => m.includes('trustedInput')), ['[orchestrator] gemini: trustedInput is on for gemini but no trusted input is wired; using the synthetic insert'])
  assert.ok(infoLines(h.log).includes('[orchestrator] gemini: submitted by stop_button (send: button.send)'), 'the classic line')
  const off = harness({ trusted: () => false })
  await off.run(request())
  assert.deepEqual(off.ops(), ['ready', 'insertAndSubmit', 'observe'], 'the kill switch: selectors say false → synthetic, no warning')
  assert.deepEqual(off.deps.map((d) => d[0]), ['focus'])
  const boom = harness({
    trusted: () => {
      throw new Error('bad config')
    },
  })
  await boom.run(request())
  assert.deepEqual(boom.ops(), ['ready', 'insertAndSubmit', 'observe'])
  assert.ok(warnLines(boom.log).some((m) => m.includes('trustedInputFor threw (bad config)')))
})

test('an adapter that answers verifyInput with something else is a site_error; a composer that did not take the focus is warned about', async () => {
  const h = harness({ script: { verifyInput: () => ({ landed: 'maybe', composerChars: 0, expectedChars: 18 }) } })
  const final = await h.run(request())
  assert.equal(final.code, 'site_error')
  assert.match(final.message, /verifyInput answered landed=maybe/)
  assert.equal(h.deps.some((d) => d[0] === 'pressEnter'), false)
  const unfocused = harness({ script: { prepareInput: () => ({ state: 'ready', composerSelector: '.ql-editor', composerChars: 0, focused: false }) } })
  await unfocused.run(request())
  assert.ok(warnLines(unfocused.log).some((m) => m.includes('gemini: the composer did not take the focus; the trusted insert may land nothing')))
})

test('a prepareInput refusal (the session gate) ends the turn before anything is typed', async () => {
  const h = harness({
    script: {
      prepareInput: () => {
        throw new AdapterRequestError('logged_out', 'the site shows a sign-in link')
      },
    },
  })
  const final = await h.run(request())
  assert.equal(final.ok, false)
  assert.equal(final.code, 'site_error')
  assert.match(final.message, /^logged_out: /)
  assert.deepEqual(h.deps.map((d) => d[0]), ['focus'], 'nothing typed')
  assert.deepEqual(h.ops(), ['ready', 'prepareInput'])
})

test('two trusted turns on different sites never interleave their insert phases: the second waits for the first to confirm', async () => {
  const gate = {}
  const h = harness({
    trusted: () => true,
    insertText: (view, slot) => new Promise((resolve) => {
      gate[slot] = resolve
    }),
  })
  const a = h.run(request('gemini'))
  const b = h.run(request('claude'))
  for (let i = 0; i < 12; i++) await tick()
  assert.deepEqual(h.deps.map((d) => `${d[0]}:${d[1] === 'pane' ? d[2] : d[1]}`), ['focus:gemini', 'insertText:gemini'], 'claude waits for the mutex')
  gate.gemini()
  for (let i = 0; i < 24; i++) await tick()
  assert.ok(gate.claude, 'claude typed only after gemini confirmed')
  const order = h.deps.map((d) => `${d[0]}:${d[1] === 'pane' ? d[2] : d[1]}`)
  assert.deepEqual(order.slice(0, 4), ['focus:gemini', 'insertText:gemini', 'pressEnter:gemini', 'focus:claude'])
  gate.claude()
  assert.equal((await a).ok, true)
  assert.equal((await b).ok, true)
})
