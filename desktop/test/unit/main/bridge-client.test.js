// bridge-client.js — hello with the token on open, hello_ack required before requests, request →
// result round trip with the corpus frame shapes, ping → pong, cancel → onCancel, reconnect
// schedule 0.5→10 s, fatal closes (superseded 4002, bad token 4003) → no reconnect storm, a socket
// drop mid-turn → the turn completes locally and its frames are discarded, capture / analyst /
// health frames, hello_ack + ping watchdogs, close().
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridgeClient, bridgeUrlFor, BACKOFF_MS, HELLO_ACK_TIMEOUT_MS, PING_MISS_FACTOR, CLOSE_SUPERSEDED, CLOSE_BAD_TOKEN, CLOSE_CLIENT_TIMEOUT } from '../../../main/bridge-client.js'
import { validate } from '../../../main/protocol.js'
import { fakeTimers, fakeLog, tick } from './_fakes.js'

const corpus = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'protocol', 'bridge-v1.json'), 'utf8'))
const REQUEST = corpus.frames.request.examples[0] // web:chatgpt, pane, chat
const HELLO_ACK = corpus.frames.hello_ack.examples[0] // ping_s 20
const URL = 'ws://127.0.0.1:8021/api/bridge'
const HEALTH = corpus.frames.health.examples[0].health

/** A WebSocket look-alike the test drives by hand: open(), receive(frame), drop(code), fail(). */
function fakeSocket(url) {
  const listeners = {}
  const fire = (name, event) => {
    for (const fn of listeners[name] || []) fn(event)
  }
  const s = {
    url,
    readyState: 0,
    sent: [],
    closed: null,
    addEventListener(name, fn) {
      ;(listeners[name] ||= []).push(fn)
    },
    send(text) {
      if (s.readyState !== 1) throw new Error('socket not open')
      s.sent.push(JSON.parse(text))
    },
    close(code, reason) {
      if (s.closed) return
      s.closed = { code, reason }
      s.readyState = 3
      fire('close', { code, reason })
    },
    open() {
      s.readyState = 1
      fire('open', {})
    },
    receive(frame) {
      fire('message', { data: JSON.stringify(frame) })
    },
    receiveRaw(data) {
      fire('message', { data })
    },
    drop(code = 1006, reason = '') {
      s.readyState = 3
      s.closed = { code, reason }
      fire('close', { code, reason })
    },
    fail() {
      fire('error', { message: 'ECONNREFUSED' })
      s.drop(1006)
    },
    frames: (type) => s.sent.filter((f) => f.type === type),
  }
  return s
}

function setup({ health = {}, capture = { claude: false, chatgpt: true, grok: false }, analyst = null, onRequest, token = 'e2e' } = {}) {
  const sockets = []
  const timers = fakeTimers()
  const states = []
  const cancels = []
  const requests = []
  const log = fakeLog()
  const client = createBridgeClient({
    url: URL,
    token,
    version: '0.1.0',
    getCapture: () => ({ ...capture }),
    getAnalyst: () => analyst,
    getHealth: (slot) => health[slot] || null,
    onRequest:
      onRequest ||
      (async (frame, emit) => {
        requests.push(frame)
        emit({ type: 'accepted', req_id: frame.req_id, view: frame.view, slot: frame.slot })
        emit({ type: 'result', req_id: frame.req_id, ok: true, captured: false, url: 'https://chatgpt.com/', ms: 1234 })
      }),
    onCancel: (id) => cancels.push(id),
    onState: (s) => states.push(s),
    makeSocket: (u) => {
      const s = fakeSocket(u)
      sockets.push(s)
      return s
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    log,
  })
  const last = () => sockets[sockets.length - 1]
  /** open the current socket and complete the handshake */
  const handshake = () => {
    last().open()
    last().receive(HELLO_ACK)
  }
  return { client, sockets, last, timers, states, cancels, requests, log, handshake }
}

test('bridgeUrlFor maps the backend URL to the bridge WebSocket', () => {
  assert.equal(bridgeUrlFor('http://127.0.0.1:8021'), 'ws://127.0.0.1:8021/api/bridge')
  assert.equal(bridgeUrlFor('http://127.0.0.1:8021/'), 'ws://127.0.0.1:8021/api/bridge')
  assert.equal(bridgeUrlFor('https://localhost:9/x'), 'wss://localhost:9/api/bridge')
  assert.throws(() => createBridgeClient({ url: URL }), /token is required/)
})

test('connect: the first and only frame on open is hello with the token, protocol 1, sites, capture and analyst (corpus-valid)', () => {
  const { client, sockets, last, states } = setup({ analyst: 'grok' })
  assert.equal(client.connect(), true)
  assert.equal(client.connect(), false, 'idempotent while connecting')
  assert.equal(sockets.length, 1)
  assert.equal(last().url, URL)
  assert.deepEqual(last().sent, [], 'nothing before open')
  last().open()
  assert.equal(last().sent.length, 1)
  const hello = last().sent[0]
  assert.deepEqual(hello, { type: 'hello', protocol: 1, token: 'e2e', version: '0.1.0', sites: ['claude', 'chatgpt', 'grok'], capture: { claude: false, chatgpt: true, grok: false }, analyst: { slot: 'grok' } })
  assert.equal(validate(hello).ok, true)
  assert.equal(client.status().state, 'open')
  assert.equal(client.isConnected(), false)
  assert.deepEqual(states, [], 'not connected until hello_ack')
})

test('hello_ack is required before requests: a request before it is dropped; after it the round trip carries corpus-exact frames', async () => {
  const { client, last, states, requests, timers, log } = setup({ health: { chatgpt: HEALTH } })
  client.connect()
  last().open()
  last().receive(REQUEST)
  await tick()
  assert.deepEqual(requests, [], 'request before hello_ack ignored')
  assert.ok(log.lines.some(([, m]) => m.includes('before hello_ack')))

  timers.advance(5)
  last().receive(HELLO_ACK)
  assert.equal(client.isConnected(), true)
  assert.deepEqual(states, [{ connected: true, since: 5 }])
  assert.deepEqual(client.status().since, 5)
  assert.equal(client.status().pingS, 20)
  // the cached health of every view is re-sent right after the ack
  assert.deepEqual(last().frames('health'), [{ type: 'health', slot: 'chatgpt', health: HEALTH }])
  assert.equal(validate(last().frames('health')[0]).ok, true)

  last().receive(REQUEST)
  assert.equal(client.inflight(), 1)
  await tick()
  await tick()
  assert.deepEqual(requests, [REQUEST])
  const out = last().sent.slice(2)
  assert.deepEqual(out, [
    { type: 'accepted', req_id: REQUEST.req_id, view: 'pane', slot: 'chatgpt' },
    { type: 'result', req_id: REQUEST.req_id, ok: true, captured: false, url: 'https://chatgpt.com/', ms: 1234 },
  ])
  for (const f of out) assert.equal(validate(f).ok, true)
  assert.equal(client.inflight(), 0)
  assert.equal(client.status().discarded, 0)
})

test('ping → pong echoing ts; cancel → onCancel(req_id); invalid / non-server frames are dropped without effect', () => {
  const { client, last, cancels, handshake, log } = setup()
  client.connect()
  handshake()
  last().receive({ type: 'ping', ts: 1710000020000 })
  assert.deepEqual(last().frames('pong'), [{ type: 'pong', ts: 1710000020000 }])
  last().receive({ type: 'cancel', req_id: REQUEST.req_id })
  assert.deepEqual(cancels, [REQUEST.req_id])
  const before = last().sent.length
  last().receiveRaw('{nope')
  last().receive({ type: 'pong', ts: 1 })
  last().receive({ type: 'ping' })
  last().receive({ type: 'request', req_id: 'x' })
  assert.equal(last().sent.length, before)
  assert.ok(log.lines.filter(([, m]) => m.includes('dropped an invalid backend frame')).length >= 3)
  assert.equal(client.isConnected(), true)
})

test('reconnect schedule: 0.5 → 1 → 2 → 4 → 8 → 10 → 10 s after non-fatal closes; a hello_ack resets it; a connected drop reports the state', () => {
  const { client, sockets, last, timers, states, handshake } = setup()
  client.connect()
  last().fail()
  assert.equal(client.status().state, 'closed')
  assert.deepEqual(states, [], 'never connected: no state event')
  const delays = []
  for (let i = 0; i < 7; i++) {
    assert.equal(timers.pending(), 1, `attempt ${i}: one reconnect timer`)
    const openedBefore = sockets.length
    const t0 = timers.now()
    // advance until a new socket appears
    let step = 0
    while (sockets.length === openedBefore) {
      timers.advance(100)
      step += 100
      if (step > 20000) throw new Error('no reconnect within 20 s')
    }
    delays.push(timers.now() - t0)
    last().fail()
  }
  assert.deepEqual(delays.map((d) => Math.ceil(d / 100) * 100), [500, 1000, 2000, 4000, 8000, 10000, 10000])
  assert.equal(client.status().attempts, 8)

  timers.advance(BACKOFF_MS[BACKOFF_MS.length - 1])
  handshake()
  assert.equal(client.status().attempts, 0, 'hello_ack resets the backoff')
  assert.deepEqual(states.at(-1), { connected: true, since: timers.now() })
  last().drop(1006)
  assert.deepEqual(states.at(-1), { connected: false })
  assert.equal(client.status().state, 'closed')
  assert.equal(client.status().lastClose.code, 1006)
  timers.advance(BACKOFF_MS[0])
  assert.equal(sockets.length, 10, 'the first retry after a reset waits 0.5 s again')
})

test('superseded (4002) and bad token (4003) stop the client: no reconnect timer, state stopped; connect() restarts explicitly', () => {
  for (const code of [CLOSE_SUPERSEDED, CLOSE_BAD_TOKEN]) {
    const { client, sockets, last, timers, states, handshake, log } = setup()
    client.connect()
    handshake()
    last().drop(code, 'superseded')
    assert.equal(client.status().state, 'stopped', String(code))
    assert.equal(timers.pending(), 0, `${code}: no reconnect scheduled`)
    assert.deepEqual(states.at(-1), { connected: false })
    timers.advance(60000)
    assert.equal(sockets.length, 1, `${code}: no reconnect storm`)
    assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && m.includes(String(code)) && m.includes('not reconnecting')))
    assert.equal(client.connect(), true, 'an explicit connect() tries again')
    assert.equal(sockets.length, 2)
  }
})

test('a socket drop mid-turn: the turn completes locally and every later frame is discarded, never sent on the new socket', async () => {
  let finishTurn
  const trace = []
  const { client, sockets, last, timers, handshake } = setup({
    onRequest: (frame, emit) =>
      new Promise((resolve) => {
        trace.push(`accepted-sent:${emit({ type: 'accepted', req_id: frame.req_id, view: 'pane', slot: 'chatgpt' })}`)
        finishTurn = () => {
          trace.push(`result-sent:${emit({ type: 'result', req_id: frame.req_id, ok: true, captured: true, text: 'late reply', url: 'u', ms: 9, done_by: 'quiet' })}`)
          resolve()
        }
      }),
  })
  client.connect()
  handshake()
  const first = last()
  first.receive(REQUEST)
  await tick()
  assert.deepEqual(trace, ['accepted-sent:true'])
  assert.equal(client.inflight(), 1)
  first.drop(1006)
  assert.equal(client.inflight(), 1, 'the local turn is still running')
  timers.advance(BACKOFF_MS[0])
  handshake() // the new socket
  assert.equal(sockets.length, 2)
  const second = last()
  finishTurn()
  await tick()
  await tick()
  assert.deepEqual(trace, ['accepted-sent:true', 'result-sent:false'])
  assert.deepEqual(second.frames('result'), [], 'the stale result never reaches the new socket')
  assert.deepEqual(first.frames('result'), [], 'nor the dead one')
  assert.equal(client.inflight(), 0)
  assert.equal(client.status().discarded, 1)
})

test('capture / analyst / health frames go out only while connected and only when valid', () => {
  const { client, last, handshake, log } = setup()
  assert.equal(client.sendCapture({ claude: true, chatgpt: false, grok: false }), false, 'not connected: nothing sent')
  client.connect()
  last().open()
  assert.equal(client.sendCapture(), false, 'open but no hello_ack yet')
  last().receive(HELLO_ACK)
  assert.equal(client.sendCapture({ claude: true, chatgpt: false, grok: false }), true)
  assert.equal(client.sendCapture(), true, 'defaults to getCapture()')
  assert.deepEqual(last().frames('capture'), [
    { type: 'capture', capture: { claude: true, chatgpt: false, grok: false } },
    { type: 'capture', capture: { claude: false, chatgpt: true, grok: false } },
  ])
  assert.equal(client.sendAnalyst('claude'), true)
  assert.equal(client.sendAnalyst(null), true)
  assert.equal(client.sendAnalyst({ slot: 'grok' }), true)
  assert.deepEqual(last().frames('analyst'), [
    { type: 'analyst', analyst: { slot: 'claude' } },
    { type: 'analyst', analyst: null },
    { type: 'analyst', analyst: { slot: 'grok' } },
  ])
  assert.equal(client.sendHealth('grok', HEALTH), true)
  assert.equal(client.sendHealth('grok', { ...HEALTH, zoom: 1 }), false, 'an invalid Health is not sent')
  assert.equal(client.sendHealth('bing', HEALTH), false)
  assert.equal(client.sendCapture({ claude: 'yes' }), false, 'an invalid capture map is not sent')
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && m.includes('invalid capture frame')))
  for (const f of last().sent) assert.equal(validate(f).ok, true, JSON.stringify(f))
  // the token is never logged
  assert.ok(log.lines.every(([, m]) => !m.includes('e2e')), 'no log line carries the token')
})

test('watchdogs: no hello_ack within 10 s → close 4000 + reconnect; no ping for 2.5 × ping_s → close 4000 + reconnect', () => {
  const { client, sockets, last, timers, handshake } = setup()
  client.connect()
  last().open()
  timers.advance(HELLO_ACK_TIMEOUT_MS)
  assert.deepEqual(last().closed, { code: CLOSE_CLIENT_TIMEOUT, reason: 'hello_ack timeout' })
  assert.equal(client.status().state, 'closed')
  timers.advance(BACKOFF_MS[0])
  assert.equal(sockets.length, 2)
  handshake()
  const quiet = HELLO_ACK.ping_s * 1000 * PING_MISS_FACTOR
  timers.advance(quiet - 1000)
  last().receive({ type: 'ping', ts: 1 })
  timers.advance(quiet - 1000)
  assert.equal(client.isConnected(), true, 'a ping re-arms the watchdog')
  timers.advance(1000)
  assert.deepEqual(last().closed, { code: CLOSE_CLIENT_TIMEOUT, reason: 'ping timeout' })
  assert.equal(client.status().state, 'closed')
  assert.equal(timers.pending(), 1, 'a reconnect is scheduled')
})

test('close(): the socket is closed 1000, no reconnect, state stopped; a later connect() works', () => {
  const { client, sockets, last, timers, states, handshake } = setup()
  client.connect()
  handshake()
  client.close()
  assert.deepEqual(last().closed, { code: 1000, reason: 'shutdown' })
  assert.equal(client.status().state, 'stopped')
  assert.equal(timers.pending(), 0)
  assert.deepEqual(states.at(-1), { connected: false })
  timers.advance(60000)
  assert.equal(sockets.length, 1)
  client.connect()
  assert.equal(sockets.length, 2)
  client.close()
  assert.equal(client.status().state, 'stopped')
})

test('an onRequest that throws answers a site_error result so the backend never waits the full timeout', async () => {
  const { client, last, handshake } = setup({
    onRequest: () => {
      throw new Error('boom')
    },
  })
  client.connect()
  handshake()
  last().receive(REQUEST)
  await tick()
  await tick()
  const results = last().frames('result')
  assert.equal(results.length, 1)
  assert.equal(results[0].code, 'site_error')
  assert.match(results[0].message, /boom/)
  assert.equal(validate(results[0]).ok, true)
  assert.equal(client.inflight(), 0)
})

test('a socket factory that throws schedules a reconnect instead of crashing', () => {
  const timers = fakeTimers()
  const client = createBridgeClient({
    url: URL,
    token: 't',
    makeSocket: () => {
      throw new Error('no WebSocket')
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    log: fakeLog(),
  })
  assert.equal(client.connect(), false)
  assert.equal(client.status().state, 'closed')
  assert.equal(timers.pending(), 1)
})
