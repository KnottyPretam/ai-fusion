// chats.js — (conversation, slot) → chat URL, atomic JSON round trip, corrupt-file recovery, and
// the link rule: only http(s) URLs on the site's hosts are stored (a tampered file is scrubbed).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChats, sanitizeChats, isChatLink, CHATS_FILE } from '../../../main/chats.js'
import { SITES } from '../../../main/sites.js'
import { fakeLog, fakeSites } from './_fakes.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-chats-'))
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const CONV = 'a3c1e2d4-5b6f-4a78-9c0d-e1f2a3b4c5d6'

test('empty start: no file → {}, get() null, links() {}', () => {
  const dir = tmpDir()
  const c = createChats({ dir, sites: SITES, log: fakeLog() })
  assert.deepEqual(c.load(), {})
  assert.equal(c.get(CONV, 'claude'), null)
  assert.deepEqual(c.links(CONV), {})
  assert.equal(c.file, path.join(dir, CHATS_FILE))
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written until the first set')
})

test('set / get / links / forget round-trip atomically and load back identically', () => {
  const dir = tmpDir()
  const c = createChats({ dir, sites: SITES, log: fakeLog() })
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

  const again = createChats({ dir, sites: SITES, log: fakeLog() })
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
  const c = createChats({ dir: tmpDir(), sites: SITES, log: fakeLog() })
  assert.throws(() => c.set(CONV, 'bing', 'https://claude.ai/chat/1'), /unknown slot/)
  assert.throws(() => c.set('', 'claude', 'https://claude.ai/chat/1'), /conversation id/)
  assert.throws(() => c.set(CONV, 'claude', ''), /url/)
  assert.throws(() => c.get(CONV, 'bing'), /unknown slot/)
  assert.equal(c.get(null, 'claude'), null)
  assert.equal(c.get(42, 'claude'), null)
})

test('a corrupt file is moved aside with a warning and the store starts empty; the next set writes a valid file', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, CHATS_FILE), '{not json')
  const log = fakeLog()
  const c = createChats({ dir, sites: SITES, log, now: () => 1000 })
  assert.deepEqual(c.load(), {})
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('not valid JSON') && m.includes('moved to')), JSON.stringify(log.lines))
  const files = fs.readdirSync(dir)
  assert.ok(files.some((f) => f.startsWith(`${CHATS_FILE}.corrupt-`)), files.join(','))
  assert.equal(files.includes(CHATS_FILE), false)
  c.set(CONV, 'claude', 'https://claude.ai/chat/2')
  assert.deepEqual(readJson(c.file), { [CONV]: { claude: 'https://claude.ai/chat/2' } })

  // a JSON array is "corrupt" too; a foreign object keeps only well-typed links
  fs.writeFileSync(path.join(dir, CHATS_FILE), '[1,2]')
  assert.deepEqual(createChats({ dir, sites: SITES, log: fakeLog() }).load(), {})
  fs.writeFileSync(path.join(dir, CHATS_FILE), JSON.stringify({ [CONV]: { claude: 'https://claude.ai/chat/9', bing: 'https://claude.ai/chat/9', grok: 7 }, '': { claude: 'https://claude.ai/chat/9' }, junk: 'no', empty: {} }))
  assert.deepEqual(createChats({ dir, sites: SITES, log: fakeLog() }).load(), { [CONV]: { claude: 'https://claude.ai/chat/9' } })
})

test('sanitizeChats keeps only http(s) urls for known slots under non-empty ids; without a site table the scheme rule alone applies', () => {
  assert.deepEqual(sanitizeChats(null), {})
  assert.deepEqual(sanitizeChats({ a: { chatgpt: '', claude: 'https://claude.ai/chat/x' }, b: { grok: null } }), { a: { claude: 'https://claude.ai/chat/x' } })
  assert.deepEqual(sanitizeChats({ a: { chatgpt: 'x', claude: 'javascript:alert(1)', grok: 'https://anything.example/c/1' } }), { a: { grok: 'https://anything.example/c/1' } }, 'no sites: any https host, never a non-URL / javascript:')
})

test('links must be https on the site\'s hosts (http only on loopback): a tampered chats.json is scrubbed on load with a warning, set() refuses, views never see them', () => {
  const dir = tmpDir()
  const log = fakeLog()
  const sites = fakeSites() // hosts: 127.0.0.1 / localhost (the fake site under test)
  fs.writeFileSync(
    path.join(dir, CHATS_FILE),
    JSON.stringify({
      c1: { chatgpt: 'https://evil.example/c/x', claude: 'javascript:alert(1)', grok: 'file:///etc/hostname' },
      c2: { claude: 'http://127.0.0.1:5199/c/1?site=claude', chatgpt: 'http://evil.example/c/2', grok: 'https://localhost:5199/c/3' },
      c3: { chatgpt: 'data:text/html,hi', claude: 'http://127.0.0.1.evil.example/c/4' },
    }),
  )
  const c = createChats({ dir, sites, log })
  assert.deepEqual(c.load(), { c2: { claude: 'http://127.0.0.1:5199/c/1?site=claude', grok: 'https://localhost:5199/c/3' } })
  const dropped = log.lines.filter(([lvl, m]) => lvl === 'warn' && m.includes('dropped the'))
  assert.equal(dropped.length, 6, JSON.stringify(log.lines))
  assert.ok(dropped.some(([, m]) => m.includes('chatgpt link of c1') && m.includes('https://evil.example')))
  assert.ok(dropped.every(([, m]) => !m.includes('/c/')), 'the log never carries a chat path')
  assert.equal(c.get('c1', 'chatgpt'), null)
  assert.throws(() => c.set(CONV, 'chatgpt', 'https://evil.example/c/y'), /http\(s\) URL on the site's hosts/)
  assert.throws(() => c.set(CONV, 'chatgpt', 'javascript:alert(1)'), /site's hosts/)
  assert.throws(() => c.set(CONV, 'chatgpt', 'http://evil.example/c/y'), /site's hosts/)
  assert.equal(c.get(CONV, 'chatgpt'), null, 'nothing stored')
  assert.equal(c.set(CONV, 'chatgpt', 'http://localhost:5199/c/2?site=chatgpt'), true, 'http on loopback is the fake site')
  assert.deepEqual(readJson(c.file)[CONV], { chatgpt: 'http://localhost:5199/c/2?site=chatgpt' })

  // the real site table: https on the site's hosts (subdomains and the listed alternates), never plain http
  const real = createChats({ dir: tmpDir(), sites: SITES, log: fakeLog() })
  assert.equal(real.set(CONV, 'chatgpt', 'https://chat.openai.com/c/1'), true)
  assert.equal(real.set(CONV, 'claude', 'https://www.claude.ai/chat/1'), true, 'subdomain')
  assert.throws(() => real.set(CONV, 'chatgpt', 'http://chatgpt.com/c/1'), /site's hosts/, 'plain http on a real host')
  assert.throws(() => real.set(CONV, 'grok', 'https://chatgpt.com/c/1'), /site's hosts/, 'another site\'s host')
  assert.throws(() => real.set(CONV, 'claude', 'https://claude.ai.evil.example/chat/1'), /site's hosts/)
  assert.equal(isChatLink('https://grok.com/c/1', SITES, 'grok'), true)
  assert.equal(isChatLink('https://grok.com/c/1', SITES, 'claude'), false)
  assert.equal(isChatLink('', SITES, 'grok'), false)
  assert.equal(isChatLink('https://grok.com/c/1', null, 'grok'), true, 'no site table: the scheme rule alone')
})
