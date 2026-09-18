// analyst-views.js — the hidden analyst page (Stage 3): lazy creation on persist:<settings.analyst>
// with the site preload and the pane hardening, attached hidden, zoom pinned to 1, the policy /
// permissions / device-chooser rules of a site view; adapterFor gating (null analyst, or a slot
// that is not the chosen one); setAnalyst switching the partition (old view destroyed, new hidden
// view); auto-reveal on a challenge / logged_out health; the `analyst` layout rect driving bounds
// and visibility; slotOfSender; navigation + focus for the orchestrator; the per-conversation
// analyst chat memory (chatFor / chatOwner / noteChat); the selector hot reload.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ANALYST_CHAT_MEMORY, createAnalystViews, REVEAL_SESSIONS } from '../../../main/analyst-views.js'
import { normalizeLayout } from '../../../main/layout.js'
import { isPoliced } from '../../../main/policy.js'
import { hasDeviceChooserPolicy } from '../../../main/permissions.js'
import { makeFakeWebContentsViewClass, fakeSession, fakeSettings, fakeIpcMain, fakeTimers, fakeLog, fakeSites, eventFrom, tick } from './_fakes.js'

const PRELOAD = '/app/preload/site.cjs'

function health(session = 'ok', extra = {}) {
  return {
    composer: true,
    send: true,
    reply: false,
    stop: false,
    session,
    matched: { composer: '#c', send: '#s', reply: null, stop: null, error: null },
    url: 'http://127.0.0.1:5199/',
    host: '127.0.0.1',
    title: 't',
    ts: 1,
    ...extra,
  }
}

/** A manager over fakes; `instances` collects every WebContentsView built, `states` every onState. */
function setup({ analyst = 'chatgpt', analystVisible = false } = {}) {
  const instances = []
  const sessions = new Map()
  const states = []
  const timers = fakeTimers()
  const log = fakeLog()
  const sites = fakeSites()
  const settings = fakeSettings(undefined, { analyst, analystVisible })
  const contentView = { added: [], removed: [], addChildView: (v) => contentView.added.push(v), removeChildView: (v) => contentView.removed.push(v) }
  const manager = createAnalystViews({
    WebContentsView: makeFakeWebContentsViewClass(instances),
    sessionFromPartition: (p) => {
      if (!sessions.has(p)) sessions.set(p, fakeSession(p))
      return sessions.get(p)
    },
    contentView,
    sites,
    preload: PRELOAD,
    settings,
    ipcMain: fakeIpcMain(),
    openExternal: () => {},
    onState: (s) => states.push(s),
    log,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    ssoHosts: [],
  })
  return { manager, instances, sessions, states, contentView, settings, sites, timers, log }
}

test('nothing is created until something asks: adapterFor builds the view on persist:<analyst>, hidden, zoom 1, hardened', async () => {
  const { manager, instances, contentView, sessions } = setup()
  assert.equal(instances.length, 0, 'lazy: no view at construction')
  assert.equal(manager.get(), null)
  assert.equal(manager.slot(), 'chatgpt')

  const client = manager.adapterFor('chatgpt')
  assert.ok(client, 'an adapter client for the chosen analyst')
  assert.equal(instances.length, 1)
  const view = instances[0]
  const wp = view.options.webPreferences
  assert.equal(wp.partition, 'persist:chatgpt', 'the analyst shares the slot’s logged-in partition')
  assert.equal(wp.preload, PRELOAD)
  assert.equal(wp.sandbox, true)
  assert.equal(wp.contextIsolation, true)
  assert.equal(wp.nodeIntegration, false)
  assert.equal(wp.backgroundThrottling, false, 'a hidden view must keep running')
  assert.equal(wp.zoomFactor, 1)
  assert.equal(view.webContents.zoom, 1)
  assert.equal(view.getVisible(), false, 'attached with setVisible(false)')
  assert.deepEqual(contentView.added, [view], 'addChildView')
  assert.equal(isPoliced(view.webContents), true, 'the same popup / navigation policy as a pane')
  assert.equal(hasDeviceChooserPolicy(view.webContents), true)
  assert.ok(sessions.get('persist:chatgpt'), 'permissions applied to the partition')
  assert.equal(sessions.get('persist:chatgpt').requestHandler !== null, true)
  await tick()
  assert.deepEqual(view.webContents.loads, ['http://127.0.0.1:5199/?site=chatgpt'], 'loads the site’s newChatUrl')

  // a second call reuses the same view and the same client
  assert.equal(manager.adapterFor('chatgpt'), client)
  assert.equal(instances.length, 1)
})

test('adapterFor: null analyst → null (the orchestrator answers analyst_not_chosen), and a slot that is not the chosen one → null', () => {
  const none = setup({ analyst: null })
  assert.equal(none.manager.slot(), null)
  assert.equal(none.manager.adapterFor('chatgpt'), null)
  assert.equal(none.manager.adapterFor(null), null)
  assert.equal(none.instances.length, 0, 'nothing is ever built without an analyst')

  const chosen = setup({ analyst: 'claude' })
  assert.equal(chosen.manager.adapterFor('chatgpt'), null, 'chatgpt is not the chosen analyst')
  assert.equal(chosen.instances.length, 0)
  assert.ok(chosen.manager.adapterFor('claude'))
  assert.equal(chosen.instances[0].options.webPreferences.partition, 'persist:claude')
})

test('setAnalyst switches the partition: the old view is destroyed and a new hidden one is created; null tears the view down and stays lazy', () => {
  const { manager, instances, contentView, states, settings } = setup()
  manager.adapterFor('chatgpt')
  const first = instances[0]
  assert.equal(instances.length, 1)

  manager.setAnalyst('grok')
  assert.equal(settings.analyst, 'grok', 'persisted in settings.json')
  assert.equal(instances.length, 2, 'recreated because one existed')
  assert.deepEqual(contentView.removed, [first], 'the old view is detached')
  assert.equal(first.webContents.isDestroyed(), true, 'and closed')
  assert.equal(instances[1].options.webPreferences.partition, 'persist:grok')
  assert.equal(instances[1].getVisible(), false, 'the new one is hidden too')
  assert.equal(manager.getHealth(), null, 'the old view’s health never describes the new one')
  assert.deepEqual(states.at(-1), { slot: 'grok', visible: false, health: null })

  manager.setAnalyst(null)
  assert.equal(instances.length, 2, 'null creates nothing')
  assert.equal(instances[1].webContents.isDestroyed(), true)
  assert.equal(manager.adapterFor('grok'), null)
  assert.deepEqual(states.at(-1), { slot: null, visible: false, health: null })

  assert.throws(() => manager.setAnalyst('nope'), /unknown slot/)
})

test('setAnalyst to the SAME slot keeps the view (no partition change, nothing destroyed)', () => {
  const { manager, instances, contentView } = setup()
  manager.adapterFor('chatgpt')
  manager.setAnalyst('chatgpt')
  assert.equal(instances.length, 1)
  assert.deepEqual(contentView.removed, [])
  assert.equal(instances[0].webContents.isDestroyed(), false)
})

test('a challenge or logged_out health reveals the analyst view (decision 7) and reaches the renderer as panes:analyst', () => {
  for (const session of REVEAL_SESSIONS) {
    const { manager, states, settings } = setup()
    manager.adapterFor('chatgpt')
    manager.setHealth(health(session))
    assert.equal(settings.analystVisible, true, `${session} persists analystVisible`)
    const last = states.at(-1)
    assert.equal(last.visible, true, `${session} → panes:analyst visible:true`)
    assert.equal(last.slot, 'chatgpt')
    assert.equal(last.health.session, session)
  }
})

test('an ok health publishes the state without revealing anything, and a health that is not an object is ignored', () => {
  const { manager, states, settings } = setup()
  manager.adapterFor('chatgpt')
  manager.setHealth(health('ok'))
  assert.equal(settings.analystVisible, false)
  assert.deepEqual(states.at(-1).visible, false)
  assert.equal(manager.getHealth().session, 'ok')
  const before = states.length
  assert.equal(manager.setHealth(null), null)
  assert.equal(manager.setHealth('nope'), null)
  assert.equal(states.length, before, 'nothing published for a malformed health')
  assert.equal(manager.getHealth().session, 'ok')
})

test('a view already revealed stays revealed on a second challenge health (no repeated writes, one state per report)', () => {
  const { manager, states, settings } = setup({ analystVisible: true })
  manager.adapterFor('chatgpt')
  const before = states.length
  manager.setHealth(health('challenge'))
  assert.equal(settings.analystVisible, true)
  assert.equal(states.length, before + 1)
})

test('a manual hide is respected while the session stays broken: only the transition into challenge / logged_out reveals', () => {
  const { manager, settings, states } = setup()
  manager.adapterFor('chatgpt')
  manager.setHealth(health('challenge'))
  assert.equal(settings.analystVisible, true)
  manager.setVisible(false) // the user closes the tab again
  assert.equal(settings.analystVisible, false)
  manager.setHealth(health('challenge')) // the adapter's 10 s heartbeat
  assert.equal(settings.analystVisible, false, 'the heartbeat does not reopen the tab')
  assert.equal(states.at(-1).visible, false)
  // recovering and breaking again DOES reveal it: that is a new transition
  manager.setHealth(health('ok'))
  manager.setHealth(health('logged_out'))
  assert.equal(settings.analystVisible, true)
})

test('the analyst layout rect drives bounds + visibility only while the analyst is visible; null hides it', () => {
  const { manager, instances } = setup({ analystVisible: true })
  manager.adapterFor('chatgpt')
  const view = instances[0]
  manager.applyLayout(normalizeLayout({ analyst: { x: 10.4, y: 20.6, width: 300, height: 400 }, claude: { x: 0, y: 0, width: 5, height: 5 } }))
  assert.deepEqual(view.getBounds(), { x: 10, y: 21, width: 300, height: 400 })
  assert.equal(view.getVisible(), true)

  manager.applyLayout(normalizeLayout({ analyst: null }))
  assert.equal(view.getVisible(), false)

  // a rect reported while the analyst is hidden never shows it
  manager.setVisible(false)
  manager.applyLayout(normalizeLayout({ analyst: { x: 1, y: 2, width: 3, height: 4 } }))
  assert.equal(view.getVisible(), false)
})

test('showAnalyst(true) creates the view lazily and persists the flag; showAnalyst(false) hides it at once', () => {
  const { manager, instances, settings, states } = setup()
  assert.equal(instances.length, 0)
  manager.setVisible(true)
  assert.equal(settings.analystVisible, true)
  assert.equal(instances.length, 1, 'revealing builds the view')
  assert.equal(instances[0].getVisible(), false, 'still nothing to show until the renderer reports a rect')
  manager.applyLayout(normalizeLayout({ analyst: { x: 0, y: 0, width: 100, height: 100 } }))
  assert.equal(instances[0].getVisible(), true)

  manager.setVisible(false)
  assert.equal(settings.analystVisible, false)
  assert.equal(instances[0].getVisible(), false)
  assert.deepEqual(states.at(-1), { slot: 'chatgpt', visible: false, health: null })
})

test('an analyst rect reported while the analyst is visible creates the view (the fourth tab opened before any analyst call)', () => {
  const { manager, instances } = setup({ analystVisible: true })
  assert.equal(instances.length, 0)
  manager.applyLayout(normalizeLayout({ analyst: { x: 0, y: 0, width: 10, height: 10 } }))
  assert.equal(instances.length, 1)
  assert.equal(instances[0].getVisible(), true)
})

test('slotOfSender matches only the analyst view’s own main frame', () => {
  const { manager, instances } = setup()
  assert.equal(manager.slotOfSender(eventFrom({ id: 1 })), null, 'no view yet')
  manager.adapterFor('chatgpt')
  const wc = instances[0].webContents
  assert.equal(manager.slotOfSender(eventFrom(wc)), 'chatgpt')
  assert.equal(manager.slotOfSender(eventFrom(wc, { parent: {} })), null, 'a sub-frame is not the analyst')
  assert.equal(manager.slotOfSender(eventFrom({ id: 987654 })), null)
  assert.equal(manager.slotOfSender(null), null)
})

test('navigation seam: newChatUrl / loadUrl / pendingNavigation / currentUrl / focus for the orchestrator', async () => {
  const { manager, instances, timers } = setup()
  assert.equal(manager.newChatUrl(), 'http://127.0.0.1:5199/?site=chatgpt')
  manager.adapterFor('chatgpt')
  const wc = instances[0].webContents

  // the initial load is tracked: a request must wait for it to commit before `ready`
  const pending = manager.pendingNavigation()
  assert.ok(pending && typeof pending.then === 'function')
  wc.emit('did-navigate', {}, 'http://127.0.0.1:5199/?site=chatgpt')
  await pending
  assert.equal(manager.pendingNavigation(), null)

  await manager.loadUrl('http://127.0.0.1:5199/?site=chatgpt')
  assert.equal(wc.loads.at(-1), 'http://127.0.0.1:5199/?site=chatgpt')
  assert.equal(manager.currentUrl(), 'http://127.0.0.1:5199/?site=chatgpt')
  assert.equal(manager.focus(), true)
  assert.equal(wc.focused, 1, 'a hidden view still takes focus (the Stage 0 spike)')

  await assert.rejects(() => manager.loadUrl('https://evil.example/'), (e) => e.code === 'navigation')
  assert.equal(wc.loads.filter((u) => u.includes('evil')).length, 0, 'nothing off the site’s hosts is ever loaded')
  timers.advance(60000)
})

test('loadUrl / focus / currentUrl are inert without a view, and loadUrl reports view_crashed', async () => {
  const { manager } = setup({ analyst: null })
  assert.equal(manager.newChatUrl(), null)
  assert.equal(manager.currentUrl(), '')
  assert.equal(manager.focus(), false)
  assert.equal(manager.pendingNavigation(), null)
  await assert.rejects(() => manager.loadUrl('http://127.0.0.1:5199/'), (e) => e.code === 'view_crashed')
})

test('a crashed analyst view publishes a view_crashed health and is recreated once, hidden — and the recreate publishes the cleared health', () => {
  const { manager, instances, timers, states } = setup()
  manager.adapterFor('chatgpt')
  const wc = instances[0].webContents
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  assert.equal(manager.getHealth().matched.error, 'view_crashed')
  assert.equal(states.at(-1).health.matched.error, 'view_crashed')
  assert.equal(instances.length, 1, 'not recreated synchronously')
  timers.advance(1000)
  assert.equal(instances.length, 2, 'recreated after the delay')
  assert.equal(instances[1].getVisible(), false)
  assert.equal(instances[1].options.webPreferences.partition, 'persist:chatgpt')
  // main's own gate is open again (rejectFromHealth(null) lets a turn through): the renderer must
  // hear that too, or the fourth tab keeps a red view_crashed chip on a live view for seconds
  assert.equal(manager.getHealth(), null)
  assert.equal(states.at(-1).health, null, 'the recreated view’s cleared state reached the renderer')
  assert.deepEqual(states.at(-1), { slot: 'chatgpt', visible: false, health: null })
})

test('setAnalyst(null) hides the fourth tab: nothing is left behind it (the deck would keep an empty half)', () => {
  const { manager, instances, settings, states } = setup({ analystVisible: true })
  manager.adapterFor('chatgpt')
  manager.applyLayout(normalizeLayout({ analyst: { x: 0, y: 0, width: 100, height: 100 } }))
  assert.equal(instances[0].getVisible(), true, 'revealed as the fourth pane')

  manager.setAnalyst(null) // the drawer: "ollama:hermes3" or "— none —"
  assert.equal(manager.get(), null, 'no view behind the tab any more')
  assert.equal(settings.analystVisible, false, 'so the tab is hidden, and that is persisted')
  assert.deepEqual(states.at(-1), { slot: null, visible: false, health: null })
  assert.equal(instances[0].webContents.isDestroyed(), true, 'the view behind the tab is gone')

  // choosing a web analyst again leaves the tab closed until the user asks for it
  manager.setAnalyst('grok')
  assert.equal(settings.analystVisible, false)
  assert.deepEqual(states.at(-1), { slot: 'grok', visible: false, health: null })
})

test('revealing the analyst pane is refused while no analyst is chosen (nothing would be behind the tab)', () => {
  const { manager, instances, settings, states } = setup({ analyst: null })
  assert.equal(manager.setVisible(true), false)
  assert.equal(settings.analystVisible, false, 'not persisted: there is no page to show')
  assert.equal(instances.length, 0)
  assert.deepEqual(states.at(-1), { slot: null, visible: false, health: null })

  // with an analyst it is persisted as before
  manager.setAnalyst('grok')
  assert.equal(manager.setVisible(true), true)
  assert.equal(settings.analystVisible, true)
})

test('setAnalyst(null) with the tab already closed publishes exactly one state', () => {
  const { manager, states } = setup()
  manager.adapterFor('chatgpt')
  const before = states.length
  manager.setAnalyst(null)
  assert.equal(states.length, before + 1, 'no double publish when there is nothing to hide')
  assert.deepEqual(states.at(-1), { slot: null, visible: false, health: null })
})

test('the per-conversation analyst chat memory: noteChat / chatFor / chatOwner, capped, and cleared when the slot changes', () => {
  const { manager } = setup()
  const A = 'a1111111-2222-4333-8444-555555555555'
  const B = 'b1111111-2222-4333-8444-555555555555'
  assert.equal(manager.chatFor(A), null)
  assert.equal(manager.chatOwner('https://chatgpt.test/c/1'), null)

  manager.noteChat(A, 'https://chatgpt.test/c/a')
  manager.noteChat(B, 'https://chatgpt.test/c/b')
  assert.equal(manager.chatFor(A), 'https://chatgpt.test/c/a')
  assert.equal(manager.chatOwner('https://chatgpt.test/c/b'), B, 'the orchestrator asks whose chat the view is in')
  assert.equal(manager.chatOwner('https://chatgpt.test/c/zz'), null)

  // the newest URL of a conversation wins, and junk is ignored
  manager.noteChat(A, 'https://chatgpt.test/c/a2')
  assert.equal(manager.chatFor(A), 'https://chatgpt.test/c/a2')
  assert.equal(manager.chatOwner('https://chatgpt.test/c/a'), null, 'the replaced URL belongs to nobody')
  for (const bad of [null, undefined, '', 42]) {
    assert.equal(manager.noteChat(bad, 'https://chatgpt.test/c/x'), null)
    assert.equal(manager.noteChat(A, bad), null)
    assert.equal(manager.chatFor(bad), null)
    assert.equal(manager.chatOwner(bad), null)
  }
  assert.equal(manager.chatFor(A), 'https://chatgpt.test/c/a2', 'unchanged by the junk')

  // bounded: a long session never grows the map for ever, and the newest entries are the kept ones
  for (let i = 0; i < ANALYST_CHAT_MEMORY + 5; i++) manager.noteChat(`conv-${i}`, `https://chatgpt.test/c/${i}`)
  assert.equal(manager.chatFor(A), null, 'the oldest entries fell out')
  assert.equal(manager.chatFor(`conv-${ANALYST_CHAT_MEMORY + 4}`), `https://chatgpt.test/c/${ANALYST_CHAT_MEMORY + 4}`)
  assert.equal(manager.chatFor('conv-0'), null)

  // the URLs belong to the site that is going away
  manager.noteChat(A, 'https://chatgpt.test/c/a3')
  manager.setAnalyst('grok')
  assert.equal(manager.chatFor(A), null, 'a new partition starts with no remembered chats')
  assert.equal(manager.chatOwner('https://chatgpt.test/c/a3'), null)
})

test('pushConfig reaches the analyst view too (the §4 selector hot reload), and is a no-op while lazy', () => {
  const { manager, instances } = setup()
  assert.equal(manager.pushConfig({ version: 1 }), 0, 'nothing to push before the view exists')
  manager.adapterFor('chatgpt')
  assert.equal(manager.pushConfig({ version: 1, chatgpt: {} }), 1)
  assert.deepEqual(instances[0].webContents.adapterMessages().at(-1), { op: 'config', selectors: { version: 1, chatgpt: {} } })
})

test('createAnalystViews refuses to build without its collaborators', () => {
  assert.throws(() => createAnalystViews({}), /WebContentsView is required/)
  assert.throws(() => createAnalystViews({ WebContentsView: class {} }), /contentView is required/)
  assert.throws(() => createAnalystViews({ WebContentsView: class {}, contentView: { addChildView() {} } }), /sites, settings and ipcMain are required/)
})
