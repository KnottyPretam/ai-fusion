// desktop/main/backend.js — the Triplex backend the desktop talks to (contract §6; decision 18).
//
//   buildSpawnSpec(opts)  pure: `<repo>/.venv/bin/python -m backend.main` with cwd=<repo> (or the
//                         `~/.local/bin/uv run python -m backend.main` fallback when the venv is
//                         missing) and the env of §6: PORT=8021 HOST=127.0.0.1 DATA_DIR=<userData>/data
//                         TRIPLEX_DESKTOP=1 BRIDGE_TOKEN=<random> MOCK_OPENROUTER=0 SLOT_*_MODEL=web:*
//                         SLOT_*_EFFORT=off ANALYST_MODEL=web:<settings.analyst>:analyst ('' when
//                         null) TRIPLEX_APP_DIR=<repo>/frontend/dist LOG_LEVEL (+ OLLAMA_* only under
//                         TRIPLEX_OLLAMA=1). OPENROUTER_API_KEY, every MOCK_* and every SLOT_* /
//                         ANALYST_MODEL of the parent environment are dropped, and OPENROUTER_API_KEY
//                         (plus ANALYST_MODEL when no analyst is chosen) is PINNED to '' rather than
//                         omitted: python-dotenv only fills variables that are absent, so the repo
//                         `.env` can never re-supply them — a desktop backend never routes a live
//                         OpenRouter call with the user's key ('' reads as "no key" / "no analyst").
//   attachSpec(env)       `TRIPLEX_BACKEND_URL` → {url, port, token: BRIDGE_TOKEN} (nothing spawned);
//                         a non-loopback host is refused (the token, every prompt and every captured
//                         reply would leave the machine) unless TRIPLEX_ALLOW_REMOTE_BACKEND=1, which
//                         warns loudly. main.js turns the refusal into a config error (exit 2).
//   createBackend(deps)   start() first probes `GET /`: a port that already answers belongs to
//                         another server (an orphaned backend, a dev server) and is refused with
//                         `code: 'port_in_use'` — spawning onto it would "succeed" on the foreign
//                         process, fail the hello 4003 and loop the real child through bind errors.
//                         Then it spawns and polls `GET /` every START_POLL_MS up to START_TIMEOUT_MS;
//                         stdout/stderr → <userData>/logs/backend.log; an unexpected exit restarts
//                         the process at most RESTART_LIMIT times per RESTART_WINDOW_MS, then gives
//                         up; stop() sends SIGTERM (SIGKILL after STOP_GRACE_MS). The bridge client
//                         reconnects on its own once the new process answers.
//   randomToken()         crypto.randomBytes(32).toString('hex') — the per-launch bridge token.
// Pure module apart from node built-ins; `spawn`, `fetch`, `fs`, the clock and the timers are
// injected so node --test drives it without a Python process.

import { randomBytes } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SLOTS, LOOPBACK_HOSTS } from './sites.js'
import { APP_TITLE } from './branding.js'

export const DEFAULT_PORT = 8021
export const START_TIMEOUT_MS = 45000
export const START_POLL_MS = 250
export const RESTART_WINDOW_MS = 60000
export const RESTART_LIMIT = 3
export const RESTART_DELAY_MS = 1000
export const STOP_GRACE_MS = 5000
export const LOG_FILE = 'backend.log'
/** Parent-environment keys never handed to the spawned backend (§6: never OPENROUTER_API_KEY). */
export const ENV_DENYLIST = Object.freeze(['OPENROUTER_API_KEY', 'PORT', 'BACKEND_PORT', 'HOST', 'DATA_DIR', 'TRIPLEX_DESKTOP', 'BRIDGE_TOKEN', 'ANALYST_MODEL', 'TRIPLEX_APP_DIR', 'LOG_LEVEL', 'APP_TITLE'])
export const ENV_DENY_PREFIXES = Object.freeze(['MOCK_', 'SLOT_'])
/** Keys pinned to '' in the spawn env so the repo `.env` (dotenv, override=False) cannot fill them in. */
export const ENV_PINNED_EMPTY = Object.freeze(['OPENROUTER_API_KEY'])
/** The env var that lets TRIPLEX_BACKEND_URL name a host other than loopback. */
export const ALLOW_REMOTE_BACKEND_VAR = 'TRIPLEX_ALLOW_REMOTE_BACKEND'

export function randomToken() {
  return randomBytes(32).toString('hex')
}

function analystOf(settings) {
  if (!settings) return null
  const v = typeof settings.getAnalyst === 'function' ? settings.getAnalyst() : settings.analyst
  return SLOTS.includes(v) ? v : null
}

/**
 * buildSpawnSpec({repoDir, userData, port, token, settings, env, home, exists, dataDir, appDir, logLevel})
 *   → {command, args, cwd, env, port, url, via: 'venv'|'uv', available}
 */
export function buildSpawnSpec({ repoDir, userData, port = DEFAULT_PORT, token, settings = null, env = process.env, home = os.homedir(), exists = nodeFs.existsSync, dataDir = null, appDir = null, logLevel = null } = {}) {
  if (typeof repoDir !== 'string' || repoDir === '') throw new Error('buildSpawnSpec: repoDir is required')
  if (typeof userData !== 'string' || userData === '') throw new Error('buildSpawnSpec: userData is required')
  if (typeof token !== 'string' || token === '') throw new Error('buildSpawnSpec: token is required')
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum <= 0) throw new Error('buildSpawnSpec: port must be a positive integer')

  const venvPython = path.join(repoDir, '.venv', 'bin', 'python')
  const uv = (env && env.TRIPLEX_UV_BIN) || path.join(home, '.local', 'bin', 'uv')
  let command
  let args
  let via
  let available
  if (exists(venvPython)) {
    command = venvPython
    args = ['-m', 'backend.main']
    via = 'venv'
    available = true
  } else {
    command = uv
    args = ['run', 'python', '-m', 'backend.main']
    via = 'uv'
    available = !!exists(uv)
  }

  const out = {}
  const ollama = !!(env && env.TRIPLEX_OLLAMA === '1')
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) continue
    if (ENV_DENYLIST.includes(k)) continue
    if (ENV_DENY_PREFIXES.some((p) => k.startsWith(p))) continue
    if (k.startsWith('OLLAMA_') && !ollama) continue
    out[k] = String(v)
  }
  out.PORT = String(portNum)
  out.HOST = '127.0.0.1'
  out.DATA_DIR = dataDir || (env && env.TRIPLEX_DATA_DIR) || path.join(userData, 'data')
  out.TRIPLEX_DESKTOP = '1'
  // The product name the backend stamps on an exported document ("<app title> Send — <title>").
  // Pinned here, not left to .env, so the app and its exports always agree.
  out.APP_TITLE = APP_TITLE
  out.BRIDGE_TOKEN = token
  out.MOCK_OPENROUTER = '0'
  out.SLOT_CLAUDE_MODEL = 'web:claude'
  out.SLOT_CHATGPT_MODEL = 'web:chatgpt'
  out.SLOT_GROK_MODEL = 'web:grok'
  out.SLOT_CLAUDE_EFFORT = 'off'
  out.SLOT_CHATGPT_EFFORT = 'off'
  out.SLOT_GROK_EFFORT = 'off'
  const analyst = analystOf(settings)
  out.ANALYST_MODEL = analyst ? `web:${analyst}:analyst` : '' // '' = no analyst chosen; never a .env slug
  for (const k of ENV_PINNED_EMPTY) out[k] = ''
  out.TRIPLEX_APP_DIR = appDir || path.join(repoDir, 'frontend', 'dist')
  out.LOG_LEVEL = logLevel || (env && (env.TRIPLEX_BACKEND_LOG_LEVEL || env.LOG_LEVEL)) || 'INFO'

  return { command, args, cwd: repoDir, env: out, port: portNum, url: `http://127.0.0.1:${portNum}`, via, available }
}

/** True when `hostname` (as `new URL(...).hostname` reports it) is a loopback address. */
export function isLoopbackHost(hostname) {
  return typeof hostname === 'string' && LOOPBACK_HOSTS.includes(hostname.toLowerCase().replace(/\.$/, ''))
}

/**
 * `TRIPLEX_BACKEND_URL` set → attach spec `{url, port, token, attached: true}`; unset/blank → null.
 * A URL whose host is not loopback throws unless `TRIPLEX_ALLOW_REMOTE_BACKEND=1` (then a loud
 * warning): the bridge token, every prompt and every captured reply would travel to that host.
 */
export function attachSpec(env = process.env, { log = console } = {}) {
  const raw = env && env.TRIPLEX_BACKEND_URL
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let u
  try {
    u = new URL(raw.trim())
  } catch (e) {
    throw new Error(`TRIPLEX_BACKEND_URL is not a URL: ${e.message}`)
  }
  if (!isLoopbackHost(u.hostname)) {
    if (env[ALLOW_REMOTE_BACKEND_VAR] !== '1') {
      throw new Error(`TRIPLEX_BACKEND_URL names the non-loopback host ${u.hostname}; the desktop attaches only to a backend on this machine (127.0.0.1 / localhost). Set ${ALLOW_REMOTE_BACKEND_VAR}=1 to override — the bridge token, every prompt and every captured reply then leave this machine`)
    }
    if (log && typeof log.warn === 'function') log.warn(`[backend] WARNING: ${ALLOW_REMOTE_BACKEND_VAR}=1 — attaching to the REMOTE backend host ${u.hostname}${u.protocol === 'http:' ? ' over cleartext http' : ''}: the bridge token, every prompt and every captured reply leave this machine, and that host can drive the three signed-in site views`)
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  let token = typeof env.BRIDGE_TOKEN === 'string' ? env.BRIDGE_TOKEN : ''
  if (token === '') {
    token = randomToken()
    if (log && typeof log.warn === 'function') log.warn('[backend] TRIPLEX_BACKEND_URL without BRIDGE_TOKEN: using a random token (accepted only by a backend started without BRIDGE_TOKEN)')
  }
  return { url: `${u.protocol}//${u.host}`, port, token, attached: true }
}

const sleep = (setT, ms) => new Promise((r) => setT(r, ms))

/**
 * createBackend({spec, logDir, spawn, fetch, fs, setTimeout, clearTimeout, now, log, onState}) → backend
 *   start() → Promise<{port, url, pid}>   rejects when the process dies or never answers within START_TIMEOUT_MS
 *   stop()  → Promise<void>               SIGTERM, then SIGKILL after STOP_GRACE_MS
 *   status() → {running, ready, pid, port, url, via, restarts, gaveUp, exitCode}
 *   info()   → {port, url}                 for panes:getInfo
 *   onState({running, ready, restarts, gaveUp}) on every change
 */
export function createBackend({
  spec,
  logDir,
  spawn = nodeSpawn,
  fetch = globalThis.fetch,
  fs = nodeFs,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  now = Date.now,
  log = console,
  onState = null,
} = {}) {
  if (!spec || typeof spec.command !== 'string') throw new Error('createBackend: spec is required')
  const warn = (m) => log && typeof log.warn === 'function' && log.warn(`[backend] ${m}`)
  const error = (m) => log && typeof log.error === 'function' && log.error(`[backend] ${m}`)
  const info = (m) => log && typeof log.log === 'function' && log.log(`[backend] ${m}`)

  let child = null
  let ready = false
  let stopping = false
  let gaveUp = false
  let exitCode = null
  let logStream = null
  const restarts = []

  const emit = () => {
    if (typeof onState !== 'function') return
    try {
      onState({ running: !!child, ready, restarts: restarts.length, gaveUp })
    } catch (e) {
      warn(`onState failed: ${(e && e.message) || e}`)
    }
  }

  function openLog() {
    if (logStream || !logDir) return
    try {
      fs.mkdirSync(logDir, { recursive: true })
      logStream = fs.createWriteStream(path.join(logDir, LOG_FILE), { flags: 'a' })
      logStream.on('error', (e) => warn(`log stream: ${(e && e.message) || e}`))
    } catch (e) {
      warn(`cannot open ${path.join(logDir, LOG_FILE)}: ${(e && e.message) || e}`)
      logStream = null
    }
  }

  function spawnChild() {
    openLog()
    const stamp = new Date(now()).toISOString()
    if (logStream) logStream.write(`\n[triplex-desktop ${stamp}] starting ${spec.via || 'backend'}: ${spec.command} ${spec.args.join(' ')} (cwd ${spec.cwd})\n`)
    const proc = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child = proc
    ready = false
    exitCode = null
    if (proc.stdout && logStream) proc.stdout.pipe(logStream, { end: false })
    if (proc.stderr && logStream) proc.stderr.pipe(logStream, { end: false })
    proc.on('error', (e) => {
      error(`spawn failed: ${(e && e.message) || e}`)
      if (logStream) logStream.write(`[triplex-desktop] spawn failed: ${(e && e.message) || e}\n`)
    })
    proc.on('exit', (code, signal) => {
      if (child !== proc) return
      child = null
      ready = false
      exitCode = code === null ? `signal ${signal}` : code
      if (logStream) logStream.write(`[triplex-desktop] backend exited (${exitCode})\n`)
      if (stopping) {
        emit()
        return
      }
      const t = now()
      while (restarts.length && t - restarts[0] >= RESTART_WINDOW_MS) restarts.shift()
      if (restarts.length >= RESTART_LIMIT) {
        gaveUp = true
        error(`exited (${exitCode}) ${restarts.length} times within ${RESTART_WINDOW_MS / 1000} s; not restarting (see ${logDir ? path.join(logDir, LOG_FILE) : 'the log'})`)
        emit()
        return
      }
      restarts.push(t)
      warn(`exited (${exitCode}); restarting in ${RESTART_DELAY_MS} ms (${restarts.length}/${RESTART_LIMIT} per minute)`)
      emit()
      setT(() => {
        if (stopping || child) return
        try {
          spawnChild()
          waitReady().catch((e) => warn(`restart: ${(e && e.message) || e}`))
        } catch (e) {
          error(`restart failed: ${(e && e.message) || e}`)
        }
      }, RESTART_DELAY_MS)
    })
    info(`spawned pid ${proc.pid} via ${spec.via || 'command'} on ${spec.url}`)
    emit()
    return proc
  }

  async function probe() {
    try {
      const res = await fetch(`${spec.url}/`)
      return !!(res && res.ok)
    } catch (_e) {
      return false
    }
  }

  async function waitReady() {
    const proc = child
    const deadline = now() + START_TIMEOUT_MS
    while (now() < deadline) {
      if (child !== proc) throw new Error(`backend exited before it answered (${exitCode})`)
      if (await probe()) {
        ready = true
        info(`ready on ${spec.url}`)
        emit()
        return { port: spec.port, url: spec.url, pid: proc && proc.pid }
      }
      await sleep(setT, START_POLL_MS)
    }
    throw new Error(`backend did not answer GET ${spec.url}/ within ${START_TIMEOUT_MS / 1000} s`)
  }

  async function start() {
    if (child) return waitReady()
    stopping = false
    gaveUp = false
    if (await probe()) {
      // Someone already answers on our port: an orphaned backend from an earlier session, a dev
      // server on 8021, … Spawning would only look successful (the poll hits the foreign process).
      const err = new Error(`${spec.url}/ already answers: another server owns port ${spec.port}. Stop it, or set TRIPLEX_BACKEND_URL=${spec.url} (with its BRIDGE_TOKEN) to attach to it`)
      err.code = 'port_in_use'
      error(err.message)
      if (logStream || logDir) {
        openLog()
        if (logStream) logStream.write(`[triplex-desktop ${new Date(now()).toISOString()}] refusing to spawn: ${err.message}\n`)
      }
      throw err
    }
    if (spec.available === false) warn(`${spec.command} not found; the spawn will fail (create .venv with \`uv sync --frozen\`)`)
    spawnChild()
    try {
      return await waitReady()
    } catch (e) {
      if (child) {
        warn(`${(e && e.message) || e}; stopping it`)
        await stop()
      }
      throw e
    }
  }

  /** End the log stream and resolve once it has flushed (so backend.log is complete when stop() returns). */
  function closeLog() {
    return new Promise((resolve) => {
      if (!logStream) {
        resolve()
        return
      }
      const s = logStream
      logStream = null
      try {
        s.end(() => resolve())
      } catch (_e) {
        resolve()
      }
    })
  }

  function stop() {
    stopping = true
    const proc = child
    if (!proc) return closeLog()
    return new Promise((resolve) => {
      let timer = null
      const done = () => {
        if (timer !== null) clearT(timer)
        closeLog().then(resolve, resolve)
      }
      proc.once('exit', done)
      timer = setT(() => {
        warn(`no exit ${STOP_GRACE_MS} ms after SIGTERM; sending SIGKILL`)
        try {
          proc.kill('SIGKILL')
        } catch (_e) {
          /* already gone */
        }
      }, STOP_GRACE_MS)
      try {
        proc.kill('SIGTERM')
      } catch (e) {
        warn(`SIGTERM failed: ${(e && e.message) || e}`)
        done()
      }
    })
  }

  return {
    start,
    stop,
    status: () => ({ running: !!child, ready, pid: child ? child.pid : null, port: spec.port, url: spec.url, via: spec.via || null, restarts: restarts.length, gaveUp, exitCode }),
    info: () => ({ port: spec.port, url: spec.url }),
  }
}
