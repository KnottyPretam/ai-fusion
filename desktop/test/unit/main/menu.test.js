// menu.js — the Site menu (Reload selectors, Save DOM snapshot, Show analyst page, Sign out of
// <site>) is added to the shortcuts template before Edit; every item drives its action; failures are
// logged, never thrown; the Stage 3 item is omitted when no showAnalyst action is wired.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMenuTemplate, findMenuItem, SITE_LABELS } from '../../../main/menu.js'
import { createShortcuts } from '../../../main/shortcuts.js'
import { fakeLog, tick } from './_fakes.js'

function setup({ dev = true, active = 'grok', failSnapshot = false, showAnalyst = true } = {}) {
  const calls = []
  const log = fakeLog()
  const shortcuts = createShortcuts({ getActive: () => active, zoom: () => 1, reload: (s) => calls.push(['reload', s]), inspect: (s) => calls.push(['inspect', s]), focusRenderer: () => {}, sendToRenderer: () => {}, dev, log })
  const template = buildMenuTemplate({
    shortcuts,
    dev,
    getActive: () => active,
    actions: {
      reloadSelectors: () => calls.push(['reloadSelectors']),
      saveSnapshot: async (slot) => {
        calls.push(['saveSnapshot', slot])
        if (failSnapshot) throw new Error('no view')
        return { path: `/snap/${slot}-1.html` }
      },
      ...(showAnalyst ? { showAnalyst: () => calls.push(['showAnalyst']) } : {}),
      signOut: async (slot) => calls.push(['signOut', slot]),
    },
    log,
  })
  return { template, calls, log }
}

test('the template keeps Triplex / Panes / Edit and inserts Site before Edit with the five items', () => {
  const { template } = setup()
  assert.deepEqual(
    template.map((m) => m.label),
    ['Triplex', 'Panes', 'Site', 'Edit'],
  )
  const site = template[2]
  // one "Sign out of <site>" per slot, in SLOTS order (claude, chatgpt, grok)
  assert.deepEqual(
    site.submenu.map((i) => i.label || i.type),
    ['Reload selectors', 'Save DOM snapshot of the active pane', 'Show analyst page', 'separator', 'Sign out of Claude', 'Sign out of ChatGPT', 'Sign out of Grok'],
  )
  assert.equal(findMenuItem(setup({ showAnalyst: false }).template, 'Show analyst page'), null, 'no analyst manager → no item')
  assert.deepEqual(SITE_LABELS, { chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' })
  assert.ok(findMenuItem(template, 'Reload pane'), 'the Stage 1 items stay')
  assert.ok(findMenuItem(template, 'Inspect pane'), 'dev: Inspect pane present')
  assert.equal(findMenuItem(setup({ dev: false }).template, 'Inspect pane'), null)
  assert.equal(findMenuItem(template, 'Nope'), null)
})

test('clicking the items drives the actions: reload selectors, snapshot of the ACTIVE pane, sign out of each site', async () => {
  const { template, calls, log } = setup({ active: 'claude' })
  findMenuItem(template, 'Reload selectors').click()
  findMenuItem(template, 'Save DOM snapshot of the active pane').click()
  findMenuItem(template, 'Show analyst page').click()
  findMenuItem(template, 'Sign out of Grok').click()
  findMenuItem(template, 'Sign out of ChatGPT').click()
  findMenuItem(template, 'Reload pane').click()
  await tick()
  await tick()
  assert.deepEqual(calls, [['reloadSelectors'], ['saveSnapshot', 'claude'], ['showAnalyst'], ['signOut', 'grok'], ['signOut', 'chatgpt'], ['reload', 'claude']])
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'log' && m.includes('/snap/claude-1.html')), 'the snapshot path is logged')
})

test('a failing or missing action is logged, never thrown; an unknown active slot falls back to the first', async () => {
  const { template, log } = setup({ active: 'bing', failSnapshot: true })
  assert.doesNotThrow(() => findMenuItem(template, 'Save DOM snapshot of the active pane').click())
  await tick()
  await tick()
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('save DOM snapshot failed')))
  const bare = buildMenuTemplate({ actions: {} })
  assert.doesNotThrow(() => findMenuItem(bare, 'Reload selectors').click())
  assert.deepEqual(
    bare.map((m) => m.label),
    ['Triplex', 'Site'],
  )
})
