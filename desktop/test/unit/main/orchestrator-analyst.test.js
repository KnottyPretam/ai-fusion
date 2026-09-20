// orchestrator.js, `view: 'analyst'` (Stage 3 analyst-view): the request runs on the HIDDEN analyst
// view of that site, not on its pane — a `web:chatgpt:analyst` request drives the analyst client
// while `web:chatgpt` drives the pane client; no analyst chosen (or a slot that is not the chosen
// one) → `rejected analyst_not_chosen`; `fresh:true` opens newChatUrl on the analyst view and waits
// for the composer, `fresh:false` continues in place; analyst turns are serialized against each
// other (`view_busy`) while the same site's PANE turn runs independently; the analyst ALWAYS
// observes whatever the capture switches say; it never reads or records a PANE chat link and never
// emits a `panes:turn` phase; its own health governs its rejections; a `fresh:false` continuation
// is bound to the chat its own CONVERSATION used (main's in-memory analyst chat map), and the
// stale-stop health re-read holds the view reserved while it is in flight. Every emitted frame is
// checked by protocol.validate().
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrchestrator, ANALYST_PATIENCE, CAPTURE_CEILING_MARGIN_MS } from '../../../main/orchestrator.js'
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
function setup({ analystSlot = 'chatgpt', analystHealth = null, capture = {}, links = {}, paneHealth = {}, analystNewChatUrl = null, analystChatMemory = {} } = {}) {
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
  /** main's memory of which analyst chat each conversation used (analyst-views.js). */
  const analystChats = new Map(Object.entries(analystChatMemory))
  let clock = 1000.4
  const log = fakeLog()
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
      chatFor: (convId) => analystChats.get(convId) || null,
      chatOwner: (url) => {
        for (const [convId, u] of analystChats) if (u === url) return convId
        return null
      },
      noteChat: (convId, url) => analystChats.set(convId, url),
    },
    focusView: (slot) => trace.push(`${slot}:focus`),
    restoreRendererFocus: () => trace.push('renderer:focus'),
    timeoutsFor: () => ({ composerWaitMs: 1000, sendWaitMs: 2000, submitVerifyMs: 500 }),
    captureTimeoutsFor: () => ({ quietMs: 250, settleMs: 200, firstTokenMs: 3000, captureTimeoutMs: 4000 }),
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
    log,
  })
  const emitted = []
  const emit = (frame) => emitted.push(frame)
  return { orch, panes, analystClient, analyst, analystChats, trace, timers, phases, chatsSet, emitted, emit, log }
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

test('the stale-stop health re-read holds the view reserved: a second request inside that window is view_busy, not a second turn on the same client', async () => {
  const { orch, analystClient, analyst, emitted, emit } = setup({ analystHealth: okHealth({ stop: true }) })
  const first = orch.run(analystRequest('chatgpt', { req_id: 'A1' }), emit)
  await settleAll()
  assert.deepEqual(analystClient.ops(), ['health'], 'the fresh read is in flight, nothing is reserved yet in the old code')

  // A2 arrives while A1 is still awaiting the fresh health read (up to FRESH_HEALTH_TIMEOUT_MS)
  const second = await orch.run(analystRequest('chatgpt', { req_id: 'A2' }), emit)
  assert.equal(second.type, 'rejected', 'the second request never gets accepted')
  assert.equal(second.code, 'view_busy')
  assert.equal(second.req_id, 'A2')
  assert.deepEqual(analystClient.ops(), ['health'], 'and never reaches the view — no second health read, no second ready')
  assert.deepEqual(
    emitted.filter((f) => f.type === 'accepted'),
    [],
    'neither turn is accepted while the read is in flight (A1 is still deciding)',
  )

  // A1 owns the view and runs to completion; cancel still reaches it (its entry was not overwritten)
  analystClient.settle('health', { ok: true, op: 'health', health: okHealth({ stop: false }) })
  await settleAll()
  assert.equal(analyst.health.stop, false)
  assert.deepEqual(
    emitted.filter((f) => f.type === 'accepted').map((f) => f.req_id),
    ['A1'],
    'exactly one turn was accepted for the one analyst view',
  )
  assert.equal(analystClient.ops()[1], 'ready')
  assert.equal(orch.cancel('A1'), true, 'the reservation belongs to A1')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  const result = await first
  assert.equal(result.ok, false)
  assert.equal(result.code, 'cancelled')
  assertValid(emitted)

  // the map was given back, so the next request is accepted again
  const third = orch.run(analystRequest('chatgpt', { req_id: 'A3' }), emit)
  await settleAll()
  assert.ok(
    emitted.some((f) => f.type === 'accepted' && f.req_id === 'A3'),
    'the view is free once the first turn finished',
  )
  orch.cancel('A3')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await third
})

test('a rejected stale-stop read gives the reservation back: the view is not left busy for ever', async () => {
  const { orch, analystClient, emitted, emit } = setup({ analystHealth: okHealth({ stop: true }) })
  const first = orch.run(analystRequest('chatgpt', { req_id: 'B1' }), emit)
  await settleAll()
  analystClient.settle('health', { ok: true, op: 'health', health: okHealth({ stop: true }) }) // really still answering
  const rejected = await first
  assert.equal(rejected.type, 'rejected')
  assert.equal(rejected.code, 'view_busy')
  assert.equal(orch.inflight('analyst:chatgpt'), null, 'nothing is left in the active map')

  const second = orch.run(analystRequest('chatgpt', { req_id: 'B2', fresh: false }), emit)
  await settleAll()
  analystClient.settle('health', { ok: true, op: 'health', health: okHealth({ stop: false }) })
  await settleAll()
  assert.ok(
    emitted.some((f) => f.type === 'accepted' && f.req_id === 'B2'),
    'the next request is judged on its own fresh read',
  )
  orch.cancel('B2')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await second
})

test('a fresh:false analyst continuation is bound to its conversation: back to its OWN chat, never typed into another conversation’s', async () => {
  const OTHER = 'b7d2c1e0-4a3b-4c5d-9e8f-102030405060'
  const { orch, analystClient, analyst, analystChats, emit, emitted } = setup()

  /** One whole analyst turn; `landedIn` is the chat URL the page reports back (and navigates to). */
  const runTurn = async (convId, extra, landedIn) => {
    const done = orch.run(analystRequest('chatgpt', { conversation_id: convId, ...extra }), emit)
    await settleAll()
    analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
    await settleAll()
    analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, ms: 1 })
    await settleAll()
    analyst.url = landedIn // the site navigated into the chat while it answered
    analystClient.settle('observe', { ok: true, op: 'observe', text: '{}', doneBy: 'quiet', ms: 1, url: landedIn })
    return done
  }

  // 1. conversation A opens a fresh analyst chat and finishes there: main remembers it
  assert.equal((await runTurn(CONV, { req_id: 'A1', fresh: true }, 'https://x.test/c/a1')).ok, true)
  assert.equal(analystChats.get(CONV), 'https://x.test/c/a1', 'the analyst chat is recorded for A')
  // 2. conversation B takes the one hidden view in the gap between A's two attempts
  assert.equal((await runTurn(OTHER, { req_id: 'B1', fresh: true }, 'https://x.test/c/b1')).ok, true)
  assert.equal(analystChats.get(OTHER), 'https://x.test/c/b1')
  assert.equal(analyst.url, 'https://x.test/c/b1', 'the view now shows B’s chat')

  // 3. A's correction attempt (bridge fresh:false) goes BACK to A's chat, not into B's
  const loadsBefore = analyst.loads.length
  const correction = orch.run(analystRequest('chatgpt', { req_id: 'A2', fresh: false, conversation_id: CONV }), emit)
  await settleAll()
  assert.deepEqual(analyst.loads.slice(loadsBefore), ['https://x.test/c/a1'], 'A’s own chat is opened first')
  assert.deepEqual(analystClient.ops().at(-1), 'ready', 'and only then is the page asked anything')
  orch.cancel('A2')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await correction

  // 4. a conversation with no recorded chat, while the view sits in someone else's: a NEW chat
  analyst.url = 'https://x.test/c/b1'
  const third = orch.run(analystRequest('chatgpt', { req_id: 'C1', fresh: false, conversation_id: '5f6e7d8c-9a0b-4c1d-8e2f-304050607080' }), emit)
  await settleAll()
  assert.equal(analyst.loads.at(-1), 'https://x.test/new-chatgpt', 'a fresh chat rather than B’s')
  orch.cancel('C1')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await third
  assertValid(emitted)
})

test('a fresh:false analyst continuation stays put when the view is already in its own chat (or in nobody’s)', async () => {
  const { orch, analystClient, analyst, emit } = setup({ analystChatMemory: { [CONV]: 'https://x.test/c/a1' } })
  analyst.url = 'https://x.test/c/a1'
  const own = orch.run(analystRequest('chatgpt', { req_id: 'A2', fresh: false }), emit)
  await settleAll()
  assert.deepEqual(analyst.loads, [], 'no navigation: the view is already in this conversation’s chat')
  assert.deepEqual(analystClient.ops(), ['ready'])
  orch.cancel('A2')
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await own

  // an unowned chat (nothing recorded for anyone) is still adopted, exactly as before Stage 3's fix
  const fresh = setup()
  const run = fresh.orch.run(analystRequest('chatgpt', { req_id: 'A3', fresh: false }), fresh.emit)
  await settleAll()
  assert.deepEqual(fresh.analyst.loads, [])
  assert.deepEqual(fresh.analystClient.ops(), ['ready'])
  fresh.orch.cancel('A3')
  fresh.analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await run
})

test('the analyst chat is recorded only for a URL that matches the site’s chatUrlPattern (the site root never becomes a chat)', async () => {
  const { orch, analystClient, analyst, analystChats, emit } = setup()
  const done = orch.run(analystRequest('chatgpt', { fresh: true }), emit)
  await settleAll()
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0, ms: 1 })
  await settleAll()
  analyst.url = 'https://x.test/'
  analystClient.settle('observe', { ok: true, op: 'observe', text: '{}', doneBy: 'quiet', ms: 1, url: 'https://x.test/' })
  assert.equal((await done).ok, true)
  assert.equal(analystChats.size, 0, 'nothing recorded for a URL that is not a chat')
})

// --- S10: the analyst page holds the longest, most structured reply in the system ------------------
//
// `budgets()` was keyed on the slot alone, so the hidden analyst view was given a PANE's timings —
// the ones tuned for a chat answer a human is watching. On 2026-09-20 that ended two analyst captures
// mid-document (13 and 6 characters, reported as `ok`), and Analyze degraded on both. The analyst view
// therefore waits ANALYST_PATIENCE times as long for stillness, is told that its reply is a JSON
// document, and is sent the first-token budget main never used to send at all.

test('S10: the analyst view gets every capture window scaled — stillness, first token AND the whole run — and is told to expect JSON', async () => {
  const { orch, analystClient, emit } = setup()
  const done = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 2 })
  await settleAll()
  const obs = analystClient.last()
  assert.equal(obs.op, 'observe')
  assert.ok(ANALYST_PATIENCE >= 3, 'quiet and settle at least ×3')
  // A reasoning mode inside ChatGPT can render nothing readable for minutes, so the analyst needs a
  // longer RUN, not just longer lulls (measured 2026-09-20: a condense call timed out at chars=0
  // inside a pane's 300 s while its answer arrived shortly after). Capped by the deadline the
  // backend granted for this very request, so the adapter's timeout always reports first.
  assert.deepEqual(obs.payload, {
    baselineCount: 2,
    quietMs: 250 * ANALYST_PATIENCE,
    settleMs: 200 * ANALYST_PATIENCE,
    timeoutMs: 4000 * ANALYST_PATIENCE,
    firstTokenMs: 3000 * ANALYST_PATIENCE,
    expect: 'json',
  })
  analystClient.settle('observe', { ok: true, op: 'observe', text: '```json\n{"agreements": []}\n```', doneBy: 'quiet', ms: 7 })
  const result = await done
  assert.equal(result.ok, true)
  assert.equal(result.done_by, 'quiet')
})

test('S10: the analyst capture is logged like any other — length, signal and time, and no reply text', async () => {
  const { orch, analystClient, emit, log } = setup()
  const done = orch.run(analystRequest('chatgpt'), emit)
  await settleAll()
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0 })
  await settleAll()
  analystClient.settle('observe', { ok: true, op: 'observe', text: '{"agreements": []}', doneBy: 'stop_gone', ms: 78500 })
  await done
  const line = log.lines.map(([, m]) => m).find((m) => m.includes('captured'))
  assert.ok(line, `no capture line in ${JSON.stringify(log.lines)}`)
  assert.match(line, /analyst page \(chatgpt\): captured 18 chars by stop_gone in 78500 ms/)
  for (const [, m] of log.lines) assert.equal(m.includes('agreements'), false, m)
})

test('S10: the scaled analyst budget never outlives the deadline the backend granted for the request', async () => {
  // Past `timeout_s` the bridge has already failed the request, so a capture still running then is
  // reporting into a void: its partial, its doneBy and its reason are all thrown away.
  const { orch, analystClient, emit } = setup()
  const done = orch.run(analystRequest('chatgpt', { timeout_s: 20 }), emit)
  await settleAll()
  analystClient.settle('ready', { ok: true, op: 'ready', composerSelector: '#c' })
  await settleAll()
  analystClient.settle('insertAndSubmit', { ok: true, op: 'insertAndSubmit', submitted: true, assistantCount: 0 })
  await settleAll()
  const obs = analystClient.last()
  assert.ok(obs.payload.timeoutMs < 20000, `${obs.payload.timeoutMs} ms must finish inside the granted 20 s`)
  assert.ok(obs.payload.timeoutMs > 0, 'and still leave a usable window')
  // With room to spare the margin is what it gives back, not half the grant.
  assert.equal(CAPTURE_CEILING_MARGIN_MS, 30000)
  analystClient.settle('observe', { ok: true, op: 'observe', text: '{"agreements": []}', doneBy: 'quiet', ms: 7 })
  await done
})
