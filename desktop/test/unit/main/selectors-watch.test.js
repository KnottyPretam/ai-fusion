// selectors.js (Stage 2) — fs.watch hot reload: the override's directory is watched, changes are
// debounced, the reload reports {config, error, changed}; an invalid file keeps the last good
// config and surfaces the error; the v2 capture budgets and chatUrlPattern helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSelectorsLoader, captureTimeoutsFor, chatUrlPatternFor, DEFAULT_SELECTORS, WATCH_DEBOUNCE_MS } from '../../../main/selectors.js'
import { fakeLog, fakeTimers } from './_fakes.js'

function fileWith(contents) {
  const store = { text: contents }
  const readFile = (p) => {
    if (store.text === null) {
      const e = new Error(`ENOENT: ${p}`)
      e.code = 'ENOENT'
      throw e
    }
    return store.text
  }
  return { store, readFile }
}

test('watch(): a debounced change to the override reloads and reports {config, error, changed}; invalid → last good + error; stop() ends it', () => {
  const { store, readFile } = fileWith(JSON.stringify({ chatgpt: { composer: ['#one'] } }))
  const timers = fakeTimers()
  const log = fakeLog()
  const loader = createSelectorsLoader({ filePath: '/x/dir/selectors.json', readFile, log })
  loader.load()
  const watched = []
  let listener = null
  let closed = 0
  const events = []
  const stop = loader.watch({
    watch: (dir, opts, cb) => {
      watched.push([dir, opts])
      listener = cb
      return { close: () => (closed += 1), on: () => {} }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onChange: (e) => events.push(e),
  })
  assert.deepEqual(watched, [['/x/dir', { persistent: false }]], 'the DIRECTORY is watched (editors save by rename)')
  store.text = JSON.stringify({ chatgpt: { composer: ['#two'] } })
  listener('change', 'selectors.json')
  listener('rename', 'selectors.json')
  listener('change', 'other.json')
  assert.deepEqual(events, [], 'debounced')
  timers.advance(WATCH_DEBOUNCE_MS - 1)
  assert.deepEqual(events, [])
  timers.advance(1)
  assert.equal(events.length, 1, 'three events → one reload')
  assert.deepEqual(events[0].config.chatgpt.composer, ['#two'])
  assert.equal(events[0].error, null)
  assert.equal(events[0].changed, true)
  assert.deepEqual(loader.current().chatgpt.composer, ['#two'])

  listener('change', 'selectors.json')
  timers.advance(WATCH_DEBOUNCE_MS)
  assert.equal(events[1].changed, false, 'same content → changed:false (main need not push)')

  store.text = '{oops'
  listener('change', 'selectors.json')
  timers.advance(WATCH_DEBOUNCE_MS)
  assert.equal(events[2].changed, true, 'the error state changed')
  assert.match(events[2].error, /not valid JSON/)
  assert.deepEqual(events[2].config.chatgpt.composer, ['#two'], 'last good config kept')
  assert.equal(loader.lastError(), events[2].error)

  store.text = JSON.stringify({ chatgpt: { composer: ['#three'] } })
  listener('change', null) // some platforms report no filename
  timers.advance(WATCH_DEBOUNCE_MS)
  assert.deepEqual(events[3].config.chatgpt.composer, ['#three'])
  assert.equal(events[3].error, null)

  stop()
  assert.equal(closed, 1)
  listener('change', 'selectors.json')
  timers.advance(WATCH_DEBOUNCE_MS)
  assert.equal(events.length, 4, 'stopped')
  assert.equal(timers.pending(), 0)

  assert.equal(typeof createSelectorsLoader({ readFile, log }).watch({ watch: () => assert.fail('no override path: must not watch') }), 'function')
  createSelectorsLoader({ filePath: '/x/dir/selectors.json', readFile, log }).watch({
    watch: () => {
      throw new Error('ENOENT')
    },
  })
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('cannot watch /x/dir')))
})

test('captureTimeoutsFor / chatUrlPatternFor read the v2 keys with the contract defaults', () => {
  assert.deepEqual(captureTimeoutsFor(DEFAULT_SELECTORS, 'chatgpt'), { quietMs: 2500, firstTokenMs: 90000, captureTimeoutMs: 300000 })
  assert.deepEqual(captureTimeoutsFor({ grok: { quietMs: 100, captureTimeoutMs: -5 } }, 'grok'), { quietMs: 100, firstTokenMs: 90000, captureTimeoutMs: 300000 })
  assert.deepEqual(captureTimeoutsFor(null, 'claude'), { quietMs: 2500, firstTokenMs: 90000, captureTimeoutMs: 300000 })
  assert.equal(chatUrlPatternFor(DEFAULT_SELECTORS, 'claude'), DEFAULT_SELECTORS.claude.chatUrlPattern)
  assert.equal(chatUrlPatternFor({ claude: { chatUrlPattern: '^http://127' } }, 'claude'), '^http://127')
  assert.equal(chatUrlPatternFor(null, 'grok'), DEFAULT_SELECTORS.grok.chatUrlPattern)
  assert.equal(chatUrlPatternFor({ grok: { chatUrlPattern: '' } }, 'grok'), DEFAULT_SELECTORS.grok.chatUrlPattern)
})
