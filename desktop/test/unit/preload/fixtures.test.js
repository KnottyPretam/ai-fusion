// The committed DOM fixtures (desktop/test/fixtures/dom/*.html) run through the REAL
// desktop/preload/site.cjs: for each one, which cascade ENTRY `health()` matched and what
// `sessionState()` answers. This is the offline half of selector calibration — a cascade edit that
// silently stops matching a site's markup fails here, with the fixture's name on it.
//
// The fixtures are hand-built and scrubbed (no identity, allow-listed attributes only, text `…`),
// and the parser (`_dom.js`) has no layout and no CSS: visibility rules are NOT exercised here
// (the Playwright `adapters` project covers those against the fake site), and the consequences of
// the scrubbed shape — `href`/`src`/`aria-live` dropped, so grok's href-only logged-out cascade and
// an `iframe` challenge cannot be reproduced — are spelled out in the fixtures' README.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FIXTURES_DIR } from './_fixture-lint.js'
import { parseHtml } from './_dom.js'

const require = createRequire(import.meta.url)
const { createAdapter, toMarkdown, DEFAULT_SELECTORS, SLOTS } = require('../../../preload/site.cjs')

const S = DEFAULT_SELECTORS
/**
 * The expected `health()` answer per fixture: the booleans, the session, and the cascade ENTRY that
 * matched (an index into the site's cascade, so the expectation reads as "the first/second entry",
 * never as a copy of the selector string). `null` = nothing matched.
 */
const EXPECTED = {
  'chatgpt-composer': { composer: 0, send: 0, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  'chatgpt-streaming': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  'chatgpt-done': { composer: 0, send: 0, reply: 0, stop: null, session: 'ok', messages: 2, assistant: 1 },
  'chatgpt-logged-out': { composer: null, send: null, reply: null, stop: null, session: 'logged_out', messages: 0, assistant: 0 },
  'claude-composer': { composer: 0, send: 0, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  'claude-streaming': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  'claude-done': { composer: 0, send: 0, reply: 0, stop: null, session: 'ok', messages: 2, assistant: 1 },
  'claude-logged-out': { composer: null, send: null, reply: null, stop: null, session: 'logged_out', messages: 0, assistant: 0 },
  // grok's composer is the one measured fact (grok.com, signed in, 2026-09-16): the TipTap editor
  // must win over the hidden helper textarea, and the submit button exists only once text is in —
  // so `composer` is entry 0 and `send` is null until the `done` fixture.
  'grok-composer': { composer: 0, send: null, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  'grok-streaming': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  'grok-done': { composer: 0, send: 0, reply: 0, stop: null, session: 'ok', messages: 2, assistant: 1 },
  // href is not a kept attribute, and grok's loggedOut cascade is href-only: a scrubbed snapshot of
  // the sign-in page can only be `unknown` (no composer). See README.md, consequence 1.
  'grok-logged-out': { composer: null, send: null, reply: null, stop: null, session: 'unknown', messages: 0, assistant: 0 },
}

const fixture = (name) => fs.readFileSync(path.join(FIXTURES_DIR, `${name}.html`), 'utf8')
const adapterFor = (name) => {
  const slot = name.split('-')[0]
  const doc = parseHtml(fixture(name))
  return { doc, slot, adapter: createAdapter({ document: doc, site: slot, selectors: DEFAULT_SELECTORS }) }
}
/** The cascade entry an `EXPECTED` index means; `reply` is the v2 `assistant` cascade. */
const entry = (slot, key, index) => (index === null ? null : S[slot][key === 'reply' ? 'assistant' : key][index])

test('the fixture DOM helper answers the selector shapes the cascades use (a wrong helper would fake a green cascade)', () => {
  const doc = parseHtml(
    `<html><head><title>a title</title></head><body><div id="wrap" class="outer"><div class="tiptap ProseMirror" contenteditable="true" role="textbox" aria-label="Ask Grok anything"><p>text</p></div><textarea class="helper"></textarea><button data-testid="chat-submit" aria-label="Submit" type="submit" disabled>Send</button><div id="response-uuid"><span class="font-claude-response">x</span></div></div></body></html>`,
  )
  // a compound of two classes plus attributes (the measured grok composer) — `.a.b` is TWO classes
  assert.equal(doc.querySelectorAll("div.tiptap.ProseMirror[contenteditable='true'][aria-label='Ask Grok anything']").length, 1)
  assert.equal(doc.querySelectorAll('div.tiptap.Missing').length, 0)
  assert.equal(doc.querySelector('#wrap').localName, 'div')
  assert.equal(doc.querySelectorAll("div[id^='response-']").length, 1)
  assert.equal(doc.querySelectorAll('.font-claude-response:not(#markdown-artifact)').length, 1)
  assert.equal(doc.querySelectorAll('.font-claude-response:not(.font-claude-response)').length, 0)
  assert.equal(doc.querySelectorAll('textarea[aria-label]').length, 0) // the helper carries none
  assert.equal(doc.querySelectorAll('button:disabled').length, 1)
  assert.equal(doc.querySelectorAll('div p').length, 1) // descendant
  assert.equal(doc.querySelectorAll('#wrap > p').length, 0) // child
  assert.equal(doc.querySelectorAll('#wrap > div').length, 2)
  assert.equal(doc.querySelectorAll('span, textarea').length, 2) // a list
  assert.equal(doc.title, 'a title')
  const editor = doc.querySelector('.ProseMirror')
  const paragraph = doc.querySelector('p')
  assert.ok(editor.contains(paragraph))
  assert.equal(paragraph.closest('#wrap, body'), doc.querySelector('#wrap'))
  assert.ok(editor.matches("div[role='textbox']"))
  const later = doc.querySelector('#response-uuid')
  assert.ok((editor.compareDocumentPosition(later) & 4) !== 0, 'the response div follows the editor')
  assert.ok((later.compareDocumentPosition(editor) & 2) !== 0, 'and the editor precedes it')
  assert.throws(() => doc.querySelectorAll('div:has(p)'), /unsupported/) // an unsupported shape fails loudly
})

test('every state of every site has a fixture, and every fixture has an expectation', () => {
  const names = fs
    .readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith('.html'))
    .map((n) => n.replace(/\.html$/, ''))
    .sort()
  const wanted = []
  for (const slot of [...SLOTS].sort()) for (const state of ['composer', 'done', 'logged-out', 'streaming']) wanted.push(`${slot}-${state}`)
  assert.deepEqual(names, wanted.sort())
  assert.deepEqual(Object.keys(EXPECTED).sort(), names)
  assert.ok(fs.existsSync(path.join(FIXTURES_DIR, 'README.md')), 'the fixtures must document what is measured and what is not')
})

for (const name of Object.keys(EXPECTED)) {
  const want = EXPECTED[name]
  test(`${name}: health() matches the expected cascade entries and session ${want.session}`, () => {
    const { slot, adapter } = adapterFor(name)
    const h = adapter.health()
    assert.deepEqual(
      {
        composer: h.composer,
        send: h.send,
        reply: h.reply,
        stop: h.stop,
        session: h.session,
        matched: { composer: h.matched.composer, send: h.matched.send, reply: h.matched.reply, stop: h.matched.stop },
      },
      {
        composer: want.composer !== null,
        send: want.send !== null,
        reply: want.reply !== null,
        stop: want.stop !== null,
        session: want.session,
        matched: {
          composer: entry(slot, 'composer', want.composer),
          send: entry(slot, 'send', want.send),
          reply: entry(slot, 'reply', want.reply),
          stop: entry(slot, 'stop', want.stop),
        },
      },
    )
    assert.equal(h.matched.error, null)
    assert.equal(adapter.countMessages(), want.messages)
    assert.equal(adapter.countAssistant(), want.assistant)
    assert.equal(adapter.sessionState(), want.session)
    assert.equal(h.title, '…') // the scrubbed title never looks like a Cloudflare interstitial
  })
}

test('the streaming fixtures: an assistant container exists, the stop button is the site\'s first stop entry, and the alert-like regions never block the session', () => {
  for (const slot of SLOTS) {
    const { adapter } = adapterFor(`${slot}-streaming`)
    const containers = adapter.assistantContainers()
    assert.equal(containers.length, 1)
    assert.equal(adapter.replyText(containers[0]), '…') // the whole reply is one scrubbed paragraph
    assert.equal(adapter.health().matched.stop, S[slot].stop[0])
    assert.equal(adapter.sessionState(), 'ok')
  }
})

test('the done fixtures: the reply renders as markdown (a fence with the language from the code class), and chatgpt\'s copy-turn marker is found on the last container', () => {
  const chatgpt = adapterFor('chatgpt-done')
  const [container] = chatgpt.adapter.assistantContainers()
  assert.equal(chatgpt.adapter.replyText(container), '…\n\n- …\n- …\n\n```python\n…\n```')
  assert.ok(chatgpt.doc.querySelector(S.chatgpt.done[0]), 'the done marker is the copy-turn button')
  // claude and grok have no done marker; their code-block header is a sibling of the <pre> and its
  // text is scrubbed to `…`, so the header survives as a paragraph and the language comes from the
  // `language-xxx` class (README.md, consequence 3)
  const claude = adapterFor('claude-done')
  assert.equal(claude.adapter.replyText(claude.adapter.assistantContainers()[0]), '…\n\n1. …\n   - …\n2. …\n\n…\n\n```python\n…\n```')
  assert.deepEqual(S.claude.done, [])
  const grok = adapterFor('grok-done')
  assert.equal(
    grok.adapter.replyText(grok.adapter.assistantContainers()[0]),
    '…\n\n| … | … |\n| --- | --- |\n| … | … |\n\n…\n\n```json\n…\n```',
  )
  assert.deepEqual(S.grok.done, [])
})

test('the assistantText cascade points at the reply BODY in every site\'s streaming and done fixture (S8: claude reads `.prose`, not the whole turn)', () => {
  for (const slot of SLOTS) {
    const entryText = S[slot].assistantText[0]
    assert.ok(entryText, `${slot}: the assistantText cascade must have an entry`)
    for (const state of ['streaming', 'done']) {
      const { adapter, doc } = adapterFor(`${slot}-${state}`)
      const [container] = adapter.assistantContainers()
      const bodies = container.querySelectorAll(entryText)
      assert.equal(bodies.length, 1, `${slot}-${state}: ${entryText} must match the body exactly once`)
      // the capture is that body's markdown, never the turn's — the rule that keeps claude's thinking
      // widget (and any other turn chrome) out of a capture
      assert.equal(adapter.replyText(container), toMarkdown(bodies[0]))
      assert.ok(container !== bodies[0] && container.contains(bodies[0]), `${slot}-${state}: the body is inside the container`)
      assert.equal(doc.querySelectorAll(entryText).length, 1)
    }
  }
})

test('the logged-out fixtures write nothing: ready() rejects with the session state before touching the DOM', async () => {
  for (const slot of SLOTS) {
    const { adapter } = adapterFor(`${slot}-logged-out`)
    assert.equal(adapter.findComposer(), null)
    const expected = slot === 'grok' ? 'composer_not_found' : 'logged_out' // grok: href dropped, see README.md
    await assert.rejects(adapter.ready(20), (e) => e.code === expected, `${slot}: ${expected}`)
  }
})

test('the composer fixtures are insertable: the composer is a contenteditable ProseMirror-style editor, and grok has no send button until text is in', () => {
  for (const slot of SLOTS) {
    const { adapter } = adapterFor(`${slot}-composer`)
    const found = adapter.findComposer()
    assert.ok(found, slot)
    assert.equal(found.el.getAttribute('contenteditable'), 'true')
    assert.equal(adapter.sessionState(), 'ok')
  }
  // the measured grok rule: the hidden helper textarea is in the fixture and must never be picked
  const grok = adapterFor('grok-composer')
  assert.ok(grok.doc.querySelector('textarea'), 'the fixture keeps the hidden helper textarea')
  assert.equal(grok.adapter.findComposer().el.localName, 'div')
  assert.equal(grok.adapter.findSendButton(), null)
  assert.ok(adapterFor('grok-done').adapter.findSendButton())
})
