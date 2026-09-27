// openrouter-key.js — the key round trip through a fake safeStorage and a REAL settings.json in a
// temp dir (the file never contains the key), the refusal without a keyring (`encryption_unavailable`
// naming the backend), an undecryptable blob cleared with an error (a merely unavailable keyring keeps
// it), the sync (PUT key + PUT defaults with `Bearer <token>`, DELETE when no key, a 10 s abort,
// 401/403 stop, ECONNREFUSED retried 2 s × 5 on fake timers, a loopback backend only, coalescing), a
// key that is stored but unreadable at launch (NO key step, `pushed` stays false, the keyring re-checked
// on the fake timers, `onDecrypted` fires once it reads — a status never says "pushed" for a key the
// backend does not hold), the prefix rule (`sk-or-v1-` or nothing) and — for every path — every log
// line, error message, thrown error and status scanned for the key.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOpenRouterKey, isKeyShape, isLoopbackUrl, defaultsBody, KEY_ERRORS, KEY_PREFIX_CHARS, KEY_PUBLIC_PREFIX, KEY_RECHECK_MS, SYNC_TIMEOUT_MS, SYNC_RETRY_MS, SYNC_RETRIES, KEY_PATH, DEFAULTS_PATH } from '../../../main/openrouter-key.js'
import { createSettings, SETTINGS_FILE } from '../../../main/settings.js'
import { DEFAULT_COUNCIL } from '../../../main/council.js'
import { fakeSafeStorage, fakeFetch, connRefused, fakeTimers, fakeLog, tick } from './_fakes.js'

const KEY = `sk-or-v1-${'d'.repeat(64)}` // 73 chars
const URL_ = 'http://127.0.0.1:8021'
const TOKEN = 'tok-1234'
const TWO = { slots: { chatgpt: { model: 'web:chatgpt', effort: 'off' }, qwen: { model: 'qwen/qwen3-235b-a22b', effort: 'low' } } }
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-key-'))
const readFile = (dir) => fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
const args = (extra = {}) => ({ url: URL_, token: TOKEN, council: TWO, analystModel: 'web:chatgpt:analyst', ...extra })

/** Everything a test could have leaked into, as one string: log lines, statuses, results, errors. */
function leakSurface({ log, ...rest }) {
  return JSON.stringify([log ? log.lines : null, rest])
}

function setup({ dir = tmpDir(), safeStorage = fakeSafeStorage(), answer = 200, timers = fakeTimers() } = {}) {
  const log = fakeLog()
  const settings = createSettings({ dir, log: fakeLog() })
  settings.load()
  const fetch = fakeFetch(answer)
  const keys = createOpenRouterKey({ settings, safeStorage, fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, log })
  return { dir, settings, safeStorage, fetch, timers, log, keys }
}

/** The recorded fetches as {method, path, auth, body}. */
const summary = (fetch) => fetch.calls.map((c) => ({ method: c.method, path: new URL(c.url).pathname, auth: c.headers.authorization, body: c.body ? JSON.parse(c.body) : null }))

/** Drive a sync that fails N times over the fake timers: advance the retry delay and let the loop breathe. */
async function retryRounds(timers, n) {
  for (let i = 0; i < n; i++) {
    await tick()
    timers.advance(SYNC_RETRY_MS)
    await tick()
  }
  await tick()
}

test('isKeyShape / isLoopbackUrl / defaultsBody', () => {
  assert.equal(isKeyShape(KEY), true)
  assert.equal(isKeyShape('x'.repeat(20)), true)
  assert.equal(isKeyShape('x'.repeat(512)), true)
  for (const bad of ['', 'x'.repeat(19), 'x'.repeat(513), `${'x'.repeat(19)} `, `${'x'.repeat(19)}\t`, `${'x'.repeat(19)}ü`, null, 42, ['x'.repeat(20)]]) assert.equal(isKeyShape(bad), false, JSON.stringify(bad))
  for (const ok of ['http://127.0.0.1:8021', 'http://localhost:8021/', 'https://[::1]:8443', 'http://LOCALHOST.:1']) assert.equal(isLoopbackUrl(ok), true, ok)
  for (const bad of ['http://10.0.0.5:8021', 'https://example.com', 'ws://127.0.0.1:8021', 'file:///x', 'not a url', '', null]) assert.equal(isLoopbackUrl(bad), false, String(bad))
  assert.deepEqual(defaultsBody(TWO, 'web:chatgpt:analyst'), { slot_config: { slots: TWO.slots, analyst_model: 'web:chatgpt:analyst', max_iterations: 2, materiality_min: 'medium', grounded: false } })
  assert.equal(defaultsBody(TWO).slot_config.analyst_model, '', 'no analyst → the backend\'s "none"')
  assert.equal(defaultsBody(TWO, null).slot_config.analyst_model, '')
  assert.deepEqual(Object.keys(defaultsBody(DEFAULT_COUNCIL()).slot_config.slots), ['claude', 'chatgpt', 'grok'])
  assert.notEqual(defaultsBody(TWO).slot_config.slots.qwen, TWO.slots.qwen, 'copied, not aliased')
  assert.equal(defaultsBody(null), null)
  assert.equal(defaultsBody({ slots: {} }), null)
  assert.equal(KEY_PREFIX_CHARS, 'sk-or-v1-'.length)
  assert.equal(KEY_PUBLIC_PREFIX, 'sk-or-v1-')
})

test('status.prefix is the public marker or nothing: a key in any other shape shows no prefix (nine characters of it would be nine characters of the secret)', () => {
  const { keys, log } = setup()
  const odd = `sk-or-${'e'.repeat(40)}` // no `v1-` segment: a valid shape, not the public format
  assert.deepEqual(keys.set(odd), { configured: true, prefix: '', length: odd.length, pushed: false })
  assert.equal(keys.plaintext(), odd)
  const other = 'x'.repeat(32)
  assert.deepEqual(keys.set(other), { configured: true, prefix: '', length: 32, pushed: false })
  assert.deepEqual(keys.set(KEY).prefix, KEY_PUBLIC_PREFIX)
  const surface = leakSurface({ log, s: keys.status() })
  assert.equal(surface.includes(odd.slice(0, KEY_PREFIX_CHARS)), false, 'not even the first nine characters')
  assert.equal(surface.includes(other.slice(0, KEY_PREFIX_CHARS)), false)
})

test('a stored key that is unreadable at launch: sync sends NO key step (not a DELETE), the defaults still go out, pushed stays false with encryption_unavailable, the warning is said once across the sync; the keyring is re-checked on the timers and the decrypt fires onDecrypted with pushed false — never "pushed" without a PUT', async () => {
  const dir = tmpDir()
  setup({ dir }).keys.set(KEY) // session 1: stored with a keyring
  const s2 = createSettings({ dir, log: fakeLog() })
  s2.load()
  const off = fakeSafeStorage({ available: false, backend: 'unknown' })
  const fetch = fakeFetch(200)
  const timers = fakeTimers()
  const log = fakeLog()
  const decrypted = []
  const keys = createOpenRouterKey({ settings: s2, safeStorage: off, fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, log, onDecrypted: () => decrypted.push(keys.status()) })
  // session 2: the bridge's connected edge pushes while the keyring is still locked
  const r = await keys.sync(args())
  assert.deepEqual(r, { ok: false, error: KEY_ERRORS.encryptionUnavailable }, 'not a success: the key was not sent')
  assert.deepEqual(summary(fetch), [{ method: 'PUT', path: DEFAULTS_PATH, auth: `Bearer ${TOKEN}`, body: defaultsBody(TWO, 'web:chatgpt:analyst') }], 'the defaults only — no DELETE for a key the user did enter')
  assert.deepEqual(keys.status(), { configured: true, prefix: '', length: 0, pushed: false, error: KEY_ERRORS.encryptionUnavailable })
  keys.status()
  await keys.sync(args())
  keys.status()
  assert.equal(log.lines.filter(([l, m]) => l === 'warn' && m.includes('encryption_unavailable')).length, 1, 'warned once, not again after a sync or per status call')
  assert.ok(log.lines.some(([l, m]) => l === 'log' && m === `[openrouter-key] pushed: key stored but ${KEY_ERRORS.encryptionUnavailable} — not sent; defaults 2 agents`))
  assert.equal(JSON.parse(readFile(dir)).openrouterKey !== null, true, 'the blob is kept')
  assert.equal(keys.status().pushed, false)
  // the re-check: one timer, re-armed while the keyring stays locked, no decrypt attempted
  assert.equal(timers.pending(), 1, 'one re-check timer while unreadable')
  timers.advance(KEY_RECHECK_MS)
  assert.equal(off.decrypted, 0)
  assert.equal(timers.pending(), 1, 're-armed')
  assert.deepEqual(decrypted, [])
  // the keyring unlocks: the next re-check decrypts, pushed is (still) false, onDecrypted fires once
  off.available = true
  timers.advance(KEY_RECHECK_MS)
  assert.equal(off.decrypted, 1)
  assert.deepEqual(decrypted, [{ configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false }], 'onDecrypted sees the readable, NOT pushed status')
  assert.equal(timers.pending(), 0, 'no more re-checks')
  assert.deepEqual(keys.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false }, 'the error clears, "pushed" does not appear on its own')
  assert.ok(log.lines.some(([l, m]) => l === 'log' && m === '[openrouter-key] the stored key decrypted (73 chars, unknown); not yet pushed'))
  // only a PUT of the key makes it pushed (what main's onDecrypted → syncKey does)
  fetch.calls.length = 0
  assert.deepEqual(await keys.sync(args()), { ok: true })
  assert.deepEqual(summary(fetch).map((c) => [c.method, c.path]), [['PUT', KEY_PATH], ['PUT', DEFAULTS_PATH]])
  assert.deepEqual(keys.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: true })
  assert.equal(decrypted.length, 1, 'onDecrypted fired for the one transition')
  assert.equal(leakSurface({ log, r, decrypted, s: keys.status() }).includes(KEY), false)
  // the same transition through status() (a getInfo while unreadable, then a getInfo after the unlock)
  const s3 = createSettings({ dir, log: fakeLog() })
  s3.load()
  const off3 = fakeSafeStorage({ available: false })
  const t3 = fakeTimers()
  const fired = []
  const k3 = createOpenRouterKey({ settings: s3, safeStorage: off3, fetch: fakeFetch(), setTimeout: t3.setTimeout, clearTimeout: t3.clearTimeout, log: fakeLog(), onDecrypted: () => fired.push(1) })
  assert.equal(k3.status().error, KEY_ERRORS.encryptionUnavailable)
  off3.available = true
  assert.deepEqual(k3.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false })
  assert.deepEqual(fired, [1])
  assert.equal(t3.pending(), 0, 'the re-check is dropped once the key reads')
  // a set / clear while unreadable is impossible (set refuses) or ends the spell (clear): no timer left
  const s4 = createSettings({ dir, log: fakeLog() })
  s4.load()
  const t4 = fakeTimers()
  const k4 = createOpenRouterKey({ settings: s4, safeStorage: fakeSafeStorage({ available: false }), fetch: fakeFetch(), setTimeout: t4.setTimeout, clearTimeout: t4.clearTimeout, log: fakeLog() })
  k4.status()
  assert.equal(t4.pending(), 1)
  k4.clear()
  assert.equal(t4.pending(), 0)
  assert.deepEqual(k4.status(), { configured: false, prefix: '', length: 0, pushed: false })
  // dispose drops the re-check too
  const s5 = createSettings({ dir, log: fakeLog() })
  s5.load()
  s5.setOpenRouterKeyCiphertext(JSON.parse(readFile(dir)).openrouterKey || 'ZW5jOjAw')
  const t5 = fakeTimers()
  const k5 = createOpenRouterKey({ settings: s5, safeStorage: fakeSafeStorage({ available: false }), fetch: fakeFetch(), setTimeout: t5.setTimeout, clearTimeout: t5.clearTimeout, log: fakeLog() })
  k5.status()
  assert.equal(t5.pending(), 1)
  k5.dispose()
  assert.equal(t5.pending(), 0)
})

test('round trip: set encrypts through safeStorage, the settings file holds base64 that never contains the key, status shows prefix + length, a fresh module on the same dir decrypts it lazily', () => {
  const { dir, keys, safeStorage, settings, log } = setup()
  assert.deepEqual(keys.status(), { configured: false, prefix: '', length: 0, pushed: false })
  const status = keys.set(KEY)
  assert.deepEqual(status, { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false })
  assert.equal(safeStorage.encrypted, 1)
  assert.equal(keys.plaintext(), KEY)
  const file = readFile(dir)
  assert.equal(file.includes(KEY), false, 'settings.json never holds the key')
  assert.equal(file.includes('d'.repeat(16)), false)
  const blob = JSON.parse(file).openrouterKey
  assert.match(blob, /^[A-Za-z0-9+/]+=*$/)
  assert.equal(Buffer.from(blob, 'base64').toString('utf8').includes(KEY), false, 'not even one decode away')
  assert.ok(log.lines.some(([l, m]) => l === 'log' && m.includes('stored (73 chars, encrypted with gnome_libsecret)')))
  // a second module on the same file (the next launch) decrypts on first use, once
  const again = createOpenRouterKey({ settings: createSettings({ dir, log: fakeLog() }), safeStorage, fetch: fakeFetch(), log })
  again.status()
  assert.equal(safeStorage.decrypted, 0, 'nothing decrypted before load')
  const s2 = createSettings({ dir, log: fakeLog() })
  s2.load()
  const third = createOpenRouterKey({ settings: s2, safeStorage, fetch: fakeFetch(), log })
  assert.deepEqual(third.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false })
  third.status()
  third.plaintext()
  assert.equal(safeStorage.decrypted, 1, 'decrypted once, then cached')
  assert.equal(third.plaintext(), KEY)
  // clear: cache and file
  assert.deepEqual(third.clear(), { configured: false, prefix: '', length: 0, pushed: false })
  assert.equal(JSON.parse(readFile(dir)).openrouterKey, null)
  assert.equal(third.plaintext(), null)
  assert.equal(settings.getOpenRouterKeyCiphertext() === null || typeof settings.getOpenRouterKeyCiphertext() === 'string', true)
  assert.equal(leakSurface({ log, status, s: third.status() }).includes(KEY), false)
})

test('set: a bad shape is bad_request; without a keyring the refusal is encryption_unavailable, names the backend, stores nothing', () => {
  const { dir, keys, log } = setup({ safeStorage: fakeSafeStorage({ available: false, backend: 'basic_text' }) })
  for (const bad of ['short', '', null, 42]) assert.throws(() => keys.set(bad), /^Error: bad_request$/)
  let thrown = null
  try {
    keys.set(KEY)
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown)
  assert.equal(thrown.message, KEY_ERRORS.encryptionUnavailable)
  assert.equal(thrown.backend, 'basic_text')
  assert.equal(fs.existsSync(path.join(dir, SETTINGS_FILE)), false, 'nothing was written at all')
  assert.deepEqual(keys.status(), { configured: false, prefix: '', length: 0, pushed: false, error: KEY_ERRORS.encryptionUnavailable })
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes('refused: encryption_unavailable (safeStorage backend: basic_text)')))
  assert.equal(leakSurface({ log, thrown: String(thrown), s: keys.status() }).includes(KEY), false)
})

test('plaintext: an undecryptable blob is cleared from the file and reported `undecryptable` (no throw); a merely unavailable keyring keeps the blob and reports encryption_unavailable', () => {
  const dir = tmpDir()
  const good = fakeSafeStorage()
  const { keys } = setup({ dir, safeStorage: good })
  keys.set(KEY)
  const blob = JSON.parse(readFile(dir)).openrouterKey
  // another keyring: decryptString throws (or returns garbage) — cleared
  const other = fakeSafeStorage({ backend: 'kwallet6' })
  other.decryptString = () => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString')
  }
  const s2 = createSettings({ dir, log: fakeLog() })
  s2.load()
  const log = fakeLog()
  const k2 = createOpenRouterKey({ settings: s2, safeStorage: other, fetch: fakeFetch(), log })
  assert.doesNotThrow(() => k2.plaintext())
  assert.equal(k2.plaintext(), null)
  assert.deepEqual(k2.status(), { configured: false, prefix: '', length: 0, pushed: false, error: KEY_ERRORS.undecryptable })
  assert.equal(JSON.parse(readFile(dir)).openrouterKey, null, 'the blob is gone from the file')
  assert.equal(log.lines.filter(([l, m]) => l === 'warn' && m.includes('could not be decrypted (safeStorage backend: kwallet6); the key was cleared')).length, 1, 'said once')
  // garbage that decrypts to a non-key is the same case
  const garbage = fakeSafeStorage()
  garbage.decryptString = () => 'x'
  const s3 = createSettings({ dir, log: fakeLog() })
  s3.load()
  s3.setOpenRouterKeyCiphertext(blob)
  const k3 = createOpenRouterKey({ settings: s3, safeStorage: garbage, fetch: fakeFetch(), log: fakeLog() })
  assert.equal(k3.status().error, KEY_ERRORS.undecryptable)
  assert.equal(JSON.parse(readFile(dir)).openrouterKey, null)
  // an UNAVAILABLE keyring: nothing proved the blob bad, so it stays; configured but unreadable
  const s4 = createSettings({ dir, log: fakeLog() })
  s4.load()
  s4.setOpenRouterKeyCiphertext(blob)
  const off = fakeSafeStorage({ available: false, backend: 'unknown' })
  const log4 = fakeLog()
  const k4 = createOpenRouterKey({ settings: s4, safeStorage: off, fetch: fakeFetch(), log: log4 })
  assert.deepEqual(k4.status(), { configured: true, prefix: '', length: 0, pushed: false, error: KEY_ERRORS.encryptionUnavailable })
  k4.status()
  assert.equal(JSON.parse(readFile(dir)).openrouterKey, blob, 'kept')
  assert.equal(log4.lines.filter(([, m]) => m.includes('encryption_unavailable')).length, 1, 'warned once, not per status call')
  // the keyring comes back: the same module decrypts and the error clears
  off.available = true
  assert.equal(k4.plaintext(), KEY)
  assert.deepEqual(k4.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false })
  assert.equal(leakSurface({ log, log4 }).includes(KEY), false)
})

test('sync: PUT key then PUT defaults with `Bearer <token>`, JSON bodies and an abort signal; pushed flips true; a later clear → DELETE then PUT defaults', async () => {
  const { keys, fetch, log } = setup()
  keys.set(KEY)
  const r = await keys.sync(args())
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(summary(fetch), [
    { method: 'PUT', path: KEY_PATH, auth: `Bearer ${TOKEN}`, body: { key: KEY } },
    { method: 'PUT', path: DEFAULTS_PATH, auth: `Bearer ${TOKEN}`, body: defaultsBody(TWO, 'web:chatgpt:analyst') },
  ])
  for (const c of fetch.calls) {
    assert.equal(c.headers['content-type'], 'application/json')
    assert.ok(c.signal && typeof c.signal.aborted === 'boolean', 'an AbortSignal travels with every request')
    assert.ok(c.url.startsWith(URL_))
  }
  assert.deepEqual(keys.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: true })
  keys.clear()
  assert.equal(keys.status().pushed, false)
  fetch.calls.length = 0
  await keys.sync(args({ url: `${URL_}/` }))
  assert.deepEqual(summary(fetch), [
    { method: 'DELETE', path: KEY_PATH, auth: `Bearer ${TOKEN}`, body: null },
    { method: 'PUT', path: DEFAULTS_PATH, auth: `Bearer ${TOKEN}`, body: defaultsBody(TWO, 'web:chatgpt:analyst') },
  ])
  assert.equal(fetch.calls[0].url, `${URL_}${KEY_PATH}`, 'a trailing slash on the base is not doubled')
  assert.deepEqual(keys.status(), { configured: false, prefix: '', length: 0, pushed: true })
  // no council → the defaults step is skipped, the key step still runs
  fetch.calls.length = 0
  keys.set(KEY)
  await keys.sync(args({ council: null }))
  assert.deepEqual(summary(fetch).map((c) => c.path), [KEY_PATH])
  assert.ok(log.lines.some(([l, m]) => l === 'log' && m === '[openrouter-key] pushed: key configured, defaults skipped'))
  assert.ok(log.lines.some(([, m]) => m === '[openrouter-key] pushed: key configured, defaults 2 agents'))
  assert.ok(log.lines.some(([, m]) => m === '[openrouter-key] pushed: key cleared, defaults 2 agents'))
  assert.equal(leakSurface({ log, r, s: keys.status() }).includes(KEY), false)
})

test('sync refuses (nothing sent) without a URL or token and for a non-loopback backend; the codes land in status.error', async () => {
  const { keys, fetch, log } = setup()
  keys.set(KEY)
  assert.deepEqual(await keys.sync({ url: '', token: TOKEN, council: TWO }), { ok: false, error: KEY_ERRORS.syncUnavailable })
  assert.deepEqual(await keys.sync({ url: URL_, token: '', council: TWO }), { ok: false, error: KEY_ERRORS.syncUnavailable })
  assert.deepEqual(await keys.sync(), { ok: false, error: KEY_ERRORS.syncUnavailable })
  assert.deepEqual(await keys.sync(args({ url: 'http://10.0.0.5:8021' })), { ok: false, error: KEY_ERRORS.syncRefusedRemote })
  assert.deepEqual(await keys.sync(args({ url: 'https://example.com' })), { ok: false, error: KEY_ERRORS.syncRefusedRemote })
  assert.deepEqual(fetch.calls, [], 'nothing left the machine')
  assert.deepEqual(keys.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false, error: KEY_ERRORS.syncRefusedRemote })
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes('refusing to push the key to a non-loopback backend')))
  assert.equal(leakSurface({ log }).includes(KEY), false)
})

test('sync: 401 / 403 stop at once (no retry, no defaults step); another non-2xx is sync_rejected with the status; a success afterwards clears the error', async () => {
  for (const status of [401, 403]) {
    const { keys, fetch, log, timers } = setup({ answer: status })
    keys.set(KEY)
    const r = await keys.sync(args())
    assert.deepEqual(r, { ok: false, error: KEY_ERRORS.syncUnauthorized }, String(status))
    assert.equal(fetch.calls.length, 1, 'one request, no retry, no defaults')
    assert.equal(timers.pending(), 0, 'no retry timer armed')
    assert.deepEqual(keys.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false, error: KEY_ERRORS.syncUnauthorized })
    assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes(`PUT ${KEY_PATH}: HTTP ${status}; not retrying`)))
    assert.equal(leakSurface({ log, r }).includes(KEY), false)
  }
  let refuseDefaults = true
  const rejected = setup({ answer: (call) => (refuseDefaults && call.url.endsWith(DEFAULTS_PATH) ? 422 : 200) })
  rejected.keys.set(KEY)
  assert.deepEqual(await rejected.keys.sync(args()), { ok: false, error: KEY_ERRORS.syncRejected })
  assert.equal(rejected.fetch.calls.length, 2, 'the key PUT passed, the defaults PUT was refused, no retry')
  assert.ok(rejected.log.lines.some(([, m]) => m.includes(`PUT ${DEFAULTS_PATH}: HTTP 422; not retrying`)))
  assert.equal(rejected.keys.status().error, KEY_ERRORS.syncRejected)
  refuseDefaults = false // everything answers 200 from here
  assert.deepEqual(await rejected.keys.sync(args()), { ok: true })
  assert.deepEqual(rejected.keys.status(), { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: true })
})

test('sync: a transport failure (ECONNREFUSED) is retried SYNC_RETRIES times, SYNC_RETRY_MS apart, on the injected timers; the sixth failure is sync_unreachable', async () => {
  const { keys, fetch, log, timers } = setup({ answer: connRefused() })
  keys.set(KEY)
  const p = keys.sync(args())
  await tick()
  assert.equal(fetch.calls.length, 1)
  assert.equal(timers.pending(), 1, 'one retry timer')
  timers.advance(SYNC_RETRY_MS - 1)
  await tick()
  assert.equal(fetch.calls.length, 1, 'not before the delay')
  timers.advance(1)
  await tick()
  assert.equal(fetch.calls.length, 2)
  await retryRounds(timers, SYNC_RETRIES - 1)
  assert.equal(fetch.calls.length, SYNC_RETRIES + 1, 'the first attempt plus five retries')
  assert.deepEqual(await p, { ok: false, error: KEY_ERRORS.syncUnreachable })
  assert.equal(timers.pending(), 0)
  assert.equal(keys.status().error, KEY_ERRORS.syncUnreachable)
  assert.equal(keys.status().pushed, false)
  const warns = log.lines.filter(([l]) => l === 'warn').map(([, m]) => m)
  assert.equal(warns.filter((m) => /ECONNREFUSED; retry \d\/5 in 2000 ms/.test(m)).length, SYNC_RETRIES)
  assert.ok(warns.some((m) => m.includes(`PUT ${KEY_PATH}: ECONNREFUSED after ${SYNC_RETRIES} retries; giving up until the next connect`)))
  assert.equal(leakSurface({ log }).includes(KEY), false)
  // the backend comes up during the retries: the next attempt succeeds and the rest of the steps run
  let n = 0
  const recovering = setup({ answer: () => (++n <= 2 ? connRefused() : 200) })
  recovering.keys.set(KEY)
  const q = recovering.keys.sync(args())
  await retryRounds(recovering.timers, 2)
  assert.deepEqual(await q, { ok: true })
  assert.deepEqual(summary(recovering.fetch).map((c) => c.method), ['PUT', 'PUT', 'PUT', 'PUT'], 'two failed key PUTs, then the key and the defaults')
  assert.equal(recovering.keys.status().pushed, true)
})

test('sync: a request that never answers is aborted after SYNC_TIMEOUT_MS (AbortError counts as a transport failure and is retried)', async () => {
  const { keys, fetch, log, timers } = setup({ answer: 'hang' })
  keys.set(KEY)
  const p = keys.sync(args())
  await tick()
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].signal.aborted, false)
  timers.advance(SYNC_TIMEOUT_MS)
  await tick()
  assert.equal(fetch.calls[0].signal.aborted, true, 'aborted at the deadline')
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && m.includes(`PUT ${KEY_PATH}: AbortError; retry 1/${SYNC_RETRIES}`)))
  keys.dispose() // quit while waiting on the retry delay: the run ends, nothing hangs
  assert.deepEqual(await p, { ok: false, error: KEY_ERRORS.syncStopped })
  assert.equal(timers.pending(), 0)
  assert.equal(leakSurface({ log }).includes(KEY), false)
})

test('sync calls coalesce: a call during a run returns that run\'s promise and the run repeats ONCE more with the latest state', async () => {
  let release = null
  const gate = new Promise((r) => {
    release = r
  })
  const settings = createSettings({ dir: tmpDir(), log: fakeLog() })
  settings.load()
  const calls = []
  let first = true
  // a fetch whose very first request waits on the gate; everything after answers at once
  const slowFetch = async (url, init) => {
    calls.push({ method: init.method, path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : null })
    if (first) {
      first = false
      await gate
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const log = fakeLog()
  const k = createOpenRouterKey({ settings, safeStorage: fakeSafeStorage(), fetch: slowFetch, log })
  assert.equal(k.inflight(), false)
  k.set(KEY)
  const p1 = k.sync(args())
  assert.equal(k.inflight(), true)
  await tick()
  assert.equal(calls.length, 1, 'the first PUT is waiting on the gate')
  k.clear() // the state changes while the run is blocked
  const p2 = k.sync(args())
  const p3 = k.sync(args({ council: DEFAULT_COUNCIL() }))
  assert.equal(p2, p1, 'the same run')
  assert.equal(p3, p1)
  release()
  assert.deepEqual(await p1, { ok: true })
  assert.equal(k.inflight(), false)
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [
    ['PUT', KEY_PATH],
    ['PUT', DEFAULTS_PATH],
    ['DELETE', KEY_PATH],
    ['PUT', DEFAULTS_PATH],
  ], 'one full run, then exactly one more with the latest state (a clear, the newer council)')
  assert.deepEqual(Object.keys(calls[3].body.slot_config.slots), ['claude', 'chatgpt', 'grok'], 'the LAST args win')
  assert.deepEqual(k.status(), { configured: false, prefix: '', length: 0, pushed: true })
  assert.equal(leakSurface({ log, calls: calls.filter((c) => c.path !== KEY_PATH) }).includes(KEY), false)
})

test('createOpenRouterKey requires a ciphertext-aware settings object', () => {
  assert.throws(() => createOpenRouterKey({ settings: null, safeStorage: fakeSafeStorage() }), /settings is required/)
  assert.throws(() => createOpenRouterKey({ settings: { getCapture: () => ({}) }, safeStorage: fakeSafeStorage() }), /settings is required/)
})
