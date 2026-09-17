// desktop/main/protocol.js — bridge protocol v1 validator (contract §1; electron-bridge Stage 2).
//
// Hand-written, dependency-free mirror of backend/llm/bridge_protocol.py: every frame is checked
// strictly (JSON already has real types — "1" is never protocol 1, 1 is never true), unknown keys
// are a protocol error, and `result` is told apart by its `ok` / `captured` pair so an ok:false
// result without `code` and an ok:true, captured:true result without `text` are rejected.
// desktop/protocol/bridge-v1.json is the corpus both sides are held to: every `examples` entry
// passes, every `invalid` entry fails (test/unit/main/protocol.test.js).
//
//   validate(frame)            → {ok:true, type, direction:'client'|'server'} | {ok:false, error}
//   validateClientFrame(frame) → the same, but only Electron → backend shapes pass
//   validateServerFrame(frame) → the same, but only backend → Electron shapes pass
//   parseFrame(text)           → JSON.parse + validate (a non-object / bad JSON → {ok:false, error})
//
// Pure module: no electron import, no I/O.

export const PROTOCOL_VERSION = 1

export const SLOT_IDS = Object.freeze(['claude', 'chatgpt', 'grok'])
export const SESSION_STATES = Object.freeze(['ok', 'logged_out', 'challenge', 'blocked', 'unknown'])
export const VIEWS = Object.freeze(['pane', 'analyst'])
export const DONE_BY = Object.freeze(['done_selector', 'stop_gone', 'quiet'])
export const BRIDGE_ROLES = Object.freeze(['chatgpt', 'claude', 'grok', 'analyst'])
export const PURPOSES = Object.freeze(['chat', 'extraction', 'defense', 'convergence'])
export const REJECT_CODES = Object.freeze(['view_busy', 'logged_out', 'challenge', 'blocked', 'analyst_not_chosen', 'unknown_site', 'view_crashed'])
export const RESULT_CODES = Object.freeze(['composer_not_found', 'send_not_found', 'not_submitted', 'reply_not_found', 'timeout', 'cancelled', 'adapter_gone', 'site_error', 'navigation', 'view_crashed'])
export const CLIENT_TYPES = Object.freeze(['hello', 'capture', 'analyst', 'health', 'accepted', 'rejected', 'result', 'pong'])
export const SERVER_TYPES = Object.freeze(['hello_ack', 'request', 'cancel', 'ping'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'
const isBool = (v) => typeof v === 'boolean'
const isInt = (v) => typeof v === 'number' && Number.isInteger(v)

class Invalid extends Error {}

function fail(msg) {
  throw new Invalid(msg)
}

/** `obj` must be a plain object whose keys ⊆ required ∪ optional and ⊇ required. */
function keys(obj, where, required, optional = []) {
  if (!isPlainObject(obj)) fail(`${where}: expected an object`)
  for (const k of required) if (!(k in obj)) fail(`${where}: missing "${k}"`)
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) fail(`${where}: unknown key "${k}"`)
}

function str(v, where) {
  if (!isStr(v)) fail(`${where}: expected a string`)
  return v
}

function nonEmptyStr(v, where) {
  if (!isStr(v) || v.length === 0) fail(`${where}: expected a non-empty string`)
  return v
}

function strOrNull(v, where) {
  if (v !== null && !isStr(v)) fail(`${where}: expected a string or null`)
  return v
}

function bool(v, where) {
  if (!isBool(v)) fail(`${where}: expected a boolean`)
  return v
}

function boolOrNull(v, where) {
  if (v !== null && !isBool(v)) fail(`${where}: expected a boolean or null`)
  return v
}

function int(v, where, { min = -Infinity, gt = -Infinity } = {}) {
  if (!isInt(v)) fail(`${where}: expected an integer`)
  if (v < min) fail(`${where}: must be ≥ ${min}`)
  if (v <= gt) fail(`${where}: must be > ${gt}`)
  return v
}

function oneOf(v, allowed, where) {
  if (!isStr(v) || !allowed.includes(v)) fail(`${where}: expected one of ${allowed.join('|')}`)
  return v
}

// --- shared objects ---------------------------------------------------------------------------

function captureMap(v, where) {
  keys(v, where, SLOT_IDS)
  for (const s of SLOT_IDS) bool(v[s], `${where}.${s}`)
}

function analystChoice(v, where) {
  if (v === null) return
  keys(v, where, ['slot'])
  oneOf(v.slot, SLOT_IDS, `${where}.slot`)
}

function matched(v, where) {
  keys(v, where, ['composer', 'send', 'reply', 'stop'], ['error'])
  for (const k of ['composer', 'send', 'reply', 'stop']) strOrNull(v[k], `${where}.${k}`)
  if ('error' in v) strOrNull(v.error, `${where}.error`)
}

/** The Health object of contract §1 (also used by the view manager before publishing). */
export function checkHealth(v, where = 'health') {
  keys(v, where, ['composer', 'send', 'reply', 'stop', 'session', 'matched', 'url', 'host', 'title', 'ts'])
  bool(v.composer, `${where}.composer`)
  bool(v.send, `${where}.send`)
  boolOrNull(v.reply, `${where}.reply`)
  boolOrNull(v.stop, `${where}.stop`)
  oneOf(v.session, SESSION_STATES, `${where}.session`)
  matched(v.matched, `${where}.matched`)
  str(v.url, `${where}.url`)
  str(v.host, `${where}.host`)
  str(v.title, `${where}.title`)
  int(v.ts, `${where}.ts`)
}

// --- client → backend --------------------------------------------------------------------------

const CLIENT = {
  hello(f) {
    keys(f, 'hello', ['type', 'protocol', 'token', 'version', 'sites', 'capture', 'analyst'])
    if (f.protocol !== PROTOCOL_VERSION) fail(`hello.protocol: expected ${PROTOCOL_VERSION}`)
    nonEmptyStr(f.token, 'hello.token')
    str(f.version, 'hello.version')
    if (!Array.isArray(f.sites) || f.sites.length < 1 || f.sites.length > 3) fail('hello.sites: expected 1..3 slots')
    for (const s of f.sites) oneOf(s, SLOT_IDS, 'hello.sites[]')
    if (new Set(f.sites).size !== f.sites.length) fail('hello.sites: must not repeat a slot')
    captureMap(f.capture, 'hello.capture')
    analystChoice(f.analyst, 'hello.analyst')
  },
  capture(f) {
    keys(f, 'capture', ['type', 'capture'])
    captureMap(f.capture, 'capture.capture')
  },
  analyst(f) {
    keys(f, 'analyst', ['type', 'analyst'])
    analystChoice(f.analyst, 'analyst.analyst')
  },
  health(f) {
    keys(f, 'health', ['type', 'slot', 'health'])
    oneOf(f.slot, SLOT_IDS, 'health.slot')
    checkHealth(f.health, 'health.health')
  },
  accepted(f) {
    keys(f, 'accepted', ['type', 'req_id', 'view', 'slot'])
    nonEmptyStr(f.req_id, 'accepted.req_id')
    oneOf(f.view, VIEWS, 'accepted.view')
    oneOf(f.slot, SLOT_IDS, 'accepted.slot')
  },
  rejected(f) {
    keys(f, 'rejected', ['type', 'req_id', 'code', 'message'])
    nonEmptyStr(f.req_id, 'rejected.req_id')
    oneOf(f.code, REJECT_CODES, 'rejected.code')
    str(f.message, 'rejected.message')
  },
  result(f) {
    if (!isPlainObject(f)) fail('result: expected an object')
    if (f.ok === false) {
      keys(f, 'result(ok:false)', ['type', 'req_id', 'ok', 'code', 'message'], ['partial'])
      nonEmptyStr(f.req_id, 'result.req_id')
      oneOf(f.code, RESULT_CODES, 'result.code')
      str(f.message, 'result.message')
      if ('partial' in f) strOrNull(f.partial, 'result.partial')
      return
    }
    if (f.ok !== true) fail('result.ok: expected a boolean')
    if (f.captured === false) {
      keys(f, 'result(captured:false)', ['type', 'req_id', 'ok', 'captured', 'url', 'ms'])
      nonEmptyStr(f.req_id, 'result.req_id')
      str(f.url, 'result.url')
      int(f.ms, 'result.ms', { min: 0 })
      return
    }
    keys(f, 'result(captured:true)', ['type', 'req_id', 'ok', 'captured', 'text', 'url', 'ms', 'done_by'])
    if (f.captured !== true) fail('result.captured: expected a boolean')
    nonEmptyStr(f.req_id, 'result.req_id')
    str(f.text, 'result.text')
    str(f.url, 'result.url')
    int(f.ms, 'result.ms', { min: 0 })
    oneOf(f.done_by, DONE_BY, 'result.done_by')
  },
  pong(f) {
    keys(f, 'pong', ['type', 'ts'])
    int(f.ts, 'pong.ts')
  },
}

// --- backend → client --------------------------------------------------------------------------

const SERVER = {
  hello_ack(f) {
    keys(f, 'hello_ack', ['type', 'protocol', 'backend_version', 'ping_s'])
    if (f.protocol !== PROTOCOL_VERSION) fail(`hello_ack.protocol: expected ${PROTOCOL_VERSION}`)
    str(f.backend_version, 'hello_ack.backend_version')
    int(f.ping_s, 'hello_ack.ping_s', { gt: 0 })
  },
  request(f) {
    keys(f, 'request', ['type', 'req_id', 'model', 'slot', 'view', 'fresh', 'text', 'role', 'purpose', 'conversation_id', 'timeout_s'])
    nonEmptyStr(f.req_id, 'request.req_id')
    str(f.model, 'request.model')
    oneOf(f.slot, SLOT_IDS, 'request.slot')
    oneOf(f.view, VIEWS, 'request.view')
    bool(f.fresh, 'request.fresh')
    str(f.text, 'request.text')
    oneOf(f.role, BRIDGE_ROLES, 'request.role')
    oneOf(f.purpose, PURPOSES, 'request.purpose')
    strOrNull(f.conversation_id, 'request.conversation_id')
    int(f.timeout_s, 'request.timeout_s', { gt: 0 })
    const expected = `web:${f.slot}${f.view === 'analyst' ? ':analyst' : ''}`
    if (f.model !== expected) fail(`request.model: must be "${expected}" for slot "${f.slot}" and view "${f.view}"`)
  },
  cancel(f) {
    keys(f, 'cancel', ['type', 'req_id'])
    nonEmptyStr(f.req_id, 'cancel.req_id')
  },
  ping(f) {
    keys(f, 'ping', ['type', 'ts'])
    int(f.ts, 'ping.ts')
  },
}

function run(table, direction, frame) {
  try {
    if (!isPlainObject(frame)) fail('frame: expected an object')
    const type = frame.type
    if (!isStr(type)) fail('frame: missing "type"')
    const check = Object.prototype.hasOwnProperty.call(table, type) ? table[type] : null
    if (!check) fail(`frame: unknown ${direction} type "${type}"`)
    check(frame)
    return { ok: true, type, direction }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message }
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export function validateClientFrame(frame) {
  return run(CLIENT, 'client', frame)
}

export function validateServerFrame(frame) {
  return run(SERVER, 'server', frame)
}

/** Either direction: the frame's `type` selects the table (the two type sets are disjoint). */
export function validate(frame) {
  if (isPlainObject(frame) && isStr(frame.type) && SERVER_TYPES.includes(frame.type)) return validateServerFrame(frame)
  return validateClientFrame(frame)
}

/** JSON text → validate; the parsed frame is returned as `frame` when valid. */
export function parseFrame(text, direction = null) {
  let parsed
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : String(text))
  } catch (e) {
    return { ok: false, error: `frame: not valid JSON (${e.message})` }
  }
  const r = direction === 'server' ? validateServerFrame(parsed) : direction === 'client' ? validateClientFrame(parsed) : validate(parsed)
  return r.ok ? { ...r, frame: parsed } : r
}
