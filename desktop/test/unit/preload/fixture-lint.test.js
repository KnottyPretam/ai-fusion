// The DOM-fixture lint: fails when any desktop/test/fixtures/dom/*.html carries `@`, `/c/`,
// `/chat/`, a uuid, `googleusercontent` or `x.com/` (identity that a scrubbed snapshot must not
// keep), and `scrubDom`'s attribute-value scrubbing is proven to defeat every pattern by removing
// the identity token itself (the address, the handle, the chat id), not merely the delimiter.
//
// Stage 3 (capture-hardening) added the twelve committed fixtures, so the scan is no longer
// vacuous: the shape of each one is checked here too — only `SNAPSHOT_KEEP_ATTRS` attributes, every
// non-blank text node exactly `…`, none of the tags `scrubDom` drops, and the file is a fixed point
// of the scrubber (re-scrubbing the parsed file changes nothing but the indentation). What each
// fixture is expected to MATCH lives in fixtures.test.js; why it looks the way it does, and which
// entries are unverified, in the fixtures' README.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FIXTURES_DIR, LINT_PATTERNS, lintText, listFixtures, lintFixtures } from './_fixture-lint.js'
import { parseHtml } from './_dom.js'

const require = createRequire(import.meta.url)
const { scrubDom, SNAPSHOT_KEEP_ATTRS, SNAPSHOT_DROP_TAGS } = require('../../../preload/site.cjs')

test('lintText flags every pattern with its line, and passes clean markup', () => {
  assert.deepEqual(lintText('<div class="x">…</div>\n<a class="ok">…</a>'), [])
  const bad = [
    ['<span aria-label="mail me at someone@example.com">', 'at-sign (an e-mail address)'],
    ['<a class="link" data-testid="/c/abc123">', 'chat path /c/'],
    ['<a data-testid="/chat/0f1e2d3c">', 'chat path /chat/'],
    ['<div id="response-8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d">', 'uuid'],
    ['<div class="avatar lh3.googleusercontent.com">', 'googleusercontent (an avatar host)'],
    ['<a aria-label="https://x.com/someone">', 'x.com/ (a profile link)'],
  ]
  bad.forEach(([line, name], i) => {
    const findings = lintText(`<html>\n${line}\n</html>`)
    assert.ok(findings.some((f) => f.name === name && f.line === 2), `case ${i}: expected ${name} on line 2, got ${JSON.stringify(findings)}`)
  })
  assert.equal(LINT_PATTERNS.length, 6)
  // case-insensitive where identity hides in case; the uuid pattern needs the full 8-4-4-4-12 shape
  assert.equal(lintText('GOOGLEUSERCONTENT X.COM/me').length, 2)
  assert.deepEqual(lintText('1234-5678-abcd'), [])
})

test('every desktop/test/fixtures/dom/*.html passes the lint, and there really are fixtures to scan', () => {
  const { files, findings } = lintFixtures(FIXTURES_DIR)
  assert.ok(Array.isArray(files))
  assert.ok(FIXTURES_DIR.endsWith(path.join('desktop', 'test', 'fixtures', 'dom')), FIXTURES_DIR)
  assert.deepEqual(findings, [], `fixture lint findings: ${JSON.stringify(findings, null, 2)}`)
  for (const f of files) assert.ok(f.endsWith('.html'))
  assert.equal(files.length, 12, 'three sites × composer / streaming / done / logged-out')
})

test('every committed fixture is in the scrubbed shape: allow-listed attributes only, every text node `…`, no dropped tags', () => {
  for (const file of listFixtures(FIXTURES_DIR)) {
    const name = path.basename(file)
    const doc = parseHtml(fs.readFileSync(file, 'utf8'))
    const attrs = new Set()
    const texts = new Set()
    const tags = new Set()
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (node.data.trim() !== '') texts.add(node.data.trim())
      } else if (node.nodeType === 1) {
        tags.add(node.localName)
        for (const a of node.attributes) attrs.add(a.name)
      }
      for (const c of node.childNodes || []) walk(c)
    }
    walk(doc.documentElement)
    for (const a of attrs) assert.ok(SNAPSHOT_KEEP_ATTRS.includes(a), `${name}: attribute "${a}" is not in SNAPSHOT_KEEP_ATTRS`)
    assert.deepEqual([...texts], ['…'], `${name}: every non-blank text node must be the scrub placeholder`)
    for (const tag of tags) assert.ok(!SNAPSHOT_DROP_TAGS.includes(tag), `${name}: <${tag}> is dropped by scrubDom and cannot be in a fixture`)
    assert.ok(attrs.has('class'), `${name}: a fixture with no class attribute pins nothing`)
  }
})

test('every committed fixture is a fixed point of scrubDom (only its indentation differs from the scrubber output)', () => {
  for (const file of listFixtures(FIXTURES_DIR)) {
    const raw = fs.readFileSync(file, 'utf8')
    const once = scrubDom(parseHtml(raw))
    assert.equal(scrubDom(parseHtml(once)), once, path.basename(file))
    assert.ok(once.startsWith('<!doctype html>\n<html'), path.basename(file))
    assert.deepEqual(lintText(once), [])
    // the same content, with the fixture's readable indentation removed
    assert.equal(once.replace(/\s+/g, ''), raw.replace(/\s+/g, ''), path.basename(file))
  }
})

test('the scan really reads files: a temp fixture directory with one dirty and one clean file yields exactly the dirty findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triplex-fixture-lint-'))
  try {
    fs.writeFileSync(path.join(dir, 'clean.html'), '<!doctype html>\n<html><body><div class="a">…</div></body></html>\n')
    fs.writeFileSync(path.join(dir, 'dirty.html'), '<!doctype html>\n<html><body>\n<a aria-label="me@example.com">…</a>\n<div id="c-8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d">…</div>\n</body></html>\n')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'someone@example.com is not a fixture')
    assert.deepEqual(
      listFixtures(dir).map((f) => path.basename(f)),
      ['clean.html', 'dirty.html'],
    )
    const { findings } = lintFixtures(dir)
    assert.deepEqual(findings, [
      { file: 'dirty.html', name: 'at-sign (an e-mail address)', line: 3 },
      { file: 'dirty.html', name: 'uuid', line: 4 },
    ])
    assert.deepEqual(listFixtures(path.join(dir, 'missing')), [])
    assert.deepEqual(lintFixtures(path.join(dir, 'missing')), { files: [], findings: [] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A fake element/text node for scrubDom (no jsdom). */
const el = (tag, attrs = {}, children = []) => ({ nodeType: 1, localName: tag, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), childNodes: children })
const text = (s) => ({ nodeType: 3, data: s })

test('scrubDom output passes the lint although the page carried every pattern in text and in kept attribute values', () => {
  const doc = {
    documentElement: el('html', {}, [
      el('body', {}, [
        el('div', { id: 'response-8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d', class: 'lh3.googleusercontent.com avatar', 'data-testid': '/c/abc/chat/def' }, [text('mail someone@example.com, see https://x.com/someone and /c/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d')]),
        el('a', { 'aria-label': 'someone@example.com', href: 'https://chatgpt.com/c/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d' }, [text('x.com/profile')]),
      ]),
    ]),
  }
  const html = scrubDom(doc)
  assert.deepEqual(lintText(html), [], html)
  assert.ok(html.includes('id="response-uuid"'))
  assert.ok(html.includes('class="lh3.img-host.com avatar"'))
  assert.ok(html.includes('data-testid="/c-/id/chat-/id"'))
  assert.ok(html.includes('aria-label="email"'))
  assert.ok(!html.includes('href='))
  assert.ok(!html.includes('profile'))
  for (const leaked of ['someone', 'example.com', 'abc', 'def', '(at)']) assert.ok(!html.includes(leaked), `leaked: ${leaked}`)
})
