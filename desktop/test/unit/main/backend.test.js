// backend.js — buildSpawnSpec (venv path, §6 env keys incl. DATA_DIR / TRIPLEX_DESKTOP=1 /
// BRIDGE_TOKEN / ANALYST_MODEL from settings, OPENROUTER_API_KEY pinned to '' so the repo .env
// cannot re-supply it, uv fallback), attachSpec (loopback only unless TRIPLEX_ALLOW_REMOTE_BACKEND=1),
// start() refusing a port that already answers, then polling GET /, backend.log, restart ≤3/min
// then give up, stop() SIGTERM → SIGKILL.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_TITLE } from '../../../main/branding.js'
import { buildSpawnSpec, bundledBackendPath, BUNDLED_BACKEND_DIR, BUNDLED_BACKEND_EXE, attachSpec, createBackend, randomToken, isLoopbackHost, DEFAULT_PORT, START_TIMEOUT_MS, START_POLL_MS, RESTART_LIMIT, RESTART_DELAY_MS, RESTART_WINDOW_MS, STOP_GRACE_MS, LOG_FILE } from '../../../main/backend.js'
import { fakeTimers, fakeLog, tick } from './_fakes.js'

const REPO = '/repo'
const USER = '/home/u/.config/triplex-desktop'
const TOKEN = 'a'.repeat(64)

test('buildSpawnSpec: .venv python, cwd = repo, the §6 env, OPENROUTER_API_KEY pinned to \'\' (never the parent value), no MOCK_* / parent SLOT_* leaks', () => {
  const parent = { PATH: '/usr/bin', HOME: '/home/u', OPENROUTER_API_KEY: 'sk-secret', MOCK_OPENROUTER: '1', MOCK_SCENARIO: 'planted_factual', SLOT_CLAUDE_MODEL: 'openai/x', ANALYST_MODEL: 'openai/y', LOG_LEVEL: 'DEBUG', OLLAMA_BASE_URL: 'http://x', PORT: '8001', DATA_DIR: './data' }
  const spec = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, settings: { analyst: 'chatgpt' }, env: parent, home: '/home/u', exists: (p) => p === path.join(REPO, '.venv', 'bin', 'python') })
  assert.equal(spec.command, '/repo/.venv/bin/python')
  assert.deepEqual(spec.args, ['-m', 'backend.main'])
  assert.equal(spec.cwd, REPO)
  assert.equal(spec.via, 'venv')
  assert.equal(spec.available, true)
  assert.equal(spec.port, DEFAULT_PORT)
  assert.equal(spec.url, 'http://127.0.0.1:8021')
  const e = spec.env
  assert.equal(e.PORT, '8021')
  assert.equal(e.HOST, '127.0.0.1')
  assert.equal(e.DATA_DIR, path.join(USER, 'data'))
  assert.equal(e.TRIPLEX_DESKTOP, '1')
  assert.equal(e.BRIDGE_TOKEN, TOKEN)
  assert.equal(e.MOCK_OPENROUTER, '0')
  assert.equal(e.SLOT_CLAUDE_MODEL, 'web:claude')
  assert.equal(e.SLOT_CHATGPT_MODEL, 'web:chatgpt')
  assert.equal(e.SLOT_GROK_MODEL, 'web:grok')
  assert.equal(e.SLOT_CLAUDE_EFFORT, 'off')
  assert.equal(e.SLOT_CHATGPT_EFFORT, 'off')
  assert.equal(e.SLOT_GROK_EFFORT, 'off')
  assert.equal(e.ANALYST_MODEL, 'web:chatgpt:analyst')
  assert.equal(e.TRIPLEX_APP_DIR, path.join(REPO, 'frontend', 'dist'))
  assert.equal(e.LOG_LEVEL, 'DEBUG', 'the parent LOG_LEVEL is honoured')
  assert.equal(Object.hasOwn(e, 'OPENROUTER_API_KEY'), true, 'present …')
  assert.equal(e.OPENROUTER_API_KEY, '', '… and empty: python-dotenv (override=False) leaves a set variable alone, so the repo .env cannot re-supply the key')
  assert.equal('MOCK_SCENARIO' in e, false)
  assert.equal('OLLAMA_BASE_URL' in e, false, 'OLLAMA_* only under TRIPLEX_OLLAMA=1')
  assert.equal(e.PATH, '/usr/bin')
  assert.equal(e.HOME, '/home/u')
  assert.ok(Object.values(e).every((v) => typeof v === 'string'))
})

test('buildSpawnSpec: ANALYST_MODEL pinned to \'\' when settings.analyst is null (or settings absent) so a .env slug never becomes the analyst; settings objects with getAnalyst work; TRIPLEX_OLLAMA=1 passes OLLAMA_*; TRIPLEX_DATA_DIR overrides', () => {
  const exists = () => true
  const nul = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, settings: { analyst: null }, env: { ANALYST_MODEL: 'openai/from-parent' }, exists })
  assert.equal(nul.env.ANALYST_MODEL, '', 'present and empty (dotenv cannot fill it; the backend reads it as "no analyst")')
  assert.equal(buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: {}, exists }).env.ANALYST_MODEL, '')
  const viaGetter = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, settings: { getAnalyst: () => 'grok' }, env: {}, exists })
  assert.equal(viaGetter.env.ANALYST_MODEL, 'web:grok:analyst')
  const bogus = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, settings: { analyst: 'gemini' }, env: {}, exists })
  assert.equal(bogus.env.ANALYST_MODEL, '')
  assert.equal(bogus.env.OPENROUTER_API_KEY, '', 'pinned empty even when the parent had no key')
  const ollama = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: { TRIPLEX_OLLAMA: '1', OLLAMA_BASE_URL: 'http://x', OLLAMA_MODELS: 'hermes3' }, exists })
  assert.equal(ollama.env.OLLAMA_BASE_URL, 'http://x')
  assert.equal(ollama.env.OLLAMA_MODELS, 'hermes3')
  const data = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: { TRIPLEX_DATA_DIR: '/elsewhere' }, exists })
  assert.equal(data.env.DATA_DIR, '/elsewhere')
  const explicit = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: {}, exists, dataDir: '/d', appDir: '/a', logLevel: 'WARNING', port: 9000 })
  assert.equal(explicit.env.DATA_DIR, '/d')
  assert.equal(explicit.env.TRIPLEX_APP_DIR, '/a')
  assert.equal(explicit.env.LOG_LEVEL, 'WARNING')
  assert.equal(explicit.env.PORT, '9000')
  assert.equal(explicit.url, 'http://127.0.0.1:9000')
  assert.equal(buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: {}, exists }).env.LOG_LEVEL, 'INFO')
})

test('buildSpawnSpec: uv fallback via ~/.local/bin/uv when .venv is missing; availability reported; validation', () => {
  const spec = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: {}, home: '/home/u', exists: (p) => p === '/home/u/.local/bin/uv' })
  assert.equal(spec.command, '/home/u/.local/bin/uv')
  assert.deepEqual(spec.args, ['run', 'python', '-m', 'backend.main'])
  assert.equal(spec.cwd, REPO)
  assert.equal(spec.via, 'uv')
  assert.equal(spec.available, true)
  const none = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: {}, home: '/home/u', exists: () => false })
  assert.equal(none.via, 'uv')
  assert.equal(none.available, false)
  const custom = buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, env: { TRIPLEX_UV_BIN: '/opt/uv' }, exists: (p) => p === '/opt/uv' })
  assert.equal(custom.command, '/opt/uv')
  assert.throws(() => buildSpawnSpec({ userData: USER, token: TOKEN }), /repoDir/)
  assert.throws(() => buildSpawnSpec({ repoDir: REPO, token: TOKEN }), /userData/)
  assert.throws(() => buildSpawnSpec({ repoDir: REPO, userData: USER, token: '' }), /token/)
  assert.throws(() => buildSpawnSpec({ repoDir: REPO, userData: USER, token: TOKEN, port: 'x' }), /port/)
})

test('randomToken is 64 hex chars and never repeats; attachSpec reads TRIPLEX_BACKEND_URL + BRIDGE_TOKEN', () => {
  const a = randomToken()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, randomToken())
  assert.equal(attachSpec({}), null)
  assert.equal(attachSpec({ TRIPLEX_BACKEND_URL: '  ' }), null)
  assert.deepEqual(attachSpec({ TRIPLEX_BACKEND_URL: 'http://127.0.0.1:8021/', BRIDGE_TOKEN: 'e2e' }), { url: 'http://127.0.0.1:8021', port: 8021, token: 'e2e', attached: true })
  const log = fakeLog()
  const noToken = attachSpec({ TRIPLEX_BACKEND_URL: 'https://localhost' }, { log })
  assert.equal(noToken.port, 443)
  assert.match(noToken.token, /^[0-9a-f]{64}$/)
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('random token')))
  assert.throws(() => attachSpec({ TRIPLEX_BACKEND_URL: 'not a url' }), /not a URL/)
})

test('attachSpec refuses a TRIPLEX_BACKEND_URL whose host is not loopback unless TRIPLEX_ALLOW_REMOTE_BACKEND=1, which warns loudly', () => {
  for (const url of ['http://10.0.0.5:8021', 'https://backend.example.com', 'http://127.0.0.1.evil.example:8021', 'ws://10.0.0.5:8021']) {
    assert.throws(() => attachSpec({ TRIPLEX_BACKEND_URL: url, BRIDGE_TOKEN: 't' }, { log: fakeLog() }), /non-loopback host .*TRIPLEX_ALLOW_REMOTE_BACKEND=1/, url)
  }
  assert.throws(() => attachSpec({ TRIPLEX_BACKEND_URL: 'http://10.0.0.5:8021', BRIDGE_TOKEN: 't', TRIPLEX_ALLOW_REMOTE_BACKEND: 'yes' }, { log: fakeLog() }), /non-loopback/, 'only the exact value 1 overrides')
  for (const url of ['http://127.0.0.1:8021', 'http://localhost:8021', 'http://[::1]:8021', 'http://LOCALHOST:8021']) {
    const log = fakeLog()
    assert.equal(attachSpec({ TRIPLEX_BACKEND_URL: url, BRIDGE_TOKEN: 't' }, { log }).attached, true, url)
    assert.equal(log.lines.length, 0, `${url}: loopback needs no warning`)
  }
  const log = fakeLog()
  const remote = attachSpec({ TRIPLEX_BACKEND_URL: 'http://10.0.0.5:8021', BRIDGE_TOKEN: 'secret-token', TRIPLEX_ALLOW_REMOTE_BACKEND: '1' }, { log })
  assert.deepEqual(remote, { url: 'http://10.0.0.5:8021', port: 8021, token: 'secret-token', attached: true })
  const warning = log.lines.find(([lvl, m]) => lvl === 'warn' && m.includes('REMOTE backend host 10.0.0.5'))
  assert.ok(warning, JSON.stringify(log.lines))
  assert.match(warning[1], /cleartext http/)
  assert.ok(log.lines.every(([, m]) => !m.includes('secret-token')), 'the token is never logged')
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost('localhost.'), true)
  assert.equal(isLoopbackHost('10.0.0.5'), false)
  assert.equal(isLoopbackHost(undefined), false)
})

// --- createBackend --------------------------------------------------------------------------------

function fakeChild(pid) {
  const c = new EventEmitter()
  c.pid = pid
  c.stdout = new PassThrough()
  c.stderr = new PassThrough()
  c.signals = []
  c.kill = (sig) => {
    c.signals.push(sig)
    return true
  }
  return c
}

/**
 * `okAfter` = how many probes AFTER the spawn are refused before GET / answers; the probe that
 * start() sends BEFORE spawning is refused unless `portBusy` (a foreign server on the port).
 */
function harness({ okAfter = 2, logDir, portBusy = false } = {}) {
  const timers = fakeTimers()
  const children = []
  const spawns = []
  let probes = 0
  let postProbes = 0
  const spec = { command: '/repo/.venv/bin/python', args: ['-m', 'backend.main'], cwd: '/repo', env: { PORT: '8021' }, port: 8021, url: 'http://127.0.0.1:8021', via: 'venv', available: true }
  const log = fakeLog()
  const states = []
  const backend = createBackend({
    spec,
    logDir,
    spawn: (command, args, opts) => {
      spawns.push({ command, args, opts })
      const c = fakeChild(1000 + children.length)
      children.push(c)
      return c
    },
    fetch: async (url) => {
      probes += 1
      if (spawns.length === 0) {
        if (portBusy) return { ok: true, url }
        throw new Error('ECONNREFUSED')
      }
      postProbes += 1
      if (postProbes <= okAfter) throw new Error('ECONNREFUSED')
      return { ok: true, url }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    log,
    onState: (s) => states.push(s),
  })
  return { backend, timers, children, spawns, log, states, probes: () => probes, last: () => children[children.length - 1] }
}

/** Let the async start() loop run: settle microtasks, then advance one poll tick, repeatedly. */
async function pump(timers, ticks) {
  for (let i = 0; i < ticks; i++) {
    for (let j = 0; j < 4; j++) await tick()
    timers.advance(START_POLL_MS)
  }
  for (let j = 0; j < 4; j++) await tick()
}

test('start() spawns with the spec (piped stdio), polls GET / until it answers, resolves {port, url, pid}; stdout/stderr land in backend.log', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-backend-log-'))
  const { backend, timers, spawns, last, probes, states } = harness({ okAfter: 2, logDir })
  const started = backend.start()
  await pump(timers, 3)
  const info = await started
  assert.deepEqual(info, { port: 8021, url: 'http://127.0.0.1:8021', pid: 1000 })
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0], { command: '/repo/.venv/bin/python', args: ['-m', 'backend.main'], opts: { cwd: '/repo', env: { PORT: '8021' }, stdio: ['ignore', 'pipe', 'pipe'] } })
  assert.equal(probes(), 4, 'the pre-spawn probe (refused: the port is free), two refusals, then ok')
  assert.deepEqual(backend.info(), { port: 8021, url: 'http://127.0.0.1:8021' })
  assert.equal(backend.status().ready, true)
  assert.equal(backend.status().running, true)
  assert.deepEqual(states.at(-1), { running: true, ready: true, restarts: 0, gaveUp: false })
  last().stdout.write('INFO uvicorn running\n')
  last().stderr.write('WARNING something\n')
  // the pipe → write stream → disk path is asynchronous: poll the file (real clock) instead of reading once
  const logFile = path.join(logDir, LOG_FILE)
  const waitForLog = async (re) => {
    for (let i = 0; i < 200; i++) {
      let text = ''
      try {
        text = fs.readFileSync(logFile, 'utf8')
      } catch (_e) {
        text = ''
      }
      if (re.test(text)) return text
      await new Promise((r) => globalThis.setTimeout(r, 10))
    }
    throw new Error(`${logFile} never matched ${re}`)
  }
  const logText = await waitForLog(/WARNING something/)
  assert.match(logText, /starting venv: \/repo\/\.venv\/bin\/python -m backend\.main/)
  assert.match(logText, /INFO uvicorn running/)
  const stopped = backend.stop()
  assert.deepEqual(last().signals, ['SIGTERM'])
  last().emit('exit', 0, null)
  await stopped
  assert.equal(backend.status().running, false)
  await waitForLog(/backend exited \(0\)/)
})

test('start() refuses to spawn onto a port that already answers GET / (code port_in_use, nothing spawned, the log names the attach knob)', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-backend-busy-'))
  const { backend, spawns, log, states, probes } = harness({ okAfter: 0, portBusy: true, logDir })
  await assert.rejects(backend.start(), (e) => e.code === 'port_in_use' && /already answers: another server owns port 8021/.test(e.message) && /TRIPLEX_BACKEND_URL=http:\/\/127\.0\.0\.1:8021/.test(e.message))
  assert.equal(spawns.length, 0, 'never spawned')
  assert.equal(probes(), 1)
  assert.equal(backend.status().running, false)
  assert.equal(backend.status().ready, false)
  assert.deepEqual(states, [], 'no state change: nothing was started')
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && m.includes('already answers')), JSON.stringify(log.lines))
  await backend.stop() // ends the log stream → backend.log is complete on disk
  assert.match(fs.readFileSync(path.join(logDir, LOG_FILE), 'utf8'), /refusing to spawn: http:\/\/127\.0\.0\.1:8021\/ already answers/)
})

test('start() rejects when GET / never answers within 45 s (the child is stopped) or when the child exits first', async () => {
  const { backend, timers, last } = harness({ okAfter: Infinity })
  const started = backend.start()
  const rejected = started.then(
    () => 'resolved',
    (e) => e.message,
  )
  await pump(timers, Math.ceil(START_TIMEOUT_MS / START_POLL_MS) + 1)
  // the failed start stops the child: SIGTERM, then the child exits
  await tick()
  assert.deepEqual(last().signals, ['SIGTERM'])
  last().emit('exit', null, 'SIGTERM')
  assert.match(await rejected, /did not answer GET http:\/\/127\.0\.0\.1:8021\/ within 45 s/)
  assert.equal(backend.status().running, false)

  const early = harness({ okAfter: Infinity })
  const p = early.backend.start().then(
    () => 'resolved',
    (e) => e.message,
  )
  await tick()
  early.last().emit('exit', 3, null)
  await pump(early.timers, 2)
  assert.match(await p, /exited before it answered \(3\)/)
})

test('an unexpected exit restarts the backend after 1 s, at most 3 times per minute, then gives up; the bridge state reports it', async () => {
  const { backend, timers, children, log, states } = harness({ okAfter: 0 })
  const started = backend.start()
  await pump(timers, 1)
  await started
  for (let i = 1; i <= RESTART_LIMIT; i++) {
    children[children.length - 1].emit('exit', 1, null)
    assert.equal(backend.status().running, false)
    assert.equal(backend.status().restarts, i)
    timers.advance(RESTART_DELAY_MS)
    assert.equal(children.length, i + 1, `restart ${i} spawned a new child`)
    await pump(timers, 1)
    assert.equal(backend.status().ready, true, `restart ${i} became ready`)
  }
  children[children.length - 1].emit('exit', 1, null)
  timers.advance(RESTART_DELAY_MS * 2)
  assert.equal(children.length, RESTART_LIMIT + 1, 'the fourth crash within a minute is not restarted')
  assert.equal(backend.status().gaveUp, true)
  assert.deepEqual(states.at(-1), { running: false, ready: false, restarts: RESTART_LIMIT, gaveUp: true })
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && m.includes('not restarting')))

  // outside the window the counter slides
  const fresh = harness({ okAfter: 0 })
  const s2 = fresh.backend.start()
  await pump(fresh.timers, 1)
  await s2
  for (let i = 0; i < RESTART_LIMIT + 2; i++) {
    fresh.children[fresh.children.length - 1].emit('exit', 1, null)
    fresh.timers.advance(RESTART_DELAY_MS)
    await pump(fresh.timers, 1)
    fresh.timers.advance(RESTART_WINDOW_MS)
  }
  assert.equal(fresh.backend.status().gaveUp, false, 'one crash per minute never gives up')
  assert.equal(fresh.children.length, RESTART_LIMIT + 3)
})

test('stop(): SIGTERM, then SIGKILL after the grace period when the process ignores it; stop() without a child resolves', async () => {
  const { backend, timers, last } = harness({ okAfter: 0 })
  const started = backend.start()
  await pump(timers, 1)
  await started
  const stopped = backend.stop()
  assert.deepEqual(last().signals, ['SIGTERM'])
  timers.advance(STOP_GRACE_MS)
  assert.deepEqual(last().signals, ['SIGTERM', 'SIGKILL'])
  last().emit('exit', null, 'SIGKILL')
  await stopped
  assert.equal(backend.status().running, false)
  assert.equal(backend.status().exitCode, 'signal SIGKILL')
  await backend.stop()
  // a stop is not a crash: no restart is scheduled
  timers.advance(RESTART_DELAY_MS * 2)
  assert.equal(backend.status().restarts, 0)
})

test('once() is available for the fake child (sanity for the harness)', async () => {
  const c = fakeChild(1)
  setImmediate(() => c.emit('exit', 0, null))
  assert.deepEqual(await once(c, 'exit'), [0, null])
})

// ---------------------------------------------------------------------------------------------
// The bundled backend: an INSTALLED app carries its own interpreter (PyInstaller, shipped as an
// Electron extraResource), so the machine it runs on needs no Python, no uv and no checkout.
// ---------------------------------------------------------------------------------------------

const RESOURCES = '/opt/solomons-judgment/resources'

/** The arguments every spec needs, so each test below states only what it is about. */
const base = () => ({ repoDir: REPO, userData: USER, token: TOKEN, settings: { analyst: 'chatgpt' }, env: {}, home: '/home/u' })

test('an installed app runs its own bundled backend, ahead of any venv on the machine', () => {
  const spec = buildSpawnSpec({
    ...base(),
    resourcesDir: RESOURCES,
    platform: 'linux',
    exists: () => true, // a venv exists too; the bundle still wins
  })
  assert.equal(spec.via, 'bundled')
  assert.equal(spec.command, `${RESOURCES}/backend/triplex-backend`)
  assert.deepEqual(spec.args, [], 'the frozen binary IS the entry point; there is no module to run')
  assert.equal(spec.available, true)
  // Same environment either way: the backend does not know or care how it was started.
  assert.equal(spec.env.TRIPLEX_DESKTOP, '1')
  assert.equal(spec.env.OPENROUTER_API_KEY, '')
  assert.equal(spec.env.APP_TITLE, APP_TITLE)
})

test('on Windows it is the .exe, and the venv fallback is Scripts/python.exe', () => {
  const bundled = buildSpawnSpec({ ...base(), resourcesDir: 'C:\\app\\resources', platform: 'win32', exists: () => true })
  assert.equal(bundled.command, path.join('C:\\app\\resources', 'backend', 'triplex-backend.exe'))

  const fromRepo = buildSpawnSpec({
    ...base(),
    platform: 'win32',
    exists: (p) => p.includes('Scripts'),
  })
  assert.equal(fromRepo.via, 'venv')
  assert.match(fromRepo.command, /Scripts[\\/]python\.exe$/)
})

test('no resources directory (a checkout) falls through to the venv, then to uv', () => {
  const venv = buildSpawnSpec({ ...base(), resourcesDir: null, exists: (p) => p.endsWith('/.venv/bin/python') })
  assert.equal(venv.via, 'venv')

  const uv = buildSpawnSpec({ ...base(), resourcesDir: null, exists: () => false })
  assert.equal(uv.via, 'uv')
  assert.equal(uv.available, false, 'and it says so when uv is not there either')
})

test('a resources directory with no backend in it is not mistaken for a bundle', () => {
  const spec = buildSpawnSpec({
    ...base(),
    resourcesDir: RESOURCES,
    platform: 'linux',
    exists: (p) => !p.startsWith(RESOURCES) && p.endsWith('/.venv/bin/python'),
  })
  assert.equal(spec.via, 'venv')
})

test('bundledBackendPath: null without a resources directory, platform-correct with one', () => {
  assert.equal(bundledBackendPath(null), null)
  assert.equal(bundledBackendPath(''), null)
  assert.equal(bundledBackendPath(undefined), null)
  assert.equal(bundledBackendPath('/r', 'linux'), path.join('/r', BUNDLED_BACKEND_DIR, BUNDLED_BACKEND_EXE))
  assert.equal(bundledBackendPath('/r', 'darwin'), path.join('/r', BUNDLED_BACKEND_DIR, BUNDLED_BACKEND_EXE))
  assert.equal(bundledBackendPath('/r', 'win32'), path.join('/r', BUNDLED_BACKEND_DIR, `${BUNDLED_BACKEND_EXE}.exe`))
})
