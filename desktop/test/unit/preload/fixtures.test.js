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
const { createAdapter, toMarkdown, DEFAULT_SELECTORS, SLOTS, mergeSelectors, isScreenReaderOnly, turnChrome, TURN_CHROME_TAGS, TURN_CHROME_CLASSES } = require('../../../preload/site.cjs')

const S = DEFAULT_SELECTORS
/**
 * The expected `health()` answer per fixture: the booleans, the session, and the cascade ENTRY that
 * matched (an index into the site's cascade, so the expectation reads as "the first/second entry",
 * never as a copy of the selector string). `null` = nothing matched.
 */
const EXPECTED = {
  'chatgpt-composer': { composer: 0, send: 0, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  // 2026-10-10: chatgpt's `assistant` cascade gained the exchange-group-by-user-turn entry as entry 0; these
  // hand-built fixtures carry the `data-message-author-role` layout, so they match entry 1 — entry 2 since 2026-10-18
  // (the group-by-block entry went in front of it; neither group entry matches this layout)
  'chatgpt-streaming': { composer: 0, send: null, reply: 2, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  'chatgpt-done': { composer: 0, send: 0, reply: 2, stop: null, session: 'ok', messages: 2, assistant: 1 },
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
  // 2026-10-18: a plain Send's failed capture on chatgpt.com (`containers=0 anchor=0 stopNow=true`, a 9-minute reply in a
  // 413 px pane), pruned to the transcript and the composer like the others (README) — the answer's MarkdownRoot cut to
  // its first six blocks and its citation links dropped (they carried the chat's topic). ONE exchange group holding
  // only the activity-header block and the answer block: the USER block is unmounted, so the `:has(user turn)` entry
  // (now entry 1) matches nothing and the group-by-block entry (entry 0) is the one container; no user turn at all;
  // still answering — the stop control is the plain "Stop" (entry 3), no send button, no done marker. The ProseMirror
  // editor has no #prompt-textarea id (composer entry 1). One message: the group (the cascade is counted too).
  'chatgpt-oct18-unmounted-user': { composer: 1, send: null, reply: 0, stop: 3, session: 'ok', messages: 1, assistant: 1 },
  // 2026-10-18: the FIRST real gemini page (`snapshots/gemini-failed-1792365237747.html`: Argon still thinking at the
  // 90 s first-row deadline, `reply_not_found`, `containers=0 anchor=1 stopNow=true`), pruned to the chat history and
  // the input area (the side navigation — the user's conversation titles — and the account header are gone). The
  // exchange is `pending-request.conversation-container` holding the `user-query`, a `thinking-dots-animation` and a
  // `pending-response` with no text; no `model-response` yet. The composer (entry 0) and the stop control (entry 0)
  // are the seeded entries, now measured; `reply` is entry 0, the one entry that names both reply elements. Two
  // messages: the user turn and the pending row.
  'gemini-oct18-pending': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
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
  // 2026-10-17 — gemini. HAND-BUILT FROM PUBLIC SOURCES (2026-08…10-17: the voyager extension, the a8s-gemini-web
  // driver, an Electron 44 Gemini embed's CDP-measured selectors, exporter userscripts), NOT recorded: replace each with
  // a pruned real snapshot after the first live capture (README). Every entry they match is unmeasured.
  // composer: a fresh /app — the Quill editor (entry 0) beside Quill's contenteditable `.ql-clipboard`, the microphone in
  // the send slot (no send button while empty), and the signed-in header's account button (`Google Account: name`),
  // which must never read as a wall.
  'gemini-composer': { composer: 0, send: null, reply: null, stop: null, session: 'ok', messages: 0, assistant: 0 },
  // logged-out: GUEST MODE — the composer is there and works (entry 0), and the header's "Sign in" link is the only
  // sign of it. Its href is scrubbed away, so the `a[aria-label='Sign in']` entry (2) is what matches offline; the
  // session must be `logged_out` WITH a composer.
  'gemini-logged-out': { composer: 0, send: null, reply: null, stop: null, session: 'logged_out', messages: 0, assistant: 0 },
  // streaming: one `div.conversation-container` holding the `user-query` and the `model-response` (2 messages, 1
  // container — the exchange box itself is neither), the reply body `.markdown-main-panel` mid-stream, the stop
  // control in the send slot (entry 0)
  'gemini-streaming': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
  // done: the finished turn's thumbs in `message-actions`, a `code-block` custom element around the fence, a copy button
  // on the user's own query, and text back in the composer so the send button is up (entry 0)
  'gemini-done': { composer: 0, send: 0, reply: 0, stop: null, session: 'ok', messages: 2, assistant: 1 },
  // thinking: an EXPANDED `model-thoughts` panel whose own `message-content > .markdown.markdown-main-panel` comes before
  // the answer's — the body cascade must read the answer alone — while the answer streams (stop entry 0)
  'gemini-thinking': { composer: 0, send: null, reply: 0, stop: 0, session: 'ok', messages: 2, assistant: 1 },
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
  // 2026-10-17: `gemini-thinking`, hand-built — the expanded thinking panel the body cascade must skip
  // 2026-10-18: `chatgpt-oct18-unmounted-user` and `gemini-oct18-pending`, both pruned from the day's failure snapshots
  const EXTRA = ['chatgpt-thinking', 'chatgpt-effort-streaming', 'chatgpt-virtualized', 'claude-virtualized', 'grok-virtualized', 'chatgpt-oct10-done', 'claude-oct10-status', 'grok-oct11-fresh', 'gemini-thinking', 'chatgpt-oct18-unmounted-user', 'gemini-oct18-pending']
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
  // 2026-10-17 (hand-built): gemini's fence sits in a `code-block` CUSTOM element around block markup — read as a block
  // (it used to collapse into one inline code span), its scrubbed header a stray `…` paragraph as on claude / grok, and no
  // language (the code carries none, the header's token is scrubbed); the done marker is the thumbs-up
  const gemini = adapterFor('gemini-done')
  const [geminiTurn] = gemini.adapter.assistantContainers()
  assert.equal(gemini.adapter.replyText(geminiTurn), '…\n\n- …\n- …\n\n…\n\n```\n…\n```')
  assert.equal(gemini.adapter.findDone(geminiTurn).selector, S.gemini.done[0])
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
    // 2026-10-17: gemini's signed-out page is GUEST MODE — its composer is there and works, and the session is still
    // logged_out (the Sign-in link): "a composer" never means "signed in" on that site
    if (slot === 'gemini') assert.equal(adapter.findComposer().selector, S.gemini.composer[0])
    else assert.equal(adapter.findComposer(), null)
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
  // 2026-10-17 (hand-built): gemini's Quill editor wins over Quill's own contenteditable `.ql-clipboard` — which a bare
  // contenteditable entry would match too — and the send button exists only once text is in, as on grok
  const gemini = adapterFor('gemini-composer')
  assert.equal(gemini.doc.querySelectorAll("div[contenteditable='true']").length, 2, 'the fixture keeps the clipboard decoy')
  assert.ok(gemini.adapter.findComposer().el.matches('.ql-editor'))
  for (const entry of S.gemini.composer) assert.equal(gemini.doc.querySelectorAll(entry).length, 1, `${entry} matches the editor alone`)
  assert.equal(gemini.adapter.findSendButton(), null)
  assert.ok(adapterFor('gemini-done').adapter.findSendButton())
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

// ---- 2026-10-18: the day's failure snapshots (chatgpt `containers=0 anchor=0`, gemini `containers=0 anchor=1`) ----------

test('chatgpt-oct18-unmounted-user: an exchange group whose USER block is unmounted — the old `:has(user turn)` entry matches nothing, the group-by-block entry (0) finds the one group; no user turn on the page; the body is the MarkdownRoot; still answering ("Stop", no done marker)', () => {
  const { doc, adapter } = adapterFor('chatgpt-oct18-unmounted-user')
  assert.equal(doc.querySelectorAll(S.chatgpt.assistant[1]).length, 0, 'the 10-10 entry: the user block it keys on is gone')
  assert.equal(doc.querySelectorAll(S.chatgpt.assistant[0]).length, 1)
  assert.equal(doc.querySelectorAll('div.group.flex.flex-col').length, 2, 'the bare triple also matches the answer wrapper; the block entry does not')
  const [group] = adapter.assistantContainers()
  assert.equal(adapter.countAssistant(), 1)
  const blocks = group.querySelectorAll("[class^='block-']")
  assert.equal(blocks.length, 2, 'the activity header and the answer — no user block')
  assert.equal(blocks[0].querySelectorAll("[class*='group/activity-header']").length, 1)
  assert.equal(adapter.userTurns().length, 0)
  assert.equal(doc.querySelectorAll("[class~='group/user-message']").length, 0)
  const body = adapter.replyBlocks(group)
  assert.equal(body.length, 1)
  assert.ok(body[0].matches("[class*='MarkdownRoot-']"))
  assert.ok(adapter.replyText(group).startsWith('# …'))
  assert.deepEqual([adapter.replyReading(group).bodyMatched, adapter.replyReading(group).heldUserTurn], [true, false])
  assert.equal(adapter.health().matched.stop, "button[aria-label='Stop']")
  assert.equal(adapter.findDone(group), null, 'still answering when the capture gave up')
  assert.equal(adapter.findSendButton(), null)
})

test('the 2026-10-18 MESSAGE_SELECTORS entries keep the session rules quiet inside a reply: an error phrase or a sign-in control INSIDE the chatgpt group with no user block, or inside gemini\'s pending row, is reply text — never a banner, never a wall', () => {
  const withInside = (name, anchor, html) => {
    const src = fixture(name)
    assert.ok(src.includes(anchor), `${name}: the anchor is in the fixture`)
    const doc = parseHtml(src.replace(anchor, anchor + html))
    return createAdapter({ document: doc, site: name.split('-')[0], selectors: DEFAULT_SELECTORS })
  }
  const CHATGPT_IN = '<div class="min-w-0 text-size-chat relative overflow-visible py-0">'
  const GEMINI_IN = '<pending-response class="ng-star-inserted">'
  for (const [name, anchor] of [['chatgpt-oct18-unmounted-user', CHATGPT_IN], ['gemini-oct18-pending', GEMINI_IN]]) {
    const errorText = DEFAULT_SELECTORS[name.split('-')[0]].errorText[0]
    assert.equal(withInside(name, anchor, `<div role="status">${errorText}</div>`).sessionState(), 'ok', `${name}: an error phrase inside the reply`)
  }
  assert.equal(withInside('chatgpt-oct18-unmounted-user', CHATGPT_IN, '<button data-testid="login-button">…</button>').sessionState(), 'ok')
  assert.equal(withInside('gemini-oct18-pending', GEMINI_IN, '<a aria-label="Sign in">…</a>').sessionState(), 'ok')
  // …and the same controls OUTSIDE any message are the walls and banners they always were (the checks above are not vacuous)
  assert.equal(withInside('chatgpt-oct18-unmounted-user', '<body>', '<button data-testid="login-button">…</button>').sessionState(), 'logged_out')
  assert.equal(withInside('gemini-oct18-pending', 'variable-context">', '<a aria-label="Sign in">…</a>').sessionState(), 'logged_out')
  assert.equal(withInside('gemini-oct18-pending', 'variable-context">', `<div role="alert">${DEFAULT_SELECTORS.gemini.errorText[0]}</div>`).sessionState(), 'blocked')
})

test('gemini-oct18-pending: the first real gemini page — while the model thinks the reply row is `pending-response` (no `model-response` anywhere); entry 0 names it, the `user-query` anchors it, it holds no text; composer and stop are the seeded first entries', () => {
  const { doc, adapter } = adapterFor('gemini-oct18-pending')
  assert.equal(doc.querySelectorAll('model-response').length, 0)
  assert.equal(doc.querySelectorAll('pending-request.conversation-container > pending-response').length, 1)
  assert.equal(doc.querySelectorAll('thinking-dots-animation').length, 1)
  const [row] = adapter.assistantContainers()
  assert.equal(row.localName, 'pending-response')
  const turns = adapter.userTurns()
  assert.equal(turns.length, 1)
  assert.equal(turns[0].localName, 'user-query')
  assert.equal(adapter.containerForAnchor(turns[0]), row)
  assert.equal(adapter.replyBlocks(row).length, 0)
  assert.equal(adapter.replyText(row).trim(), '', 'the pending row holds no text: the stop control keeps the capture waiting')
  assert.equal(adapter.health().matched.composer, S.gemini.composer[0])
  assert.equal(adapter.health().matched.stop, "button[aria-label='Stop response']")
  assert.equal(doc.querySelectorAll("[aria-label^='Google Account:']").length, 0, 'the account header was pruned away')
})


// ---- 2026-10-17: gemini (HAND-BUILT from public sources — see EXPECTED and the README) -------------------------------

test('gemini-composer: the signed-in header\'s account button ("Google Account: name", the scrubbed label) never reads as a wall; the page is ok', () => {
  const { doc, adapter } = adapterFor('gemini-composer')
  const account = doc.querySelector("a[aria-label^='Google Account:']")
  assert.ok(account, 'the fixture carries the account button')
  assert.equal(account.getAttribute('aria-label'), 'Google Account: name')
  for (const entry of S.gemini.loggedOut) assert.equal(doc.querySelectorAll(entry).length, 0, `${entry} must not match the account button`)
  assert.equal(adapter.sessionState(), 'ok')
})

test('gemini-logged-out: GUEST MODE — composer present, the Sign-in link matched by its aria-label (the scrubbed fixture has no href), session logged_out; ready() rejects before any write', async () => {
  const { doc, adapter } = adapterFor('gemini-logged-out')
  assert.equal(doc.querySelectorAll(S.gemini.loggedOut[0]).length, 0, 'the href entries cannot match a scrubbed snapshot')
  assert.equal(doc.querySelectorAll(S.gemini.loggedOut[2]).length, 1)
  assert.ok(adapter.findComposer())
  assert.equal(adapter.health().session, 'logged_out')
  await assert.rejects(adapter.ready(20), (e) => e.code === 'logged_out')
})

test('gemini-streaming: the exchange box holds the user turn and the reply turn; the anchor rule pairs them (user-query → model-response), the "You said" / "Gemini said" labels are screen-reader-only, and the box itself is no container', () => {
  const { doc, adapter } = adapterFor('gemini-streaming')
  const box = doc.querySelector('div.conversation-container')
  const turns = adapter.userTurns()
  assert.equal(turns.length, 1)
  assert.equal(turns[0].localName, 'user-query')
  const [reply] = adapter.assistantContainers()
  assert.equal(reply.localName, 'model-response')
  assert.ok(box.contains(turns[0]) && box.contains(reply))
  assert.equal(adapter.containerForAnchor(turns[0]), reply)
  assert.ok(!adapter.assistantContainers().includes(box))
  for (const label of doc.querySelectorAll('.cdk-visually-hidden')) assert.ok(isScreenReaderOnly(label))
  assert.equal(adapter.replyReading(reply).bodyMatched, true)
  assert.equal(adapter.replyReading(reply).heldUserTurn, false)
})

test('gemini-thinking: the thinking panel renders its own `.markdown-main-panel`, and the body cascade reads the ANSWER alone — an unscoped override would have captured the thoughts', () => {
  const { doc, adapter } = adapterFor('gemini-thinking')
  assert.equal(doc.querySelectorAll('.markdown-main-panel').length, 2, 'the thoughts body and the answer body')
  assert.equal(doc.querySelectorAll('model-thoughts .markdown-main-panel').length, 1)
  const [reply] = adapter.assistantContainers()
  const blocks = adapter.replyBlocks(reply)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].closest('model-thoughts'), null, 'the body block is outside the thinking panel')
  assert.equal(adapter.replyText(reply), '- …')
  // the second entry is scoped the same way
  const second = createAdapter({ document: doc, site: 'gemini', selectors: mergeSelectors(DEFAULT_SELECTORS, { gemini: { assistantText: [S.gemini.assistantText[1]] } }).merged })
  assert.equal(second.replyText(second.assistantContainers()[0]), '- …')
  // the scoping is what does it: without `:not(model-thoughts *)` the thoughts ride in front of the answer
  const unscoped = createAdapter({ document: doc, site: 'gemini', selectors: mergeSelectors(DEFAULT_SELECTORS, { gemini: { assistantText: ['.markdown-main-panel'] } }).merged })
  assert.equal(unscoped.replyText(unscoped.assistantContainers()[0]), '…\n\n…\n\n- …')
})

test('gemini-done: the thumbs-up is the done marker, never the copy button on the user\'s own query (`data-test-id` — kept by the snapshot allow-list since 2026-10-17); the Bad-response and Copy buttons beside it are not markers either', () => {
  const { doc, adapter } = adapterFor('gemini-done')
  const [reply] = adapter.assistantContainers()
  assert.equal(doc.querySelectorAll("user-query button[data-test-id='copy-button']").length, 1)
  const done = adapter.findDone(reply)
  assert.equal(done.selector, "button[aria-label='Good response']")
  assert.equal(done.el.closest('message-actions') !== null, true)
  assert.equal(doc.querySelectorAll("mat-icon[fonticon='thumb_up']").length, 1, 'the language-neutral glyph (`fonticon`, kept since 2026-10-17)')
})

// ---- 2026-10-17 review of the gemini adapter: a body-cascade MISS, and the challenge cascade ------------------------

/** gemini-thinking with distinguishable text: the screen-reader label, the two thoughts and the answer. */
function labelledThinking() {
  const html = fixture('gemini-thinking')
    .replace('<span class="cdk-visually-hidden screen-reader-model-response-label">…</span>', '<span class="cdk-visually-hidden screen-reader-model-response-label">SAID-LABEL</span>')
    .replace(/<p>…<\/p>\s*<p>…<\/p>/, '<p>THOUGHT-ONE</p><p>THOUGHT-TWO</p>')
    .replace('<li>…</li>', '<li>ANSWER</li>')
  for (const marker of ['SAID-LABEL', 'THOUGHT-ONE', 'ANSWER']) assert.ok(html.includes(marker), `the fixture edit planted ${marker}`)
  return html
}

test('gemini-thinking with the body cascade MISSING (every entry is unmeasured — a renamed class is a realistic first capture): the turn-level fallback reads the answer, never the thinking panel or the "Gemini said" label; the reading says no body matched and no user turn was held', () => {
  const html = labelledThinking()
  const hit = createAdapter({ document: parseHtml(html), site: 'gemini', selectors: DEFAULT_SELECTORS })
  assert.equal(hit.replyText(hit.assistantContainers()[0]), '- ANSWER')
  const miss = createAdapter({ document: parseHtml(html), site: 'gemini', selectors: mergeSelectors(DEFAULT_SELECTORS, { gemini: { assistantText: ['.renamed-body'] } }).merged })
  const [reply] = miss.assistantContainers()
  assert.equal(reply.localName, 'model-response')
  assert.deepEqual(miss.replyBlocks(reply), [])
  // before the review the whole container: `SAID-LABEL\n\nTHOUGHT-ONE\n\nTHOUGHT-TWO\n\n- ANSWER`
  assert.deepEqual(miss.replyReading(reply), { text: '- ANSWER', bodyMatched: false, heldUserTurn: false })
  // the panel's tag renamed as well: its class and its inner `.thoughts-container` still keep it out — of the
  // fallback read, and of the default body cascade (`:not(.thoughts-container *)`)
  const renamed = html.replace('<model-thoughts class="model-thoughts ng-star-inserted">', '<model-reasoning class="model-thoughts ng-star-inserted">').replace('</model-thoughts>', '</model-reasoning>')
  assert.ok(renamed.includes('<model-reasoning'))
  const renamedMiss = createAdapter({ document: parseHtml(renamed), site: 'gemini', selectors: mergeSelectors(DEFAULT_SELECTORS, { gemini: { assistantText: ['.renamed-body'] } }).merged })
  assert.equal(renamedMiss.replyText(renamedMiss.assistantContainers()[0]), '- ANSWER')
  const renamedHit = createAdapter({ document: parseHtml(renamed), site: 'gemini', selectors: DEFAULT_SELECTORS })
  const [renamedReply] = renamedHit.assistantContainers()
  assert.equal(renamedHit.replyBlocks(renamedReply).length, 1, 'the thoughts body is outside both scoped entries')
  assert.equal(renamedHit.replyText(renamedReply), '- ANSWER')
})

test('turnChrome (the turn-level skip predicate) names gemini\'s thinking panel, its inner box and the CDK screen-reader label ONLY — never the generic sr-only / visually-hidden — and no claude / chatgpt / grok fixture carries anything it names, so their turn-level reads are byte-identical', () => {
  assert.deepEqual([...TURN_CHROME_TAGS], ['model-thoughts'])
  assert.deepEqual([...TURN_CHROME_CLASSES], ['model-thoughts', 'thoughts-container', 'cdk-visually-hidden'])
  const doc = parseHtml('<div><model-thoughts id="a"></model-thoughts><div id="b" class="x thoughts-container"></div><span id="c" class="cdk-visually-hidden"></span><h6 id="d" class="sr-only"></h6><span id="e" class="visually-hidden"></span><div id="f" class="markdown"></div></div>')
  const verdict = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, turnChrome(doc.querySelector(`#${id}`))]))
  assert.deepEqual(verdict, { a: true, b: true, c: true, d: false, e: false, f: false })
  for (const v of [null, undefined, 'model-thoughts', {}]) assert.equal(turnChrome(v), false)
  const classic = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.html') && !f.startsWith('gemini-'))
  assert.ok(classic.length >= 20)
  for (const f of classic) {
    const all = parseHtml(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')).querySelectorAll('*')
    assert.equal(all.filter((el) => turnChrome(el)).length, 0, `${f} carries nothing turnChrome names`)
  }
})

test('gemini: an INVISIBLE reCAPTCHA scoring frame embedded in the page is no challenge (2026-10-17 review: the challenge cascade is empty until a wall is measured) — the session stays ok and ready() resolves', async () => {
  const html = fixture('gemini-composer').replace('</chat-app>', '</chat-app><div style="width:0;height:0;visibility:hidden"><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/enterprise/anchor?ar=1&amp;size=invisible"></iframe></div>')
  const doc = parseHtml(html)
  assert.equal(doc.querySelectorAll("iframe[src*='recaptcha']").length, 1, 'the frame is on the page')
  const adapter = createAdapter({ document: doc, site: 'gemini', selectors: DEFAULT_SELECTORS })
  assert.equal(adapter.sessionState(), 'ok')
  const ready = await adapter.ready(200) // the composer match, as the op handler reads it
  assert.equal(ready.selector, S.gemini.composer[0])
})
