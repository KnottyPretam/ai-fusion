// selectors.js — override replaces per key, unknown key warns, bad JSON keeps the last good config.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSelectorsLoader, mergeOverride, timeoutsFor, DEFAULT_SELECTORS } from '../../../main/selectors.js'
import { fakeLog } from './_fakes.js'

function fileWith(contents) {
  const store = { text: contents }
  const readFile = (p) => {
    if (store.text === null) {
      const e = new Error(`ENOENT: ${p}`)
      e.code = 'ENOENT'
      throw e
    }
    if (store.text instanceof Error) throw store.text
    return store.text
  }
  return { store, readFile }
}

test('DEFAULT_SELECTORS come from site.cjs and every chatUrlPattern compiles', () => {
  for (const slot of ['chatgpt', 'claude', 'grok']) {
    assert.ok(Array.isArray(DEFAULT_SELECTORS[slot].composer), slot)
    assert.doesNotThrow(() => new RegExp(DEFAULT_SELECTORS[slot].chatUrlPattern), slot)
  }
})

test('override replaces the whole key (not appended), other keys and sites untouched', () => {
  const { store, readFile } = fileWith(JSON.stringify({ version: 1, chatgpt: { composer: ['#mine'] } }))
  const log = fakeLog()
  const loader = createSelectorsLoader({ filePath: '/x/selectors.json', readFile, log })
  const { config, warnings, error } = loader.load()
  assert.equal(error, null)
  assert.deepEqual(warnings, [])
  assert.deepEqual(config.chatgpt.composer, ['#mine'])
  assert.deepEqual(config.chatgpt.send, DEFAULT_SELECTORS.chatgpt.send)
  assert.deepEqual(config.claude, DEFAULT_SELECTORS.claude)
  assert.equal(config.version, 1)
  assert.equal(loader.current(), config)
  assert.notEqual(config.chatgpt, DEFAULT_SELECTORS.chatgpt, 'defaults are never mutated')
  assert.deepEqual(DEFAULT_SELECTORS.chatgpt.composer[0], '#prompt-textarea')
  store.text = null
})

test('unknown key → warning (logged), value dropped, the rest merged', () => {
  const { readFile } = fileWith(JSON.stringify({ claude: { nope: ['x'], send: ['button.go'] }, bing: { composer: ['y'] } }))
  const log = fakeLog()
  const loader = createSelectorsLoader({ filePath: '/x/selectors.json', readFile, log })
  const { config, warnings, error } = loader.load()
  assert.equal(error, null)
  assert.ok(warnings.some((w) => w.includes('claude.nope') && w.includes('unknown key')), JSON.stringify(warnings))
  assert.ok(warnings.some((w) => w.includes('bing') && w.includes('unknown site')))
  assert.deepEqual(config.claude.send, ['button.go'])
  assert.equal('nope' in config.claude, false)
  assert.equal('bing' in config, false)
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('claude.nope')))
  assert.deepEqual(loader.warnings(), warnings)
})

test('bad JSON keeps the last good config and reports lastError(); a fixed file clears it', () => {
  const { store, readFile } = fileWith(JSON.stringify({ grok: { composer: ['textarea.good'] } }))
  const log = fakeLog()
  const loader = createSelectorsLoader({ filePath: '/x/selectors.json', readFile, log })
  loader.load()
  assert.deepEqual(loader.current().grok.composer, ['textarea.good'])

  store.text = '{ this is not json'
  const r = loader.reload()
  assert.ok(r.error && r.error.includes('not valid JSON'), r.error)
  assert.equal(loader.lastError(), r.error)
  assert.deepEqual(loader.current().grok.composer, ['textarea.good'], 'last good config kept')
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('keeping the last good config')))

  store.text = JSON.stringify({ grok: { composer: ['textarea.fixed'] } })
  const ok = loader.reload()
  assert.equal(ok.error, null)
  assert.equal(loader.lastError(), null)
  assert.deepEqual(loader.current().grok.composer, ['textarea.fixed'])
})

test('a missing override file is not an error and yields the defaults; an unreadable one keeps the last good', () => {
  const { store, readFile } = fileWith(null)
  const loader = createSelectorsLoader({ filePath: '/x/selectors.json', readFile, log: fakeLog() })
  const r = loader.load()
  assert.equal(r.error, null)
  assert.deepEqual(r.config, DEFAULT_SELECTORS)
  store.text = JSON.stringify({ claude: { composer: ['.c'] } })
  loader.reload()
  const eacces = new Error('EACCES')
  eacces.code = 'EACCES'
  store.text = eacces
  const bad = loader.reload()
  assert.ok(bad.error && bad.error.includes('unreadable'))
  assert.deepEqual(loader.current().claude.composer, ['.c'])
})

test('no filePath → defaults, never reads', () => {
  const loader = createSelectorsLoader({ readFile: () => assert.fail('must not read'), log: fakeLog() })
  assert.deepEqual(loader.load().config, DEFAULT_SELECTORS)
  assert.equal(loader.filePath, null)
})

test('mergeOverride: a type mismatch warns and keeps the default; the version key is checked', () => {
  const { merged, warnings, error } = mergeOverride(DEFAULT_SELECTORS, { version: 2, chatgpt: { composer: 'not-a-list', composerWaitMs: 999 } })
  assert.equal(error, null)
  assert.deepEqual(merged.chatgpt.composer, DEFAULT_SELECTORS.chatgpt.composer)
  assert.equal(merged.chatgpt.composerWaitMs, 999)
  assert.ok(warnings.some((w) => w.startsWith('version:')))
  assert.ok(warnings.some((w) => w.includes('chatgpt.composer')))
  assert.ok(mergeOverride(DEFAULT_SELECTORS, '{oops').error)
})

test('timeoutsFor reads the merged per-site budgets with defaults for missing / bad values', () => {
  assert.deepEqual(timeoutsFor(DEFAULT_SELECTORS, 'claude'), { composerWaitMs: 15000, sendWaitMs: 18000, submitVerifyMs: 5000 })
  assert.deepEqual(timeoutsFor({ claude: { composerWaitMs: 1000, sendWaitMs: -1 } }, 'claude'), { composerWaitMs: 1000, sendWaitMs: 18000, submitVerifyMs: 5000 })
  assert.deepEqual(timeoutsFor(null, 'grok'), { composerWaitMs: 15000, sendWaitMs: 18000, submitVerifyMs: 5000 })
})
