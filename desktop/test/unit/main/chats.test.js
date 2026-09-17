// chats.js — (conversation, slot) → chat URL, atomic JSON round trip, corrupt-file recovery.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChats, sanitizeChats, CHATS_FILE } from '../../../main/chats.js'
import { fakeLog } from './_fakes.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-chats-'))
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'

test('empty start: no file → {}, get() null, links() {}', () => {
  const dir = tmpDir()
  const c = createChats({ dir, log: fakeLog() })
  assert.deepEqual(c.load(), {})
  assert.equal(c.get(CONV, 'claude'), null)
  assert.deepEqual(c.links(CONV), {})
  assert.equal(c.file, path.join(dir, CHATS_FILE))
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written until the first set')
})

test('set / get / links / forget round-trip atomically and load back identically', () => {
  const dir = tmpDir()
  const c = createChats({ dir, log: fakeLog() })
  c.load()
  assert.equal(c.set(CONV, 'chatgpt', 'https://chatgpt.com/c/abc'), true)
  assert.equal(c.set(CONV, 'chatgpt', 'https://chatgpt.com/c/abc'), false, 'unchanged → false')
  assert.equal(c.set(CONV, 'grok', 'https://grok.com/c/xyz'), true)
  assert.equal(c.set('other', 'claude', 'https://claude.ai/chat/1'), true)
  assert.deepEqual(readJson(c.file), { [CONV]: { chatgpt: 'https://chatgpt.com/c/abc', grok: 'https://grok.com/c/xyz' }, other: { claude: 'https://claude.ai/chat/1' } })
  assert.deepEqual(fs.readdirSync(dir), [CHATS_FILE], 'no tmp file left behind')
  assert.equal(c.get(CONV, 'grok'), 'https://grok.com/c/xyz')
  assert.equal(c.get(CONV, 'claude'), null)
  assert.deepEqual(c.links(CONV), { chatgpt: 'https://chatgpt.com/c/abc', grok: 'https://grok.com/c/xyz' })
  c.links(CONV).chatgpt = 'mutated'
  assert.equal(c.get(CONV, 'chatgpt'), 'https://chatgpt.com/c/abc', 'links() is a copy')

  const again = createChats({ dir, log: fakeLog() })
  assert.deepEqual(again.load(), c.all())
  assert.equal(again.forgetSlot(CONV, 'grok'), true)
  assert.deepEqual(again.links(CONV), { chatgpt: 'https://chatgpt.com/c/abc' })
  assert.equal(again.forget('other'), true)
  assert.equal(again.forget('other'), false)
  assert.deepEqual(readJson(again.file), { [CONV]: { chatgpt: 'https://chatgpt.com/c/abc' } })
  assert.equal(again.forgetSlot(CONV, 'chatgpt'), true)
  assert.deepEqual(readJson(again.file), {}, 'a conversation with no links left is dropped')
})

test('validation: unknown slot / empty id / empty url throw; get() with a bad id is null', () => {
  const c = createChats({ dir: tmpDir(), log: fakeLog() })
  assert.throws(() => c.set(CONV, 'bing', 'u'), /unknown slot/)
  assert.throws(() => c.set('', 'claude', 'u'), /conversation id/)
  assert.throws(() => c.set(CONV, 'claude', ''), /url/)
  assert.throws(() => c.get(CONV, 'bing'), /unknown slot/)
  assert.equal(c.get(null, 'claude'), null)
  assert.equal(c.get(42, 'claude'), null)
})

test('a corrupt file is moved aside with a warning and the store starts empty; the next set writes a valid file', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, CHATS_FILE), '{not json')
  const log = fakeLog()
  const c = createChats({ dir, log, now: () => 1000 })
  assert.deepEqual(c.load(), {})
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('not valid JSON') && m.includes('moved to')), JSON.stringify(log.lines))
  const files = fs.readdirSync(dir)
  assert.ok(files.some((f) => f.startsWith(`${CHATS_FILE}.corrupt-`)), files.join(','))
  assert.equal(files.includes(CHATS_FILE), false)
  c.set(CONV, 'claude', 'https://claude.ai/chat/2')
  assert.deepEqual(readJson(c.file), { [CONV]: { claude: 'https://claude.ai/chat/2' } })

  // a JSON array is "corrupt" too; a foreign object keeps only well-typed links
  fs.writeFileSync(path.join(dir, CHATS_FILE), '[1,2]')
  assert.deepEqual(createChats({ dir, log: fakeLog() }).load(), {})
  fs.writeFileSync(path.join(dir, CHATS_FILE), JSON.stringify({ [CONV]: { claude: 'u', bing: 'x', grok: 7 }, '': { claude: 'u' }, junk: 'no', empty: {} }))
  assert.deepEqual(createChats({ dir, log: fakeLog() }).load(), { [CONV]: { claude: 'u' } })
})

test('sanitizeChats keeps only string urls for known slots under non-empty ids', () => {
  assert.deepEqual(sanitizeChats(null), {})
  assert.deepEqual(sanitizeChats({ a: { chatgpt: '', claude: 'x' }, b: { grok: null } }), { a: { claude: 'x' } })
})
