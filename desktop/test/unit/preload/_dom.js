// desktop/test/unit/preload/_dom.js — a tiny HTML parser + DOM for `node --test` (not a test:
// node --test only collects *.test.js).
//
// Why it exists: the fixture DOMs under desktop/test/fixtures/dom/ and the toMarkdown snippets have
// to be run through the REAL desktop/preload/site.cjs, and the desktop package may not grow a
// dependency (no jsdom). The surface below is exactly what site.cjs touches — `querySelector(All)`,
// `matches`, `closest`, `contains`, `compareDocumentPosition`, `childNodes`, `attributes`,
// `textContent`, `getAttribute`/`hasAttribute`, `nodeType`/`localName`/`tagName`, `document.title`
// — and nothing else. There is no layout and no view, so `isVisible` treats every element as
// visible and `toMarkdown` preserves no whitespace (see the site.cjs Stage 3 header): a fixture is
// a shape, never a rendering.
//
// The parser is deliberately strict and small; the fixtures are hand-written to suit it:
//   * tags and attributes are lowercase, attribute values are double-quoted (or bare / single-quoted)
//   * void elements close themselves, `<x/>` is accepted, comments and the doctype are dropped
//   * `<script>`/`<style>` bodies are NOT special-cased (fixtures carry neither)
// The selector engine covers the selector shapes DEFAULT_SELECTORS and site.cjs actually use:
// a comma list of complex selectors with descendant / `>` combinators over compounds of
// `tag`, `*`, `#id`, `.class`, `[attr]`, `[attr=v]`, `[attr^=v]`, `[attr*=v]`, `[attr$=v]`,
// `[attr~=v]`, `:not(<compound>)`, `:disabled` and `:empty`.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' }

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m
  })
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

class Text {
  constructor(data) {
    this.nodeType = 3
    this.data = data
    this.parentNode = null
    this.ownerDocument = null
  }
  get nodeValue() {
    return this.data
  }
  get textContent() {
    return this.data
  }
}

class Element {
  constructor(tag, attrs = []) {
    this.nodeType = 1
    this.localName = String(tag).toLowerCase()
    this.tagName = this.localName.toUpperCase()
    this.attributes = attrs.map(([name, value]) => ({ name: String(name).toLowerCase(), value: String(value) }))
    this.childNodes = []
    this.parentNode = null
    this.ownerDocument = null
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1)
  }
  get id() {
    return this.getAttribute('id') || ''
  }
  get className() {
    return this.getAttribute('class') || ''
  }
  get classList() {
    return this.className.split(/\s+/).filter((s) => s !== '')
  }
  get disabled() {
    return this.hasAttribute('disabled')
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('')
  }
  getAttribute(name) {
    const a = this.attributes.find((x) => x.name === String(name).toLowerCase())
    return a ? a.value : null
  }
  hasAttribute(name) {
    return this.attributes.some((x) => x.name === String(name).toLowerCase())
  }
  setAttribute(name, value) {
    const key = String(name).toLowerCase()
    const a = this.attributes.find((x) => x.name === key)
    if (a) a.value = String(value)
    else this.attributes.push({ name: key, value: String(value) })
  }
  appendChild(node) {
    node.parentNode = this
    node.ownerDocument = this.ownerDocument
    this.childNodes.push(node)
    return node
  }
  matches(selector) {
    return matchesSelector(this, selector)
  }
  closest(selector) {
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) if (matchesSelector(el, selector)) return el
    return null
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true
    return false
  }
  /** DOCUMENT_POSITION_FOLLOWING (4) / _PRECEDING (2) / _CONTAINED_BY (16) — what site.cjs reads. */
  compareDocumentPosition(other) {
    if (other === this) return 0
    if (this.contains(other)) return 4 + 16
    if (other.contains && other.contains(this)) return 2 + 8
    const order = documentOrder(rootOf(this))
    const a = order.indexOf(this)
    const b = order.indexOf(other)
    if (a === -1 || b === -1) return 0
    return b > a ? 4 : 2
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
  querySelectorAll(selector) {
    const list = parseSelectorList(selector)
    const out = []
    for (const el of documentOrder(this)) {
      if (el === this) continue
      if (list.some((complex) => matchesComplex(el, complex))) out.push(el)
    }
    return out
  }
}

class Document {
  constructor() {
    this.nodeType = 9
    this.documentElement = null
    this.title = ''
    this.defaultView = null
  }
  querySelector(selector) {
    return this.documentElement ? scopedQuery(this.documentElement, selector)[0] || null : null
  }
  querySelectorAll(selector) {
    return this.documentElement ? scopedQuery(this.documentElement, selector) : []
  }
}

/** Like `querySelectorAll` but the root element itself can match (a document scopes from the root). */
function scopedQuery(root, selector) {
  const list = parseSelectorList(selector)
  return documentOrder(root).filter((el) => list.some((complex) => matchesComplex(el, complex)))
}

function rootOf(node) {
  let n = node
  while (n.parentNode) n = n.parentNode
  return n
}

/** Every element at or under `node`, in document order. */
function documentOrder(node) {
  const out = []
  const walk = (n) => {
    if (n.nodeType === 1) out.push(n)
    for (const c of n.childNodes || []) walk(c)
  }
  walk(node)
  return out
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

// A class name here is `[\w-]+`: `.a.b` is two classes, exactly as CSS reads it (a real class that
// contains a dot or a bang — `gap-2.5`, `whitespace-pre!` — would need escaping in a selector, and
// none of the cascades use one).
const COMPOUND_RE = /^(?:[*]|[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]*\]|:not\([^)]*\)|:[a-z-]+)+/

/** Split a selector list on top-level commas (a comma inside [] or :not() stays put). */
function splitList(selector) {
  const out = []
  let depth = 0
  let current = ''
  for (const ch of String(selector)) {
    if (ch === '[' || ch === '(') depth += 1
    if (ch === ']' || ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/** `a b > c` → [{compound:'a', combinator:null}, {compound:'b', combinator:' '}, …] (left to right). */
function parseComplex(selector) {
  const parts = []
  let rest = selector.trim()
  let combinator = null
  while (rest !== '') {
    const m = COMPOUND_RE.exec(rest)
    if (!m) throw new Error(`_dom: unsupported selector "${selector}" at "${rest}"`)
    parts.push({ compound: parseCompound(m[0]), combinator })
    rest = rest.slice(m[0].length)
    const sep = /^\s*([>+~])?\s*/.exec(rest)
    const hadSpace = sep[0] !== ''
    combinator = sep[1] || (hadSpace ? ' ' : null)
    rest = rest.slice(sep[0].length)
    if (rest !== '' && combinator === null) throw new Error(`_dom: unsupported selector "${selector}"`)
  }
  return parts
}

function parseCompound(text) {
  const simple = []
  let rest = text
  while (rest !== '') {
    let m
    if ((m = /^\*/.exec(rest))) simple.push({ kind: 'any' })
    else if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) simple.push({ kind: 'tag', value: m[0].toLowerCase() })
    else if ((m = /^#([\w-]+)/.exec(rest))) simple.push({ kind: 'id', value: m[1] })
    else if ((m = /^\.([\w-]+)/.exec(rest))) simple.push({ kind: 'class', value: m[1] })
    else if ((m = /^\[([\w-]+)(?:([~^$*|]?=)\s*("[^"]*"|'[^']*'|[^\]]*))?\]/.exec(rest))) {
      simple.push({ kind: 'attr', name: m[1].toLowerCase(), op: m[2] || null, value: m[3] === undefined ? null : unquote(m[3]) })
    } else if ((m = /^:not\(([^)]*)\)/.exec(rest))) simple.push({ kind: 'not', value: parseCompound(m[1].trim()) })
    else if ((m = /^:([a-z-]+)/.exec(rest))) simple.push({ kind: 'pseudo', value: m[1] })
    else throw new Error(`_dom: unsupported simple selector at "${rest}"`)
    rest = rest.slice(m[0].length)
  }
  return simple
}

function unquote(v) {
  const s = String(v).trim()
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s
}

const CACHE = new Map()
function parseSelectorList(selector) {
  const key = String(selector)
  if (!CACHE.has(key)) CACHE.set(key, splitList(key).map(parseComplex))
  return CACHE.get(key)
}

function matchesCompound(el, compound) {
  return compound.every((s) => {
    if (s.kind === 'any') return true
    if (s.kind === 'tag') return el.localName === s.value
    if (s.kind === 'id') return el.id === s.value
    if (s.kind === 'class') return el.classList.includes(s.value)
    if (s.kind === 'not') return !matchesCompound(el, s.value)
    if (s.kind === 'pseudo') {
      if (s.value === 'disabled') return el.hasAttribute('disabled')
      if (s.value === 'enabled') return !el.hasAttribute('disabled')
      if (s.value === 'empty') return el.childNodes.length === 0
      throw new Error(`_dom: unsupported pseudo-class :${s.value}`)
    }
    const v = el.getAttribute(s.name)
    if (v === null) return false
    if (s.op === null) return true
    if (s.op === '=') return v === s.value
    if (s.op === '*=') return s.value !== '' && v.includes(s.value)
    if (s.op === '^=') return v.startsWith(s.value)
    if (s.op === '$=') return v.endsWith(s.value)
    if (s.op === '~=') return v.split(/\s+/).includes(s.value)
    if (s.op === '|=') return v === s.value || v.startsWith(s.value + '-')
    throw new Error(`_dom: unsupported attribute operator ${s.op}`)
  })
}

/** Right-to-left evaluation of `a b > c` against `el`. */
function matchesComplex(el, parts) {
  const last = parts[parts.length - 1]
  if (!matchesCompound(el, last.compound)) return false
  let current = el
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const combinator = parts[i].combinator
    const target = parts[i - 1].compound
    if (combinator === '>') {
      current = current.parentNode
      if (!current || current.nodeType !== 1 || !matchesCompound(current, target)) return false
      continue
    }
    if (combinator === ' ') {
      let ancestor = current.parentNode
      while (ancestor && ancestor.nodeType === 1 && !matchesCompound(ancestor, target)) ancestor = ancestor.parentNode
      if (!ancestor || ancestor.nodeType !== 1) return false
      current = ancestor
      continue
    }
    throw new Error(`_dom: unsupported combinator "${combinator}"`)
  }
  return true
}

export function matchesSelector(el, selector) {
  return parseSelectorList(selector).some((complex) => matchesComplex(el, complex))
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

function parseAttrs(text) {
  const attrs = []
  const re = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
  let m
  while ((m = re.exec(text)) !== null) attrs.push([m[1], m[2] === undefined ? '' : decodeEntities(unquote(m[2]))])
  return attrs
}

/**
 * Parse `html` into a Document. Whitespace-only text between tags is kept (site.cjs must cope with
 * it exactly as in a browser); a fixture that wants no stray text writes its tags back to back.
 */
export function parseHtml(html) {
  const doc = new Document()
  const root = new Element('html')
  root.ownerDocument = doc
  doc.documentElement = root
  const stack = [root]
  const src = String(html)
  let i = 0
  const top = () => stack[stack.length - 1]
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      addText(top(), src.slice(i), doc)
      break
    }
    if (lt > i) addText(top(), src.slice(i, lt), doc)
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      i = end === -1 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end === -1 ? src.length : end + 1
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt === -1) {
      addText(top(), src.slice(lt), doc)
      break
    }
    const raw = src.slice(lt + 1, gt).trim()
    i = gt + 1
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase()
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].localName === name) {
          stack.length = k
          break
        }
      }
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const space = body.search(/\s/)
    const name = (space === -1 ? body : body.slice(0, space)).toLowerCase()
    const attrs = space === -1 ? [] : parseAttrs(body.slice(space))
    // The document's own <html> tag is the root that already exists (the whitespace after a
    // doctype is not content); its attributes land on it.
    if (name === 'html' && stack.length === 1 && root.children.length === 0) {
      root.childNodes = root.childNodes.filter((n) => !(n.nodeType === 3 && n.data.trim() === ''))
      for (const [n, v] of attrs) root.setAttribute(n, v)
      continue
    }
    const el = new Element(name, attrs)
    el.ownerDocument = doc
    top().appendChild(el)
    if (!selfClosing && !VOID.has(name)) stack.push(el)
  }
  const title = doc.querySelector('title')
  if (title) doc.title = title.textContent
  return doc
}

function addText(parent, raw, doc) {
  if (raw === '') return
  const node = new Text(decodeEntities(raw))
  node.parentNode = parent
  node.ownerDocument = doc
  parent.childNodes.push(node)
}

/** Parse an HTML snippet and return its single root element (the toMarkdown fixture snippets). */
export function parseFragment(html) {
  const doc = parseHtml(html)
  return doc.documentElement.children[0] || doc.documentElement
}

export { Document, Element, Text }
