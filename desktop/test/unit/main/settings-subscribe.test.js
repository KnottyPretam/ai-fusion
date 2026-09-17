// settings.js (Stage 2) — subscribe(): the capture switches (and analyst / zoom / analystVisible)
// notify listeners after the atomic save, so main re-sends the bridge `capture` frame on change.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettings } from '../../../main/settings.js'
import { fakeLog } from './_fakes.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-settings-sub-'))
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

test('subscribe(): capture / analyst / zoom / analystVisible setters notify AFTER saving; unsubscribe stops it; a throwing listener is logged', () => {
  const dir = tmpDir()
  const log = fakeLog()
  const s = createSettings({ dir, log })
  s.load()
  const events = []
  const off = s.subscribe((e) => events.push(e))
  s.subscribe(() => {
    throw new Error('boom')
  })
  s.setCapture('grok', true)
  assert.deepEqual(events, [{ key: 'capture', value: { claude: false, chatgpt: false, grok: true } }])
  assert.equal(readJson(s.file).capture.grok, true, 'saved before the listener ran')
  s.setAnalyst(null)
  s.setZoom('claude', 1.2)
  s.setAnalystVisible(true)
  assert.deepEqual(
    events.map((e) => e.key),
    ['capture', 'analyst', 'zoom', 'analystVisible'],
  )
  assert.deepEqual(events[1].value, null)
  assert.deepEqual(events[2].value, { slot: 'claude', factor: 1.2 })
  assert.equal(events[3].value, true)
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('listener for capture failed')))
  off()
  s.setCapture('grok', false)
  assert.equal(events.length, 4, 'unsubscribed')
  assert.equal(typeof s.subscribe('nope'), 'function', 'a non-function subscriber is a no-op')
  assert.deepEqual(s.getCapture(), { claude: false, chatgpt: false, grok: false })
})
