// desktop/preload/site.cjs `toMarkdown(el)` (contract §3, Stage 3) over hand-built DOM snippets in
// the three sites' code-block shapes, plus the `replyText` cascade that uses it.
//
// The snippets are parsed by test/unit/preload/_dom.js (no jsdom, no dependency), which has no
// layout and no view: `getComputedStyle` is absent, so nothing preserves whitespace here and every
// element counts as visible. Whitespace preservation and the real chat chrome are covered by the
// Playwright `adapters` project against the fake site (test/adapters/observe.spec.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { parseFragment, parseHtml } from './_dom.js'

const require = createRequire(import.meta.url)
const { toMarkdown, createAdapter, DEFAULT_SELECTORS, MD_CHROME_TEXT, MD_SKIP_TAGS } = require('../../../preload/site.cjs')

const md = (html) => toMarkdown(parseFragment(html))

test('toMarkdown: a chatgpt code block — the header language and the Copy button live INSIDE the <pre> — becomes a fenced block with that language and nothing else', () => {
  // The language is taken from the `language-xxx` class when it is there…
  const withClass = md(
    `<div class="markdown"><pre class="overflow-visible!"><div class="contain-inline-size"><div class="flex items-center text-xs">json</div><div class="sticky top-9"><div class="absolute end-0"><button class="flex gap-1">Copy code</button></div></div><div class="overflow-y-auto p-4"><code class="whitespace-pre! language-json">{"a": 1, "b": [2, 3]}</code></div></div></pre></div>`,
  )
  assert.equal(withClass, '```json\n{"a": 1, "b": [2, 3]}\n```')
  // …and from the header text when the code carries no class at all (the header is the only clue)
  const fromHeader = md(
    `<div class="markdown"><pre><div><div class="flex items-center text-xs">python</div><div><button aria-label="Copy">Copy code</button></div><div><code>print("hi")</code></div></div></pre></div>`,
  )
  assert.equal(fromHeader, '```python\nprint("hi")\n```')
  // no class, no header: a bare fence, and the chrome is still gone
  assert.equal(md(`<div class="markdown"><pre><div><button>Copy code</button><code>plain body</code></div></pre></div>`), '```\nplain body\n```')
})

test('toMarkdown: a code block whose header sits OUTSIDE the <pre> (claude / grok) still fences with that language, and the copy chrome after it is dropped', () => {
  const claude = md(
    `<div class="font-claude-response"><div class="relative group/copy"><div class="text-text-300 absolute text-xs">sql</div><div class="code-block__code"><pre><code>SELECT 1;</code></pre></div><div class="absolute end-2"><button aria-label="Copy to clipboard">Copy</button></div></div></div>`,
  )
  assert.equal(claude, '```sql\nSELECT 1;\n```')
  const grok = md(
    `<div class="response-content-markdown"><div class="not-prose"><div class="flex items-center justify-between"><span class="font-mono text-xs">bash</span><button aria-label="Copy">Copy</button></div><pre><code>echo hi</code></pre></div></div>`,
  )
  assert.equal(grok, '```bash\necho hi\n```')
  // a bare label that is NOT followed by a code block stays content
  assert.equal(md(`<div class="markdown"><p>json</p><p>is a format</p></div>`), 'json\n\nis a format')
  // a chrome-only block is dropped wherever it sits
  assert.equal(md(`<div class="markdown"><p>text</p><div>Copy code</div></div>`), 'text')
})

test('toMarkdown: a code block keeps its body byte for byte — indentation, blank lines and backticks — and one trailing newline is dropped', () => {
  const body = 'def f(x):\n    if x:\n\n        return "`x`"\n'
  const el = parseFragment(`<div class="markdown"><pre><code class="language-python">${body}</code></pre></div>`)
  assert.equal(toMarkdown(el), '```python\ndef f(x):\n    if x:\n\n        return "`x`"\n```')
  // a body that itself holds a fence line is wrapped in four backticks
  const nested = md(`<div class="markdown"><pre><code class="language-md">\`\`\`json\n{}\n\`\`\`</code></pre></div>`)
  assert.equal(nested, '````md\n```json\n{}\n```\n````')
})

test('toMarkdown: nested lists become - / 1. with the marker\'s indentation, tight against their parent item', () => {
  const nested = md(
    `<div class="markdown"><ul><li>one<ul><li>one a</li><li>one b<ul><li>deep</li></ul></li></ul></li><li>two</li></ul></div>`,
  )
  assert.equal(nested, '- one\n  - one a\n  - one b\n    - deep\n- two')
  const ordered = md(`<div class="markdown"><ol><li><p>first</p><ul><li>bullet</li></ul></li><li>second</li></ol></div>`)
  assert.equal(ordered, '1. first\n   - bullet\n2. second')
  assert.equal(md(`<div class="markdown"><ol start="3"><li>three</li><li>four</li></ol></div>`), '3. three\n4. four')
  // a second paragraph inside an item keeps its blank line, indented under the marker
  assert.equal(md(`<div class="markdown"><ul><li><p>a</p><p>still a</p></li></ul></div>`), '- a\n\n  still a')
})

test('toMarkdown: a table becomes GFM pipes (the row with <th> is the header, a pipe in a cell is escaped, short rows are padded)', () => {
  const table = md(
    `<div class="markdown"><table><thead><tr><th>Model</th><th>Range</th></tr></thead><tbody><tr><td>R1</td><td>2000 deg/s</td></tr><tr><td>R2</td><td>a | b</td></tr></tbody></table></div>`,
  )
  assert.equal(table, '| Model | Range |\n| --- | --- |\n| R1 | 2000 deg/s |\n| R2 | a \\| b |')
  // no <th> at all: the first row is the header; a short row is padded to the table's width
  assert.equal(md(`<div class="markdown"><table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table></div>`), '| a | b |\n| --- | --- |\n| c |  |')
})

test('toMarkdown: headings, inline code, links (text only), emphasis, quotes, rules and paragraphs', () => {
  const body = md(
    `<div class="markdown"><h1>Title</h1><h3>Sub</h3><p>Use <code>npm ci</code> and see <a href="https://example.com/deep/path?q=1">the docs</a>.</p><p>A <strong>bold</strong> and <em>italic</em> and <del>gone</del> word.</p><blockquote><p>quoted</p><p>twice</p></blockquote><hr /><p>after</p></div>`,
  )
  assert.equal(
    body,
    '# Title\n\n### Sub\n\nUse `npm ci` and see the docs.\n\nA **bold** and _italic_ and ~~gone~~ word.\n\n> quoted\n>\n> twice\n\n---\n\nafter',
  )
  // the URL really is dropped, the link text really is kept
  assert.ok(!body.includes('example.com'))
  // <br> is a line break inside its paragraph; a heading never gets one
  assert.equal(md(`<div class="markdown"><p>a<br />b</p><h2>c<br />d</h2></div>`), 'a\nb\n\n## c d')
})

test('toMarkdown: whitespace is normalised — runs collapse, blank edges go, blocks are separated by exactly one blank line', () => {
  assert.equal(md(`<div class="markdown">\n  <p>  a   lot\n   of   space  </p>\n  <p>\n\tsecond\n  </p>\n</div>`), 'a lot of space\n\nsecond')
  // an empty block contributes nothing at all
  assert.equal(md(`<div class="markdown"><p></p><p>  </p><p>x</p><div></div></div>`), 'x')
})

test('toMarkdown: chrome, media and hidden subtrees never reach the capture', () => {
  const html = `<div class="markdown"><p>keep</p><button data-testid="copy-turn-action-button">Copy</button><script>var x = 1</script><style>p{}</style><svg><title>icon</title></svg><img /><iframe></iframe><textarea>draft</textarea><select><option>one</option></select><div hidden>hidden block</div><span aria-hidden="true">decorative</span><p>also keep</p></div>`
  assert.equal(md(html), 'keep\n\nalso keep')
  for (const tag of ['script', 'style', 'button', 'svg', 'iframe', 'textarea', 'select']) assert.ok(MD_SKIP_TAGS.includes(tag), tag)
  assert.ok(MD_CHROME_TEXT.includes('copy code'))
})

test('toMarkdown never throws and answers "" for anything it cannot walk (the caller then falls back to innerText)', () => {
  assert.equal(toMarkdown(null), '')
  assert.equal(toMarkdown(undefined), '')
  assert.equal(toMarkdown('a string'), '')
  assert.equal(toMarkdown({ innerText: 'no childNodes here' }), '') // a Stage 2 fake, or a shadow host
  assert.equal(toMarkdown({ nodeType: 1, localName: 'div', childNodes: [] }), '')
  const throwing = {
    nodeType: 1,
    localName: 'div',
    get childNodes() {
      throw new Error('boom')
    },
  }
  assert.equal(toMarkdown(throwing), '')
  // a bare text node is its own text
  assert.equal(toMarkdown({ nodeType: 3, data: 'just text' }), 'just text')
})

test('toMarkdown: a <pre> or a <table> handed in directly renders as itself, not as a container', () => {
  assert.equal(toMarkdown(parseFragment('<pre><code class="language-js">let a = 1</code></pre>')), '```js\nlet a = 1\n```')
  assert.equal(toMarkdown(parseFragment('<table><tr><th>h</th></tr><tr><td>v</td></tr></table>')), '| h |\n| --- |\n| v |')
  assert.equal(toMarkdown(parseFragment('<ul><li>a</li><li>b</li></ul>')), '- a\n- b')
})

test('replyText: the assistantText cascade is preferred and rendered as markdown; a node the walk cannot read falls back to innerText', () => {
  const doc = parseHtml(
    `<html><body><main><article data-message-author-role="assistant"><div class="markdown"><p>the answer</p><pre><code class="language-json">{"ok": true}</code></pre></div><div class="flex"><button data-testid="copy-turn-action-button">Copy</button></div></article></main></body></html>`,
  )
  const a = createAdapter({ document: doc, site: 'chatgpt', selectors: DEFAULT_SELECTORS })
  const container = doc.querySelector("[data-message-author-role='assistant']")
  assert.equal(a.replyText(container), 'the answer\n\n```json\n{"ok": true}\n```')
  // the ".markdown" match wins over the container, so the action bar's "Copy" is not in the capture
  assert.ok(!a.replyText(container).includes('Copy'))
  // claude keeps assistantText empty: the container itself is rendered
  const claudeDoc = parseHtml(`<html><body><div class="font-claude-response"><p>hello</p><ul><li>a</li></ul></div></body></html>`)
  const claude = createAdapter({ document: claudeDoc, site: 'claude', selectors: DEFAULT_SELECTORS })
  assert.equal(claude.replyText(claudeDoc.querySelector('.font-claude-response')), 'hello\n\n- a')
  // the Stage 2 fallback: a container with no childNodes (a fake, a shadow host) still reads back
  assert.equal(claude.replyText({ tagName: 'DIV', innerText: 'rendered text' }), 'rendered text')
  assert.equal(claude.replyText({ tagName: 'DIV', textContent: 'raw text' }), 'raw text')
})
