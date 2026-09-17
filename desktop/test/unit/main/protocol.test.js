// protocol.js — held to desktop/protocol/bridge-v1.json: every example passes validate() (and the
// direction-specific validator of its side), every invalid entry fails; parseFrame handles text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate, validateClientFrame, validateServerFrame, parseFrame, checkHealth, CLIENT_TYPES, SERVER_TYPES, REJECT_CODES, RESULT_CODES } from '../../../main/protocol.js'

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'protocol', 'bridge-v1.json')
const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'))

test('every example of every frame type passes validate() with its direction', () => {
  let count = 0
  for (const [type, spec] of Object.entries(corpus.frames)) {
    for (const example of spec.examples) {
      const r = validate(example)
      assert.deepEqual(r, { ok: true, type, direction: spec.direction }, `${type}: ${JSON.stringify(example)}`)
      const sided = spec.direction === 'client' ? validateClientFrame(example) : validateServerFrame(example)
      assert.equal(sided.ok, true, `${type} (${spec.direction} validator)`)
      const other = spec.direction === 'client' ? validateServerFrame(example) : validateClientFrame(example)
      assert.equal(other.ok, false, `${type} must not pass the other direction's validator`)
      count += 1
    }
  }
  assert.ok(count >= 40, `corpus examples: ${count}`)
})

test('every invalid entry of every frame type fails validate() with a message', () => {
  let count = 0
  for (const [type, spec] of Object.entries(corpus.frames)) {
    for (const bad of spec.invalid) {
      const r = validate(bad)
      assert.equal(r.ok, false, `${type} invalid must fail: ${JSON.stringify(bad)}`)
      assert.ok(typeof r.error === 'string' && r.error.length > 0, `${type}: error message`)
      count += 1
    }
  }
  assert.ok(count >= 60, `corpus invalid entries: ${count}`)
})

test('the validator knows exactly the documented frame types and codes', () => {
  assert.deepEqual([...CLIENT_TYPES].sort(), Object.entries(corpus.frames).filter(([, s]) => s.direction === 'client').map(([t]) => t).sort())
  assert.deepEqual([...SERVER_TYPES].sort(), Object.entries(corpus.frames).filter(([, s]) => s.direction === 'server').map(([t]) => t).sort())
  assert.deepEqual([...REJECT_CODES].sort(), [...new Set(corpus.frames.rejected.examples.map((e) => e.code))].sort())
  assert.deepEqual([...RESULT_CODES].sort(), [...new Set(corpus.frames.result.examples.filter((e) => e.ok === false).map((e) => e.code))].sort())
})

test('non-objects, unknown types, missing type and wrong-direction frames are rejected', () => {
  for (const bad of [null, undefined, 42, 'hello', [], [{ type: 'ping', ts: 1 }]]) assert.equal(validate(bad).ok, false, String(bad))
  assert.match(validate({ type: 'delta', req_id: 'x', text: 't' }).error, /unknown client type "delta"/)
  assert.match(validate({ ts: 1 }).error, /missing "type"/)
  assert.equal(validateClientFrame({ type: 'ping', ts: 1 }).ok, false)
  assert.equal(validateServerFrame({ type: 'pong', ts: 1 }).ok, false)
})

test('strictness: strings are never numbers or booleans, floats are never integers, extras are errors', () => {
  assert.equal(validate({ type: 'pong', ts: 1.5 }).ok, false)
  assert.equal(validate({ type: 'pong', ts: '1' }).ok, false)
  assert.equal(validate({ type: 'pong', ts: true }).ok, false)
  assert.equal(validate({ type: 'ping', ts: -1 }).ok, true, 'ping.ts has no lower bound')
  assert.equal(validate({ type: 'hello_ack', protocol: 1, backend_version: '1', ping_s: 1.5 }).ok, false)
  assert.equal(validate({ type: 'hello_ack', protocol: 1, backend_version: '1', ping_s: -1 }).ok, false)
  assert.equal(validate({ type: 'cancel', req_id: 'a', extra: 1 }).ok, false)
  const r = validate({ type: 'result', req_id: 'a', ok: true, captured: true, text: 't', url: 'u', ms: 1.2, done_by: 'quiet' })
  assert.equal(r.ok, false)
  assert.match(r.error, /result\.ms/)
})

test('result variants: partial is optional (string or null) only on ok:false; ms must be a non-negative integer', () => {
  assert.equal(validate({ type: 'result', req_id: 'a', ok: false, code: 'timeout', message: 'm' }).ok, true)
  assert.equal(validate({ type: 'result', req_id: 'a', ok: false, code: 'timeout', message: 'm', partial: null }).ok, true)
  assert.equal(validate({ type: 'result', req_id: 'a', ok: false, code: 'timeout', message: 'm', partial: 'p' }).ok, true)
  assert.equal(validate({ type: 'result', req_id: 'a', ok: false, code: 'timeout', message: 'm', partial: 5 }).ok, false)
  assert.equal(validate({ type: 'result', req_id: 'a', ok: true, captured: false, url: 'u', ms: 0 }).ok, true)
  assert.equal(validate({ type: 'result', req_id: 'a', ok: true, captured: false, url: 'u', ms: 0, partial: null }).ok, false)
  assert.equal(validate({ type: 'result', req_id: 'a', ok: true, captured: 'yes', text: 't', url: 'u', ms: 0, done_by: 'quiet' }).ok, false)
  assert.equal(validate({ type: 'result', req_id: '', ok: true, captured: false, url: 'u', ms: 0 }).ok, false, 'req_id must be non-empty')
})

test('request.model must match slot and view exactly', () => {
  const base = { type: 'request', req_id: 'r', model: 'web:claude', slot: 'claude', view: 'pane', fresh: false, text: 't', role: 'claude', purpose: 'chat', conversation_id: null, timeout_s: 1 }
  assert.equal(validate(base).ok, true)
  assert.equal(validate({ ...base, model: 'web:claude:analyst', view: 'analyst', role: 'analyst', purpose: 'extraction' }).ok, true)
  assert.equal(validate({ ...base, model: 'web:claude:analyst' }).ok, false)
  assert.equal(validate({ ...base, model: 'web:grok' }).ok, false)
  assert.equal(validate({ ...base, conversation_id: 7 }).ok, false)
  assert.equal(validate({ ...base, timeout_s: 0 }).ok, false)
})

test('health: matched.error is optional, every other key required; session is one of five states', () => {
  const h = { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: null, send: null, reply: null, stop: null }, url: '', host: '', title: '', ts: 0 }
  assert.doesNotThrow(() => checkHealth(h))
  assert.equal(validate({ type: 'health', slot: 'grok', health: h }).ok, true)
  assert.equal(validate({ type: 'health', slot: 'grok', health: { ...h, session: 'unknown' } }).ok, true)
  assert.equal(validate({ type: 'health', slot: 'grok', health: { ...h, session: 'expired' } }).ok, false)
  assert.equal(validate({ type: 'health', slot: 'grok', health: { ...h, matched: { ...h.matched, error: 'bad file' } } }).ok, true)
  assert.equal(validate({ type: 'health', slot: 'grok', health: { ...h, matched: { ...h.matched, error: 5 } } }).ok, false)
  assert.equal(validate({ type: 'health', slot: 'grok', health: { ...h, ts: 1.5 } }).ok, false)
  assert.throws(() => checkHealth({ ...h, composer: 'yes' }), /health\.composer/)
})

test('parseFrame: JSON text in, validated frame out; bad JSON / non-object / wrong direction rejected', () => {
  const ping = parseFrame('{"type":"ping","ts":5}')
  assert.deepEqual(ping, { ok: true, type: 'ping', direction: 'server', frame: { type: 'ping', ts: 5 } })
  assert.equal(parseFrame('{"type":"ping","ts":5}', 'server').ok, true)
  assert.equal(parseFrame('{"type":"ping","ts":5}', 'client').ok, false)
  assert.match(parseFrame('{nope').error, /not valid JSON/)
  assert.equal(parseFrame('[1,2]').ok, false)
  assert.equal(parseFrame('"ping"').ok, false)
  assert.equal(parseFrame(Buffer.from('{"type":"pong","ts":1}')).ok, true, 'a Buffer is stringified')
})
