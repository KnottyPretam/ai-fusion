// stepper.js (2026-10-17): the pure rules of the agents stepper — bounds 2 / 4 (and a stored 5),
// the right-most removal, where a change lands (default / in place / new chat), how each vendor is
// seated (site → web; else OpenRouter with a pushed key and a listed model; else a live Ollama
// model named like it; else a reason), the menu's order, and the copy.
import { describe, expect, test } from 'vitest'
import { COUNCIL_EDIT_MAX } from './council.js'
import { CFG, CFG2, CFG5, DESKTOP_CATALOG, KEY_SET, KEY_UNSET, conv, health, modelsState } from './fakes.js'
import {
  FAMILY_WORDS,
  LOADING_TEXT,
  MAX_TEXT,
  MIN_TEXT,
  addOptions,
  addTitle,
  anyStreaming,
  busyReason,
  countText,
  countTitle,
  councilSettled,
  itemText,
  itemTitle,
  listText,
  localModelFor,
  membersOf,
  menuHint,
  nextSpec,
  removeTarget,
  removeTitle,
  seatEffort,
  seatFor,
  stepperAction,
  stepperMode,
  stepperSource,
} from './stepper.js'
import { SITES, SLOT_IDS } from './slice.js'

const web = (slot) => ({ model: `web:${slot}`, effort: 'off' })
const spec = (...slots) => ({ slots: Object.fromEntries(slots.map((s) => [s, web(s)])) })
const FOUR = spec('claude', 'chatgpt', 'grok', 'gemini')
const IDLE = { status: 'idle', error: null, httpStatus: null }
const STREAMING = { status: 'streaming', error: null, httpStatus: null }
const KEY_STORED = { configured: true, prefix: 'sk-or-v1-', length: 73, pushed: false }
const turn = { id: 't1', type: 'send', prompt: 'q', slot_config: CFG, responses: {}, usage: { calls: [], totals: {} } }

describe('stepper: streams, settled, source, mode', () => {
  test('anyStreaming covers every feature key, upstream’s reread and plan included', () => {
    expect(anyStreaming({})).toBe(false)
    expect(anyStreaming(null)).toBe(false)
    expect(anyStreaming({ send: IDLE, analyze: { status: 'done' } })).toBe(false)
    for (const key of ['send', 'analyze', 'fusion', 'preparse', 'refactor', 'plan', 'reread', 'anything']) expect(anyStreaming({ send: IDLE, [key]: STREAMING })).toBe(true)
  })

  test('councilSettled: a turn, or a message in any thread (the backend’s rule)', () => {
    expect(councilSettled(null)).toBe(false)
    expect(councilSettled(conv())).toBe(false)
    expect(councilSettled(conv({ turns: [turn] }))).toBe(true)
    expect(councilSettled(conv({ threads: { claude: [], chatgpt: [{ role: 'user', content: 'x' }], grok: [] } }))).toBe(true)
  })

  test('stepperSource: the conversation’s config, else main’s default, else every site on its web session', () => {
    expect(stepperSource({ conversation: conv({ slot_config: CFG2 }), slotConfig: CFG2, council: CFG5 })).toEqual({ spec: { slots: CFG2.slots }, source: 'conversation' })
    // the conversation's own slot_config when the slotConfig slice lags
    expect(stepperSource({ conversation: conv({ slot_config: CFG2 }), slotConfig: null }).spec).toEqual({ slots: CFG2.slots })
    expect(stepperSource({ conversation: null, slotConfig: null, council: { slots: CFG5.slots } })).toEqual({ spec: { slots: CFG5.slots }, source: 'default' })
    const fallback = stepperSource({})
    expect(fallback.source).toBe('default')
    expect(membersOf(fallback.spec)).toEqual(SITES)
    expect(fallback.spec).toEqual(FOUR)
    // an invalid default (one member) falls through to the four
    expect(stepperSource({ council: { slots: { claude: web('claude') } } }).spec).toEqual(FOUR)
  })

  test('stepperMode: default (no conversation) / in-place (empty) / new-chat (something was said)', () => {
    expect(stepperMode({ conversation: null })).toBe('default')
    expect(stepperMode({})).toBe('default')
    expect(stepperMode({ conversation: conv() })).toBe('in-place')
    expect(stepperMode({ conversation: conv({ turns: [turn] }) })).toBe('new-chat')
  })
})

describe('stepper: members, removal, effort, local models', () => {
  test('removeTarget is the right-most member in catalog order, whatever the key order of the spec', () => {
    expect(removeTarget(FOUR)).toBe('gemini')
    expect(removeTarget({ slots: { qwen: web('qwen'), claude: web('claude') } })).toBe('qwen')
    expect(removeTarget(CFG)).toBe('grok')
    expect(removeTarget(null)).toBeNull()
    expect(membersOf({ slots: { gemini: {}, claude: {} } })).toEqual(['claude', 'gemini'])
  })

  test('seatEffort: off when the model lists it, else its lowest; an unknown model starts at off', () => {
    const models = modelsState()
    expect(seatEffort(models, 'deepseek/deepseek-r1')).toBe('off')
    expect(seatEffort(models, 'google/gemini-2.5-pro')).toBe('low') // low/medium/high only: off would be a 422
    expect(seatEffort(models, 'openai/gpt-5')).toBe('low')
    expect(seatEffort(models, 'web:gemini')).toBe('off')
    expect(seatEffort(models, 'ollama:qwen3:8b')).toBe('off') // not in the catalog
    expect(seatEffort(DESKTOP_CATALOG, 'google/gemini-2.5-pro')).toBe('low') // a bare item list works too
    expect(seatEffort(modelsState([{ id: 'x/y', efforts: ['high', 'xhigh'] }]), 'x/y')).toBe('high')
    expect(seatEffort(null, 'x/y')).toBe('off')
  })

  test('localModelFor: the first live Ollama name (sorted) carrying the vendor’s family word; nothing unrelated', () => {
    expect(localModelFor('qwen', ['qwen3:8b', 'hermes3', 'qwen2.5:7b'])).toBe('ollama:qwen2.5:7b')
    expect(localModelFor('qwen', ['QwQ:32b'])).toBe('ollama:QwQ:32b')
    expect(localModelFor('deepseek', ['hermes3', 'deepseek-r1:14b'])).toBe('ollama:deepseek-r1:14b')
    expect(localModelFor('deepseek', ['hermes3'])).toBeNull() // never an unrelated model
    expect(localModelFor('mimo', [])).toBeNull()
    expect(localModelFor('mimo', null)).toBeNull()
    expect(Object.keys(FAMILY_WORDS)).toEqual(SLOT_IDS)
  })
})

describe('stepper: seatFor and the menu', () => {
  const models = modelsState()

  test('a site is always seated on its web session', () => {
    for (const s of SITES) expect(seatFor(s, {})).toEqual({ seat: web(s), transport: 'web', reason: null, pending: false })
  })

  test('a token vendor: OpenRouter needs a configured AND pushed key and a listed model; else a live Ollama model named like it', () => {
    expect(seatFor('deepseek', { models, keyStatus: KEY_SET, ollama: [] })).toMatchObject({ seat: { model: 'deepseek/deepseek-r1', effort: 'off' }, transport: 'openrouter' })
    // a key stored but not pushed: the backend would refuse, so Ollama is next
    expect(seatFor('qwen', { models, keyStatus: KEY_STORED, ollama: ['qwen3:8b'] })).toMatchObject({ seat: { model: 'ollama:qwen3:8b', effort: 'off' }, transport: 'ollama' })
    expect(seatFor('qwen', { models, keyStatus: KEY_UNSET, ollama: ['qwen3:8b'] })).toMatchObject({ transport: 'ollama' })
  })

  test('the reasons, one sentence each; pending while the catalog or the probe has not answered', () => {
    expect(seatFor('deepseek', { models, keyStatus: KEY_UNSET, ollama: [] })).toEqual({ seat: null, transport: null, pending: false, reason: 'DeepSeek needs an OpenRouter key or a local Ollama model named like it. Set one up on the Agents page.' })
    expect(seatFor('deepseek', { models, keyStatus: KEY_STORED, ollama: [] }).reason).toBe('The OpenRouter key is stored but not yet pushed to the backend, and no local Ollama model is named like DeepSeek.')
    const noMimo = modelsState(DESKTOP_CATALOG.filter((m) => m.vendor !== 'xiaomi'))
    expect(seatFor('mimo', { models: noMimo, keyStatus: KEY_SET, ollama: [] }).reason).toBe('OpenRouter lists no MiMo model right now, and no local Ollama model is named like it.')
    expect(seatFor('deepseek', { models, keyStatus: KEY_UNSET, ollama: null })).toEqual({ seat: null, transport: null, pending: true, reason: LOADING_TEXT })
    expect(seatFor('deepseek', { models: { items: [], byId: {}, loaded: false, error: null }, keyStatus: KEY_SET, ollama: [] })).toMatchObject({ seat: null, pending: true })
    // a listed OpenRouter model needs no probe
    expect(seatFor('deepseek', { models, keyStatus: KEY_SET, ollama: null })).toMatchObject({ transport: 'openrouter', pending: false })
    expect(seatFor('bing', {})).toMatchObject({ seat: null, reason: 'unknown agent "bing"' })
  })

  test('addOptions: only unseated vendors, the sites first (with the pane’s session), then token / local in catalog order', () => {
    const items = addOptions({ spec: spec('claude', 'chatgpt'), models, keyStatus: KEY_SET, ollama: ['qwen3:8b'], health: { grok: health({ session: 'logged_out' }) } })
    expect(items.map((i) => i.slot)).toEqual(['grok', 'gemini', 'deepseek', 'qwen', 'mimo'])
    expect(items.map((i) => i.group)).toEqual(['web', 'web', 'token', 'token', 'token'])
    expect(items[0]).toMatchObject({ seat: web('grok'), detail: 'signed out, sign in in its pane' })
    expect(items[1]).toMatchObject({ seat: web('gemini'), detail: null }) // no health yet is not "signed out"
    // with no key, Qwen comes from the live Ollama list and the others cannot be seated
    const local = addOptions({ spec: FOUR, models, keyStatus: KEY_UNSET, ollama: ['qwen3:8b'] })
    expect(local.map((i) => [i.slot, i.group, !!i.seat])).toEqual([
      ['deepseek', 'token', false],
      ['qwen', 'local', true],
      ['mimo', 'token', false],
    ])
    expect(addOptions({ spec: { slots: Object.fromEntries(SLOT_IDS.map((s) => [s, web(s)])) } })).toEqual([])
  })

  test('the item copy', () => {
    const [grok, deepseek] = addOptions({ spec: spec('claude', 'chatgpt', 'gemini'), models, keyStatus: KEY_SET, ollama: [], health: { grok: health({ session: 'logged_out' }) } })
    expect(itemText(grok)).toBe('Grok · web session (your login) · signed out, sign in in its pane')
    expect(itemTitle(grok)).toMatch(/^Seat Grok on your own login in its pane; no key, no token cost\. The pane is signed out/)
    expect(itemText(deepseek)).toBe('DeepSeek · OpenRouter · deepseek/deepseek-r1')
    // a pane on a verification check or blocked is not "signed out" (review 2026-10-17)
    const [challenged] = addOptions({ spec: spec('claude', 'chatgpt', 'gemini'), health: { grok: health({ session: 'challenge' }) } })
    expect(challenged).toMatchObject({ attention: 'challenge', detail: 'a check is waiting in its pane' })
    expect(itemText(challenged)).toBe('Grok · web session (your login) · a check is waiting in its pane')
    expect(itemTitle(challenged)).toBe('Seat Grok on your own login in its pane; no key, no token cost. The pane shows a verification check: finish it there before sending.')
    const [blocked] = addOptions({ spec: spec('claude', 'chatgpt', 'grok'), health: { gemini: health({ session: 'blocked' }) } })
    expect(blocked).toMatchObject({ slot: 'gemini', attention: 'blocked', detail: 'the site reports it is blocked' })
    expect(itemTitle(blocked)).toMatch(/The site reports this session is blocked: open its pane to see why\.$/)
    const [fine] = addOptions({ spec: spec('claude', 'chatgpt', 'grok'), health: { gemini: health({ session: 'ok' }) } })
    expect(fine).toMatchObject({ attention: null, detail: null })
    expect(itemTitle(fine)).toBe('Seat Gemini on your own login in its pane; no key, no token cost.')
    expect(itemTitle(deepseek)).toBe('Seat DeepSeek on OpenRouter (deepseek/deepseek-r1, effort off); tokens and cost are metered. Pick another model on the Agents page.')
    const [qwen] = addOptions({ spec: FOUR, models, keyStatus: KEY_UNSET, ollama: ['qwen3'] }).filter((i) => i.slot === 'qwen')
    expect(itemText(qwen)).toBe('Qwen · local Ollama · ollama:qwen3')
    const [mimo] = addOptions({ spec: FOUR, models, keyStatus: KEY_UNSET, ollama: [] }).filter((i) => i.slot === 'mimo')
    expect(itemText(mimo)).toBe('MiMo · MiMo needs an OpenRouter key or a local Ollama model named like it. Set one up on the Agents page.')
    expect(itemTitle(mimo)).toBe(mimo.reason)
  })
})

describe('stepper: nextSpec and stepperAction', () => {
  test('nextSpec adds and removes, re-keyed in catalog order; never a non-council', () => {
    const added = nextSpec(spec('claude', 'chatgpt', 'gemini'), 'add', { slot: 'grok', seat: web('grok') })
    expect(Object.keys(added.slots)).toEqual(['claude', 'chatgpt', 'grok', 'gemini']) // Grok lands in its catalog place
    expect(nextSpec(FOUR, 'remove', { slot: 'gemini' })).toEqual(spec('claude', 'chatgpt', 'grok'))
    expect(nextSpec(spec('claude', 'chatgpt'), 'remove', { slot: 'chatgpt' })).toBeNull() // one member
    expect(nextSpec(FOUR, 'add', { slot: 'qwen', seat: null })).toBeNull()
    expect(nextSpec(FOUR, 'swap', { slot: 'qwen' })).toBeNull()
  })

  test('no conversation: the default changes in place (no conversation id); remove takes the right-most', () => {
    expect(stepperAction({ op: 'remove' })).toEqual({ kind: 'apply-in-place', spec: spec('claude', 'chatgpt', 'grok'), conversationId: null, target: 'gemini', op: 'remove' })
    const add = stepperAction({ council: CFG, op: 'add', slot: 'gemini', seat: web('gemini') })
    expect(add).toEqual({ kind: 'apply-in-place', spec: FOUR, conversationId: null, target: 'gemini', op: 'add' })
  })

  test('an empty conversation changes in place; a settled one starts a new chat', () => {
    const empty = conv({ id: 'c1', slot_config: CFG })
    expect(stepperAction({ conversation: empty, slotConfig: CFG, op: 'remove' })).toMatchObject({ kind: 'apply-in-place', conversationId: 'c1', target: 'grok', spec: spec('claude', 'chatgpt') })
    const settled = conv({ id: 'c2', slot_config: CFG, turns: [turn] })
    expect(stepperAction({ conversation: settled, slotConfig: CFG, op: 'add', slot: 'gemini', seat: web('gemini') })).toEqual({ kind: 'new-chat', spec: FOUR, conversationId: 'c2', target: 'gemini', op: 'add' })
  })

  test('the bounds: two at least, four from the stepper; a stored five can still lose one', () => {
    expect(COUNCIL_EDIT_MAX).toBe(4)
    expect(stepperAction({ council: CFG2, op: 'remove' })).toEqual({ kind: 'blocked', reason: MIN_TEXT })
    expect(stepperAction({ op: 'add', slot: 'deepseek', seat: { model: 'deepseek/deepseek-r1', effort: 'off' } })).toEqual({ kind: 'blocked', reason: MAX_TEXT })
    const five = conv({ id: 'c5', slot_config: CFG5, turns: [turn] })
    expect(stepperAction({ conversation: five, slotConfig: CFG5, op: 'add', slot: 'mimo', seat: web('mimo') })).toEqual({ kind: 'blocked', reason: MAX_TEXT })
    const trimmed = stepperAction({ conversation: five, slotConfig: CFG5, op: 'remove' })
    expect(trimmed).toMatchObject({ kind: 'new-chat', target: 'qwen' })
    expect(Object.keys(trimmed.spec.slots)).toEqual(['claude', 'chatgpt', 'grok', 'gemini'])
  })

  test('blocked while busy or streaming, for a seated or unknown slot, and without a seat', () => {
    expect(stepperAction({ op: 'remove', busy: true }).kind).toBe('blocked')
    expect(stepperAction({ op: 'remove', streams: { plan: STREAMING } })).toEqual({ kind: 'blocked', reason: 'a stream is running' })
    expect(stepperAction({ council: CFG, op: 'add', slot: 'grok', seat: web('grok') })).toMatchObject({ kind: 'blocked', reason: 'Grok is already seated' })
    expect(stepperAction({ council: CFG, op: 'add', slot: 'bing', seat: web('bing') }).kind).toBe('blocked')
    expect(stepperAction({ council: CFG, op: 'add', slot: 'deepseek', seat: null })).toMatchObject({ kind: 'blocked', reason: 'DeepSeek cannot be seated' })
    expect(stepperAction({ op: 'shuffle' }).kind).toBe('blocked')
  })
})

describe('stepper: copy', () => {
  test('lists, counts and the busy reason', () => {
    expect(listText(['claude'])).toBe('Claude')
    expect(listText(['claude', 'gemini'])).toBe('Claude and Gemini')
    expect(listText(['claude', 'chatgpt', 'grok'])).toBe('Claude, ChatGPT and Grok')
    expect(listText([])).toBe('')
    expect(countText(4)).toBe('4 agents')
    expect(countText(1)).toBe('1 agent')
    expect(busyReason({})).toBeNull()
    expect(busyReason({ streams: { reread: STREAMING }, sending: true })).toBe('a stream is running')
    expect(busyReason({ sending: true, creating: true })).toBe('a send is in flight')
    expect(busyReason({ creating: true })).toBe('a new chat is being created')
    expect(busyReason({ inflight: true })).toBe('changing the agents…')
  })

  test('every title states the mode', () => {
    const four = ['claude', 'chatgpt', 'grok', 'gemini']
    expect(removeTitle({ mode: 'default', members: four })).toBe('Remove Gemini (the right-most agent). New chats then start with Claude, ChatGPT and Grok.')
    expect(removeTitle({ mode: 'in-place', members: four })).toBe('Remove Gemini (the right-most agent) from this conversation (nothing has been said yet) and make Claude, ChatGPT and Grok the default for new chats.')
    expect(removeTitle({ mode: 'new-chat', members: four })).toBe('Remove Gemini (the right-most agent): starts a new chat with Claude, ChatGPT and Grok and makes them the default. This chat keeps its agents and stays in the sidebar.')
    expect(removeTitle({ mode: 'default', members: ['claude', 'gemini'] })).toBe(MIN_TEXT)
    expect(removeTitle({ mode: 'default', members: four, busy: 'a stream is running' })).toBe('Remove an agent: a stream is running')
    expect(addTitle({ mode: 'default', members: ['claude', 'chatgpt', 'grok'] })).toBe('Add an agent (4 of 4) to the agents new chats start with.')
    expect(addTitle({ mode: 'in-place', members: ['claude', 'chatgpt'] })).toBe('Add an agent (3 of 4) to this conversation (nothing has been said yet) and to the default for new chats.')
    expect(addTitle({ mode: 'new-chat', members: ['claude', 'chatgpt'] })).toMatch(/^Add an agent \(3 of 4\): starts a new chat with these agents plus the one you pick/)
    expect(addTitle({ mode: 'default', members: four })).toBe(MAX_TEXT)
    expect(addTitle({ mode: 'new-chat', members: [...four, 'qwen'] })).toBe('Four agents at most. This council has 5 from before; − trims it in a new chat.')
    expect(addTitle({ mode: 'in-place', members: four, busy: 'a send is in flight' })).toBe('Add an agent: a send is in flight')
    expect(countTitle('default', four)).toBe('The agents new chats start with: Claude, ChatGPT, Grok and Gemini.')
    expect(countTitle('in-place', ['claude', 'grok'])).toBe("This conversation's agents: Claude and Grok.")
    expect(countTitle('new-chat', ['claude', 'grok'])).toBe("This conversation's agents: Claude and Grok. Fixed once something was said; − or + starts a new chat.")
    expect(menuHint('default')).toBe('Add to the agents new chats start with.')
    expect(menuHint('in-place')).toBe('Add to this conversation (nothing said yet) and to the default for new chats.')
    expect(menuHint('new-chat')).toBe('Adding starts a new chat with these agents plus the one you pick; this chat stays in the sidebar.')
  })
})
