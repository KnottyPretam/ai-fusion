// site.cjs pure helpers, jsdom-free: text normalisation and the insertion verification rule,
// visibility/enabled predicates over plain objects, the deep (open shadow root) query helpers over
// a fake tree, readText and AdapterError.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  normalizeText,
  tailMatches,
  isBlank,
  nonNegativeInt,
  isVisible,
  isEnabled,
  isTextField,
  readText,
  openShadowRoots,
  deepQuerySelector,
  deepQuerySelectorAll,
  AdapterError,
  VERIFY_TAIL_CHARS,
  SEND_POLL_MS,
  HEALTH_HEARTBEAT_MS,
  INSERT_SETTLE_MS,
  MESSAGE_SELECTORS,
  ASSISTANT_SELECTORS,
  ALERT_SELECTORS,
} = require('../../../preload/site.cjs')

test('constants match contract §3 (150 ms send poll, 20-char tail, 10 s heartbeat); INSERT_SETTLE_MS is exported for main\'s budget', () => {
  assert.equal(SEND_POLL_MS, 150)
  assert.equal(VERIFY_TAIL_CHARS, 20)
  assert.equal(HEALTH_HEARTBEAT_MS, 10000)
  assert.ok(Number.isInteger(INSERT_SETTLE_MS) && INSERT_SETTLE_MS > 0 && INSERT_SETTLE_MS < 1000)
})

test('the selector lists are frozen non-empty string lists; assistant selectors are a strict subset of the message roles', () => {
  for (const list of [MESSAGE_SELECTORS, ASSISTANT_SELECTORS, ALERT_SELECTORS]) {
    assert.ok(Object.isFrozen(list))
    assert.ok(list.length > 0 && list.every((s) => typeof s === 'string' && s !== ''))
  }
  assert.ok(!ASSISTANT_SELECTORS.includes('[data-message-author-role]')) // user turns are never assistant turns
  assert.ok(!ASSISTANT_SELECTORS.includes("[data-testid='user-message']"))
  assert.ok(!ASSISTANT_SELECTORS.includes('.message-bubble'))
})

test('normalizeText: CRLF/CR → LF, NBSP → space, null/undefined → "", everything else verbatim', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  assert.equal(normalizeText('x y'), 'x y')
  assert.equal(normalizeText(null), '')
  assert.equal(normalizeText(undefined), '')
  assert.equal(normalizeText('`${x}` "q" 日本 🚀'), '`${x}` "q" 日本 🚀')
  assert.equal(normalizeText(42), '42')
})

test('tailMatches: the composer text must end with the last 20 chars of the inserted text', () => {
  const text = 'The quick brown fox jumps over the lazy dog — ünïcödé 🚀'
  assert.ok(tailMatches(text, text))
  assert.ok(tailMatches('draft already there\n' + text, text)) // appended after a draft
  assert.ok(tailMatches(text + ' ', text)) // trailing whitespace from the editor
  assert.ok(!tailMatches(text.slice(0, -1), text)) // one char lost at the end
  assert.ok(!tailMatches(text, text + '!'))
  assert.ok(!tailMatches('', text))
  assert.ok(tailMatches('anything', '')) // nothing to verify
  assert.ok(tailMatches('x', 'x'))
})

test('tailMatches ignores whitespace differences (paragraph re-rendering, NBSP) but never non-whitespace ones', () => {
  const text = 'line one\n\nline  two\tend'
  assert.ok(tailMatches('line one\nline two end', text))
  assert.ok(tailMatches('line one\n\nline  two\tend\n', text))
  assert.ok(tailMatches('line one\n\nline  two\tend', text))
  assert.ok(!tailMatches('line one\n\nline  two\tEnd', text))
  assert.ok(!tailMatches('line one\n\nline  two\ten', text))
})

test('tailMatches with a custom n', () => {
  assert.ok(tailMatches('zzzabc', 'abc', 3))
  assert.ok(!tailMatches('zzzab', 'abc', 3))
  assert.ok(tailMatches('xbc', 'abc', 2))
})

test('isBlank treats NBSP, newlines and an empty-paragraph newline as blank', () => {
  assert.ok(isBlank(''))
  assert.ok(isBlank('\n'))
  assert.ok(isBlank('  \t\n'))
  assert.ok(isBlank(null))
  assert.ok(!isBlank('.'))
})

test('nonNegativeInt: rounds numbers and numeric strings, falls back for anything else', () => {
  assert.equal(nonNegativeInt(1500, 7), 1500)
  assert.equal(nonNegativeInt('250', 7), 250)
  assert.equal(nonNegativeInt(2.5, 7), 3)
  assert.equal(nonNegativeInt(0, 7), 0)
  assert.equal(nonNegativeInt(-1, 7), 7)
  assert.equal(nonNegativeInt(undefined, 7), 7)
  assert.equal(nonNegativeInt(null, 7), 7)
  assert.equal(nonNegativeInt('', 7), 7)
  assert.equal(nonNegativeInt('abc', 7), 7)
  assert.equal(nonNegativeInt(NaN, 7), 7)
  assert.equal(nonNegativeInt(Infinity, 7), 7)
})

test('isEnabled: disabled and aria-disabled="true" are not enabled; missing attributes are', () => {
  assert.ok(isEnabled({}))
  assert.ok(isEnabled({ disabled: false, getAttribute: () => null }))
  assert.ok(!isEnabled({ disabled: true }))
  assert.ok(!isEnabled({ getAttribute: (n) => (n === 'aria-disabled' ? 'TRUE' : null) }))
  assert.ok(isEnabled({ getAttribute: (n) => (n === 'aria-disabled' ? 'false' : null) }))
  assert.ok(!isEnabled(null))
  assert.ok(isEnabled({ getAttribute: () => { throw new Error('no attrs') } }))
})

test('isEnabled honours :disabled inheritance (a disabled <fieldset>) and a bare disabled attribute; a throwing matches() is ignored', () => {
  assert.ok(!isEnabled({ matches: (s) => s === ':disabled' }))
  assert.ok(isEnabled({ matches: () => false }))
  assert.ok(!isEnabled({ hasAttribute: (n) => n === 'disabled' }))
  assert.ok(isEnabled({ hasAttribute: () => false, getAttribute: () => null }))
  assert.ok(isEnabled({ matches: () => { throw new Error('unsupported pseudo-class') } }))
  assert.ok(!isEnabled({ matches: () => { throw new Error('boom') }, getAttribute: (n) => (n === 'aria-disabled' ? 'true' : null) })) // the later checks still run
})

test('isVisible: no client rects → hidden; display:none / visibility:hidden → hidden; no layout APIs → visible', () => {
  assert.ok(isVisible({}))
  assert.ok(!isVisible(null))
  assert.ok(!isVisible({ getClientRects: () => [] }))
  assert.ok(isVisible({ getClientRects: () => [{ width: 1 }] }))
  const win = (style) => ({ getComputedStyle: () => style })
  assert.ok(!isVisible({ getClientRects: () => [{}] }, win({ display: 'none', visibility: 'visible' })))
  assert.ok(!isVisible({ getClientRects: () => [{}] }, win({ display: 'block', visibility: 'hidden' })))
  assert.ok(isVisible({ getClientRects: () => [{}] }, win({ display: 'block', visibility: 'visible' })))
  // ownerDocument.defaultView is used when no window is passed
  const el = { getClientRects: () => [{}], ownerDocument: { defaultView: win({ display: 'none' }) } }
  assert.ok(!isVisible(el))
  assert.ok(isVisible({ getClientRects: () => { throw new Error('detached') } }))
})

test('isVisible rejects a zero-size bounding box (a collapsed duplicate) and accepts a real one', () => {
  assert.ok(!isVisible({ getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 0, height: 0 }) }))
  assert.ok(!isVisible({ getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 40, height: 0 }) }))
  assert.ok(!isVisible({ getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 0, height: 20 }) }))
  assert.ok(isVisible({ getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 40, height: 20 }) }))
  assert.ok(isVisible({ getBoundingClientRect: () => ({ width: 40, height: 20 }) }))
  assert.ok(isVisible({ getBoundingClientRect: () => null }))
  assert.ok(isVisible({ getBoundingClientRect: () => { throw new Error('detached') } }))
})

test('isTextField and readText: textarea/input read `value`, contenteditable reads innerText then textContent', () => {
  assert.ok(isTextField({ tagName: 'TEXTAREA' }))
  assert.ok(isTextField({ tagName: 'input' }))
  assert.ok(!isTextField({ tagName: 'DIV' }))
  assert.ok(!isTextField({}))
  assert.equal(readText({ tagName: 'TEXTAREA', value: 'v', innerText: 'ignored' }), 'v')
  assert.equal(readText({ tagName: 'TEXTAREA', value: null }), '')
  assert.equal(readText({ tagName: 'DIV', innerText: 'rendered', textContent: 'raw' }), 'rendered')
  assert.equal(readText({ tagName: 'DIV', textContent: 'raw' }), 'raw')
  assert.equal(readText({ tagName: 'DIV' }), '')
  assert.equal(readText(null), '')
  assert.equal(
    readText({
      tagName: 'DIV',
      get innerText() {
        throw new Error('no layout')
      },
    }),
    '',
  )
})

/** A fake DOM root: `map` = selector → element | element[]; `all` = the elements '*' returns. */
function fakeRoot(map, all = []) {
  const root = {
    querySelector(s) {
      if (s === '!bad') throw new SyntaxError('bad selector')
      const v = map[s]
      return Array.isArray(v) ? v[0] || null : v || null
    },
    querySelectorAll(s) {
      if (s === '!bad') throw new SyntaxError('bad selector')
      if (s === '*') return all
      const v = map[s]
      return v === undefined ? [] : Array.isArray(v) ? v : [v]
    },
  }
  return root
}

test('openShadowRoots lists open roots depth-first, nested ones included', () => {
  const inner = fakeRoot({})
  const innerHost = { shadowRoot: inner }
  const outer = fakeRoot({}, [innerHost])
  const outerHost = { shadowRoot: outer }
  const plain = {}
  const doc = fakeRoot({}, [plain, outerHost, plain])
  assert.deepEqual(openShadowRoots(doc), [outer, inner])
  assert.deepEqual(openShadowRoots(fakeRoot({}, [])), [])
  assert.deepEqual(openShadowRoots(null), [])
})

test('deepQuerySelector: light DOM first, then every open shadow root; invalid selectors → null', () => {
  const light = { id: 'light' }
  const shadowed = { id: 'shadowed' }
  const sr = fakeRoot({ '.only-in-shadow': shadowed, '.both': { id: 'shadow-copy' } })
  const doc = fakeRoot({ '.both': light }, [{ shadowRoot: sr }])
  assert.equal(deepQuerySelector(doc, '.both'), light)
  assert.equal(deepQuerySelector(doc, '.only-in-shadow'), shadowed)
  assert.equal(deepQuerySelector(doc, '.nowhere'), null)
  assert.equal(deepQuerySelector(doc, '!bad'), null)
  // roots may be pre-computed or lazy
  assert.equal(deepQuerySelector(doc, '.only-in-shadow', [sr]), shadowed)
  let calls = 0
  assert.equal(
    deepQuerySelector(doc, '.both', () => {
      calls += 1
      return [sr]
    }),
    light,
  )
  assert.equal(calls, 0) // the lazy root list is not computed on a light-DOM hit
  assert.equal(deepQuerySelector(doc, '.only-in-shadow', () => [sr]), shadowed)
  assert.equal(deepQuerySelector(doc, '.only-in-shadow', []), null)
})

test('deepQuerySelectorAll concatenates light DOM and shadow matches in order; invalid selectors → []', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const sr = fakeRoot({ '.m': [c] })
  const doc = fakeRoot({ '.m': [a, b] }, [{ shadowRoot: sr }])
  assert.deepEqual(deepQuerySelectorAll(doc, '.m'), [a, b, c])
  assert.deepEqual(deepQuerySelectorAll(doc, '.none'), [])
  assert.deepEqual(deepQuerySelectorAll(doc, '!bad'), [])
  assert.deepEqual(deepQuerySelectorAll(doc, '.m', []), [a, b])
  assert.deepEqual(deepQuerySelectorAll(null, '.m'), [])
})

test('AdapterError carries a contract code (unknown codes become site_error), the message and an optional partial', () => {
  const e = new AdapterError('not_submitted', 'nothing confirmed it', 'partial text')
  assert.ok(e instanceof Error)
  assert.equal(e.name, 'AdapterError')
  assert.equal(e.code, 'not_submitted')
  assert.equal(e.message, 'nothing confirmed it')
  assert.equal(e.partial, 'partial text')
  const bare = new AdapterError('busy')
  assert.equal(bare.message, 'busy')
  assert.ok(!('partial' in bare))
  assert.equal(new AdapterError('made_up', 'x').code, 'site_error')
})
