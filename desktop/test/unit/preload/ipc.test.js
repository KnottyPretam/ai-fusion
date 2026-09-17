// attachIpc over a fake IPC and a fake adapter (contract §2 "Main ↔ site preload"): inert on
// site:null, health on boot / on change / 10 s heartbeat, op dispatch and result shapes (Stage 2:
// observe carries the url, snapshot the html), one op in flight (busy), cancel, error-code mapping
// with the partial, config hot reload, dispose, and requests that land before adapter:config
// settles (parked and replayed, dropped when inert).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { attachIpc, AdapterError, HEALTH_HEARTBEAT_MS, HEALTH_POLL_MS } = require('../../../preload/site.cjs')

const tick = () => new Promise((r) => setTimeout(r, 0))
async function until(fn, ms = 1000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until: timed out')
    await tick()
  }
}

function fakeIpc(config = { site: 'chatgpt', selectors: {}, dev: false }) {
  const handlers = new Map()
  const ipc = {
    config,
    invoked: [],
    sent: [],
    invoke(channel, ...args) {
      ipc.invoked.push({ channel, args })
      if (channel === 'adapter:config') return Promise.resolve(ipc.config)
      return Promise.reject(new Error(`unknown ${channel}`))
    },
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, [])
      handlers.get(channel).push(handler)
    },
    send(channel, payload) {
      ipc.sent.push({ channel, payload })
    },
    emit(channel, msg) {
      for (const h of handlers.get(channel) || []) h({ senderId: 1 }, msg)
    },
    handlers: (channel) => (handlers.get(channel) || []).length,
    results: () => ipc.sent.filter((s) => s.channel === 'triplex:adapter:result').map((s) => s.payload),
    healths: () => ipc.sent.filter((s) => s.channel === 'triplex:adapter:health').map((s) => s.payload),
    result: (reqId) => ipc.results().find((r) => r.reqId === reqId) || null,
  }
  return ipc
}

/** A controllable adapter: `health` is mutable; ops are recorded and answered through `next`. */
function fakeAdapter() {
  let ts = 0
  const a = {
    calls: [],
    health: { composer: false, send: false, reply: null, stop: null, session: 'unknown', matched: { composer: null, send: null, reply: null, stop: null, error: null }, url: 'u', host: 'h', title: 't' },
    clock: () => ts,
    setClock(v) {
      ts = v
    },
    selectorsSet: [],
    healthImpl: () => ({ ...a.health, matched: { ...a.health.matched }, ts }),
    behaviours: {}, // op → async (msg, opts) => result | throws
  }
  const adapter = {
    health: () => a.healthImpl(),
    setSelectors: (s) => a.selectorsSet.push(s),
    url: () => a.health.url,
    ready: (timeoutMs, opts) => run('ready', { timeoutMs }, opts),
    insertAndSubmit: (text, opts) => run('insertAndSubmit', { text }, opts),
    observe: (args) => run('observe', args, args),
    snapshot: (args) => run('snapshot', args, args),
  }
  function run(op, args, opts) {
    a.calls.push({ op, args, signal: opts && opts.signal })
    const b = a.behaviours[op]
    if (!b) return Promise.reject(new AdapterError('site_error', `${op}: no behaviour`))
    return Promise.resolve().then(() => b(args, opts))
  }
  a.adapter = adapter
  return a
}

/** Boot attachIpc with captured timers; returns everything the tests poke at. */
async function boot({ ipc = fakeIpc(), fake = fakeAdapter() } = {}) {
  const timers = { intervals: [], cleared: [] }
  const setInterval = (fn, ms) => {
    const id = { fn, ms }
    timers.intervals.push(id)
    return id
  }
  const clearInterval = (id) => timers.cleared.push(id)
  const attached = attachIpc(ipc, () => fake.adapter, { setInterval, clearInterval })
  const ready = await attached.ready
  return { ipc, fake, timers, attached, ready }
}

test('attachIpc validates the ipc object', () => {
  assert.throws(() => attachIpc({}, () => null), /invoke\/on\/send/)
  assert.throws(() => attachIpc(null, () => null), /invoke\/on\/send/)
})

test('site:null (or a failed config) keeps the preload inert: ready false, no health, ops unanswered, no poll timer', async () => {
  for (const config of [{ site: null, selectors: {}, dev: false }, { selectors: {} }, null, undefined, 'nonsense']) {
    const inert = fakeIpc()
    inert.config = config // set explicitly: undefined must reach invoke() as-is
    inert.on = ((on) => (channel, handler) => {
      on.call(inert, channel, handler)
      inert.emit('triplex:adapter', { reqId: 'pre-boot', op: 'health' }) // lands before the config: parked, then dropped
    })(inert.on)
    const { ipc, timers, ready } = await boot({ ipc: inert })
    assert.equal(ready, false, `config ${JSON.stringify(config)} must stay inert`)
    assert.equal(ipc.handlers('triplex:adapter'), 1) // the listener is registered before the config arrives
    ipc.emit('triplex:adapter', { reqId: 'h1', op: 'health' })
    ipc.emit('triplex:adapter', { reqId: 'r1', op: 'ready', timeoutMs: 10 })
    await tick()
    assert.deepEqual(ipc.sent, [])
    assert.deepEqual(timers.intervals, [])
  }
  const failing = fakeIpc()
  failing.invoke = () => Promise.reject(new Error('main is gone'))
  const attached = attachIpc(failing, () => fakeAdapter().adapter, { setInterval: () => 0, clearInterval: () => {} })
  assert.equal(await attached.ready, false)
})

test('boot: asks adapter:config once, creates the adapter, publishes health immediately and starts the 1.5 s poll', async () => {
  const { ipc, timers, ready } = await boot()
  assert.equal(ready, true)
  assert.deepEqual(ipc.invoked, [{ channel: 'adapter:config', args: [] }])
  assert.equal(ipc.healths().length, 1)
  assert.equal(ipc.healths()[0].session, 'unknown')
  assert.equal(timers.intervals.length, 1)
  assert.equal(timers.intervals[0].ms, HEALTH_POLL_MS)
})

test('health is published on change and every 10 s as a heartbeat, never when unchanged in between', async () => {
  const { ipc, fake, timers } = await boot()
  const poll = timers.intervals[0].fn
  poll()
  poll()
  assert.equal(ipc.healths().length, 1) // unchanged, not due
  fake.health.composer = true
  fake.health.matched.composer = '#prompt-textarea'
  fake.health.session = 'ok'
  fake.setClock(1500)
  poll()
  assert.equal(ipc.healths().length, 2) // changed
  assert.deepEqual(ipc.healths()[1].matched, { composer: '#prompt-textarea', send: null, reply: null, stop: null, error: null })
  fake.setClock(1500 + HEALTH_HEARTBEAT_MS - 1)
  poll()
  assert.equal(ipc.healths().length, 2) // 9.999 s: not yet due
  fake.setClock(1500 + HEALTH_HEARTBEAT_MS)
  poll()
  assert.equal(ipc.healths().length, 3) // heartbeat
  assert.equal(ipc.healths()[2].ts, 1500 + HEALTH_HEARTBEAT_MS)
  fake.health.url = 'https://chatgpt.com/c/abc'
  poll()
  assert.equal(ipc.healths().length, 4) // a URL change counts as a change
})

test('health op answers {ok:true, op:"health", health}; a throwing health() answers site_error', async () => {
  const { ipc, fake } = await boot()
  ipc.emit('triplex:adapter', { reqId: 'h1', op: 'health' })
  assert.deepEqual(ipc.result('h1'), { reqId: 'h1', ok: true, op: 'health', health: fake.adapter.health() })
  fake.healthImpl = () => {
    throw new Error('dom exploded')
  }
  ipc.emit('triplex:adapter', { reqId: 'h2', op: 'health' })
  assert.deepEqual(ipc.result('h2'), { reqId: 'h2', ok: false, op: 'health', code: 'site_error', message: 'dom exploded' })
})

test('ready and insertAndSubmit dispatch to the adapter with a signal and answer the §2 result shapes', async () => {
  const { ipc, fake } = await boot()
  fake.behaviours.ready = async ({ timeoutMs }) => ({ el: {}, selector: `composer-after-${timeoutMs}` })
  fake.behaviours.insertAndSubmit = async ({ text }) => ({
    submitted: true,
    composerSelector: '#prompt-textarea',
    sendSelector: "button[data-testid='send-button']",
    assistantCount: 3,
    confirmedBy: 'composer_cleared',
    ms: 1234,
    typed: text,
  })
  ipc.emit('triplex:adapter', { reqId: 'r1', op: 'ready', timeoutMs: 700 })
  const r1 = await until(() => ipc.result('r1'))
  assert.deepEqual(r1, { reqId: 'r1', ok: true, op: 'ready', composerSelector: 'composer-after-700' })
  assert.equal(fake.calls[0].op, 'ready')
  assert.ok(fake.calls[0].signal && fake.calls[0].signal.aborted === false)

  ipc.emit('triplex:adapter', { reqId: 'i1', op: 'insertAndSubmit', text: 'hello `x` ${y}' })
  const i1 = await until(() => ipc.result('i1'))
  assert.deepEqual(i1, {
    reqId: 'i1',
    ok: true,
    op: 'insertAndSubmit',
    submitted: true,
    composerSelector: '#prompt-textarea',
    sendSelector: "button[data-testid='send-button']",
    assistantCount: 3,
    confirmedBy: 'composer_cleared',
    ms: 1234,
    typed: 'hello `x` ${y}',
    url: 'u',
  })
  assert.deepEqual(fake.calls[1].args, { text: 'hello `x` ${y}' }) // the text travels as a field, verbatim
  // health is re-published after an op when it changed
  fake.health.session = 'ok'
  ipc.emit('triplex:adapter', { reqId: 'r2', op: 'ready', timeoutMs: 1 })
  await until(() => ipc.result('r2'))
  assert.equal(ipc.healths().at(-1).session, 'ok')
})

test('observe and snapshot answer the §2 result shapes: observe {text, doneBy, ms, url} with the message fields passed through, snapshot {html}; an observe failure carries the partial', async () => {
  const { ipc, fake } = await boot()
  fake.behaviours.observe = async ({ baselineCount, quietMs, timeoutMs }) => ({ text: `reply after ${baselineCount}/${quietMs}/${timeoutMs}`, doneBy: 'stop_gone', ms: 321 })
  fake.behaviours.snapshot = async () => ({ html: '<!doctype html>\n<html></html>\n' })
  ipc.emit('triplex:adapter', { reqId: 'o1', op: 'observe', baselineCount: 2, quietMs: 500, timeoutMs: 9000 })
  assert.deepEqual(await until(() => ipc.result('o1')), { reqId: 'o1', ok: true, op: 'observe', text: 'reply after 2/500/9000', doneBy: 'stop_gone', ms: 321, url: 'u' })
  const call = fake.calls.find((c) => c.op === 'observe')
  assert.ok(call.signal && call.signal.aborted === false)
  assert.deepEqual([call.args.baselineCount, call.args.quietMs, call.args.timeoutMs], [2, 500, 9000])
  ipc.emit('triplex:adapter', { reqId: 's1', op: 'snapshot' })
  assert.deepEqual(await until(() => ipc.result('s1')), { reqId: 's1', ok: true, op: 'snapshot', html: '<!doctype html>\n<html></html>\n' })
  fake.behaviours.observe = async () => {
    throw new AdapterError('timeout', 'still replying', 'half')
  }
  ipc.emit('triplex:adapter', { reqId: 'o2', op: 'observe', baselineCount: 0 })
  assert.deepEqual(await until(() => ipc.result('o2')), { reqId: 'o2', ok: false, op: 'observe', code: 'timeout', message: 'still replying', partial: 'half' })
  fake.behaviours.observe = async () => {
    throw new AdapterError('site_error', 'Unusual activity has been detected')
  }
  ipc.emit('triplex:adapter', { reqId: 'o3', op: 'observe', baselineCount: 0 })
  assert.deepEqual(await until(() => ipc.result('o3')), { reqId: 'o3', ok: false, op: 'observe', code: 'site_error', message: 'Unusual activity has been detected' })
})

test('one op in flight per view: the second answers busy naming the first; the slot frees when the first settles', async () => {
  const { ipc, fake } = await boot()
  let release
  fake.behaviours.ready = () => new Promise((resolve) => (release = resolve))
  fake.behaviours.insertAndSubmit = async () => ({ submitted: true })
  ipc.emit('triplex:adapter', { reqId: 'first', op: 'ready', timeoutMs: 5 })
  ipc.emit('triplex:adapter', { reqId: 'second', op: 'insertAndSubmit', text: 'x' })
  ipc.emit('triplex:adapter', { reqId: 'third', op: 'observe', baselineCount: 0 })
  ipc.emit('triplex:adapter', { reqId: 'fourth', op: 'snapshot' })
  await tick()
  assert.deepEqual(ipc.result('second'), { reqId: 'second', ok: false, op: 'insertAndSubmit', code: 'busy', message: 'op ready (first) in flight' })
  assert.equal(ipc.result('third').code, 'busy')
  assert.equal(ipc.result('fourth').code, 'busy')
  assert.equal(ipc.result('first'), null)
  // health and cancel are never blocked by the in-flight op
  ipc.emit('triplex:adapter', { reqId: 'h', op: 'health' })
  assert.equal(ipc.result('h').ok, true)
  release({ el: {}, selector: '#c' })
  const first = await until(() => ipc.result('first'))
  assert.deepEqual(first, { reqId: 'first', ok: true, op: 'ready', composerSelector: '#c' })
  ipc.emit('triplex:adapter', { reqId: 'fifth', op: 'insertAndSubmit', text: 'y' })
  const fifth = await until(() => ipc.result('fifth'))
  assert.equal(fifth.ok, true)
  assert.equal(fake.calls.filter((c) => c.op === 'insertAndSubmit').length, 1) // 'second' never reached the adapter
})

test('cancel{target}: aborts the in-flight op (it answers cancelled and frees the slot); an unknown target answers cancelled:false', async () => {
  const { ipc, fake } = await boot()
  fake.behaviours.insertAndSubmit = (_args, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new AdapterError('cancelled', 'cancelled by main')))
    })
  ipc.emit('triplex:adapter', { reqId: 'op', op: 'insertAndSubmit', text: 'x' })
  await tick()
  ipc.emit('triplex:adapter', { reqId: 'c0', op: 'cancel', target: 'nope' })
  assert.deepEqual(ipc.result('c0'), { reqId: 'c0', ok: true, op: 'cancel', cancelled: false })
  assert.equal(ipc.result('op'), null)
  ipc.emit('triplex:adapter', { reqId: 'c1', op: 'cancel', target: 'op' })
  assert.deepEqual(ipc.result('c1'), { reqId: 'c1', ok: true, op: 'cancel', cancelled: true })
  const op = await until(() => ipc.result('op'))
  assert.deepEqual(op, { reqId: 'op', ok: false, op: 'insertAndSubmit', code: 'cancelled', message: 'cancelled by main' })
  ipc.emit('triplex:adapter', { reqId: 'c2', op: 'cancel', target: 'op' })
  assert.equal(ipc.result('c2').cancelled, false) // already settled
  fake.behaviours.ready = async () => ({ el: {}, selector: '#c' })
  ipc.emit('triplex:adapter', { reqId: 'after', op: 'ready' })
  assert.equal((await until(() => ipc.result('after'))).ok, true)
})

test('error mapping: AdapterError codes pass through with partial; other errors and unknown codes become site_error', async () => {
  const { ipc, fake } = await boot()
  const cases = [
    [new AdapterError('logged_out', 'wall'), { code: 'logged_out', message: 'wall' }],
    [new AdapterError('not_submitted', 'nothing confirmed', 'half typed'), { code: 'not_submitted', message: 'nothing confirmed', partial: 'half typed' }],
    [new TypeError('boom'), { code: 'site_error', message: 'boom' }],
    ['a string', { code: 'site_error', message: 'a string' }],
    [Object.assign(new Error('odd'), { code: 'made_up' }), { code: 'site_error', message: 'odd' }],
  ]
  let n = 0
  for (const [err, expected] of cases) {
    const reqId = `e${++n}`
    fake.behaviours.ready = async () => {
      throw err
    }
    ipc.emit('triplex:adapter', { reqId, op: 'ready', timeoutMs: 1 })
    const res = await until(() => ipc.result(reqId))
    assert.deepEqual(res, { reqId, ok: false, op: 'ready', ...expected })
  }
})

test('protocol edges: unknown op → site_error; missing/blank reqId or a non-object message is ignored', async () => {
  const { ipc } = await boot()
  ipc.emit('triplex:adapter', { reqId: 'x1', op: 'frobnicate' })
  assert.deepEqual(ipc.result('x1'), { reqId: 'x1', ok: false, op: 'frobnicate', code: 'site_error', message: 'unknown op frobnicate' })
  const before = ipc.sent.length
  ipc.emit('triplex:adapter', { op: 'health' })
  ipc.emit('triplex:adapter', { reqId: '', op: 'health' })
  ipc.emit('triplex:adapter', { reqId: 42, op: 'health' })
  ipc.emit('triplex:adapter', null)
  ipc.emit('triplex:adapter', 'health')
  await tick()
  assert.equal(ipc.sent.length, before)
})

test('config op: replaces the selectors, re-publishes health, never replies', async () => {
  const { ipc, fake } = await boot()
  const before = ipc.results().length
  const healths = ipc.healths().length
  ipc.emit('triplex:adapter', { op: 'config', selectors: { version: 1, chatgpt: { composer: ['#x'] } } })
  assert.deepEqual(fake.selectorsSet, [{ version: 1, chatgpt: { composer: ['#x'] } }])
  assert.equal(ipc.results().length, before)
  assert.equal(ipc.healths().length, healths + 1) // forced publish, even when unchanged
  ipc.emit('triplex:adapter', { op: 'config' })
  assert.equal(fake.selectorsSet.length, 1) // no selectors field: nothing replaced
})

test('dispose clears the poll timer, aborts the in-flight op and stops answering', async () => {
  const { ipc, fake, timers, attached } = await boot()
  let aborted = false
  fake.behaviours.ready = (_args, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new AdapterError('cancelled', 'cancelled'))
      })
    })
  ipc.emit('triplex:adapter', { reqId: 'r', op: 'ready' })
  await tick()
  attached.dispose()
  assert.deepEqual(timers.cleared, [timers.intervals[0]])
  assert.equal(aborted, true)
  const n = ipc.sent.length
  ipc.emit('triplex:adapter', { reqId: 'h', op: 'health' })
  timers.intervals[0].fn()
  await tick()
  await tick()
  // the cancelled op may still report its own result; nothing else is sent after dispose
  assert.ok(ipc.sent.slice(n).every((s) => s.channel === 'triplex:adapter:result' && s.payload.reqId === 'r'))
  assert.equal(ipc.result('h'), null)
})

test('requests that arrive before adapter:config settles are parked and replayed in order once the adapter exists', async () => {
  const ipc = fakeIpc()
  let resolveConfig
  ipc.invoke = (channel) => {
    ipc.invoked.push({ channel, args: [] })
    return new Promise((resolve) => (resolveConfig = resolve))
  }
  const fake = fakeAdapter()
  fake.behaviours.ready = async ({ timeoutMs }) => ({ el: {}, selector: `#c-${timeoutMs}` })
  const timers = { intervals: [] }
  const attached = attachIpc(ipc, () => fake.adapter, { setInterval: (fn, ms) => timers.intervals.push({ fn, ms }), clearInterval: () => {} })
  assert.equal(ipc.handlers('triplex:adapter'), 1)
  ipc.emit('triplex:adapter', { reqId: 'h', op: 'health' })
  ipc.emit('triplex:adapter', { reqId: 'r1', op: 'ready', timeoutMs: 100 })
  ipc.emit('triplex:adapter', { reqId: 'r2', op: 'ready', timeoutMs: 200 })
  ipc.emit('triplex:adapter', { op: 'config', selectors: { version: 1, chatgpt: { composer: ['#late'] } } })
  ipc.emit('triplex:adapter', null)
  ipc.emit('triplex:adapter', 'garbage')
  await tick()
  await tick()
  assert.deepEqual(ipc.sent, []) // nothing answered yet — and nothing dropped
  assert.deepEqual(fake.calls, [])
  resolveConfig({ site: 'chatgpt', selectors: {}, dev: false })
  assert.equal(await attached.ready, true)
  // boot health first, then the backlog in arrival order: h answered, r1 started, r2 busy behind it, config applied
  assert.equal(ipc.sent[0].channel, 'triplex:adapter:health')
  assert.deepEqual(ipc.result('h'), { reqId: 'h', ok: true, op: 'health', health: fake.adapter.health() })
  assert.deepEqual(ipc.result('r2'), { reqId: 'r2', ok: false, op: 'ready', code: 'busy', message: 'op ready (r1) in flight' })
  assert.deepEqual(await until(() => ipc.result('r1')), { reqId: 'r1', ok: true, op: 'ready', composerSelector: '#c-100' })
  assert.deepEqual(fake.selectorsSet, [{ version: 1, chatgpt: { composer: ['#late'] } }])
  assert.equal(fake.calls.filter((c) => c.op === 'ready').length, 1)
  assert.equal(timers.intervals.length, 1)
  // after boot, requests are handled directly
  ipc.emit('triplex:adapter', { reqId: 'h2', op: 'health' })
  assert.equal(ipc.result('h2').ok, true)
})

test('parked requests are dropped when the config resolves inert, rejects, or the preload is disposed during boot', async () => {
  for (const outcome of ['inert', 'reject', 'dispose']) {
    const ipc = fakeIpc()
    let settleConfig
    ipc.invoke = () => new Promise((resolve, reject) => (settleConfig = outcome === 'reject' ? reject : resolve))
    const fake = fakeAdapter()
    fake.behaviours.ready = async () => ({ el: {}, selector: '#c' })
    const attached = attachIpc(ipc, () => fake.adapter, { setInterval: () => 0, clearInterval: () => {} })
    ipc.emit('triplex:adapter', { reqId: 'h', op: 'health' })
    ipc.emit('triplex:adapter', { reqId: 'r', op: 'ready', timeoutMs: 10 })
    await until(() => typeof settleConfig === 'function') // adapter:config is asked on a later tick
    if (outcome === 'dispose') attached.dispose()
    settleConfig(outcome === 'reject' ? new Error('main is gone') : { site: outcome === 'dispose' ? 'chatgpt' : null, selectors: {} })
    assert.equal(await attached.ready, false, outcome)
    await tick()
    await tick()
    assert.deepEqual(ipc.sent, [], outcome)
    assert.deepEqual(fake.calls, [], outcome)
    ipc.emit('triplex:adapter', { reqId: 'late', op: 'health' })
    await tick()
    assert.deepEqual(ipc.sent, [], outcome) // still inert afterwards
  }
})
