// scrubDom (contract §3, Stage 2) over a fake node tree (no jsdom): the dropped elements, the
// attribute allow-list, text → `…`, comments / doctype / whitespace-only text dropped, void tags,
// open shadow roots, attribute escaping and value scrubbing (identity tokens replaced whole, so an
// e-mail's local part / domain, an X handle and a chat id never survive), and both attribute shapes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { lintText } from './_fixture-lint.js'

const require = createRequire(import.meta.url)
const { scrubDom, SNAPSHOT_DROP_TAGS, SNAPSHOT_KEEP_ATTRS } = require('../../../preload/site.cjs')

const el = (tag, attrs = {}, children = [], extra = {}) => ({
  nodeType: 1,
  localName: tag,
  attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  childNodes: children,
  ...extra,
})
const text = (s) => ({ nodeType: 3, data: s })
const comment = (s) => ({ nodeType: 8, data: s })

test('the drop list and the attribute allow-list are the contract lists, frozen', () => {
  assert.deepEqual([...SNAPSHOT_DROP_TAGS], ['script', 'style', 'link', 'meta', 'img', 'svg', 'iframe', 'video', 'audio'])
  assert.deepEqual([...SNAPSHOT_KEEP_ATTRS], ['id', 'class', 'role', 'contenteditable', 'aria-label', 'data-testid', 'data-message-author-role', 'data-lexical-editor', 'type', 'disabled', 'placeholder', 'translate'])
  assert.ok(Object.isFrozen(SNAPSHOT_DROP_TAGS) && Object.isFrozen(SNAPSHOT_KEEP_ATTRS))
})

test('scrubDom: drops script|style|link|meta|img|svg|iframe|video|audio with their subtrees, keeps only the allowed attributes, replaces every non-blank text node with …', () => {
  const doc = {
    documentElement: el('html', { lang: 'en' }, [
      el('head', {}, [
        el('meta', { charset: 'utf-8' }),
        el('title', {}, [text('My private conversation')]),
        el('link', { rel: 'stylesheet', href: '/site.css' }),
        el('style', {}, [text('body { color: red }')]),
        el('script', { src: '/site.js' }, [text('window.secret = 1')]),
      ]),
      el('body', {}, [
        text('\n  '),
        el('div', { id: 'app', 'data-fake-site': '', class: 'root', style: 'color: red', onclick: 'x()' }, [
          el('article', { 'data-message-author-role': 'user', 'data-message-id': 'm-1' }, [text('what I typed')]),
          el('article', { 'data-message-author-role': 'assistant' }, [
            el('div', { class: 'markdown' }, [el('p', {}, [text('the reply')]), el('img', { src: 'https://example.test/a.png', alt: 'pic' })]),
            el('svg', { viewBox: '0 0 10 10' }, [el('path', { d: 'M0 0' })]),
            el('button', { type: 'button', 'data-testid': 'copy-turn-action-button', 'aria-label': 'Copy' }, [text('Copy')]),
          ]),
          el('iframe', { src: 'https://challenges.cloudflare.com/x' }),
          el('video', { src: 'v.mp4' }, [el('source', { src: 'v.webm' })]),
          el('audio', { src: 'a.mp3' }),
          comment(' a comment with someone@example.com '),
          el('form', { class: 'composer' }, [
            el('div', { id: 'prompt-textarea', class: 'ProseMirror', contenteditable: 'true', translate: 'no', 'data-virtualkeyboard': 'true', role: 'textbox', 'data-lexical-editor': 'true' }, [el('p', { 'data-placeholder': 'Ask anything' }, [el('br')])]),
            el('textarea', { placeholder: 'Ask anything', rows: '1', tabindex: '-1' }),
            el('button', { type: 'submit', disabled: '', 'aria-label': 'Send prompt', class: 'send' }, [text('Send')]),
            el('input', { type: 'file', name: 'upload' }),
          ]),
        ]),
      ]),
    ]),
  }
  const html = scrubDom(doc)
  assert.equal(
    html,
    '<!doctype html>\n' +
      '<html>' +
      '<head><title>…</title></head>' +
      '<body>' +
      '<div id="app" class="root">' +
      '<article data-message-author-role="user">…</article>' +
      '<article data-message-author-role="assistant">' +
      '<div class="markdown"><p>…</p></div>' +
      '<button type="button" data-testid="copy-turn-action-button" aria-label="Copy">…</button>' +
      '</article>' +
      '<form class="composer">' +
      '<div id="prompt-textarea" class="ProseMirror" contenteditable="true" translate="no" role="textbox" data-lexical-editor="true"><p><br></p></div>' +
      '<textarea placeholder="Ask anything"></textarea>' +
      '<button type="submit" disabled="" aria-label="Send prompt" class="send">…</button>' +
      '<input type="file">' +
      '</form>' +
      '</div>' +
      '</body>' +
      '</html>\n',
  )
  for (const leaked of ['private', 'what I typed', 'the reply', 'secret', 'color: red', 'onclick', 'href', 'src=', 'someone', 'data-message-id', 'data-virtualkeyboard', 'data-placeholder', 'rows=', 'name=']) {
    assert.ok(!html.includes(leaked), `leaked: ${leaked}`)
  }
})

test('scrubDom: attribute values are escaped and scrubbed of identity; attribute names are matched case-insensitively; a plain-object attributes map works (fakes)', () => {
  const doc = el('div', {}, [
    el('span', { 'ARIA-LABEL': 'a "quoted" <b> & me@example.com', id: 'turn-8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d' }, [text('x')]),
    { nodeType: 1, localName: 'i', attributes: { class: 'lh3.googleusercontent.com', title: 'dropped' }, childNodes: [] },
  ])
  const html = scrubDom(doc)
  assert.equal(
    html,
    '<!doctype html>\n<div><span aria-label="a &quot;quoted&quot; &lt;b&gt; &amp; email" id="turn-uuid">…</span><i class="lh3.img-host.com"></i></div>\n',
  )
})

test('scrubDom replaces identity TOKENS whole, never just the lint delimiter: an e-mail in aria-label / id / placeholder loses its local part and domain, x.com/<handle> its handle, /c/<id> and /chat/<id> their id', () => {
  const doc = el('div', {}, [
    el('button', { 'aria-label': 'Open menu for jane.doe@gmail.com', id: 'user-jane.doe@gmail.com', placeholder: 'Signed in as jane.doe@gmail.com' }),
    el('a', { class: 'profile x.com/janedoe', 'aria-label': 'https://x.com/janedoe/status/123 and X.COM/JaneDoe' }),
    el('a', { 'data-testid': 'link-/c/abc123notuuid', id: 'thread-/chat/0f1e2d3c', class: 'tail /c/' }),
    el('span', { 'aria-label': 'ping @janedoe or jane@localhost, lone @ sign' }),
  ])
  const html = scrubDom(doc)
  assert.deepEqual(lintText(html), [], html)
  for (const leaked of ['jane', 'doe', 'gmail', 'localhost', 'abc123', '0f1e2d3c', 'status/123']) assert.ok(!html.includes(leaked), `leaked: ${leaked} in ${html}`)
  assert.ok(html.includes('aria-label="Open menu for email" id="email" placeholder="Signed in as email"'), html) // `user-jane.doe@…` is itself an address
  assert.ok(html.includes('class="profile x-com/profile" aria-label="https://x-com/profile and x-com/profile"'), html)
  assert.ok(html.includes('data-testid="link-/c-/id" id="thread-/chat-/id" class="tail /c-/"'), html)
  assert.ok(html.includes('aria-label="ping handle or email, lone (at) sign"'), html)
})

test('scrubDom: void elements have no closing tag, open shadow roots are inlined as <template shadowrootmode="open">, unknown node types and nodes without a nodeType are dropped', () => {
  const shadow = { nodeType: 11, childNodes: [el('div', { role: 'textbox', contenteditable: 'true' }, [text('typed in the shadow')])] }
  const doc = {
    documentElement: el('html', {}, [
      el('body', {}, [
        el('br'),
        el('hr', { class: 'rule' }),
        el('wbr'),
        el('my-host', { id: 'shadow-host' }, [text('light')], { shadowRoot: shadow }),
        { nodeType: 7, target: 'xml' },
        { nodeType: 4, data: 'cdata' },
        null,
        'garbage',
      ]),
    ]),
  }
  assert.equal(
    scrubDom(doc),
    '<!doctype html>\n<html><body><br><hr class="rule"><wbr><my-host id="shadow-host"><template shadowrootmode="open"><div role="textbox" contenteditable="true">…</div></template>…</my-host></body></html>\n',
  )
})

test('scrubDom: whitespace-only text nodes are dropped, nodeValue is the fallback for data, nodeName/tagName the fallback for localName, and an empty document still yields a doctype', () => {
  const doc = {
    documentElement: {
      nodeType: 1,
      nodeName: 'HTML',
      childNodes: [
        { nodeType: 3, nodeValue: '   \n\t ' },
        { nodeType: 3, nodeValue: 'real' },
        { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, data: '' }] },
      ],
    },
  }
  assert.equal(scrubDom(doc), '<!doctype html>\n<html>…<p></p></html>\n')
  assert.equal(scrubDom(null), '<!doctype html>\n\n')
  assert.equal(scrubDom({}), '<!doctype html>\n\n')
})
