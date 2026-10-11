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
  // 2026-10-10: chatgpt's `assistant` cascade gained the exchange-group-by-user-turn entry as entry 0; these
  // hand-built fixtures carry the `data-message-author-role` layout, so they match entry 1
  'chatgpt-streaming': { composer: 0, send: null, reply: 1, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  'chatgpt-done': { composer: 0, send: 0, reply: 1, stop: null, session: 'ok', messages: 2, assistant: 1 },
  'chatgpt-logged-out': { composer: null, send: null, reply: null, stop: null, session: 'logged_out', messages: 0, assistant: 0 },
  // 2026-09-27 (Part 0): two failed captures' own snapshots of the layout chatgpt.com ships with its effort
  // picker — no data-* turn attributes at all. `thinking`: 108 s into the first reply of a fresh chat — no
  // #prompt-textarea (composer entry 1), no send button while the site works, the stop control labelled
  // plainly "Stop" (stop entry 3), and the reply BODY already mounted and EMPTY (the S10 thinking shape;
  // assistant entry 1) — which read as `reply_not_found` while neither the stop nor the body selector was
  // known. `effort-streaming`: the same chat one turn later, the first reply finished (its action bar
  // carries the "Rate response" done marker) and the second still streaming: two bodies, six message
  // matches (a user turn matches twice through `group/user-message`).
  // (2026-10-10: `reply` moved 1 → 0 on both — the `:has` entry matches the same groups the old entry did)
  'chatgpt-thinking': { composer: 1, send: null, reply: 0, stop: 3, session: 'ok', messages: 3, assistant: 1 },
  'chatgpt-effort-streaming': { composer: 1, send: null, reply: 0, stop: 3, session: 'ok', messages: 6, assistant: 2 },
  // 2026-09-27: claude's `send` cascade gained the measured `button[data-testid='chat-input-send']` as entry 0;
  // these hand-built fixtures predate it and carry the aria-label only, so they match entry 1. 2026-10-10: the
  // same for `assistant` (`[data-testid='assistant-message']` first) and `stop` (`chat-input-stop` first) — the
  // hand-built rows carry `.font-claude-response` and the "Stop response" label, entry 1 of each
  'claude-composer': { composer: 0, send: 1, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  'claude-streaming': { composer: 0, send: null, reply: 1, stop: 1, session: 'ok', messages: 2, assistant: 1 },
  'claude-done': { composer: 0, send: 1, reply: 1, stop: null, session: 'ok', messages: 2, assistant: 1 },
  // 2026-09-27: the newest failed capture of each site, pruned to the transcript and the composer (README):
  // the VIRTUALIZED window — claude 5 responses (the pinned first reply + 4 exchanges) and 4 user turns, its
  // send control found by the new testid entry; chatgpt 5 exchange groups (composer entry 1: no
  // #prompt-textarea in the effort-picker layout, no send button measured); grok 7 `div[id^='response-']`
  // rows of which only 4 hold an assistant bubble — `reply` is the new `:has` entry and `assistant` is 4,
  // where the bare id prefix counted 7. No stop control: every page was settled when the failure was saved.
  // 2026-10-10: claude-virtualized `messages` 9 → 14 (its five `[data-testid=assistant-message]` rows joined the
  // generic message list) and `reply` stays 0 (the new first entry matches those same rows); chatgpt-virtualized
  // `reply` 1 → 0; grok-virtualized stays 14 — its bubbles carry the same testid, but each IS the `.message-bubble`
  // already counted, and countMessages de-duplicates by node
  'claude-virtualized': { composer: 0, send: 0, reply: 0, stop: null, session: 'ok', messages: 14, assistant: 5 },
  'chatgpt-virtualized': { composer: 1, send: null, reply: 0, stop: null, session: 'ok', messages: 15, assistant: 5 },
  'grok-virtualized': { composer: 0, send: null, reply: 0, stop: null, session: 'ok', messages: 14, assistant: 4 },
  // 2026-10-10: the morning's two failure snapshots (`containers=0` on both sites), pruned to the transcript and the
  // composer like the virtualized ones (README). chatgpt: one exchange group — now a bare `div.group.flex.flex-col`
  // found through the user turn it holds (entry 0) — with its MarkdownRoot body kept VERBATIM (628 `…` runs) and
  // the "Rate response" marker; no stop (the reply had finished), no send (empty composer, as ever). claude: the
  // REDESIGN, caught in the STATUS phase — one `[data-testid=assistant-message]` row holding the "Thought for Ns"
  // widget and no markdown, `button[data-testid=chat-input-stop]` up (entry 0 of both), no send (it swaps with the
  // stop in the same slot), two messages (the user row + the assistant row through the generic list).
  'chatgpt-oct10-done': { composer: 1, send: null, reply: 0, stop: null, session: 'ok', messages: 3, assistant: 1 },
  'claude-oct10-status': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  // 2026-10-11: a plain Send's failed capture on a FRESH grok.com chat (`containers=1 anchor=1 order=newest presubmit=0`,
  // `reply_not_found` with 6,865 characters on the page), pruned to the scroller and the composer like the others
  // (README): four `div.absolute.inset-x-0.top-0` slots — an empty one, the USER row, the ASSISTANT row, an empty one —
  // in OLDEST-first document order, where grok-virtualized's 58-row chat was newest-first (the slots are a reused
  // pool placed by transform). One container (entry 0), one user turn, two rows + two bubbles = 4 messages; settled,
  // so no stop; the composer is the measured TipTap editor (entry 0) and the voice button sits where submit would.
  'grok-oct11-fresh': { composer: 0, send: null, reply: 0, stop: null, session: 'ok', messages: 4, assistant: 1 },
  'claude-logged-out': { composer: null, send: null, reply: null, stop: null, session: 'logged_out', messages: 0, assistant: 0 },
  // grok's composer is the one measured fact (grok.com, signed in, 2026-09-16): the TipTap editor
  // must win over the hidden helper textarea, and the submit button exists only once text is in —
  // so `composer` is entry 0 and `send` is null until the `done` fixture.
  'grok-composer': { composer: 0, send: null, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  // 2026-09-27: grok's `assistant` cascade gained `div[id^='response-']:has([data-testid='assistant-message'])`
  // as entry 0 (measured). 2026-10-10: the bare id prefix is gone, so these hand-built rows now carry the measured
  // bubble (`div[role=article][data-testid=assistant-message].message-bubble` around the markdown) and match entry 0;
  // the bubble is one more `.message-bubble` for countMessages (2 → 3)
  'grok-streaming': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 3, assistant: 1 },
  'grok-done': { composer: 0, send: 0, reply: 0, stop: null, session: 'ok', messages: 3, assistant: 1 },
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
  // 2026-09-27: `:has(<list>)` (a descendant matches) and a COMPLEX selector inside `:not()`, the two shapes
  // the virtualized-transcript cascades use; an unsupported shape still fails loudly
  assert.equal(doc.querySelectorAll('div:has(p)').length, 2) // #wrap and .ProseMirror
  assert.equal(doc.querySelectorAll("div:has([data-testid='chat-submit'])").length, 1)
  assert.equal(doc.querySelectorAll('p:not(.ProseMirror *)').length, 0)
  assert.equal(doc.querySelectorAll('p:not(.helper *)').length, 1)
  assert.throws(() => doc.querySelectorAll('div:nth-child(2)'), /unsupported/)
})

test('every state of every site has a fixture, and every fixture has an expectation', () => {
  const names = fs
    .readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith('.html'))
    .map((n) => n.replace(/\.html$/, ''))
    .sort()
  const wanted = []
  for (const slot of [...SLOTS].sort()) for (const state of ['composer', 'done', 'logged-out', 'streaming']) wanted.push(`${slot}-${state}`)
  // Every site has the four states; a site may add a NAMED extra state measured later (2026-09-27:
  // `chatgpt-thinking`, the effort-picker composer mid-thought). Every file on disk has an expectation.
  const EXTRA = ['chatgpt-thinking', 'chatgpt-effort-streaming', 'chatgpt-virtualized', 'claude-virtualized', 'grok-virtualized', 'chatgpt-oct10-done', 'claude-oct10-status', 'grok-oct11-fresh']
  assert.deepEqual(names, [...wanted, ...EXTRA].sort())
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

test('the streaming fixtures: an assistant container exists, the stop button is the fixture\'s expected stop entry, and the alert-like regions never block the session', () => {
  for (const slot of SLOTS) {
    const { adapter } = adapterFor(`${slot}-streaming`)
    const containers = adapter.assistantContainers()
    assert.equal(containers.length, 1)
    assert.equal(adapter.replyText(containers[0]), '…') // the whole reply is one scrubbed paragraph
    // 2026-10-10: claude's first stop entry is the redesign's testid, which the hand-built row does not carry (entry 1)
    assert.equal(adapter.health().matched.stop, S[slot].stop[EXPECTED[`${slot}-streaming`].stop])
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
  // 2026-10-10: claude's done marker is the settled row's action bar INSIDE `[data-testid='message-actions']`; this
  // hand-built fixture's `action-bar-copy` sits in a plain div, so it is not one (claude-virtualized's is — see the
  // 2026-10-10 fixture test below)
  assert.deepEqual(S.claude.done, ["[data-testid='message-actions'] button[data-testid^='action-bar-']"])
  assert.equal(claude.adapter.findDone(claude.adapter.assistantContainers()[0]), null)
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

test('chatgpt-effort-streaming: the finished turn carries the "Rate response" done marker after its body, the streaming turn does not', () => {
  const { doc, adapter } = adapterFor('chatgpt-effort-streaming')
  const groups = [...doc.querySelectorAll("div.group.flex.flex-col.pb-2.pt-2")]
  assert.equal(groups.length, 2)
  const done = adapter.findDone(groups[0]) // a {el, selector} match record, as every cascade lookup answers
  assert.ok(done, 'the first (finished) exchange has its action bar')
  assert.equal(done.selector, "button[aria-label='Rate response']")
  assert.equal(done.el.getAttribute('aria-label'), 'Rate response')
  assert.equal(adapter.findDone(groups[1]), null, 'the second reply is still streaming: no action bar yet')
  // the text of a finished exchange is the ANSWER root only — never the user message or the thinking header
  const blocks = adapter.replyBlocks ? adapter.replyBlocks(groups[0]) : null
  if (blocks) assert.equal(blocks.length, 1)
})


// ---- 2026-10-10: the morning's failure snapshots (both sites: `containers=0`) ------------------------------------

test('chatgpt-oct10-done: the exchange group is found through the user turn it holds (entry 0); one container, one user turn, the group is the turn\'s container; the body is the verbatim MarkdownRoot (628 `…` runs) and the done marker is "Rate response"', () => {
  const { doc, adapter } = adapterFor('chatgpt-oct10-done')
  assert.equal(doc.querySelectorAll('div.group.flex.flex-col.pb-2.pt-2').length, 0, 'the Sept-27 entry matches nothing on the Oct-10 page')
  assert.equal(doc.querySelectorAll('div.group.flex.flex-col').length, 2, 'the bare triple also matches the answer wrapper')
  assert.equal(doc.querySelectorAll(S.chatgpt.assistant[0]).length, 1)
  assert.equal(adapter.countAssistant(), 1)
  const [group] = adapter.assistantContainers()
  assert.ok(group.matches("div.group.flex.flex-col:has([class~='group/user-message'])"))
  const turns = adapter.userTurns()
  assert.equal(turns.length, 1)
  assert.equal(adapter.containerForAnchor(turns[0]), group)
  assert.ok(group.contains(turns[0]))
  const blocks = adapter.replyBlocks(group)
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].matches("[class*='MarkdownRoot-']"))
  const text = adapter.replyText(group)
  assert.equal((text.match(/…/g) || []).length, 628)
  assert.ok(text.startsWith('# …'))
  assert.equal(adapter.findDone(group).selector, "button[aria-label='Rate response']")
  assert.equal(adapter.health().matched.stop, null)
  assert.equal(adapter.findSendButton(), null)
})

test('claude-oct10-status: the redesign in its status phase — the `assistant-message` row is the one container (entry 0), the user row its anchor, the stop control is `chat-input-stop`, no body block and no done marker yet; claude-virtualized\'s settled rows DO carry the marker', () => {
  const { doc, adapter } = adapterFor('claude-oct10-status')
  assert.equal(doc.querySelectorAll('.font-claude-response').length, 0, 'the Sept entries match nothing on the redesigned page')
  assert.equal(doc.querySelectorAll('.prose').length, 0)
  assert.equal(adapter.countAssistant(), 1)
  const [row] = adapter.assistantContainers()
  assert.ok(row.matches("[data-testid='assistant-message']"))
  const turns = adapter.userTurns()
  assert.equal(turns.length, 1)
  assert.equal(adapter.containerForAnchor(turns[0]), row)
  assert.ok((turns[0].compareDocumentPosition(row) & 4) !== 0, 'the reply row follows its user turn (oldest-first)')
  assert.equal(adapter.replyBlocks(row).length, 0, 'no markdown mounted yet: replyText falls back to the whole row')
  assert.equal(adapter.health().matched.stop, "button[data-testid='chat-input-stop']")
  assert.equal(adapter.findDone(row), null, 'the action bar is not there during the status phase')
  assert.equal(adapter.findSendButton(), null, 'the send control swaps with the stop control')
  const settled = adapterFor('claude-virtualized')
  for (const c of settled.adapter.assistantContainers()) assert.equal(settled.adapter.findDone(c).selector, S.claude.done[0])
})
