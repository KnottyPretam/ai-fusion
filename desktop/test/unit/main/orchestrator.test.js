// orchestrator.js — two targets in parallel, insert phases never overlap (mutex), one failure does
// not fail the other, renderer focus restored exactly once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrchestrator, createMutex, TIMEOUT_GRACE_MS } from '../../../main/orchestrator.js'
import { AdapterRequestError } from '../../../main/adapter-client.js'
import { fakeLog, tick } from './_fakes.js'

/** A scripted adapter client: every request returns a deferred the test settles by hand. */
function scriptedClient(slot, trace) {
  const calls = [] // {op, payload, opts, resolve, reject}
  return {
    slot,
    calls,
    request(op, payload, opts) {
      return new Promise((resolve, reject) => {
        trace.push(`${slot}:${op}:start`)
        calls.push({ op, payload, opts, resolve: (v) => { trace.push(`${slot}:${op}:end`); resolve(v) }, reject: (e) => { trace.push(`${slot}:${op}:fail`); reject(e) } })
      })
    },
    last: () => calls[calls.length - 1],
  }
}

function setup({ clients, timeouts } = {}) {
  const trace = []
  const focused = []
  let restored = 0
  const table = {}
  for (const slot of clients || ['claude', 'chatgpt', 'grok']) table[slot] = scriptedClient(slot, trace)
  const orch = createOrchestrator({
    adapterFor: (slot) => table[slot] || null,
    focusView: (slot) => {
      trace.push(`${slot}:focus`)
      focused.push(slot)
    },
    restoreRendererFocus: () => {
      restored += 1
      trace.push('renderer:focus')
    },
    timeoutsFor: () => timeouts || { composerWaitMs: 1000, sendWaitMs: 2000, submitVerifyMs: 500 },
    log: fakeLog(),
  })
  return { orch, table, trace, focused, restored: () => restored }
}

const settleAll = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick()
}

test('two targets: ready phases run in parallel, insert phases are serialized by the mutex', async () => {
  const { orch, table, trace, focused } = setup()
  const done = orch.submitAll({ targets: ['chatgpt', 'claude'], text: 'hello' })
  await settleAll()
  // both ready requests are in flight at once (parallel)
  assert.deepEqual(trace, ['claude:ready:start', 'chatgpt:ready:start'])
  assert.deepEqual(table.claude.last().payload, { timeoutMs: 1000 })
  assert.deepEqual(table.claude.last().opts, { timeoutMs: 1000 + TIMEOUT_GRACE_MS })

  // chatgpt becomes ready first → it takes the mutex, focuses, inserts
  table.chatgpt.last().resolve({ ok: true, op: 'ready', composerSelector: '#prompt-textarea' })
  await settleAll()
  assert.deepEqual(trace.slice(2), ['chatgpt:ready:end', 'chatgpt:focus', 'chatgpt:insertAndSubmit:start'])
  assert.deepEqual(table.chatgpt.last().payload, { text: 'hello' })
  assert.deepEqual(table.chatgpt.last().opts, { timeoutMs: 3500 + TIMEOUT_GRACE_MS })

  // claude becomes ready while chatgpt is still inserting → it must wait (no focus, no insert)
  table.claude.calls[0].resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.equal(trace.filter((t) => t === 'claude:focus').length, 0, 'claude must not focus while chatgpt holds the insert mutex')
  assert.equal(table.claude.calls.length, 1)

  // chatgpt finishes → claude proceeds
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: '#prompt-textarea', sendSelector: "button[data-testid='send-button']", url: 'https://chatgpt.test/c/1', ms: 12 })
  await settleAll()
  assert.deepEqual(trace.slice(-3), ['chatgpt:insertAndSubmit:end', 'claude:focus', 'claude:insertAndSubmit:start'])
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: 'div.ProseMirror', sendSelector: "button[aria-label='Send message']", url: 'https://claude.test/chat/2', ms: 9 })

  const { results } = await done
  assert.deepEqual(Object.keys(results), ['claude', 'chatgpt'], 'results in SLOTS order')
  assert.equal(results.chatgpt.ok, true)
  assert.equal(results.chatgpt.composerSelector, '#prompt-textarea')
  assert.equal(results.chatgpt.sendSelector, "button[data-testid='send-button']")
  assert.equal(results.chatgpt.url, 'https://chatgpt.test/c/1')
  assert.equal(typeof results.chatgpt.ms, 'number')
  assert.equal(results.claude.ok, true)
  assert.deepEqual(focused, ['chatgpt', 'claude'])
  // the insert phases never overlapped: every insert:start follows the previous insert:end
  const inserts = trace.filter((t) => t.includes('insertAndSubmit'))
  assert.deepEqual(inserts, ['chatgpt:insertAndSubmit:start', 'chatgpt:insertAndSubmit:end', 'claude:insertAndSubmit:start', 'claude:insertAndSubmit:end'])
})

test('one failure does not fail the other; the failed slot reports its code', async () => {
  const { orch, table } = setup()
  const done = orch.submitAll({ targets: ['claude', 'grok'], text: 'x' })
  await settleAll()
  table.claude.last().reject(new AdapterRequestError('logged_out', 'sign in first'))
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, ms: 1 })
  const { results } = await done
  assert.deepEqual(results.claude, { ok: false, code: 'logged_out', message: 'sign in first', ms: results.claude.ms })
  assert.equal(results.grok.ok, true)
})

test('a failure INSIDE the insert phase releases the mutex so the next target still inserts', async () => {
  const { orch, table, trace } = setup()
  const done = orch.submitAll({ targets: ['claude', 'chatgpt'], text: 'x' })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  // claude holds the mutex (ready resolved first) and fails its insert
  assert.equal(trace.includes('claude:insertAndSubmit:start'), true)
  assert.equal(trace.includes('chatgpt:insertAndSubmit:start'), false)
  table.claude.last().reject(new AdapterRequestError('send_not_found', 'no button'))
  await settleAll()
  assert.equal(trace.includes('chatgpt:insertAndSubmit:start'), true)
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  const { results } = await done
  assert.equal(results.claude.code, 'send_not_found')
  assert.equal(results.chatgpt.ok, true)
  assert.equal(orch.mutex.locked(), false)
})

test('renderer focus is restored exactly once, after the last insert, even with failures', async () => {
  const { orch, table, trace, restored } = setup()
  const done = orch.submitAll({ targets: ['claude', 'chatgpt', 'grok'], text: 'x' })
  await settleAll()
  assert.equal(restored(), 0)
  table.claude.last().reject(new AdapterRequestError('challenge', 'turnstile'))
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.equal(restored(), 0, 'not before the inserts')
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  await settleAll()
  assert.equal(restored(), 0, 'not while grok still inserts')
  table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  await done
  assert.equal(restored(), 1)
  assert.equal(trace[trace.length - 1], 'renderer:focus')
})

test('a missing view → view_crashed for that slot only; unknown / duplicate targets are dropped', async () => {
  const { orch, table } = setup({ clients: ['chatgpt'] })
  const done = orch.submitAll({ targets: ['claude', 'chatgpt', 'chatgpt', 'nope'], text: 'x' })
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  const { results } = await done
  assert.deepEqual(Object.keys(results), ['claude', 'chatgpt'])
  assert.equal(results.claude.code, 'view_crashed')
  assert.equal(results.chatgpt.ok, true)
})

test('an empty target list resolves with no results and still restores focus once', async () => {
  const { orch, restored } = setup()
  assert.deepEqual(await orch.submitAll({ targets: [], text: 'x' }), { results: {} })
  assert.equal(restored(), 1)
})

test('a non-AdapterRequestError failure is reported as site_error with its message', async () => {
  const { orch, table } = setup()
  const done = orch.submitAll({ targets: ['grok'], text: 'x' })
  await settleAll()
  table.grok.last().reject(new Error('boom'))
  const { results } = await done
  assert.equal(results.grok.code, 'site_error')
  assert.equal(results.grok.message, 'boom')
})

test('createMutex serializes holders and tolerates a double release', async () => {
  const m = createMutex()
  const order = []
  const r1 = await m.lock()
  assert.equal(m.locked(), true)
  const second = m.lock().then((r) => {
    order.push('second')
    return r
  })
  await settleAll()
  assert.deepEqual(order, [])
  r1()
  r1()
  const r2 = await second
  assert.deepEqual(order, ['second'])
  assert.equal(m.locked(), true)
  r2()
  assert.equal(m.locked(), false)
})
