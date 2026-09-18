// orchestrator.js, `view: 'analyst'` (Stage 3 analyst-view): the request runs on the HIDDEN analyst
// view of that site, not on its pane — a `web:chatgpt:analyst` request drives the analyst client
// while `web:chatgpt` drives the pane client; no analyst chosen (or a slot that is not the chosen
// one) → `rejected analyst_not_chosen`; `fresh:true` opens newChatUrl on the analyst view and waits
// for the composer, `fresh:false` continues in place; analyst turns are serialized against each
// other (`view_busy`) while the same site's PANE turn runs independently; the analyst ALWAYS
// observes whatever the capture switches say; it never reads or records a chat link and never
// emits a `panes:turn` phase; its own health governs its rejections. Every emitted frame is
// checked by protocol.validate().
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrchestrator } from '../../../main/orchestrator.js'
import { validate } from '../../../main/protocol.js'
import { fakeLog, fakeTimers, tick } from './_fakes.js'

const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'
const PATTERN = '^https://x\\.test/c/[a-z0-9]+'

/** A scripted adapter client: every request returns a deferred the test settles by hand. */
function scriptedClient(name, trace) {
  const calls = []
  return {
    name,
    calls,
    request(op, payload, opts = {}) {
      return new Promise((resolve, reject) => {
        trace.push(`${name}:${op}:start`)
        calls.push({
          op,
          payload,
          opts,
          resolve: (v) => {
            trace.push(`${name}:${op}:end`)
            resolve(v)
          },
          reject: (e) => {
            trace.push(`${name}:${op}:fail`)
            reject(e)
          },
        })
      })
    },
    last: () => calls[calls.length - 1],
    ops: () => calls.map((c) => c.op),
    settle(op, value) {
      const call = [...this.calls].reverse().find((c) => c.op === op && !c.done)
      if (!call) throw new Error(`no pending ${op} on ${name} (saw ${this.ops().join(', ')})`)
      call.done = true
      call.resolve(value)
      return call
    },
  }
}

function okHealth(extra = {}) {
  return { composer: true, send: true, reply: null, stop: null, session: 'ok', matched: { composer: '#c', send: 'b', reply: null, stop: null, error: null }, url: 'https://x.test/', host: 'x.test', title: 't', ts: 1, ...extra }
}

/**
 * setup(opts): `analystSlot` (null = no analyst chosen), `analystHealth`, `capture`, `links`.
 * The analyst seam is a fake analyst-views.js: one client, its own URL, navigation and health.
 */
function setup({ analystSlot = 'chatgpt', analystHealth = null, capture = {}, links = {}, paneHealth = {}, analystNewChatUrl = null } = {}) {
  const trace = []
  const panes = { claude: scriptedClient('pane:claude', trace), chatgpt: scriptedClient('pane:chatgpt', trace), grok: scriptedClient('pane:grok', trace) }
  const analystClient = scriptedClient('analyst', trace)
  const timers = fakeTimers()
  const phases = []
  const chatsSet = []
  const chatsDoc = { [CONV]: { ...links } }
  const analyst = {
    url: 'https://x.test/analyst',
    loads: [],
    focused: 0,
    health: analystHealth,
    pending: null,
    created: 0,
  }
  let clock = 1000.4
  const orch = createOrchestrator({
    adapterFor: (slot) => panes[slot] || null,
    analystAdapterFor: (slot) => {
      if (analystSlot === null || slot !== analystSlot) return null
      analyst.created += 1
      return analystClient
    },
    analystView: {
      currentUrl: () => analyst.url,
      loadUrl: async (url) => {
        analyst.loads.push(url)
        if (String(url).includes('fail')) throw new Error('ERR_CONNECTION_REFUSED')
        analyst.url = url
      },
      newChatUrl: () => analystNewChatUrl || (analystSlot === null ? null : `https://x.test/new-${analystSlot}`),
      pendingNavigation: () => analyst.pending,
      focus: () => {
        analyst.focused += 1
        trace.push('analyst:focus')
      },
      getHealth: () => analyst.health,
      setHealth: (h) => {
        analyst.health = h
      },
    },
    focusView: (slot) => trace.push(`${slot}:focus`),
    restoreRendererFocus: () => trace.push('renderer:focus'),
    timeoutsFor: () => ({ composerWaitMs: 1000, sendWaitMs: 2000, submitVerifyMs: 500 }),
    captureTimeoutsFor: () => ({ quietMs: 250, firstTokenMs: 3000, captureTimeoutMs: 4000 }),
    chatUrlPatternFor: () => PATTERN,
    getHealth: (slot) => paneHealth[slot] || null,
    getCapture: () => ({ claude: false, chatgpt: false, grok: false, ...capture }),
    chats: {
      get: (convId, slot) => (chatsDoc[convId] && chatsDoc[convId][slot]) || null,
      set: (convId, slot, url) => chatsSet.push([convId, slot, url]),
    },
    currentUrl: (slot) => `https://x.test/pane-${slot}`,
    loadUrl: async () => {},
    onNavigate: () => () => {},
    newChatUrl: (slot) => `https://x.test/new-${slot}`,
    onTurn: (slot, phase, code) => phases.push(code === undefined ? `${slot}:${phase}` : `${slot}:${phase}:${code}`),
    now: () => {
      clock += 100.3
      return clock
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log: fakeLog(),
  })
  const emitted = []
  const emit = (frame) => emitted.push(frame)
  return { orch, panes, analystClient, analyst, trace, timers, phases, chatsSet, emitted, emit }
}

const analystRequest = (slot = 'chatgpt', extra = {}) => ({
  type: 'request',
  req_id: `req-analyst-${slot}`,
  model: `web:${slot}:analyst`,
  slot,
  view: 'analyst',
  fresh: true,
  text: '<<<R1>>> …',
  role: 'analyst',
  purpose: 'extraction',
  conversation_id: CONV,
  timeout_s: 600,
  ...extra,
})

const paneRequest = (slot, extra = {}) => ({
  type: 'request',
  req_id: `req-${slot}`,
  model: `web:${slot}`,
  slot,
  view: 'pane',
  fresh: false,
  text: 'hello',
  role: slot,
  purpose: 'chat',
  conversation_id: CONV,
  timeout_s: 600,
  ...extra,
})

const settleAll = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick()
}

const frame = (emitted, type) => emitted.find((f) => f.type === type) || null
const assertValid = (emitted) => {
  for (const f of emitted) {
    const r = validate(f)
    assert.equal(r.ok, true, `${f.type}: ${r.error}`)
  }
}

// ----------------------------------------------------------------------------------------------

test('web:chatgpt:analyst runs on the analyst view (never the chatgpt pane) and answers captured:true', async () => {
  const { orch, panes, analystClient, analyst, emitted, emit } = setup()
  const done = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  assert.deepEqual(frame(emitted, 'accepted'), { type: 'accepted', req_id: 'req-analyst-chatgpt', view: 'analyst', slot: 'chatgpt' })
  assert.equal(analyst.created, 1, 'the hidden analyst view was asked for')
  assert.deepEqual(panes.chatgpt.ops(), [], 'the chatgpt PANE was never touched')

  assert.deepEqual(analystClient.ops(), ['ready'])
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  assert.equal(analystClient.last().op, 'insertAndSubmit')
  assert.equal(analystClient.last().payload.text, '<<<R1>>> …')
  assert.equal(analyst.focused, 1, 'the hidden view is focused under the mutex before the insert')
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 2, url: 'https://x.test/c/zz', ms: 4 })
  await settleAll()
  assert.equal(analystClient.last().op, 'observe')
  assert.equal(analystClient.last().payload.baselineCount, 2)
  analystClient.settle('observe', { ok: true, op: 'observe', text: '```json\n{}\n```', doneBy: 'stop_gone', ms: 9, url: 'https://x.test/c/zz' })
  const result = await done
  assert.equal(result.ok, true)
  assert.equal(result.captured, true)
  assert.equal(result.text, '```json\n{}\n```')
  assert.equal(result.done_by, 'stop_gone')
  assertValid(emitted)
})

test('no analyst chosen → rejected analyst_not_chosen before any DOM write; so does a slot that is not the chosen analyst', async () => {
  const none = setup({ analystSlot: null })
  const a = await none.orch.run(analystRequest('chatgpt'), none.emit)
  assert.equal(a.type, 'rejected')
  assert.equal(a.code, 'analyst_not_chosen')
  assert.deepEqual(none.analystClient.ops(), [], 'nothing was asked of any view')
  assert.deepEqual(none.panes.chatgpt.ops(), [])
  assertValid(none.emitted)

  const other = setup({ analystSlot: 'claude' })
  const b = await other.orch.run(analystRequest('chatgpt'), other.emit)
  assert.equal(b.code, 'analyst_not_chosen', 'the backend still asks for the previous analyst')
  assert.deepEqual(other.analystClient.ops(), [])

  // and without the Stage 3 seam at all (Stage 2 orchestrators)
  const bare = createOrchestrator({ adapterFor: () => null, log: fakeLog() })
  const emitted = []
  const c = await bare.run(analystRequest('chatgpt'), (f) => emitted.push(f))
  assert.equal(c.code, 'analyst_not_chosen')
})

test('fresh:true opens the analyst view’s newChatUrl and only then waits for the composer', async () => {
  const { orch, analystClient, analyst, emit } = setup()
  orch.run(analystRequest('chatgpt', { fresh: true }), emit)
  await settleAll()
  assert.deepEqual(analyst.loads, ['https://x.test/new-chatgpt'], 'a new chat before anything is typed')
  assert.deepEqual(analystClient.ops(), ['ready'], 'ready comes after the navigation')
  assert.equal(analystClient.last().payload.timeoutMs, 1000, 'the composer budget')
})

test('fresh:false continues in place: no navigation, and a recorded chat link of that slot is never opened on the analyst view', async () => {
  const { orch, analystClient, analyst, emit } = setup({ links: { chatgpt: 'https://x.test/c/pane-chat' } })
  orch.run(analystRequest('chatgpt', { fresh: false }), emit)
  await settleAll()
  assert.deepEqual(analyst.loads, [], 'the analyst keeps the chat it is already in')
  assert.deepEqual(analystClient.ops(), ['ready'])
})

test('a fresh:true navigation that fails is a `navigation` result, with nothing typed', async () => {
  const { orch, analystClient, analyst, emitted, emit } = setup({ analystNewChatUrl: 'https://x.test/fail-new' })
  const result = await orch.run(analystRequest('chatgpt', { fresh: true }), emit)
  assert.deepEqual(analyst.loads, ['https://x.test/fail-new'])
  assert.equal(result.type, 'result')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'navigation')
  assert.match(result.message, /could not open a new chat/)
  assert.deepEqual(analystClient.ops(), [], 'nothing was asked of the page, nothing typed')
  assert.ok(
    emitted.some((f) => f.type === 'accepted'),
    'the failure comes AFTER accepted (§1: a rejection is only ever pre-write)',
  )
  assertValid(emitted)
})

test('the analyst view is serialized: a second analyst request while one runs is view_busy, but the same site’s PANE turn runs in parallel', async () => {
  const { orch, panes, analystClient, emitted, emit } = setup({ capture: { chatgpt: true } })
  const first = orch.run(analystRequest('chatgpt', { req_id: 'A1' }), emit)
  await settleAll()
  assert.equal(analystClient.ops().length, 1)

  const second = await orch.run(analystRequest('chatgpt', { req_id: 'A2' }), emit)
  assert.equal(second.type, 'rejected')
  assert.equal(second.code, 'view_busy')
  assert.equal(second.req_id, 'A2')
  assert.equal(analystClient.ops().length, 1, 'the second request never reached the view')

  // the chatgpt PANE is a different view: its own turn is accepted while the analyst is busy
  const pane = orch.run(paneRequest('chatgpt', { req_id: 'P1' }), emit)
  await settleAll()
  assert.ok(
    emitted.some((f) => f.type === 'accepted' && f.req_id === 'P1' && f.view === 'pane'),
    'the pane turn was accepted',
  )
  assert.deepEqual(panes.chatgpt.ops(), ['ready'])

  // finish both so nothing is left hanging
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  panes.chatgpt.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, ms: 1 })
  await settleAll()
  panes.chatgpt.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, ms: 1 })
  await settleAll()
  analystClient.settle('observe', { ok: true, op: 'observe', text: 'a', doneBy: 'quiet', ms: 1 })
  panes.chatgpt.settle('observe', { ok: true, op: 'observe', text: 'p', doneBy: 'quiet', ms: 1 })
  assert.equal((await first).ok, true)
  assert.equal((await pane).ok, true)
  assertValid(emitted)
})

test('the analyst view ALWAYS observes: capture off for its slot still produces captured:true', async () => {
  const { orch, analystClient, emitted, emit } = setup({ capture: { chatgpt: false, claude: false, grok: false } })
  const done = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 1, ms: 1 })
  await settleAll()
  assert.equal(analystClient.last().op, 'observe', 'the capture switch never applies to the analyst')
  analystClient.settle('observe', { ok: true, op: 'observe', text: 'json', doneBy: 'quiet', ms: 1 })
  const result = await done
  assert.equal(result.captured, true)
  assert.equal(result.text, 'json')
  assertValid(emitted)
})

test('the analyst turn records no chat link and emits no panes:turn phase (both are keyed by slot, which is the PANE)', async () => {
  const { orch, analystClient, chatsSet, phases, emit } = setup()
  const done = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, url: 'https://x.test/c/abc', ms: 1 })
  await settleAll()
  analystClient.settle('observe', { ok: true, op: 'observe', text: 't', doneBy: 'quiet', ms: 1, url: 'https://x.test/c/abc' })
  await done
  assert.deepEqual(chatsSet, [], 'chats.json is the pane’s business')
  assert.deepEqual(phases, [], 'no typing / submitted / replying for a slot whose pane is idle')
})

test('a pane turn still records its chat link and phases while the analyst rule applies only to the analyst', async () => {
  const { orch, panes, chatsSet, phases, emit } = setup({ capture: { grok: true } })
  const done = orch.run(paneRequest('grok'), emit)
  await settleAll()
  panes.grok.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  panes.grok.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, url: 'https://x.test/c/g1', ms: 1 })
  await settleAll()
  panes.grok.settle('observe', { ok: true, op: 'observe', text: 't', doneBy: 'quiet', ms: 1, url: 'https://x.test/c/g1' })
  await done
  assert.deepEqual(phases, ['grok:typing', 'grok:submitted', 'grok:replying', 'grok:done'])
  assert.equal(chatsSet.length, 0, 'the seam’s currentUrl does not match the pattern here')
})

test('the analyst view’s OWN health decides its rejections (decision 7): challenge / logged_out / blocked, and a stale stop button is re-read', async () => {
  for (const [session, code] of [
    ['challenge', 'challenge'],
    ['logged_out', 'logged_out'],
    ['blocked', 'blocked'],
  ]) {
    const { orch, analystClient, emit, emitted } = setup({ analystHealth: okHealth({ session }) })
    const r = await orch.run(analystRequest('chatgpt'), emit)
    assert.equal(r.type, 'rejected', session)
    assert.equal(r.code, code, session)
    assert.deepEqual(analystClient.ops(), [], 'no DOM write on a view that is not ok')
    assertValid(emitted)
  }

  // a lingering stop:true in the cache is re-read from the analyst view before rejecting view_busy
  const { orch, analystClient, analyst, emit } = setup({ analystHealth: okHealth({ stop: true }) })
  const run = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  assert.equal(analystClient.ops()[0], 'health', 'a fresh health read, not a straight view_busy')
  analystClient.settle('health', { ok: true, op: 'health', health: okHealth({ stop: false }) })
  await settleAll()
  assert.equal(analyst.health.stop, false, 'the fresh read is written back to the analyst cache')
  assert.equal(analystClient.ops()[1], 'ready', 'the turn continues')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, ms: 1 })
  await settleAll()
  analystClient.settle('observe', { ok: true, op: 'observe', text: 't', doneBy: 'quiet', ms: 1 })
  assert.equal((await run).ok, true)
})

test('a navigation main started on the analyst view holds `ready` until it commits', async () => {
  const { orch, analystClient, analyst, emit } = setup()
  let commit = () => {}
  analyst.pending = new Promise((r) => {
    commit = r
  })
  orch.run(analystRequest('chatgpt', { fresh: false }), emit)
  await settleAll()
  assert.deepEqual(analystClient.ops(), [], 'nothing is asked of the old document')
  commit()
  await settleAll()
  assert.deepEqual(analystClient.ops(), ['ready'])
})

test('an analyst failure is a result frame with a §1 result code and never a pane phase', async () => {
  const { orch, analystClient, phases, emit, emitted } = setup()
  const done = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  const err = new Error('no composer')
  err.code = 'composer_not_found'
  analystClient.calls.find((c) => c.op === 'ready').reject(Object.assign(err, { name: 'AdapterRequestError' }))
  const result = await done
  assert.equal(result.type, 'result')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'composer_not_found')
  assert.deepEqual(phases, [])
  assertValid(emitted)
})
