// council.js (2026-09-27): the pure half of the Agents page, plus the council additions to
// slice.js (panes/council, panes/openRouterKey, normalizeCouncil, normalizeKeyStatus) and
// analyst.js (councilSlotConfig, analystKind 'openrouter').
import { describe, expect, test } from 'vitest'
import { analystKind, councilSlotConfig, desktopSlotConfig, isDesktopAnalyst, isOpenRouterSlug } from './analyst.js'
import {
  anyOnOpenRouter,
  catalogRefetchNeeded,
  customModelId,
  defaultModelFor,
  defaultRows,
  EFFORTS,
  freeSlots,
  keyStatusText,
  modelsFor,
  rowsFromSpec,
  sourceText,
  specFromRows,
  summaryText,
  TRANSPORTS,
  transportsFor,
  validateCouncil,
  webModelFor,
} from './council.js'
import { CFG, CFG2, CFG5, DESKTOP_CATALOG, KEY_SET, KEY_UNSET, modelsState } from './fakes.js'
import { DEFAULT_COUNCIL, SITES, SLOT_IDS, initialPanes, normalizeCouncil, normalizeKeyStatus, panesReducer } from './slice.js'

describe('council.js: transports, models, rows', () => {
  test('a site supports all three transports, any other vendor token or local (MiMo included)', () => {
    expect(TRANSPORTS).toEqual(['web', 'openrouter', 'ollama'])
    for (const s of SITES) expect(transportsFor(s)).toEqual(TRANSPORTS)
    for (const s of ['gemini', 'deepseek', 'qwen', 'mimo']) expect(transportsFor(s)).toEqual(['openrouter', 'ollama'])
    expect(webModelFor('grok')).toBe('web:grok')
    expect(EFFORTS).toEqual(['off', 'low', 'medium', 'high'])
  })

  test('modelsFor filters the desktop catalog by vendor + transport: web → the site entry, ollama → every local model, openrouter → the vendor prefix', () => {
    const models = modelsState()
    expect(modelsFor('claude', 'web', models).map((m) => m.id)).toEqual(['web:claude'])
    expect(modelsFor('qwen', 'web', models)).toEqual([]) // no adapter in Stage 1
    expect(modelsFor('qwen', 'ollama', models).map((m) => m.id)).toEqual(['ollama:hermes3', 'ollama:qwen3'])
    expect(modelsFor('mimo', 'ollama', models).map((m) => m.id)).toEqual(['ollama:hermes3', 'ollama:qwen3'])
    expect(modelsFor('qwen', 'openrouter', models).map((m) => m.id)).toEqual(['qwen/qwen3-235b-a22b'])
    expect(modelsFor('gemini', 'openrouter', models).map((m) => m.id)).toEqual(['google/gemini-2.5-pro'])
    expect(modelsFor('claude', 'openrouter', models).map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5'])
    // never a hidden analyst page, never another vendor
    expect(modelsFor('chatgpt', 'openrouter', DESKTOP_CATALOG).map((m) => m.id)).toEqual(['openai/gpt-5'])
    // the web app's untagged OpenRouter catalog qualifies too
    expect(modelsFor('deepseek', 'openrouter', [{ id: 'deepseek/deepseek-v4', name: 'V4', vendor: 'deepseek' }]).map((m) => m.id)).toEqual(['deepseek/deepseek-v4'])
    expect(modelsFor('deepseek', 'openrouter', null)).toEqual([])
  })

  test('defaultModelFor / customModelId', () => {
    const models = modelsState()
    expect(defaultModelFor('chatgpt', 'web', models)).toBe('web:chatgpt')
    expect(defaultModelFor('qwen', 'openrouter', models)).toBe('qwen/qwen3-235b-a22b')
    expect(defaultModelFor('mimo', 'ollama', models)).toBe('ollama:hermes3')
    expect(defaultModelFor('mimo', 'openrouter', { items: [] })).toBe('') // nothing listed: the custom field
    expect(customModelId('ollama', ' qwen3:8b ')).toBe('ollama:qwen3:8b')
    expect(customModelId('ollama', 'ollama:qwen3')).toBe('ollama:qwen3')
    expect(customModelId('openrouter', ' xiaomi/mimo-v2-flash ')).toBe('xiaomi/mimo-v2-flash')
    expect(customModelId('openrouter', '  ')).toBe('')
  })

  test('rowsFromSpec / specFromRows round-trip in catalog order; an invalid spec has no rows', () => {
    const rows = rowsFromSpec(CFG5)
    expect(rows).toEqual([
      { slot: 'claude', transport: 'web', model: 'web:claude', effort: 'off' },
      { slot: 'chatgpt', transport: 'web', model: 'web:chatgpt', effort: 'off' },
      { slot: 'grok', transport: 'web', model: 'web:grok', effort: 'off' },
      { slot: 'gemini', transport: 'openrouter', model: 'google/gemini-2.5-pro', effort: 'medium' },
      { slot: 'qwen', transport: 'ollama', model: 'ollama:qwen3', effort: 'off' },
    ])
    expect(specFromRows(rows)).toEqual({ slots: CFG5.slots })
    expect(specFromRows([...rows].reverse())).toEqual({ slots: CFG5.slots }) // re-keyed in catalog order
    expect(rowsFromSpec(null)).toEqual([])
    expect(rowsFromSpec({ slots: { claude: { model: 'web:claude' } } })).toEqual([]) // one member
    expect(defaultRows()).toEqual(rowsFromSpec(CFG))
    expect(freeSlots(rows)).toEqual(['deepseek', 'mimo'])
    expect(freeSlots(rows, 'gemini')).toEqual(['gemini', 'deepseek', 'mimo'])
  })

  test('validateCouncil names the first failure, per row, and passes a legal council', () => {
    expect(validateCouncil(rowsFromSpec(CFG))).toBeNull()
    expect(validateCouncil(rowsFromSpec(CFG2))).toBeNull()
    expect(validateCouncil(rowsFromSpec(CFG5))).toBeNull()
    expect(validateCouncil([])).toBe('a council needs at least 2 agents')
    expect(validateCouncil(rowsFromSpec(CFG).slice(0, 1))).toBe('a council needs at least 2 agents')
    expect(validateCouncil(SLOT_IDS.slice(0, 6).map((slot) => ({ slot, transport: 'ollama', model: 'ollama:x', effort: 'off' })))).toBe('a council seats at most 5 agents')
    expect(validateCouncil([{ slot: 'bing', transport: 'ollama', model: 'ollama:x', effort: 'off' }, ...rowsFromSpec(CFG2)])).toBe('unknown agent "bing"')
    expect(validateCouncil([...rowsFromSpec(CFG2), { slot: 'qwen', transport: 'ollama', model: 'ollama:x', effort: 'off' }])).toBe('Qwen is seated twice')
    expect(validateCouncil([{ slot: 'qwen', transport: 'web', model: 'web:qwen', effort: 'off' }, rowsFromSpec(CFG2)[0]])).toBe('Qwen cannot run on Subscription (web session)')
    expect(validateCouncil([{ slot: 'qwen', transport: 'openrouter', model: '', effort: 'off' }, rowsFromSpec(CFG2)[0]])).toBe('Qwen: choose or type a model')
    expect(validateCouncil([{ slot: 'claude', transport: 'web', model: 'web:chatgpt', effort: 'off' }, rowsFromSpec(CFG2)[0]])).toBe('Claude: a web session is always web:claude')
    expect(validateCouncil([{ slot: 'mimo', transport: 'ollama', model: 'mimo', effort: 'off' }, rowsFromSpec(CFG2)[0]])).toBe('MiMo: a local model is ollama:<name>')
    expect(validateCouncil([{ slot: 'mimo', transport: 'openrouter', model: 'mimo v2', effort: 'off' }, rowsFromSpec(CFG2)[0]])).toBe('MiMo: an OpenRouter model is org/model (for example xiaomi/…)')
    expect(validateCouncil([{ slot: 'mimo', transport: 'openrouter', model: 'xiaomi/mimo-v2-flash', effort: 'max' }, rowsFromSpec(CFG2)[0]])).toBe('MiMo: effort must be one of off, low, medium, high')
    expect(anyOnOpenRouter(rowsFromSpec(CFG))).toBe(false)
    expect(anyOnOpenRouter(rowsFromSpec(CFG5))).toBe(true)
  })

  test('catalogRefetchNeeded: the catalog follows the key — refetch when it arrives at configured+pushed and when a configured key is cleared', () => {
    const stored = { ...KEY_SET, pushed: false }
    expect(catalogRefetchNeeded(null, null)).toBe(false)
    expect(catalogRefetchNeeded(null, KEY_UNSET)).toBe(false)
    expect(catalogRefetchNeeded(null, KEY_SET)).toBe(true) // the first status may land after the panes loaded the no-key catalog
    expect(catalogRefetchNeeded(KEY_UNSET, stored)).toBe(false) // stored, not yet pushed: the backend has nothing new
    expect(catalogRefetchNeeded(stored, KEY_SET)).toBe(true)
    expect(catalogRefetchNeeded(KEY_SET, KEY_SET)).toBe(false)
    expect(catalogRefetchNeeded(KEY_SET, { ...KEY_SET })).toBe(false)
    expect(catalogRefetchNeeded(KEY_SET, KEY_UNSET)).toBe(true)
    expect(catalogRefetchNeeded(KEY_SET, null)).toBe(true)
    expect(catalogRefetchNeeded(stored, KEY_UNSET)).toBe(true)
    expect(catalogRefetchNeeded(KEY_SET, { ...stored, error: 'bridge_token_unset' })).toBe(false) // a failed re-push: nothing changed server-side
    expect(catalogRefetchNeeded(KEY_UNSET, KEY_UNSET)).toBe(false)
  })

  test('keyStatusText never carries the key: only main’s status fields', () => {
    expect(keyStatusText(null)).toBe('not configured')
    expect(keyStatusText(KEY_UNSET)).toBe('not configured')
    expect(keyStatusText(KEY_SET)).toBe('configured · sk-or-v1-… (73 chars)')
    expect(keyStatusText({ ...KEY_SET, pushed: false })).toBe('configured · sk-or-v1-… (73 chars) · stored, not yet pushed')
    expect(keyStatusText({ ...KEY_SET, pushed: false, error: 'bridge_token_unset' })).toBe('configured · sk-or-v1-… (73 chars) · stored, not yet pushed · bridge_token_unset')
    expect(keyStatusText({ configured: true })).toBe('configured · … · stored, not yet pushed') // no `pushed` = not pushed
    expect(summaryText(3)).toBe('3 agents → R1…R3; labels are assigned per turn')
    expect(summaryText(5)).toBe('5 agents → R1…R5; labels are assigned per turn')
    expect(summaryText(1)).toBe('1 agent → R1…R1; labels are assigned per turn')
    expect(sourceText('conversation')).toMatch(/open conversation/)
    expect(sourceText('default')).toMatch(/default council/)
  })
})

describe('slice.js: the council and key-status keys', () => {
  test('normalizeCouncil validates 2..5 known slots with a model and re-keys in catalog order', () => {
    expect(normalizeCouncil(CFG5)).toEqual({ slots: CFG5.slots })
    expect(Object.keys(normalizeCouncil({ slots: { qwen: { model: 'ollama:qwen3' }, claude: { model: 'web:claude', effort: 'high' } } }).slots)).toEqual(['claude', 'qwen'])
    expect(normalizeCouncil({ slots: { qwen: { model: 'ollama:qwen3' }, claude: { model: 'web:claude' } } }).slots.qwen).toEqual({ model: 'ollama:qwen3', effort: 'off' })
    expect(normalizeCouncil(null)).toBeNull()
    expect(normalizeCouncil({ slots: { claude: { model: 'web:claude' } } })).toBeNull()
    expect(normalizeCouncil({ slots: Object.fromEntries(SLOT_IDS.slice(0, 6).map((s) => [s, { model: 'x/y' }])) })).toBeNull()
    expect(normalizeCouncil({ slots: { claude: { model: 'web:claude' }, bing: { model: 'x/y' } } })).toBeNull()
    expect(normalizeCouncil({ slots: { claude: { model: 'web:claude' }, qwen: { model: '' } } })).toBeNull()
    expect(normalizeCouncil({ slots: { claude: { model: 'web:claude' }, qwen: 'ollama:qwen3' } })).toBeNull()
  })

  test('panes/council stores a valid spec, ignores an invalid one, keeps identity on a repeat, clears on null', () => {
    const s0 = initialPanes()
    expect(s0.council).toBeNull()
    expect(s0.openRouterKey).toBeNull()
    const s1 = panesReducer(s0, { type: 'panes/council', council: CFG5 })
    expect(s1.council).toEqual({ slots: CFG5.slots })
    expect(panesReducer(s1, { type: 'panes/council', council: { slots: { ...CFG5.slots } } })).toBe(s1)
    expect(panesReducer(s1, { type: 'panes/council', council: { slots: { claude: { model: 'web:claude' } } } })).toBe(s1)
    expect(panesReducer(s1, { type: 'panes/council', council: 'junk' })).toBe(s1)
    const s2 = panesReducer(s1, { type: 'panes/council', council: null })
    expect(s2.council).toBeNull()
    expect(panesReducer(s2, { type: 'panes/council', council: null })).toBe(s2)
  })

  test('panes/openRouterKey mirrors main’s status (never a key), keeps identity on a repeat', () => {
    const s0 = initialPanes()
    const s1 = panesReducer(s0, { type: 'panes/openRouterKey', status: KEY_SET })
    expect(s1.openRouterKey).toEqual(KEY_SET)
    expect(panesReducer(s1, { type: 'panes/openRouterKey', status: { ...KEY_SET } })).toBe(s1)
    const s2 = panesReducer(s1, { type: 'panes/openRouterKey', status: { ...KEY_SET, pushed: false, error: 'bridge_token_unset' } })
    expect(s2.openRouterKey).toEqual({ ...KEY_SET, pushed: false, error: 'bridge_token_unset' })
    expect(panesReducer(s2, { type: 'panes/openRouterKey', status: null }).openRouterKey).toBeNull()
    expect(normalizeKeyStatus({ configured: 'yes', prefix: 7, length: 'x', pushed: 1 })).toEqual({ configured: true, prefix: '', length: 0, pushed: true })
    expect(normalizeKeyStatus('sk-or-v1-secret')).toBeNull()
  })

  test('panes/active accepts every catalog member (a column can be the active tab); persisted targets keep only explicit booleans', () => {
    const s = panesReducer(initialPanes(), { type: 'panes/active', active: 'qwen' })
    expect(s.active).toBe('qwen')
    expect(panesReducer(s, { type: 'panes/active', active: 'bing' })).toBe(s)
    const t = panesReducer(s, { type: 'panes/target', slot: 'mimo', on: false })
    expect(t.targets).toEqual({ claude: true, chatgpt: true, grok: true, mimo: false })
    expect(initialPanes({ targets: { mimo: false, qwen: true } }).targets).toEqual({ claude: true, chatgpt: true, grok: true, mimo: false, qwen: true })
  })
})

describe('analyst.js: the council config and the OpenRouter analyst', () => {
  test('councilSlotConfig builds the full SlotConfig from main’s default; no / invalid council → the three web panes', () => {
    expect(councilSlotConfig(CFG5, 'ollama:hermes3')).toEqual({ slots: CFG5.slots, analyst_model: 'ollama:hermes3', max_iterations: 2, materiality_min: 'medium', grounded: false })
    expect(councilSlotConfig(null, 'web:chatgpt:analyst')).toEqual(desktopSlotConfig('web:chatgpt:analyst'))
    expect(councilSlotConfig({ slots: { claude: { model: 'web:claude' } } }, 'web:chatgpt:analyst').slots).toEqual(desktopSlotConfig().slots)
    expect(Object.keys(councilSlotConfig(CFG2, '').slots)).toEqual(['chatgpt', 'qwen'])
    expect(councilSlotConfig(CFG2, '').analyst_model).toBe('')
    expect(Object.keys(desktopSlotConfig().slots)).toEqual(DEFAULT_COUNCIL)
  })

  test("analystKind: an OpenRouter slug is 'openrouter' only with a configured key, 'other' without", () => {
    expect(isOpenRouterSlug('openai/gpt-5')).toBe(true)
    expect(isOpenRouterSlug('web:chatgpt:analyst')).toBe(false)
    expect(isOpenRouterSlug('ollama:hermes3')).toBe(false)
    expect(analystKind('openai/gpt-5')).toBe('other')
    expect(analystKind('openai/gpt-5', { keyConfigured: false })).toBe('other')
    expect(analystKind('openai/gpt-5', { keyConfigured: true })).toBe('openrouter')
    expect(analystKind('anthropic/claude-sonnet-4.5:thinking', { keyConfigured: true })).toBe('openrouter')
    expect(isDesktopAnalyst('openai/gpt-5', { keyConfigured: true })).toBe(true)
    expect(isDesktopAnalyst('openai/gpt-5')).toBe(false)
    // a web session and a local model never need the key; junk stays junk
    expect(analystKind('web:grok:analyst', { keyConfigured: true })).toBe('web')
    expect(analystKind('ollama:hermes3', { keyConfigured: true })).toBe('ollama')
    expect(analystKind('web:gemini:analyst', { keyConfigured: true })).toBe('other')
    expect(analystKind('not a slug', { keyConfigured: true })).toBe('other')
  })
})
