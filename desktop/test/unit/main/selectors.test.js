// selectors.js — override replaces per key, unknown key warns, bad JSON keeps the last good config;
// 2026-10-17: trustedInputFor (the merged boolean, else the adapter's default — true only for gemini) and the
// hot kill switch `{"gemini":{"trustedInput":false}}`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createSelectorsLoader, mergeOverride, timeoutsFor, trustedInputFor, DEFAULT_SELECTORS, TRUSTED_VERIFY_MS } from '../../../main/selectors.js'
import { SLOTS } from '../../../main/sites.js'
import { fakeLog } from './_fakes.js'

const require = createRequire(import.meta.url)
const siteAdapter = require('../../../preload/site.cjs')

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
  for (const slot of SLOTS) {
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

test('trustedInputFor: the adapter default is true for gemini only; a boolean in the merged config wins (the selectors.json kill switch); the loader hot-reloads it', () => {
  for (const slot of ['claude', 'chatgpt', 'grok']) assert.equal(trustedInputFor(DEFAULT_SELECTORS, slot), false, `${slot}: the synthetic path`)
  assert.equal(trustedInputFor(DEFAULT_SELECTORS, 'gemini'), true, 'gemini: main types with trusted input')
  assert.equal(trustedInputFor(DEFAULT_SELECTORS, 'deepseek'), false, 'no site, no default')
  assert.equal(trustedInputFor(null, 'gemini'), true, 'no config at all → the default')
  assert.equal(trustedInputFor({ version: 1 }, 'gemini'), true, 'a config without the site → the default')
  // the merged config's own boolean
  const off = mergeOverride(DEFAULT_SELECTORS, JSON.stringify({ gemini: { trustedInput: false } }))
  assert.equal(off.error, null)
  assert.deepEqual(off.warnings, [])
  assert.equal(trustedInputFor(off.merged, 'gemini'), false, 'the kill switch')
  const on = mergeOverride(DEFAULT_SELECTORS, { chatgpt: { trustedInput: true } })
  assert.equal(trustedInputFor(on.merged, 'chatgpt'), true, 'an A/B lever for another site')
  assert.equal(trustedInputFor({ gemini: { trustedInput: 'no' } }, 'gemini'), true, 'a non-boolean is not an answer: the default stands')
  // hot reload: main reads selectors.current() per turn, and a rewritten file flips the answer on the next load
  const { store, readFile } = fileWith(JSON.stringify({ gemini: { trustedInput: false } }))
  const loader = createSelectorsLoader({ filePath: '/x/selectors.json', readFile, log: fakeLog() })
  loader.load()
  assert.equal(trustedInputFor(loader.current(), 'gemini'), false)
  store.text = JSON.stringify({ version: 1 })
  loader.reload()
  assert.equal(trustedInputFor(loader.current(), 'gemini'), true, 'deleting the override restores the default')
  store.text = '{broken'
  loader.reload()
  assert.equal(trustedInputFor(loader.current(), 'gemini'), true, 'bad JSON keeps the last good config')
})

test('TRUSTED_VERIFY_MS is the adapter\'s own verifyInput window (main budgets exactly what the preload waits)', () => {
  assert.equal(TRUSTED_VERIFY_MS, Number.isFinite(siteAdapter.TRUSTED_VERIFY_MS) ? siteAdapter.TRUSTED_VERIFY_MS : 1000)
  assert.ok(TRUSTED_VERIFY_MS >= 0)
})
