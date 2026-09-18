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
  // claude reads its body from `.prose` (S8); with no `.prose` the container itself is rendered
  const claudeDoc = parseHtml(`<html><body><div class="font-claude-response"><p>hello</p><ul><li>a</li></ul></div></body></html>`)
  const claude = createAdapter({ document: claudeDoc, site: 'claude', selectors: DEFAULT_SELECTORS })
  assert.equal(claude.replyText(claudeDoc.querySelector('.font-claude-response')), 'hello\n\n- a')
  // the Stage 2 fallback: a container with no childNodes (a fake, a shadow host) still reads back
  assert.equal(claude.replyText({ tagName: 'DIV', innerText: 'rendered text' }), 'rendered text')
  assert.equal(claude.replyText({ tagName: 'DIV', textContent: 'raw text' }), 'raw text')
})

// --- S7 review fixes: capture fidelity ---------------------------------------------------------

test('toMarkdown: a bare-token block before a code block is only that fence\'s header when the fence names no other language — otherwise it is CONTENT', () => {
  // the regression: a one-token heading before a `code.language-py` was swallowed as the header and
  // then discarded outright (the class wins), so a real block vanished from the capture
  assert.equal(md(`<div class="markdown"><h3>2000</h3><pre><code class="language-py">x=1</code></pre></div>`), '### 2000\n\n```py\nx=1\n```')
  // a heading / list / table / quote is content even when the fence has no language of its own
  assert.equal(md(`<div class="markdown"><h3>2000</h3><pre><code>x=1</code></pre></div>`), '### 2000\n\n```\nx=1\n```')
  assert.equal(md(`<div class="markdown"><ul><li>2000</li></ul><pre><code>x=1</code></pre></div>`), '- 2000\n\n```\nx=1\n```')
  // a `**app.py**` filename label and a one-word answer before a snippet survive too
  assert.equal(md(`<div class="markdown"><p><strong>app.py</strong></p><pre><code class="language-py">x=1</code></pre></div>`), '**app.py**\n\n```py\nx=1\n```')
  assert.equal(md(`<div class="markdown"><p>Yes</p><pre><code class="language-py">x=1</code></pre></div>`), 'Yes\n\n```py\nx=1\n```')
  // the real claude shape: the label and the class disagree → the label is content, the class the language
  assert.equal(
    md(`<div class="font-claude-response"><div class="relative group/copy"><div class="text-text-300 absolute text-xs">app.py</div><div class="code-block__code"><pre><code class="language-python">print(1)</code></pre></div></div></div>`),
    'app.py\n\n```python\nprint(1)\n```',
  )
  // …and when they agree, the header is still folded into the fence exactly once
  assert.equal(
    md(`<div class="font-claude-response"><div class="relative group/copy"><div class="text-text-300 absolute text-xs">python</div><div class="code-block__code"><pre><code class="language-python">print(1)</code></pre></div></div></div>`),
    '```python\nprint(1)\n```',
  )
  // grok's shape is unchanged: no class anywhere, so the header IS the only language clue
  assert.equal(
    md(`<div class="response-content-markdown"><div class="not-prose"><div class="flex"><span class="font-mono text-xs">bash</span><button aria-label="Copy">Copy</button></div><pre><code>echo hi</code></pre></div></div>`),
    '```bash\necho hi\n```',
  )
})

test('toMarkdown: a code block whose lines are block elements keeps its lines (a highlighter that wraps each line in a <div>)', () => {
  const lines = md(`<div class="markdown"><pre><code class="language-json"><div>{</div><div>  "a": 1</div><div>}</div></code></pre></div>`)
  assert.equal(lines, '```json\n{\n  "a": 1\n}\n```')
  assert.equal(JSON.parse(lines.slice('```json\n'.length, -'\n```'.length)).a, 1) // the capture still parses
  // an empty line element is a blank line, and a <span> line (hljs) is still inline
  assert.equal(md(`<div class="markdown"><pre><code><div>a</div><div></div><div>b</div></code></pre></div>`), '```\na\n\nb\n```')
  assert.equal(md(`<div class="markdown"><pre><code><span>a</span><span>b</span></code></pre></div>`), '```\nab\n```')
  // the chrome inside a line container is still dropped and never breaks the line
  assert.equal(md(`<div class="markdown"><pre><code><div class="cm-line">let a = 1<button>Copy</button></div><div class="cm-line">let b = 2</div></code></pre></div>`), '```\nlet a = 1\nlet b = 2\n```')
})

test('toMarkdown: a fenced JSON body keeps its BACKSLASH escapes, so the captured block still JSON.parses (the fenced-JSON contract)', () => {
  // The reason the analyst / defense prompts ask a web session for a ```json fence (backend
  // prompts/analyze.py, prompts/fusion.py): a rendered PARAGRAPH resolves CommonMark backslash
  // escapes, so `\"x\"` inside a JSON string would reach Triplex as a bare `"x"` and stop parsing
  // (MEASURED live on 2026-09-17). Inside a code block nothing is resolved and the bytes are the
  // page's own, so the capture must hand back every backslash untouched.
  const body = '{"statement": "The reply is exactly \\"PING-1\\".", "models": ["R1", "R2", "R3"]}'
  const chatgpt = md(
    `<div class="markdown"><pre><div class="flex items-center text-xs">json</div><button class="flex gap-1">Copy code</button><code class="language-json">${body}</code></pre></div>`,
  )
  assert.equal(chatgpt, '```json\n' + body + '\n```')
  const captured = JSON.parse(chatgpt.slice('```json\n'.length, -'\n```'.length))
  assert.equal(captured.statement, 'The reply is exactly "PING-1".')
  assert.deepEqual(captured.models, ['R1', 'R2', 'R3'])
  // the same body split one BLOCK element per line (a highlighter) keeps the escapes too
  const lines = md(
    `<div class="markdown"><pre><code class="language-json"><div class="cm-line">{</div><div class="cm-line">  "s": "a \\"q\\" and a \\\\ backslash"</div><div class="cm-line">}</div></code></pre></div>`,
  )
  assert.equal(JSON.parse(lines.slice('```json\n'.length, -'\n```'.length)).s, 'a "q" and a \\ backslash')
})

test('toMarkdown: a <pre> holding more than one <code> keeps every body and promotes none of them to the fence language', () => {
  assert.equal(md(`<div class="markdown"><pre><code>line one</code><code>py</code></pre></div>`), '```\nline one\npy\n```')
  // the language still comes from the first body's class, and every body is kept in order
  assert.equal(
    md(`<div class="markdown"><pre><code class="language-py">x = 1</code><code>y = 2</code></pre></div>`),
    '```py\nx = 1\ny = 2\n```',
  )
  // one code + an in-`pre` header is unchanged (the chatgpt shape)
  assert.equal(md(`<div class="markdown"><pre><div><div>python</div><code>print(1)</code></div></pre></div>`), '```python\nprint(1)\n```')
  // a NESTED code is already part of its parent's body: it is not appended a second time
  assert.equal(md(`<div class="markdown"><pre><code class="language-js">let a = <code>1</code></code></pre></div>`), '```js\nlet a = 1\n```')
})

test('toMarkdown: the fence is always longer than the longest fence line inside the body (three, four, five backticks)', () => {
  assert.equal(md(`<div class="markdown"><pre><code class="language-md">plain</code></pre></div>`), '```md\nplain\n```')
  assert.equal(md(`<div class="markdown"><pre><code class="language-md">\`\`\`json\n{}\n\`\`\`</code></pre></div>`), '````md\n```json\n{}\n```\n````')
  // a body that itself holds a FOUR-tick fence needs five, or the captured block closes early
  assert.equal(md(`<div class="markdown"><pre><code class="language-md">\`\`\`\`json\n{}\n\`\`\`\`</code></pre></div>`), '`````md\n````json\n{}\n````\n`````')
  // an indented fence line counts too
  assert.equal(md(`<div class="markdown"><pre><code>  \`\`\`\`\n  x\n  \`\`\`\`</code></pre></div>`), '`````\n  ````\n  x\n  ````\n`````')
})

test('toMarkdown: inline code containing a backtick keeps its backticks (CommonMark delimiter run + padding)', () => {
  assert.equal(md(`<div class="markdown"><p>type <code>\`x\`</code> now</p></div>`), 'type `` `x` `` now')
  assert.equal(md(`<div class="markdown"><p>a <code>npm ci</code> b</p></div>`), 'a `npm ci` b')
  // a run inside the body is always shorter than the delimiter; the padding is only where a backtick
  // sits against an edge (CommonMark strips at most one space from each side)
  assert.equal(md(`<div class="markdown"><p><code>a \`\` b</code></p></div>`), '```a `` b```')
  assert.equal(md(`<div class="markdown"><p><code>a \` b</code></p></div>`), '``a ` b``')
  assert.equal(md(`<div class="markdown"><p><kbd>\`</kbd></p></div>`), '`` ` ``')
})

test('toMarkdown: a KaTeX / MathML formula is captured ONCE — its TeX annotation, not the glyph run as well', () => {
  const katex = (tex, glyphs, attrs = '') =>
    `<div class="markdown"><p><span class="katex"><span class="katex-mathml"><math${attrs}><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">${glyphs}</span></span></p></div>`
  assert.equal(md(katex('x^2', '<span>x</span><span>2</span>')), '$x^2$')
  assert.equal(md(katex('E = mc^2', '<span>E</span>', ' display="block"')), '$$E = mc^2$$')
  // a formula with no TeX annotation falls back to its glyph run, still once
  assert.equal(md(`<div class="markdown"><p><math><mrow><mi>x</mi><mn>2</mn></mrow></math></p></div>`), 'x2')
  // the formula sits in its sentence, and 'math' is a subtree the walk renders itself
  assert.equal(md(`<div class="markdown"><p>so <math><semantics><mi>y</mi><annotation encoding="application/x-tex">y_1</annotation></semantics></math> holds.</p></div>`), 'so $y_1$ holds.')
  assert.ok(MD_SKIP_TAGS.includes('math'))
  assert.equal(toMarkdown(parseFragment(`<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>`)), '$x$')
})

test('toMarkdown: an image contributes its alt text and never its URL', () => {
  assert.equal(md(`<div class="markdown"><p>Chart: <img src="x.png" alt="revenue by quarter"></p></div>`), 'Chart: ![revenue by quarter]()')
  const withSrc = md(`<div class="markdown"><p><img src="https://cdn.example.com/plot.png" alt="the plot"></p></div>`)
  assert.equal(withSrc, '![the plot]()')
  assert.ok(!withSrc.includes('example.com'))
  // no alt is nothing at all (the Stage 2 behaviour), and a block-level image is its own block
  assert.equal(md(`<div class="markdown"><p>Chart: <img src="x.png"></p></div>`), 'Chart:')
  assert.equal(md(`<div class="markdown"><img src="x.png" alt="a figure"><p>after</p></div>`), '![a figure]()\n\nafter')
  assert.equal(md(`<div class="markdown"><p><picture><source srcset="a.webp"><img src="a.png" alt="picture alt"></picture></p></div>`), '![picture alt]()')
  assert.equal(md(`<div class="markdown"><p><img src="x.png" alt="hidden" aria-hidden="true"></p></div>`), '')
})

// --- S8: claude's doubled thinking summary (measured 2026-09-18) --------------------------------

/**
 * The claude.ai turn shape behind the S8 capture defect: a thinking / tool-use widget above the
 * answer whose summary line is in the DOM TWICE — the row on screen and the collapsed panel's own
 * copy, the panel clipped (no `display:none`, `visibility:hidden`, `hidden` or `aria-hidden`, the
 * only four things the walk drops) — and the answer inside the `.prose` markdown body the live probe
 * measured (2717 of the container's 2754 innerText characters, 2026-09-17).
 */
const CLAUDE_SUMMARY = 'Choosing the strongest language for safety-critical flight control.'
const claudeTurn = (bodyClass) =>
  parseHtml(
    `<html><body><div class="font-claude-response">` +
      `<div class="thinking" data-state="closed">` +
      `<div class="thinking-head"><div class="thinking-summary">${CLAUDE_SUMMARY}</div></div>` +
      `<div class="thinking-panel"><div class="thinking-summary">${CLAUDE_SUMMARY}</div></div>` +
      `</div>` +
      `<div class="${bodyClass}"><p><strong>Ada/SPARK</strong></p><p>SPARK can formally prove the absence of runtime errors.</p></div>` +
      `<div class="flex items-center"><button data-testid="action-bar-copy" aria-label="Copy">Copy</button></div>` +
      `</div></body></html>`,
  )
const ANSWER_MD = '**Ada/SPARK**\n\nSPARK can formally prove the absence of runtime errors.'

test("replyText (claude, S8): the thinking summary rides in front of the answer TWICE when the body is read from the whole turn — `.prose` reads the body instead and drops the widget by structure", () => {
  const doc = claudeTurn('grid-cols-1 grid gap-2.5 prose')
  const container = doc.querySelector('.font-claude-response')
  // the defect, reproduced: with the old default (an empty cascade) the capture is the whole turn
  const old = createAdapter({ document: doc, site: 'claude', selectors: { ...DEFAULT_SELECTORS.claude, assistantText: [] } })
  assert.equal(old.replyText(container), [CLAUDE_SUMMARY, CLAUDE_SUMMARY, ANSWER_MD].join('\n\n'))
  // the fix: the body is read from the markdown container, so the widget is not in the capture at all
  const fixed = createAdapter({ document: doc, site: 'claude', selectors: DEFAULT_SELECTORS })
  assert.equal(fixed.replyText(container), ANSWER_MD)
  assert.ok(!fixed.replyText(container).includes(CLAUDE_SUMMARY))
  // one line in the DOM is one line in the capture: the doubling is the page's, not the walk's
  assert.equal(doc.querySelectorAll('.thinking-summary').length, 2)
  const single = parseHtml(`<html><body><div class="font-claude-response"><div class="thinking"><div class="thinking-summary">${CLAUDE_SUMMARY}</div></div><div class="prose"><p>answer</p></div></div></body></html>`)
  const walked = toMarkdown(single.querySelector('.font-claude-response'))
  assert.equal(walked, CLAUDE_SUMMARY + '\n\nanswer')
  assert.equal(walked.split(CLAUDE_SUMMARY).length - 1, 1)
})

test('replyText (claude, S8): a turn with no `.prose` still captures the WHOLE answer — the cascade fallback can add chrome, never lose the reply', () => {
  const doc = claudeTurn('grid-cols-1 grid gap-2.5') // a build whose body class is not `.prose` any more
  const container = doc.querySelector('.font-claude-response')
  const a = createAdapter({ document: doc, site: 'claude', selectors: DEFAULT_SELECTORS })
  const text = a.replyText(container)
  assert.equal(text, [CLAUDE_SUMMARY, CLAUDE_SUMMARY, ANSWER_MD].join('\n\n')) // exactly the old behaviour
  assert.ok(text.endsWith(ANSWER_MD)) // the answer, whole, every time
  // and the answer alone once a `.prose` element exists anywhere in the turn
  const withProse = claudeTurn('prose')
  assert.equal(createAdapter({ document: withProse, site: 'claude', selectors: DEFAULT_SELECTORS }).replyText(withProse.querySelector('.font-claude-response')), ANSWER_MD)
})

test('replyText (claude, S8): several `.prose` blocks in one turn are all captured, and a `.prose` nested in another is not captured twice', () => {
  const doc = parseHtml(
    `<html><body><div class="font-claude-response"><div class="thinking"><div class="thinking-summary">${CLAUDE_SUMMARY}</div></div>` +
      `<div class="prose"><p>first block</p></div><div class="prose"><p>second block</p><div class="prose"><p>nested</p></div></div></div></body></html>`,
  )
  const a = createAdapter({ document: doc, site: 'claude', selectors: DEFAULT_SELECTORS })
  const text = a.replyText(doc.querySelector('.font-claude-response'))
  assert.equal(text, 'first block\n\nsecond block\n\nnested')
  assert.equal(text.split('nested').length - 1, 1) // the nested block's text, once
  assert.ok(!text.includes(CLAUDE_SUMMARY))
})
