// orchestrator.js — one bridge request → one site-view turn: reject from the health cache without
// touching the adapter, accepted before any DOM write, navigation rule (decision 12), insert
// phases serialized by the mutex (decision 13), chat-URL recording, capture off → captured:false
// without observe, capture on → observe with baselineCount, cancel aborts the in-flight op,
// failure mapping, budgets, a navigation main started elsewhere holds `ready` until it commits,
// every emitted frame passes protocol.validate().
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrchestrator, createMutex, insertAndSubmitBudgetMs, observeBudgetMs, rejectFromHealth, compileChatUrlPattern, TIMEOUT_GRACE_MS, CHAT_URL_WAIT_MS, NAVIGATION_WAIT_MS, INSERT_SETTLE_MS, STRUCTURED_PURPOSES } from '../../../main/orchestrator.js'
import { INSERT_SETTLE_MS as SELECTORS_INSERT_SETTLE_MS } from '../../../main/selectors.js'
import { AdapterRequestError } from '../../../main/adapter-client.js'
import { validate } from '../../../main/protocol.js'
import { fakeLog, fakeTimers, tick } from './_fakes.js'

const SLOTS = ['claude', 'chatgpt', 'grok']
const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const PATTERN = '^https://x\\.test/c/[a-z0-9]+'

/** A scripted adapter client: every request returns a deferred the test settles by hand; aborts are traced. */
function scriptedClient(slot, trace) {
  const calls = [] // {op, payload, opts, aborted, resolve, reject}
  return {
    slot,
    calls,
    request(op, payload, opts = {}) {
      return new Promise((resolve, reject) => {
        trace.push(`${slot}:${op}:start`)
        const call = {
          op,
          payload,
          opts,
          aborted: false,
          resolve: (v) => {
            trace.push(`${slot}:${op}:end`)
            resolve(v)
          },
          reject: (e) => {
            trace.push(`${slot}:${op}:fail`)
            reject(e)
          },
        }
        if (opts.signal) {
          opts.signal.addEventListener(
            'abort',
            () => {
              call.aborted = true
              trace.push(`${slot}:${op}:abort`)
            },
            { once: true },
          )
        }
        calls.push(call)
      })
    },
    last: () => calls[calls.length - 1],
    ops: () => calls.map((c) => c.op),
  }
}

function okHealth(extra = {}) {
  return { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: '#c', send: 'b', reply: null, stop: null, error: null }, url: 'https://x.test/', host: 'x.test', title: 't', ts: 1, ...extra }
}

/**
 * setup(opts): clients (slots with a live adapter), health {slot: Health}, capture {slot: bool},
 * links {slot: url} for CONV, urls {slot: current url}, pattern, timeouts (undefined → the small
 * test budget; null → the orchestrator's defaults), analyst (an analystAdapterFor fn).
 */
function setup({ clients = SLOTS, health = {}, capture = {}, links = {}, urls = {}, pattern = PATTERN, timeouts, analyst, insertSettleMs, setHealth, pendingNavigation } = {}) {
  const trace = []
  const table = {}
  for (const slot of clients) table[slot] = scriptedClient(slot, trace)
  const timers = fakeTimers()
  const phases = []
  const loads = []
  const navCbs = {}
  const chatsSet = []
  const chatsDoc = { [CONV]: { ...links } }
  const current = { ...urls }
  let restored = 0
  let clock = 1000.4
  const log = fakeLog()
  const orch = createOrchestrator({
    adapterFor: (slot) => table[slot] || null,
    ...(analyst ? { analystAdapterFor: analyst } : {}),
    focusView: (slot) => trace.push(`${slot}:focus`),
    restoreRendererFocus: () => {
      restored += 1
      trace.push('renderer:focus')
    },
    timeoutsFor: () => (timeouts === undefined ? { composerWaitMs: 1000, sendWaitMs: 2000, submitVerifyMs: 500 } : timeouts),
    captureTimeoutsFor: () => (timeouts === undefined ? { quietMs: 250, settleMs: 200, firstTokenMs: 3000, captureTimeoutMs: 4000 } : timeouts),
    chatUrlPatternFor: () => pattern,
    getHealth: (slot) => health[slot] || null,
    setHealth,
    getCapture: () => ({ claude: false, chatgpt: false, grok: false, ...capture }),
    chats: {
      get: (convId, slot) => (chatsDoc[convId] && chatsDoc[convId][slot]) || null,
      set: (convId, slot, url) => {
        chatsSet.push([convId, slot, url])
        chatsDoc[convId] = { ...(chatsDoc[convId] || {}), [slot]: url }
      },
    },
    currentUrl: (slot) => current[slot] || '',
    loadUrl: async (slot, url) => {
      loads.push([slot, url])
      if (url.includes('fail')) throw new Error('ERR_CONNECTION_REFUSED')
      current[slot] = url
    },
    ...(pendingNavigation ? { pendingNavigation } : {}),
    onNavigate: (slot, cb) => {
      navCbs[slot] = cb
      return () => {
        if (navCbs[slot] === cb) delete navCbs[slot]
      }
    },
    newChatUrl: (slot) => `https://x.test/new-${slot}`,
    onTurn: (slot, phase, code) => phases.push(code === undefined ? `${slot}:${phase}` : `${slot}:${phase}:${code}`),
    now: () => {
      clock += 100.3
      return clock
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log,
    ...(insertSettleMs !== undefined ? { insertSettleMs } : {}),
  })
  const emitted = []
  const emit = (frame) => emitted.push(frame)
  const navigate = (slot, url) => {
    current[slot] = url
    if (navCbs[slot]) navCbs[slot](url, { inPage: true })
  }
  return { orch, table, trace, timers, phases, loads, chatsSet, chatsDoc, current, emitted, emit, navigate, restored: () => restored, navCbs, log }
}

const request = (slot, extra = {}) => ({ type: 'request', req_id: `req-${slot}`, model: `web:${slot}`, slot, view: 'pane', fresh: false, text: 'hello `x`', role: slot, purpose: 'chat', conversation_id: CONV, timeout_s: 600, ...extra })

const settleAll = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick()
}

const assertValid = (frame) => {
  const r = validate(frame)
  assert.equal(r.ok, true, `${r.error} — ${JSON.stringify(frame)}`)
  assert.equal(r.direction, 'client')
}

// --- rejections from the health cache ------------------------------------------------------------

test('rejected from the health cache before any adapter call: logged_out / challenge / blocked / view_crashed / stop → view_busy', async () => {
  const cases = [
    [okHealth({ session: 'logged_out' }), 'logged_out'],
    [okHealth({ session: 'challenge' }), 'challenge'],
    [okHealth({ session: 'blocked' }), 'blocked'],
    [okHealth({ matched: { composer: null, send: null, reply: null, stop: null, error: 'view_crashed' } }), 'view_crashed'],
  ]
  for (const [h, code] of cases) {
    const { orch, table, emitted, emit, phases } = setup({ health: { chatgpt: h } })
    const final = await orch.run(request('chatgpt'), emit)
    assert.deepEqual(emitted, [final])
    assert.equal(final.type, 'rejected')
    assert.equal(final.code, code)
    assert.equal(final.req_id, 'req-chatgpt')
    assert.equal(typeof final.message, 'string')
    assertValid(final)
    assert.deepEqual(table.chatgpt.calls, [], `${code}: the adapter was never touched`)
    assert.deepEqual(phases, [], 'a rejection is not a turn')
  }
})

test('a cached stop:true is re-read from the adapter before rejecting: still streaming → view_busy, finished → the turn proceeds', async () => {
  {
    const { orch, table, emitted, emit, phases } = setup({ health: { chatgpt: okHealth({ stop: true }) } })
    const run = orch.run(request('chatgpt'), emit)
    await settleAll()
    assert.deepEqual(table.chatgpt.ops(), ['health'], 'the cache alone never decides a stop rejection')
    table.chatgpt.last().resolve({ ok: true, op: 'health', health: okHealth({ stop: true }) })
    const final = await run
    assert.deepEqual(emitted, [final])
    assert.equal(final.type, 'rejected')
    assert.equal(final.code, 'view_busy')
    assertValid(final)
    assert.deepEqual(table.chatgpt.ops(), ['health'], 'no DOM write after the rejection')
    assert.deepEqual(phases, [], 'a rejection is not a turn')
  }
  {
    const stored = []
    const { orch, table, emitted, emit } = setup({ health: { chatgpt: okHealth({ stop: true }) }, setHealth: (slot, h) => stored.push([slot, h.stop]) })
    const run = orch.run(request('chatgpt'), emit)
    await settleAll()
    table.chatgpt.last().resolve({ ok: true, op: 'health', health: okHealth({ stop: false }) })
    await settleAll()
    assert.deepEqual(table.chatgpt.ops(), ['health', 'ready'], 'the turn proceeds to ready')
    assert.equal(emitted[0].type, 'accepted')
    assert.deepEqual(stored, [['chatgpt', false]], 'the fresh read is stored back into the cache')
    table.chatgpt.last().reject(Object.assign(new Error('stop'), { code: 'timeout' }))
    await run
  }
  {
    const { orch, table, emit } = setup({ health: { chatgpt: okHealth({ stop: true }) } })
    const run = orch.run(request('chatgpt'), emit)
    await settleAll()
    table.chatgpt.last().reject(new Error('ipc gone'))
    const final = await run
    assert.equal(final.code, 'view_busy')
  }
})

test('rejectFromHealth: null / unknown / ok health proceeds; inflight wins over everything', () => {
  assert.equal(rejectFromHealth(null), null)
  assert.equal(rejectFromHealth(okHealth()), null)
  assert.equal(rejectFromHealth(okHealth({ session: 'unknown', stop: false })), null)
  assert.equal(rejectFromHealth(okHealth({ session: 'logged_out' }), { inflight: true }).code, 'view_busy')
  assert.equal(rejectFromHealth(okHealth({ session: 'logged_out' })).code, 'logged_out')
})

test('unknown slot → unknown_site; no live view → view_crashed; analyst view → analyst_not_chosen until Stage 3 injects a runner', async () => {
  const { orch, emit, emitted } = setup({ clients: ['claude'] })
  const a = await orch.run(request('bing'), emit)
  assert.equal(a.code, 'unknown_site')
  assert.equal(a.type, 'rejected')
  const b = await orch.run(request('chatgpt'), emit)
  assert.equal(b.code, 'view_crashed')
  const c = await orch.run(request('claude', { model: 'web:claude:analyst', view: 'analyst', role: 'analyst', purpose: 'extraction', fresh: true }), emit)
  assert.equal(c.code, 'analyst_not_chosen')
  for (const f of emitted) assertValid(f)
})

test('a second request on a slot whose turn is in flight → view_busy; other slots proceed', async () => {
  const { orch, table, emit } = setup()
  const first = orch.run(request('claude', { req_id: 'first' }), emit)
  await settleAll()
  assert.deepEqual(table.claude.ops(), ['ready'])
  assert.deepEqual(orch.inflight('claude'), { reqId: 'first', view: 'pane' })
  const second = await orch.run(request('claude', { req_id: 'second' }), emit)
  assert.equal(second.type, 'rejected')
  assert.equal(second.code, 'view_busy')
  assert.equal(second.req_id, 'second')
  assert.deepEqual(table.claude.ops(), ['ready'], 'the busy slot got no second op')
  const other = orch.run(request('grok'), emit)
  await settleAll()
  assert.deepEqual(table.grok.ops(), ['ready'])
  table.claude.last().resolve({ ok: true, op: 'ready' })
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, url: 'https://x.test/' })
  await settleAll()
  table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, url: 'https://x.test/' })
  assert.equal((await first).ok, true)
  assert.equal((await other).ok, true)
  assert.equal(orch.inflight('claude'), null)
})

// --- the turn ------------------------------------------------------------------------------------

test('capture off: accepted → ready → mutex⟨focus, insertAndSubmit⟩ → result captured:false with url + integer ms; no observe', async () => {
  const { orch, table, trace, emitted, emit, phases, restored } = setup({ health: { chatgpt: okHealth() }, urls: { chatgpt: 'https://x.test/' } })
  const done = orch.run(request('chatgpt'), emit)
  await settleAll()
  assert.deepEqual(emitted, [{ type: 'accepted', req_id: 'req-chatgpt', view: 'pane', slot: 'chatgpt' }])
  assertValid(emitted[0])
  assert.deepEqual(trace, ['chatgpt:ready:start'])
  assert.deepEqual(table.chatgpt.last().payload, { timeoutMs: 1000 })
  assert.equal(table.chatgpt.last().opts.timeoutMs, 1000 + TIMEOUT_GRACE_MS)
  assert.ok(table.chatgpt.last().opts.signal instanceof AbortSignal, 'every op carries the turn signal')
  table.chatgpt.last().resolve({ ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  assert.deepEqual(trace.slice(1), ['chatgpt:ready:end', 'chatgpt:focus', 'chatgpt:insertAndSubmit:start'])
  assert.deepEqual(phases, ['chatgpt:typing'])
  assert.deepEqual(table.chatgpt.last().payload, { text: 'hello `x`' })
  assert.equal(table.chatgpt.last().opts.timeoutMs, 1000 + 2000 + 2 * 500 + 2 * INSERT_SETTLE_MS + TIMEOUT_GRACE_MS)
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, composerSelector: '#c', sendSelector: 'b', assistantCount: 2, confirmedBy: 'composer_cleared', ms: 3, url: 'https://x.test/' })
  const final = await done
  assert.deepEqual(final, { type: 'result', req_id: 'req-chatgpt', ok: true, captured: false, url: 'https://x.test/', ms: final.ms })
  assert.ok(Number.isInteger(final.ms) && final.ms > 0, `ms is an integer: ${final.ms}`)
  assertValid(final)
  assert.deepEqual(emitted[1], final)
  assert.deepEqual(table.chatgpt.ops(), ['ready', 'insertAndSubmit'], 'no observe when capture is off')
  assert.deepEqual(phases, ['chatgpt:typing', 'chatgpt:submitted', 'chatgpt:done'])
  assert.equal(restored(), 1, 'renderer focus restored after the insert phase')
  assert.equal(trace.at(-1), 'renderer:focus')
})

test('capture on: observe is called with baselineCount = the submit result assistantCount (+ quietMs/timeoutMs); result captured:true carries text, url, done_by', async () => {
  const { orch, table, emitted, emit, phases } = setup({ capture: { claude: true }, urls: { claude: 'https://x.test/c/abc' } })
  const done = orch.run(request('claude'), emit)
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 3, url: 'https://x.test/c/abc' })
  await settleAll()
  const obs = table.claude.last()
  assert.equal(obs.op, 'observe')
  assert.deepEqual(obs.payload, { baselineCount: 3, quietMs: 250, settleMs: 200, timeoutMs: 4000, firstTokenMs: 3000 })
  assert.equal(obs.opts.timeoutMs, observeBudgetMs({ firstTokenMs: 3000, captureTimeoutMs: 4000 }) + TIMEOUT_GRACE_MS)
  assert.deepEqual(phases, ['claude:typing', 'claude:submitted', 'claude:replying'])
  obs.resolve({ ok: true, op: 'observe', text: 'At sea level water boils at 100 °C.', doneBy: 'stop_gone', ms: 900, url: 'https://x.test/c/abc' })
  const final = await done
  assert.deepEqual(final, { type: 'result', req_id: 'req-claude', ok: true, captured: true, text: 'At sea level water boils at 100 °C.', url: 'https://x.test/c/abc', ms: final.ms, done_by: 'stop_gone' })
  assert.ok(Number.isInteger(final.ms))
  assertValid(final)
  assert.deepEqual(emitted.map((f) => f.type), ['accepted', 'result'])
  assert.equal(phases.at(-1), 'claude:done')
})

test('a missing / bogus assistantCount omits baselineCount from observe (the adapter samples its own baseline; 0 would capture the previous reply); an unknown doneBy is reported as quiet; an empty text is still ok', async () => {
  const { orch, table, emit } = setup({ capture: { grok: true } })
  const done = orch.run(request('grok'), emit)
  await settleAll()
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: -1 })
  await settleAll()
  assert.equal(table.grok.last().op, 'observe')
  assert.deepEqual(table.grok.last().payload, { quietMs: 250, settleMs: 200, timeoutMs: 4000, firstTokenMs: 3000 }, 'no baselineCount at all')
  assert.equal('baselineCount' in table.grok.last().payload, false)
  table.grok.last().resolve({ ok: true, op: 'observe', text: '', doneBy: 'weird', ms: 1 })
  const final = await done
  assert.equal(final.captured, true)
  assert.equal(final.text, '')
  assert.equal(final.done_by, 'quiet')
  assertValid(final)
})

// --- navigation rule (decision 12) ---------------------------------------------------------------

test('a recorded link that differs from the view URL → loadUrl(link) before ready; equal → no navigation', async () => {
  const { orch, table, loads, emit, trace } = setup({ links: { chatgpt: 'https://x.test/c/old' }, urls: { chatgpt: 'https://x.test/' } })
  const done = orch.run(request('chatgpt'), emit)
  await settleAll()
  assert.deepEqual(loads, [['chatgpt', 'https://x.test/c/old']])
  assert.deepEqual(trace, ['chatgpt:ready:start'], 'ready waits for the composer of the opened chat')
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 1, url: 'https://x.test/c/old' })
  const final = await done
  assert.equal(final.ok, true)
  assert.equal(final.url, 'https://x.test/c/old')

  const same = setup({ links: { chatgpt: 'https://x.test/c/old' }, urls: { chatgpt: 'https://x.test/c/old' } })
  const run2 = same.orch.run(request('chatgpt'), same.emit)
  await settleAll()
  assert.deepEqual(same.loads, [], 'already on the recorded chat: no navigation')
  same.table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  same.table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  assert.equal((await run2).ok, true)
  assert.deepEqual(same.chatsSet, [], 'the link is already recorded; no rewrite')
})

test('no link + view on a chat URL → no navigation, that URL is recorded right after the submit (adopt)', async () => {
  const { orch, table, loads, chatsSet, emit } = setup({ urls: { grok: 'https://x.test/c/adopted' } })
  const done = orch.run(request('grok'), emit)
  await settleAll()
  assert.deepEqual(loads, [])
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.deepEqual(chatsSet, [], 'nothing recorded before the submit')
  table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, url: 'https://x.test/c/adopted' })
  const final = await done
  assert.deepEqual(chatsSet, [[CONV, 'grok', 'https://x.test/c/adopted']])
  assert.equal(final.url, 'https://x.test/c/adopted')
})

test('no link + view on a non-matching URL → recorded only after a MATCHING navigation within 15 s; non-matching navigations never recorded', async () => {
  const { orch, table, chatsSet, emit, navigate, timers, navCbs } = setup({ urls: { chatgpt: 'https://x.test/' } })
  const done = orch.run(request('chatgpt'), emit)
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, url: 'https://x.test/' })
  const final = await done
  assert.equal(final.ok, true)
  assert.equal(final.url, 'https://x.test/', 'the result carries the current URL when no chat URL is known yet')
  assert.deepEqual(chatsSet, [])
  assert.equal(typeof navCbs.chatgpt, 'function', 'watching for the chat URL after the result')
  navigate('chatgpt', 'https://x.test/settings')
  assert.deepEqual(chatsSet, [], 'a non-matching URL is never recorded')
  navigate('chatgpt', 'https://x.test/c/new1')
  assert.deepEqual(chatsSet, [[CONV, 'chatgpt', 'https://x.test/c/new1']])
  assert.equal(navCbs.chatgpt, undefined, 'the watch stops after the first match')
  navigate('chatgpt', 'https://x.test/c/new2')
  assert.deepEqual(chatsSet.length, 1, 'one link per turn')

  // the 15 s window: a late navigation is ignored
  const late = setup({ urls: { chatgpt: 'https://x.test/' } })
  const run2 = late.orch.run(request('chatgpt'), late.emit)
  await settleAll()
  late.table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  late.table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  await run2
  late.timers.advance(CHAT_URL_WAIT_MS + 1)
  late.navigate('chatgpt', 'https://x.test/c/toolate')
  assert.deepEqual(late.chatsSet, [])
  assert.equal(timers.pending(), 0)
})

test('no conversation id → nothing recorded; a broken / missing chatUrlPattern → nothing recorded, the turn still succeeds', async () => {
  const anon = setup({ urls: { claude: 'https://x.test/c/abc' } })
  const r1 = anon.orch.run(request('claude', { conversation_id: null }), anon.emit)
  await settleAll()
  anon.table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  anon.table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  assert.equal((await r1).ok, true)
  assert.deepEqual(anon.chatsSet, [])

  const broken = setup({ urls: { claude: 'https://x.test/c/abc' }, pattern: '([' })
  const r2 = broken.orch.run(request('claude'), broken.emit)
  await settleAll()
  broken.table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  broken.table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  assert.equal((await r2).ok, true)
  assert.deepEqual(broken.chatsSet, [])
  assert.equal(compileChatUrlPattern('(['), null)
  assert.equal(compileChatUrlPattern(''), null)
  assert.ok(compileChatUrlPattern(PATTERN) instanceof RegExp)
})

test('a failed navigation to the recorded chat → result navigation (after accepted); fresh:true opens newChatUrl first', async () => {
  const { orch, table, emitted, emit, phases } = setup({ links: { grok: 'https://x.test/c/fail' }, urls: { grok: 'https://x.test/' } })
  const final = await orch.run(request('grok'), emit)
  assert.deepEqual(emitted.map((f) => f.type), ['accepted', 'result'])
  assert.equal(final.ok, false)
  assert.equal(final.code, 'navigation')
  assert.match(final.message, /could not open the recorded chat/)
  assert.equal(final.partial, null)
  assertValid(final)
  assert.deepEqual(table.grok.calls, [], 'no adapter op after a failed load')
  assert.deepEqual(phases, ['grok:error:navigation'])

  const fresh = setup({ links: { grok: 'https://x.test/c/keep' }, urls: { grok: 'https://x.test/c/keep' } })
  const run2 = fresh.orch.run(request('grok', { fresh: true }), fresh.emit)
  await settleAll()
  assert.deepEqual(fresh.loads, [['grok', 'https://x.test/new-grok']], 'fresh:true ignores the recorded link')
  fresh.table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  fresh.table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  assert.equal((await run2).ok, true)
})

test('a navigation main started elsewhere (openChats / New chat / the initial load) holds ready until it commits: bounded by NAVIGATION_WAIT_MS, ended by a cancel, skipped after the turn\'s own navigation', async () => {
  let commit
  const pending = { chatgpt: new Promise((r) => (commit = r)) }
  const { orch, table, trace, emitted, emit, timers } = setup({ pendingNavigation: (slot) => pending[slot] || null, urls: { chatgpt: 'https://x.test/' } })
  const done = orch.run(request('chatgpt'), emit)
  await settleAll()
  assert.deepEqual(emitted.map((f) => f.type), ['accepted'], 'accepted goes out at once')
  assert.deepEqual(table.chatgpt.ops(), [], 'no ready while the navigation is pending: the old document would answer it')
  assert.equal(timers.pending(), 1, 'the wait is bounded')
  commit()
  await settleAll()
  assert.deepEqual(table.chatgpt.ops(), ['ready'], 'ready right after the commit')
  assert.equal(timers.pending(), 0, 'the bound is cleared')
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, url: 'https://x.test/' })
  assert.equal((await done).ok, true)
  assert.deepEqual(trace.filter((t) => t.includes('ready')), ['chatgpt:ready:start', 'chatgpt:ready:end'])

  // a slot with nothing pending is not delayed at all
  const other = orch.run(request('grok'), emit)
  await settleAll()
  assert.deepEqual(table.grok.ops(), ['ready'])
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  assert.equal((await other).ok, true)

  // bounded: a navigation that never commits releases the turn after NAVIGATION_WAIT_MS
  const slow = setup({ pendingNavigation: () => new Promise(() => {}) })
  const run2 = slow.orch.run(request('grok'), slow.emit)
  await settleAll()
  assert.deepEqual(slow.table.grok.ops(), [])
  slow.timers.advance(NAVIGATION_WAIT_MS - 1)
  await settleAll()
  assert.deepEqual(slow.table.grok.ops(), [])
  slow.timers.advance(1)
  await settleAll()
  assert.deepEqual(slow.table.grok.ops(), ['ready'], 'ready after the bound')
  slow.table.grok.last().reject(new AdapterRequestError('timeout', 'no composer'))
  assert.equal((await run2).code, 'timeout')

  // a cancel during the wait ends it: nothing is ever asked of the page
  const c = setup({ pendingNavigation: () => new Promise(() => {}) })
  const run3 = c.orch.run(request('claude'), c.emit)
  await settleAll()
  assert.equal(c.orch.cancel('req-claude'), true)
  const f3 = await run3
  assert.equal(f3.code, 'cancelled')
  assert.deepEqual(c.table.claude.ops(), [], 'no op after the cancel')
  assert.equal(c.timers.pending(), 0)
  assertValid(f3)

  // the turn's own navigation (a differing recorded link) comes first; whatever is pending afterwards is awaited
  let commit2
  const pending2 = { chatgpt: new Promise((r) => (commit2 = r)) }
  const own = setup({ pendingNavigation: (slot) => pending2[slot] || null, links: { chatgpt: 'https://x.test/c/old' }, urls: { chatgpt: 'https://x.test/' } })
  const run4 = own.orch.run(request('chatgpt'), own.emit)
  await settleAll()
  assert.deepEqual(own.loads, [['chatgpt', 'https://x.test/c/old']], 'own navigation issued')
  assert.deepEqual(own.table.chatgpt.ops(), [], 'then the pending one is awaited')
  commit2()
  await settleAll()
  assert.deepEqual(own.table.chatgpt.ops(), ['ready'])
  own.table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  own.table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  assert.equal((await run4).ok, true)

  // a pendingNavigation that throws or answers junk never blocks the turn
  const junk = setup({ pendingNavigation: () => { throw new Error('boom') } })
  const run5 = junk.orch.run(request('claude'), junk.emit)
  await settleAll()
  assert.deepEqual(junk.table.claude.ops(), ['ready'])
  junk.table.claude.last().reject(new AdapterRequestError('timeout', 't'))
  await run5
})

// --- parallel requests, the mutex, focus --------------------------------------------------------

test('three parallel requests: ready phases overlap, insert phases never do, renderer focus restored once after the last insert', async () => {
  const { orch, table, trace, emit, restored } = setup()
  const runs = SLOTS.map((slot) => orch.run(request(slot), emit))
  await settleAll()
  assert.deepEqual(trace, ['claude:ready:start', 'chatgpt:ready:start', 'grok:ready:start'])
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.deepEqual(trace.slice(3), ['chatgpt:ready:end', 'chatgpt:focus', 'chatgpt:insertAndSubmit:start'])
  table.claude.last().resolve({ ok: true, op: 'ready' })
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.equal(trace.filter((t) => t.endsWith(':focus') && !t.startsWith('chatgpt')).length, 0, 'nobody else focuses while chatgpt inserts')
  assert.equal(restored(), 0)
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  await settleAll()
  assert.equal(restored(), 0, 'inserts still queued: renderer focus not restored yet')
  const inserting = SLOTS.filter((s) => table[s].last().op === 'insertAndSubmit' && s !== 'chatgpt')
  assert.equal(inserting.length, 1, 'exactly one of the others holds the mutex')
  table[inserting[0]].last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  await settleAll()
  const third = SLOTS.find((s) => s !== 'chatgpt' && s !== inserting[0])
  assert.equal(table[third].last().op, 'insertAndSubmit')
  table[third].last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  const finals = await Promise.all(runs)
  assert.deepEqual(finals.map((f) => f.ok), [true, true, true])
  assert.equal(restored(), 1)
  const inserts = trace.filter((t) => t.includes('insertAndSubmit'))
  for (let i = 0; i < inserts.length; i += 2) {
    assert.ok(inserts[i].endsWith(':start') && inserts[i + 1].endsWith(':end') && inserts[i].split(':')[0] === inserts[i + 1].split(':')[0], inserts.join(' '))
  }
  assert.equal(orch.mutex.locked(), false)
})

test('a failure inside the insert phase releases the mutex; the failed turn reports the adapter code with partial', async () => {
  const { orch, table, emit, phases } = setup()
  const a = orch.run(request('claude'), emit)
  const b = orch.run(request('chatgpt'), emit)
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.equal(table.claude.last().op, 'insertAndSubmit')
  table.claude.last().reject(new AdapterRequestError('send_not_found', 'no enabled send button within 18000 ms'))
  await settleAll()
  assert.equal(table.chatgpt.last().op, 'insertAndSubmit')
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  const fa = await a
  assert.deepEqual(fa, { type: 'result', req_id: 'req-claude', ok: false, code: 'send_not_found', message: 'no enabled send button within 18000 ms', partial: null })
  assertValid(fa)
  assert.equal((await b).ok, true)
  assert.ok(phases.includes('claude:error:send_not_found'))
  assert.equal(orch.mutex.locked(), false)
})

// --- cancel ---------------------------------------------------------------------------------------

test('cancel(reqId) aborts the in-flight op: the adapter answers cancelled (with partial) → result cancelled; cancel of an unknown id is false', async () => {
  const { orch, table, emit, phases } = setup({ capture: { claude: true } })
  const done = orch.run(request('claude'), emit)
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0 })
  await settleAll()
  const obs = table.claude.last()
  assert.equal(obs.op, 'observe')
  assert.equal(orch.cancel('nope'), false)
  assert.equal(orch.cancel('req-claude'), true)
  assert.equal(obs.aborted, true, 'the observe op saw the abort')
  assert.equal(orch.cancel('req-claude'), true, 'idempotent while the turn is still winding down')
  obs.reject(new AdapterRequestError('cancelled', 'cancelled by the backend', { partial: 'At sea level' }))
  const final = await done
  assert.deepEqual(final, { type: 'result', req_id: 'req-claude', ok: false, code: 'cancelled', message: 'cancelled by the backend', partial: 'At sea level' })
  assertValid(final)
  assert.equal(phases.at(-1), 'claude:error:cancelled')
  assert.equal(orch.cancel('req-claude'), false, 'gone once the turn has finished')
})

test('a cancel while the turn waits for the mutex skips the insert entirely (nothing typed)', async () => {
  const { orch, table, emit, trace } = setup()
  const a = orch.run(request('claude'), emit)
  const b = orch.run(request('grok'), emit)
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.equal(table.claude.last().op, 'insertAndSubmit', 'claude holds the mutex')
  assert.equal(table.grok.last().op, 'ready', 'grok waits for it')
  orch.cancel('req-grok')
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  const fb = await b
  assert.equal(fb.code, 'cancelled')
  assert.deepEqual(table.grok.ops(), ['ready'], 'no insert after the cancel')
  assert.equal(trace.includes('grok:focus'), false)
  assert.equal((await a).ok, true)
  assert.equal(orch.mutex.locked(), false)
})

// --- failure mapping ---------------------------------------------------------------------------------

test('adapter codes outside the §1 result set (busy, logged_out from ready) become site_error with the code in the message; result codes pass through', async () => {
  const cases = [
    [new AdapterRequestError('busy', 'op observe in flight'), 'site_error', 'busy: op observe in flight'],
    [new AdapterRequestError('logged_out', 'signed out'), 'site_error', 'logged_out: signed out'],
    [new AdapterRequestError('timeout', 'ready timed out'), 'timeout', 'ready timed out'],
    [new AdapterRequestError('adapter_gone', 'navigated'), 'adapter_gone', 'navigated'],
    [new AdapterRequestError('view_crashed', 'gone'), 'view_crashed', 'gone'],
    [new Error('boom'), 'site_error', 'boom'],
  ]
  for (const [err, code, message] of cases) {
    const { orch, table, emit } = setup()
    const done = orch.run(request('grok'), emit)
    await settleAll()
    table.grok.last().reject(err)
    const final = await done
    assert.equal(final.code, code, err.message)
    assert.equal(final.message, message)
    assertValid(final)
  }
})

// --- budgets / mutex ----------------------------------------------------------------------------------

test('insertAndSubmit budget = composer + send + 2×verify + 2×INSERT_SETTLE_MS (+ grace); observe budget = firstToken + capture (+ grace); the contract defaults apply when timeoutsFor answers null', async () => {
  assert.equal(INSERT_SETTLE_MS, SELECTORS_INSERT_SETTLE_MS, 'the settle delay comes from site.cjs through selectors.js')
  assert.ok(Number.isFinite(INSERT_SETTLE_MS) && INSERT_SETTLE_MS > 0)
  assert.equal(insertAndSubmitBudgetMs({ composerWaitMs: 15000, sendWaitMs: 18000, submitVerifyMs: 5000, insertSettleMs: 60 }), 43120)
  assert.equal(observeBudgetMs({ firstTokenMs: 90000, captureTimeoutMs: 300000 }), 390000)

  const { orch, table, emit } = setup({ timeouts: null, capture: { chatgpt: true } })
  const done = orch.run(request('chatgpt'), emit)
  await settleAll()
  assert.deepEqual(table.chatgpt.last().payload, { timeoutMs: 15000 })
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  const insert = table.chatgpt.last()
  assert.equal(insert.opts.timeoutMs, 15000 + 18000 + 2 * 5000 + 2 * INSERT_SETTLE_MS + TIMEOUT_GRACE_MS)
  insert.resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 1 })
  await settleAll()
  const obs = table.chatgpt.last()
  // a capture config that predates `settleMs` falls back to the contract default (400), never to chatgpt's
  assert.deepEqual(obs.payload, { baselineCount: 1, quietMs: 2500, settleMs: 400, timeoutMs: 300000, firstTokenMs: 90000 })
  assert.equal(obs.opts.timeoutMs, 90000 + 300000 + TIMEOUT_GRACE_MS)
  obs.resolve({ ok: true, op: 'observe', text: 't', doneBy: 'quiet', ms: 1 })
  await done

  const custom = setup({ insertSettleMs: 250 })
  const run = custom.orch.run(request('grok'), custom.emit)
  await settleAll()
  custom.table.grok.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  assert.equal(custom.table.grok.last().opts.timeoutMs, 1000 + 2000 + 2 * 500 + 2 * 250 + TIMEOUT_GRACE_MS)
  custom.table.grok.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  await run
})

test('createMutex serializes holders, counts waiters and tolerates a double release', async () => {
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
  assert.equal(m.waiting(), 1)
  r1()
  r1()
  const r2 = await second
  assert.deepEqual(order, ['second'])
  assert.equal(m.locked(), true)
  assert.equal(m.waiting(), 0)
  r2()
  assert.equal(m.locked(), false)
})

test('an emit() that throws is logged, never fails the turn', async () => {
  const { orch, table } = setup()
  const done = orch.run(request('claude'), () => {
    throw new Error('socket closed')
  })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true })
  const final = await done
  assert.equal(final.ok, true)
})

// --- S10: what main tells the adapter about the capture, and what it says about the one it got ------

test('S10: a pane turn is never told to expect a shape, and its capture budget is the site\'s own (no patience multiplier)', async () => {
  const { orch, table, emit } = setup({ capture: { chatgpt: true } })
  const done = orch.run(request('chatgpt'), emit)
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0 })
  await settleAll()
  const obs = table.chatgpt.last()
  assert.equal(obs.op, 'observe')
  assert.equal('expect' in obs.payload, false, 'a pane reply is whatever the user asked for')
  assert.deepEqual([obs.payload.quietMs, obs.payload.settleMs], [250, 200])
  obs.resolve({ ok: true, op: 'observe', text: 'hi', doneBy: 'quiet', ms: 5 })
  await done
})

test("S10: Fusion's own replies get the JSON gate too — it follows the PURPOSE, not the view", async () => {
  // A defense reply is a DefenseReply document typed into a PANE (`web:<slot>`, view 'pane'), so a
  // gate keyed on the analyst view would have left Fusion exposed to the identical mid-document
  // truncation that broke Analyze — the user's very next step after this fix.
  for (const purpose of STRUCTURED_PURPOSES) {
    const { orch, table, emit } = setup({ capture: { chatgpt: true } })
    const done = orch.run(request('chatgpt', { purpose }), emit)
    await settleAll()
    table.chatgpt.last().resolve({ ok: true, op: 'ready' })
    await settleAll()
    table.chatgpt.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0 })
    await settleAll()
    const obs = table.chatgpt.last()
    assert.equal(obs.payload.expect, 'json', purpose)
    obs.resolve({ ok: true, op: 'observe', text: '{"a":1}', doneBy: 'quiet', ms: 5 })
    await done
  }
  assert.deepEqual([...STRUCTURED_PURPOSES], ['extraction', 'defense', 'convergence'])
  assert.equal(STRUCTURED_PURPOSES.includes('chat'), false, "a pane's own chat is prose and must never wait for braces")
})

test('S10: one log line per captured turn names the length, the signal it ended on and the time — the reading this failure could not be diagnosed without', async () => {
  const { orch, table, emit, log } = setup({ capture: { claude: true } })
  const done = orch.run(request('claude'), emit)
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'ready' })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 1 })
  await settleAll()
  table.claude.last().resolve({ ok: true, op: 'observe', text: '```json\n{}\n```', doneBy: 'done_selector', ms: 1234 })
  await done
  const line = log.lines.map(([, m]) => m).find((m) => m.includes('captured'))
  assert.ok(line, `no capture line in ${JSON.stringify(log.lines)}`)
  assert.match(line, /claude: captured 14 chars by done_selector in 1234 ms/)
  // and no reply text in the log, ever (the no-text-in-logs rule)
  for (const [, m] of log.lines) assert.equal(m.includes('json'), false, m)
})
