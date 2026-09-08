import { describe, expect, test } from 'vitest'
import './index.jsx' // registers the `slots` slice at module scope
import { applyEvents, sample } from '../../state/testing.jsx'
import { initialState, rootReducer } from '../../state/registry.js'
import { DEFAULT_EFFORTS, effortsFor, mergeCitations, nearestEffort, slotTurns, turnExtras, vendorModels } from './slice.js'

const CFG = {
  slots: {
    claude: { model: 'anthropic/claude-opus-5', effort: 'medium' },
    chatgpt: { model: 'openai/gpt-5.6-sol', effort: 'medium' },
    grok: { model: 'x-ai/grok-4.6', effort: 'medium' },
  },
  analyst_model: 'openai/gpt-5.6-luna',
  max_iterations: 2,
  materiality_min: 'medium',
  grounded: false,
}

const allStarted = () => [sample.turnStart(), sample.slotStart('claude'), sample.slotStart('chatgpt'), sample.slotStart('grok')]

describe('slots slice: three synthetic streams isolate', () => {
  test('a grok delta never changes claude; untouched slots keep identity', () => {
    const base = applyEvents('send', [...allStarted(), sample.slotDelta('claude', 'A1')])
    expect(base.slots.claude.buffer).toBe('A1')
    const next = applyEvents('send', [sample.slotDelta('grok', 'G1'), sample.slotDelta('grok', 'G2')], { state: base })
    expect(next.slots.grok.buffer).toBe('G1G2')
    expect(next.slots.claude.buffer).toBe('A1')
    expect(next.slots.chatgpt.buffer).toBe('')
    expect(next.slots.claude).toBe(base.slots.claude)
    expect(next.slots.chatgpt).toBe(base.slots.chatgpt)
    expect(next.slots.grok).not.toBe(base.slots.grok)
    // Core slices are untouched by a delta.
    expect(next.conversation).toBe(base.conversation)
    expect(next.models).toBe(base.models)
  })

  test('interleaved deltas across all three columns land in their own buffers', () => {
    const s = applyEvents('send', [
      ...allStarted(),
      sample.slotDelta('chatgpt', 'c'),
      sample.slotDelta('grok', 'g'),
      sample.slotDelta('claude', 'a'),
      sample.slotDelta('chatgpt', 'h'),
      sample.slotDelta('grok', 'r'),
      sample.slotDelta('claude', 'n'),
    ])
    expect(s.slots.claude.buffer).toBe('an')
    expect(s.slots.chatgpt.buffer).toBe('ch')
    expect(s.slots.grok.buffer).toBe('gr')
    for (const k of ['claude', 'chatgpt', 'grok']) expect(s.slots[k].status).toBe('streaming')
  })

  test('slot_start records model / effort / coercion', () => {
    const s = applyEvents('send', [sample.turnStart(), { type: 'slot_start', slot: 'grok', model: 'x-ai/grok-4.6', effort: 'low', effort_coerced: true }])
    expect(s.slots.grok).toMatchObject({ status: 'streaming', model: 'x-ai/grok-4.6', effort: 'low', effortCoerced: true })
    expect(s.slots.claude.status).toBe('idle')
  })

  test('events of another feature and unknown slots are ignored (identity kept)', () => {
    const s0 = applyEvents('send', allStarted())
    const s1 = applyEvents('fusion', [sample.slotDelta('claude', 'nope')], { state: s0 })
    expect(s1.slots).toBe(s0.slots)
    const s2 = applyEvents('send', [sample.slotDelta('analyst', 'nope'), { type: 'unknown_event' }], { state: s0 })
    expect(s2.slots).toBe(s0.slots)
    expect(Object.keys(s2.slots).sort()).toEqual(['chatgpt', 'claude', 'grok'])
  })
})

describe('slots slice: turn lifecycle', () => {
  test('turn_start for a continue resets only the listed slot', () => {
    const base = applyEvents('send', [...allStarted(), sample.slotDelta('claude', 'A'), sample.slotDone('claude'), sample.slotDelta('grok', 'G'), sample.slotDone('grok')])
    const next = applyEvents('send', [{ type: 'turn_start', turn_id: 't2', feature: 'continue', slots: ['grok'] }], { state: base })
    expect(next.slots.grok).toMatchObject({ buffer: '', status: 'idle', usage: null })
    expect(next.slots.claude).toBe(base.slots.claude)
    expect(next.slots.claude.buffer).toBe('A')
  })

  test('slot_reasoning appends; slot_citations merges and de-dups by url', () => {
    const cite = (url, title) => ({ type: 'url_citation', url_citation: { url, title } })
    const s = applyEvents('send', [
      ...allStarted(),
      { type: 'slot_reasoning', slot: 'claude', text: 'think ' },
      { type: 'slot_reasoning', slot: 'claude', text: 'more' },
      { type: 'slot_citations', slot: 'claude', items: [cite('https://a.example/1', 'A'), cite('https://b.example/2', 'B')] },
      { type: 'slot_citations', slot: 'claude', items: [cite('https://a.example/1', 'A again'), cite('https://c.example/3', 'C')] },
    ])
    expect(s.slots.claude.reasoning).toBe('think more')
    expect(s.slots.claude.citations.map((c) => c.url_citation.url)).toEqual(['https://a.example/1', 'https://b.example/2', 'https://c.example/3'])
    expect(s.slots.claude.citations[0].url_citation.title).toBe('A') // first occurrence wins
    expect(s.slots.chatgpt.reasoning).toBe('')
    expect(s.slots.chatgpt.citations).toEqual([])
    // A duplicate-only batch leaves the slice untouched.
    const dup = applyEvents('send', [{ type: 'slot_citations', slot: 'claude', items: [cite('https://a.example/1', 'x')] }], { state: s })
    expect(dup.slots).toBe(s.slots)
  })

  test('slot_done stores usage, truncated and status done', () => {
    const s = applyEvents('send', [...allStarted(), sample.slotDelta('chatgpt', 'cut'), { ...sample.slotDone('chatgpt', { cost_usd: 0.02 }), finish_reason: 'length', truncated: true }])
    expect(s.slots.chatgpt).toMatchObject({ status: 'done', truncated: true, finishReason: 'length', buffer: 'cut' })
    expect(s.slots.chatgpt.usage.cost_usd).toBe(0.02)
    expect(s.slots.chatgpt.usage.role).toBe('chatgpt')
    expect(s.slots.claude.status).toBe('streaming')
  })

  test('slot_error marks the slot error, keeps the partial text and code', () => {
    const s = applyEvents('send', [...allStarted(), sample.slotDelta('grok', 'par'), { type: 'slot_error', slot: 'grok', code: 502, error_type: 'provider_unavailable', message: 'Provider disconnected', partial: 'partial' }])
    expect(s.slots.grok).toMatchObject({ status: 'error', error: 'Provider disconnected', code: 502, errorType: 'provider_unavailable', buffer: 'partial' })
    expect(s.slots.claude.status).toBe('streaming')
    // Buffer already longer than `partial` is kept as is.
    const s2 = applyEvents('send', [...allStarted(), sample.slotDelta('grok', 'longer text'), { ...sample.slotError('grok', 'boom'), partial: 'long' }])
    expect(s2.slots.grok.buffer).toBe('longer text')
    expect(s2.slots.grok.error).toBe('boom')
  })

  test('terminal error marks in-flight slots error and leaves finished slots alone', () => {
    const s = applyEvents('send', [...allStarted(), sample.slotDelta('claude', 'ok'), sample.slotDone('claude'), sample.slotDelta('grok', 'half'), { type: 'error', message: 'upstream died' }])
    expect(s.slots.claude.status).toBe('done')
    expect(s.slots.grok).toMatchObject({ status: 'error', error: 'upstream died', buffer: 'half' })
    expect(s.slots.chatgpt).toMatchObject({ status: 'error', error: 'upstream died' })
    expect(s.streams.send.status).toBe('error')
  })

  test('turn_done settles any straggler as done; sse/end{ok:false} and sse/abort settle as error', () => {
    const s = applyEvents('send', [...allStarted(), sample.slotDone('claude'), sample.slotDone('chatgpt'), sample.slotDone('grok'), sample.turnDone()])
    for (const k of ['claude', 'chatgpt', 'grok']) expect(s.slots[k].status).toBe('done')
    const straggler = applyEvents('send', [...allStarted(), sample.turnDone()])
    expect(straggler.slots.grok.status).toBe('done')
    const failed = applyEvents('send', [...allStarted(), { type: 'sse/end', feature: 'send', ok: false, error: 'network' }])
    expect(failed.slots.claude).toMatchObject({ status: 'error', error: 'network' })
    const aborted = applyEvents('send', [...allStarted(), { type: 'sse/abort', feature: 'send' }])
    expect(aborted.slots.chatgpt).toMatchObject({ status: 'error', error: 'aborted' })
    // sse/end for another feature is ignored.
    const other = applyEvents('send', [...allStarted()])
    const other2 = rootReducer(other, { type: 'sse/end', feature: 'fusion', ok: false, error: 'x' })
    expect(other2.slots).toBe(other.slots)
  })

  test('conversation/loaded clears live buffers; conversation/cleared resets', () => {
    const live = applyEvents('send', [...allStarted(), sample.slotDelta('claude', 'A'), sample.slotDone('claude')])
    expect(live.slots.claude.buffer).toBe('A')
    const conv = { id: 'c1', title: 'T', slot_config: CFG, threads: { claude: [], chatgpt: [], grok: [] }, turns: [] }
    const loaded = rootReducer(live, { type: 'conversation/loaded', conversation: conv })
    expect(loaded.slots.claude).toMatchObject({ buffer: '', status: 'idle', usage: null })
    expect(loaded.conversation.id).toBe('c1')
    // Already-empty slots keep identity on a redundant load.
    const again = rootReducer(loaded, { type: 'conversation/loaded', conversation: conv })
    expect(again.slots).toBe(loaded.slots)
    const live2 = applyEvents('send', [...allStarted(), sample.slotDelta('grok', 'G')], { state: loaded })
    const cleared = rootReducer(live2, { type: 'conversation/cleared' })
    expect(cleared.slots.grok.buffer).toBe('')
    expect(cleared.slots.grok.status).toBe('idle')
    expect(cleared.conversation).toBeNull()
  })

  test('initial state has exactly the three slots with the documented shape', () => {
    const s = initialState()
    expect(Object.keys(s.slots).sort()).toEqual(['chatgpt', 'claude', 'grok'])
    expect(s.slots.claude).toMatchObject({ buffer: '', reasoning: '', citations: [], status: 'idle', usage: null, truncated: false, error: null, effort: null, effortCoerced: false, model: null })
    expect(initialState().slots).not.toBe(s.slots)
  })
})

describe('derived helpers', () => {
  const MODELS = [
    { id: 'anthropic/claude-opus-5', vendor: 'anthropic', efforts: ['off', 'low', 'medium', 'high'] },
    { id: 'anthropic/claude-fable-5.1', vendor: 'anthropic', efforts: ['low', 'medium', 'high'], mandatory_reasoning: true },
    { id: 'openai/gpt-5.6-sol', vendor: 'openai', efforts: ['off', 'low', 'medium', 'high'] },
    { id: 'x-ai/grok-4.6', vendor: 'x-ai', efforts: ['low', 'medium', 'high'], mandatory_reasoning: true },
  ]
  const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]))

  test('vendorModels filters by SLOT_VENDORS and keeps the configured slug when absent', () => {
    expect(vendorModels(MODELS, 'claude', 'anthropic/claude-opus-5').map((m) => m.id)).toEqual(['anthropic/claude-opus-5', 'anthropic/claude-fable-5.1'])
    expect(vendorModels(MODELS, 'grok', 'x-ai/grok-4.6').map((m) => m.id)).toEqual(['x-ai/grok-4.6'])
    const withMissing = vendorModels(MODELS, 'chatgpt', 'openai/gpt-7-nova')
    expect(withMissing.map((m) => m.id)).toEqual(['openai/gpt-7-nova', 'openai/gpt-5.6-sol'])
    expect(withMissing[0].missing).toBe(true)
    expect(vendorModels([], 'claude', 'anthropic/claude-opus-5').map((m) => m.id)).toEqual(['anthropic/claude-opus-5'])
  })

  test('effortsFor uses catalog efforts, else the four defaults', () => {
    expect(effortsFor({ byId }, 'x-ai/grok-4.6')).toEqual(['low', 'medium', 'high'])
    expect(effortsFor({ byId }, 'anthropic/claude-opus-5')).toEqual(['off', 'low', 'medium', 'high'])
    expect(effortsFor({ byId }, 'unknown/model')).toBe(DEFAULT_EFFORTS)
    expect(effortsFor({ byId: {} }, '')).toBe(DEFAULT_EFFORTS)
  })

  test('nearestEffort mirrors reasoning.build coercion', () => {
    expect(nearestEffort('off', ['low', 'medium', 'high'])).toBe('low')
    expect(nearestEffort('medium', ['low', 'medium', 'high'])).toBe('medium')
    expect(nearestEffort('high', ['low'])).toBe('low')
    expect(nearestEffort('low', ['medium', 'high'])).toBe('medium')
    expect(nearestEffort('off', ['off'])).toBe('off')
  })

  test('mergeCitations keeps identity when nothing new and passes unknown items through', () => {
    const a = [{ type: 'url_citation', url_citation: { url: 'https://x/1' } }]
    expect(mergeCitations(a, [])).toBe(a)
    expect(mergeCitations(a, [{ type: 'url_citation', url_citation: { url: 'https://x/1' } }])).toBe(a)
    expect(mergeCitations(a, [{ type: 'other' }])).toHaveLength(2)
  })

  test('turnExtras / slotTurns read the per-slot fields of send and continue turns', () => {
    const send = {
      id: 't1',
      type: 'send',
      prompt: 'q',
      slot_config: CFG,
      responses: { claude: 'a', chatgpt: null, grok: 'c' },
      errors: { chatgpt: 'boom' },
      partial: { chatgpt: 'half' },
      reasoning: { claude: 'hmm' },
      citations: { grok: [{ type: 'url_citation', url_citation: { url: 'https://g/1' } }] },
      truncated: { grok: true },
      effort_applied: { claude: 'low', chatgpt: 'medium', grok: 'medium' },
      usage: { calls: [{ role: 'claude', model: 'm1', cost_usd: 0.1 }, { role: 'grok', model: 'm3', cost_usd: 0.3 }], totals: {} },
    }
    const cont = { id: 't2', type: 'continue', slot: 'grok', prompt: 'more', response: 'r', reasoning: 'why', citations: [], truncated: false, effort_applied: 'high', slot_config: CFG, usage: { calls: [{ role: 'grok', model: 'm3' }] } }
    const analyze = { id: 't3', type: 'analyze', of_turn: 't1' }
    const conv = { turns: [send, cont, analyze] }
    expect(turnExtras(send, 'claude')).toMatchObject({ turnId: 't1', reasoning: 'hmm', effort: 'low', configuredEffort: 'medium', usage: { model: 'm1' }, error: null, truncated: false })
    expect(turnExtras(send, 'chatgpt')).toMatchObject({ error: 'boom', partial: 'half', response: null, usage: null })
    expect(turnExtras(send, 'grok')).toMatchObject({ truncated: true, citations: [{ url_citation: { url: 'https://g/1' } }] })
    expect(turnExtras(cont, 'claude')).toBeNull()
    expect(turnExtras(analyze, 'claude')).toBeNull()
    const grok = slotTurns(conv, 'grok')
    expect(Object.keys(grok.byTurn)).toEqual(['t1', 't2'])
    expect(grok.latest).toMatchObject({ turnId: 't2', type: 'continue', reasoning: 'why', effort: 'high' })
    expect(slotTurns(conv, 'claude').latest.turnId).toBe('t1')
    expect(slotTurns(null, 'claude')).toEqual({ byTurn: {}, latest: null })
  })
})
