// council.js — the catalog, the transports read off a model string (strict: web: only for a site
// with an adapter and only under its own slot; ollama:<name>; an org/model slug), parseAgent /
// parseCouncil (strict, catalog order, 2..5), sanitizeCouncil (tolerant: malformed members dropped,
// too few or too many → the default council, never a truncated one), councilSlots / councilSites;
// 2026-10-17: gemini is the fourth site, the default council is the four web sites, LEGACY_COUNCIL /
// sameCouncil back the one-time settings migration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { COUNCIL_SLOTS, WEB_SITES, EFFORTS, COUNCIL_MIN, COUNCIL_MAX, TRANSPORTS, WEB_EFFORT, DEFAULT_COUNCIL, LEGACY_COUNCIL, LEGACY_SITES, sameCouncil, transportOf, parseAgent, parseCouncil, sanitizeCouncil, sanitizeCouncilReport, councilSlots, councilSites, isCouncilSlot } from '../../../main/council.js'
import { SLOTS } from '../../../main/sites.js'

const CLASSIC = { slots: { claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' }, grok: { model: 'web:grok', effort: 'off' } } }
/** The default since 2026-10-17: every web site, gemini included. */
const FOUR = { slots: { ...CLASSIC.slots, gemini: { model: 'web:gemini', effort: 'off' } } }
const QWEN = { model: 'qwen/qwen3-235b-a22b', effort: 'low' }
const DEEPSEEK = { model: 'ollama:deepseek-r1:8b', effort: 'medium' }

test('the catalog: seven vendors, the classic three FIRST (the backend SLOT_IDS order); the web sites are sites.js SLOTS; the bounds and efforts', () => {
  assert.deepEqual([...COUNCIL_SLOTS], ['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'qwen', 'mimo'])
  assert.deepEqual([...COUNCIL_SLOTS.slice(0, 4)], [...SLOTS], 'the sites are the first four catalog members, in order')
  assert.deepEqual([...SLOTS], ['claude', 'chatgpt', 'grok', 'gemini'])
  assert.equal(WEB_SITES, SLOTS)
  assert.deepEqual([...EFFORTS], ['off', 'low', 'medium', 'high'])
  assert.deepEqual([COUNCIL_MIN, COUNCIL_MAX], [2, 5])
  assert.deepEqual([...TRANSPORTS], ['web', 'ollama', 'openrouter'])
  assert.equal(WEB_EFFORT, 'off')
  assert.ok(Object.isFrozen(COUNCIL_SLOTS))
  for (const id of COUNCIL_SLOTS) assert.equal(isCouncilSlot(id), true)
  for (const bad of ['bing', 'analyst', '', null, undefined, 3]) assert.equal(isCouncilSlot(bad), false)
})

test('DEFAULT_COUNCIL(): every web site (four since 2026-10-17) on its own web session at effort off, a fresh object every time', () => {
  assert.deepEqual(DEFAULT_COUNCIL(), FOUR)
  assert.notEqual(DEFAULT_COUNCIL(), DEFAULT_COUNCIL())
  assert.notEqual(DEFAULT_COUNCIL().slots.claude, DEFAULT_COUNCIL().slots.claude)
  assert.deepEqual(Object.keys(DEFAULT_COUNCIL().slots), [...SLOTS])
  assert.deepEqual(parseCouncil(DEFAULT_COUNCIL()), FOUR, 'the default passes the strict reader')
})

test('LEGACY_COUNCIL(): the classic three as the default was before gemini joined — a fresh object every time', () => {
  assert.deepEqual(LEGACY_COUNCIL(), CLASSIC)
  assert.deepEqual([...LEGACY_SITES], ['claude', 'chatgpt', 'grok'])
  assert.ok(Object.isFrozen(LEGACY_SITES))
  assert.notEqual(LEGACY_COUNCIL(), LEGACY_COUNCIL())
  assert.notEqual(LEGACY_COUNCIL().slots.grok, LEGACY_COUNCIL().slots.grok)
  const a = LEGACY_COUNCIL()
  a.slots.claude.effort = 'high'
  assert.equal(LEGACY_COUNCIL().slots.claude.effort, 'off', 'mutating a copy never reaches the next one')
})

test('sameCouncil: the same member set with the same model and effort per member; key order irrelevant; a missing effort reads as medium', () => {
  assert.equal(sameCouncil(LEGACY_COUNCIL(), CLASSIC), true)
  assert.equal(sameCouncil(DEFAULT_COUNCIL(), FOUR), true)
  assert.equal(sameCouncil(DEFAULT_COUNCIL(), LEGACY_COUNCIL()), false, 'four is not the legacy three')
  const reordered = { slots: { grok: { model: 'web:grok', effort: 'off' }, claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' } } }
  assert.equal(sameCouncil(reordered, CLASSIC), true, 'key order does not matter')
  assert.equal(sameCouncil({ slots: { ...CLASSIC.slots, claude: { model: 'web:claude', effort: 'low' } } }, CLASSIC), false, 'an effort differs')
  assert.equal(sameCouncil({ slots: { ...CLASSIC.slots, claude: { model: 'anthropic/claude-sonnet-4.5', effort: 'off' } } }, CLASSIC), false, 'a model differs')
  assert.equal(sameCouncil({ slots: { claude: CLASSIC.slots.claude, chatgpt: CLASSIC.slots.chatgpt } }, CLASSIC), false, 'a member missing')
  assert.equal(sameCouncil({ slots: { ...CLASSIC.slots, qwen: QWEN } }, CLASSIC), false, 'a member more')
  assert.equal(sameCouncil({ slots: { claude: { model: 'web:claude' }, grok: { model: 'web:grok' } } }, { slots: { grok: { model: 'web:grok', effort: 'medium' }, claude: { model: 'web:claude', effort: 'medium' } } }), true, 'absent effort = medium')
  assert.equal(sameCouncil({ slots: { claude: 'web:claude', chatgpt: CLASSIC.slots.chatgpt, grok: CLASSIC.slots.grok } }, CLASSIC), false, 'a malformed member')
  for (const bad of [null, undefined, {}, { slots: null }, 'x', []]) {
    assert.equal(sameCouncil(bad, CLASSIC), false, JSON.stringify(bad))
    assert.equal(sameCouncil(CLASSIC, bad), false, JSON.stringify(bad))
    assert.equal(sameCouncil(bad, bad), false, 'not a council is never equal, even to itself')
  }
})

test('transportOf: web: only for a site with an adapter, ollama: with a name, an org/model slug; everything else null', () => {
  for (const site of SLOTS) assert.equal(transportOf(`web:${site}`), 'web', site)
  assert.equal(transportOf('web:gemini'), 'web', 'gemini is a site since 2026-10-17')
  for (const noAdapter of ['deepseek', 'qwen', 'mimo']) assert.equal(transportOf(`web:${noAdapter}`), null, `${noAdapter}: no site`)
  assert.equal(transportOf('web:gemini:analyst'), null, 'the gemini analyst id is not a pane model either')
  assert.equal(transportOf('web:chatgpt:analyst'), null, 'the analyst id is not a pane model')
  assert.equal(transportOf('web:'), null)
  assert.equal(transportOf('web:bing'), null)
  assert.equal(transportOf('ollama:hermes3'), 'ollama')
  assert.equal(transportOf('ollama:deepseek-r1:8b'), 'ollama')
  assert.equal(transportOf('ollama:'), null)
  assert.equal(transportOf('ollama:with space'), null)
  assert.equal(transportOf('qwen/qwen3-235b-a22b'), 'openrouter')
  assert.equal(transportOf('anthropic/claude-sonnet-4.5'), 'openrouter')
  assert.equal(transportOf('openai/gpt-5.6-luna:free'), 'openrouter')
  assert.equal(transportOf('xiaomi/mimo-v2-flash'), 'openrouter')
  for (const bad of ['', 'gpt-5', '/x', 'a/', 'a//b', 'a/b/c', 'a b/c', 'org/mod el', 'org/mödel', null, undefined, 42, {}, ['a/b']]) assert.equal(transportOf(bad), null, JSON.stringify(bad))
})

test('parseAgent: a catalog slot, a model with a transport, a web: model only under its own slot, an effort from EFFORTS (default medium); nothing coerced', () => {
  assert.deepEqual(parseAgent('claude', { model: 'web:claude', effort: 'off' }), { model: 'web:claude', effort: 'off' })
  assert.deepEqual(parseAgent('qwen', { model: 'qwen/qwen3-235b-a22b' }), { model: 'qwen/qwen3-235b-a22b', effort: 'medium' }, 'effort defaults to medium (the backend SlotSpec default)')
  assert.deepEqual(parseAgent('deepseek', DEEPSEEK), DEEPSEEK)
  assert.deepEqual(parseAgent('mimo', { model: 'xiaomi/mimo-v2-flash', effort: 'high' }), { model: 'xiaomi/mimo-v2-flash', effort: 'high' })
  assert.deepEqual(parseAgent('chatgpt', { model: 'openai/gpt-5.6-luna', effort: 'high' }), { model: 'openai/gpt-5.6-luna', effort: 'high' }, 'a classic slot on the token transport')
  assert.equal(parseAgent('qwen', { model: 'web:chatgpt' }), null, 'a web session under another slot key')
  assert.equal(parseAgent('chatgpt', { model: 'web:claude' }), null)
  assert.deepEqual(parseAgent('gemini', { model: 'web:gemini', effort: 'off' }), { model: 'web:gemini', effort: 'off' }, 'the fourth site (2026-10-17)')
  assert.equal(parseAgent('deepseek', { model: 'web:deepseek' }), null, 'no site for deepseek')
  assert.equal(parseAgent('qwen', { model: 'web:gemini' }), null, 'gemini\'s session under another slot key')
  assert.equal(parseAgent('claude', { model: 'web:claude', effort: 'max' }), null)
  assert.equal(parseAgent('claude', { model: 'web:claude', effort: 'Off' }), null)
  assert.equal(parseAgent('claude', { model: 'web:claude', effort: null }), null)
  assert.equal(parseAgent('claude', { model: 'web:claude:analyst' }), null)
  assert.equal(parseAgent('claude', { effort: 'off' }), null)
  assert.equal(parseAgent('claude', 'web:claude'), null)
  assert.equal(parseAgent('claude', null), null)
  assert.equal(parseAgent('bing', { model: 'a/b' }), null)
  assert.equal(parseAgent(undefined, { model: 'a/b' }), null)
  const spec = { model: 'a/b', effort: 'low', extra: 1 }
  assert.deepEqual(parseAgent('mimo', spec), { model: 'a/b', effort: 'low' }, 'unknown fields are not carried')
})

test('parseCouncil: strict — {slots} of 2..5 catalog members that all parse, answered re-keyed in catalog order; anything off is null', () => {
  assert.deepEqual(parseCouncil(CLASSIC), CLASSIC)
  const reordered = { slots: { qwen: QWEN, chatgpt: { model: 'web:chatgpt', effort: 'off' } } }
  assert.deepEqual(parseCouncil(reordered), { slots: { chatgpt: { model: 'web:chatgpt', effort: 'off' }, qwen: QWEN } })
  assert.deepEqual(Object.keys(parseCouncil(reordered).slots), ['chatgpt', 'qwen'], 'catalog order, whatever the spec\'s')
  const five = { slots: { mimo: { model: 'xiaomi/mimo-v2-flash' }, deepseek: DEEPSEEK, grok: { model: 'web:grok', effort: 'off' }, claude: { model: 'web:claude', effort: 'off' }, chatgpt: { model: 'web:chatgpt', effort: 'off' } } }
  assert.deepEqual(Object.keys(parseCouncil(five).slots), ['claude', 'chatgpt', 'grok', 'deepseek', 'mimo'])
  assert.equal(parseCouncil(five).slots.mimo.effort, 'medium')
  assert.equal(parseCouncil({ slots: { claude: { model: 'web:claude' } } }), null, 'one member')
  assert.equal(parseCouncil({ slots: {} }), null)
  const six = { slots: { ...five.slots, qwen: QWEN } }
  assert.equal(parseCouncil(six), null, 'six members')
  assert.equal(parseCouncil({ slots: { ...reordered.slots, bing: { model: 'a/b' } } }), null, 'a key outside the catalog')
  assert.equal(parseCouncil({ slots: { ...reordered.slots, deepseek: { model: 'web:deepseek' } } }), null, 'a member that does not parse')
  assert.deepEqual(Object.keys(parseCouncil({ slots: { gemini: { model: 'web:gemini', effort: 'off' }, claude: { model: 'web:claude', effort: 'off' } } }).slots), ['claude', 'gemini'], 'a {claude, gemini} web council')
  // every reader stays 2..5 (2026-10-17): only the editors cap at four, five-member councils exist on disk
  const fiveWithGemini = { slots: { ...FOUR.slots, qwen: QWEN } }
  assert.deepEqual(Object.keys(parseCouncil(fiveWithGemini).slots), ['claude', 'chatgpt', 'grok', 'gemini', 'qwen'])
  assert.equal(parseCouncil({ slots: { ...reordered.slots, claude: { model: 'web:claude', effort: 'ultra' } } }), null)
  for (const bad of [null, undefined, 'x', 3, [], {}, { slots: null }, { slots: [] }, { slots: 'claude,chatgpt' }]) assert.equal(parseCouncil(bad), null, JSON.stringify(bad))
  const withExtra = { slots: reordered.slots, analyst_model: 'web:chatgpt:analyst' }
  assert.deepEqual(parseCouncil(withExtra), parseCouncil(reordered), 'top-level fields beyond slots are ignored')
  assert.notEqual(parseCouncil(CLASSIC).slots.claude, CLASSIC.slots.claude, 'a new object, not the input')
})

test('sanitizeCouncil: tolerant — malformed members dropped, catalog order kept; fewer than two survivors or more than five → the default council (never truncated)', () => {
  assert.deepEqual(sanitizeCouncil(CLASSIC), CLASSIC, 'a stored three is kept as it is (the settings migration, not the reader, decides about it)')
  assert.deepEqual(sanitizeCouncil(FOUR), FOUR)
  const messy = { slots: { qwen: QWEN, grok: { model: 'web:grok', effort: 'off' }, deepseek: { model: 'web:deepseek' }, bing: { model: 'a/b' }, claude: 'web:claude', chatgpt: { model: 'web:chatgpt', effort: 'ultra' } } }
  assert.deepEqual(sanitizeCouncil(messy), { slots: { grok: { model: 'web:grok', effort: 'off' }, qwen: QWEN } })
  assert.deepEqual(sanitizeCouncil({ slots: { qwen: QWEN, deepseek: { model: 'web:deepseek' } } }), FOUR, 'one survivor → default')
  const six = { slots: { claude: { model: 'web:claude' }, chatgpt: { model: 'web:chatgpt' }, grok: { model: 'web:grok' }, deepseek: DEEPSEEK, qwen: QWEN, mimo: { model: 'xiaomi/mimo-v2-flash' } } }
  assert.deepEqual(sanitizeCouncil(six), FOUR, 'six valid members → default, not the first five')
  const five = { slots: { ...FOUR.slots, qwen: QWEN } }
  assert.deepEqual(sanitizeCouncil(five), five, 'five members still load (the editors cap at four, the reader does not)')
  for (const bad of [null, undefined, 'three', 3, [], {}, { slots: null }, { slots: [] }]) assert.deepEqual(sanitizeCouncil(bad), FOUR, JSON.stringify(bad))
  assert.notEqual(sanitizeCouncil(null), sanitizeCouncil(null), 'a fresh default every time')
  assert.equal(sanitizeCouncil(CLASSIC).slots.claude.effort, 'off')
  assert.equal(sanitizeCouncil({ slots: { claude: { model: 'web:claude' }, grok: { model: 'web:grok' } } }).slots.claude.effort, 'medium', 'a missing effort reads as medium, as parseAgent')
  // the report behind it: what was dropped and why the default was substituted, so settings.load can say so
  assert.deepEqual(sanitizeCouncilReport(CLASSIC), { council: CLASSIC, dropped: [], fallback: null })
  assert.deepEqual(sanitizeCouncilReport(messy), { council: sanitizeCouncil(messy), dropped: ['deepseek', 'bing', 'claude', 'chatgpt'], fallback: null }, 'dropped in the file\'s order: malformed and unknown members alike')
  assert.deepEqual(sanitizeCouncilReport({ slots: { qwen: QWEN, deepseek: { model: 'web:deepseek' } } }), { council: FOUR, dropped: ['deepseek'], fallback: 'too_few' })
  assert.deepEqual(sanitizeCouncilReport(six), { council: FOUR, dropped: [], fallback: 'too_many' })
  for (const bad of [null, 'three', {}, { slots: null }]) assert.deepEqual(sanitizeCouncilReport(bad), { council: FOUR, dropped: [], fallback: 'not_a_council' }, JSON.stringify(bad))
})

test('councilSlots / councilSites: members in catalog order; the sites are the members on a web session, in view order', () => {
  assert.deepEqual(councilSlots(CLASSIC), ['claude', 'chatgpt', 'grok'])
  const mixed = { slots: { qwen: QWEN, chatgpt: { model: 'web:chatgpt', effort: 'off' }, claude: { model: 'anthropic/claude-sonnet-4.5', effort: 'high' }, deepseek: DEEPSEEK } }
  assert.deepEqual(councilSlots(mixed), ['claude', 'chatgpt', 'deepseek', 'qwen'])
  assert.deepEqual(councilSites(mixed), ['chatgpt'], 'claude on OpenRouter is a column, not a pane')
  assert.deepEqual(councilSites(CLASSIC), ['claude', 'chatgpt', 'grok'])
  assert.deepEqual(councilSites(FOUR), ['claude', 'chatgpt', 'grok', 'gemini'])
  assert.deepEqual(councilSites({ slots: { gemini: { model: 'web:gemini', effort: 'off' }, claude: { model: 'web:claude', effort: 'off' } } }), ['claude', 'gemini'])
  assert.deepEqual(councilSites({ slots: { gemini: { model: 'google/gemini-2.5-pro', effort: 'low' }, claude: { model: 'web:claude', effort: 'off' } } }), ['claude'], 'gemini on OpenRouter is a column')
  assert.deepEqual(councilSites({ slots: { qwen: QWEN, deepseek: DEEPSEEK } }), [], 'a council with no site at all')
  for (const bad of [null, undefined, {}, { slots: null }, 'x']) {
    assert.deepEqual(councilSlots(bad), [])
    assert.deepEqual(councilSites(bad), [])
  }
})
