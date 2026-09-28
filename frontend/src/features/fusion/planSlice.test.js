// The plan slice (2026-09-27). Mirrors the refactor slice's tests — the template it was cut from —
// keyed on the fusion turn, plus the pure helpers the section is built on: the button rule, the
// agent picker's groups per shell, the persisted choice and the per-plan step ticks.
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_GROUP,
  DEFAULT_MODEL,
  DEFAULT_MODEL_DESKTOP,
  OLLAMA_GROUP,
  OPENROUTER_GROUP,
  OTHER_GROUP,
  PLAN_CHECKED_PREFIX,
  PLAN_MODEL_KEY,
  STRUCTURED_GROUP,
  WEB_ANALYST_GROUP,
  WEB_PANE_GROUP,
  checkedSteps,
  defaultPlanModel,
  hasOption,
  initial,
  loadPlanModel,
  newestFusionTurn,
  newestOkPlanTurn,
  persistPlanModel,
  planGate,
  planModelOptions,
  reducer,
  toggleStep,
} from './planSlice.js'
import { DESKTOP_CATALOG, PLAN, planEvents, planTurn, plannedConversation } from './fixtures.js'

const sse = (event, feature = 'plan') => ({ type: 'sse', feature, event })

describe('plan slice', () => {
  test('starts idle and empty', () => {
    expect(initial()).toEqual({ status: 'idle', turn: null, cached: false, notice: null, error: null, ofFusion: null, model: null })
  })

  test('plan_start is the only idle -> running transition and remembers the fusion turn and the model', () => {
    const s = reducer(initial(), sse(planEvents.start({ turn_id: 'p1', of_fusion: 'f1', model: 'web:claude' })))
    expect(s).toMatchObject({ status: 'running', ofFusion: 'f1', model: 'web:claude', turn: null })
  })

  test('plan_retry is progress, carried as a notice and never as an error', () => {
    let s = reducer(initial(), sse(planEvents.start()))
    s = reducer(s, sse(planEvents.retry('asking the agent for a plan')))
    expect(s.status).toBe('working')
    expect(s.notice).toBe('asking the agent for a plan')
    expect(s.error).toBeNull()
    s = reducer(s, sse(planEvents.retry('validation_error: steps[0].verify missing')))
    expect(s.notice).toContain('validation_error')
    expect(s.status).toBe('working')
  })

  test('plan_done carries the turn, the model it was made with, and clears the notice', () => {
    let s = reducer(initial(), sse(planEvents.start()))
    s = reducer(s, sse(planEvents.retry()))
    s = reducer(s, sse(planEvents.done(planTurn(), true)))
    expect(s).toMatchObject({ status: 'done', cached: true, notice: null, error: null, ofFusion: 'f1', model: 'web:claude' })
    expect(s.turn.id).toBe('p1')
    expect(s.turn.plan).toEqual(PLAN)
  })

  test('plan_degraded keeps the turn and surfaces its error', () => {
    const s = reducer(initial(), sse(planEvents.degraded()))
    expect(s).toMatchObject({ status: 'degraded', error: 'parse_error: no JSON object found', ofFusion: 'f1', cached: false })
    expect(s.turn.plan).toBeNull()
    expect(s.turn.raw_attempts).toHaveLength(2)
  })

  test('a terminal error counts on the plan stream, or on any stream while a run is in flight', () => {
    const running = reducer(initial(), sse(planEvents.start()))
    expect(reducer(running, sse({ type: 'error', message: 'boom' }, 'send')).status).toBe('error')
    expect(reducer(initial(), sse({ type: 'error', message: 'boom' }, 'send')).status).toBe('idle')
    expect(reducer(initial(), sse({ type: 'error', message: 'boom' }, 'plan'))).toMatchObject({ status: 'error', error: 'boom' })
  })

  test('a pre-stream failure arrives as sse/end and is an error', () => {
    const s = reducer(initial(), { type: 'sse/end', feature: 'plan', ok: false, error: 'plan_input_too_large' })
    expect(s).toMatchObject({ status: 'error', error: 'plan_input_too_large' })
    // an ok end without plan_done changes nothing here (the streams slice records it)
    const done = reducer(initial(), sse(planEvents.done()))
    expect(reducer(done, { type: 'sse/end', feature: 'plan', ok: true })).toBe(done)
  })

  test('an abort mid-run resets; an abort at rest changes nothing', () => {
    const running = reducer(initial(), sse(planEvents.start()))
    expect(reducer(running, { type: 'sse/abort', feature: 'plan' })).toEqual(initial())
    const atRest = reducer(initial(), sse(planEvents.done()))
    expect(reducer(atRest, { type: 'sse/abort', feature: 'plan' })).toBe(atRest)
  })

  test('conversation/loaded hydrates from the newest ok plan turn of the newest fusion turn', () => {
    const s = reducer(initial(), { type: 'conversation/loaded', conversation: plannedConversation() })
    expect(s).toMatchObject({ status: 'done', ofFusion: 'f1', model: 'web:claude', cached: false })
    expect(s.turn.id).toBe('p1')
  })

  test('conversation/loaded ignores a degraded plan turn and one made for another fusion turn', () => {
    const conv = plannedConversation({ plan: planTurn('p2', 'f1', { status: 'degraded', error: 'x' }) })
    expect(reducer(initial(), { type: 'conversation/loaded', conversation: conv })).toEqual(initial())
    const other = plannedConversation({ plan: planTurn('p3', 'f0') })
    expect(reducer(initial(), { type: 'conversation/loaded', conversation: other })).toEqual(initial())
  })

  test('conversation/loaded never clobbers a result that belongs to the displayed fusion turn', () => {
    const done = reducer(initial(), sse(planEvents.done(planTurn('p9', 'f1'))))
    const conv = plannedConversation({ plan: null })
    expect(reducer(done, { type: 'conversation/loaded', conversation: conv })).toBe(done)
    // …but a conversation whose newest fusion turn is another one resets it
    const degraded = reducer(initial(), sse(planEvents.degraded()))
    const elsewhere = plannedConversation({ plan: null })
    elsewhere.turns.push({ ...elsewhere.turns[2], id: 'f2' })
    expect(reducer(degraded, { type: 'conversation/loaded', conversation: elsewhere })).toEqual(initial())
  })

  test('conversation/loaded without a fusion turn, and conversation/cleared, reset — identity when already initial', () => {
    const fresh = initial()
    expect(reducer(fresh, { type: 'conversation/loaded', conversation: { turns: [] } })).toBe(fresh)
    expect(reducer(fresh, { type: 'conversation/cleared' })).toBe(fresh)
    const done = reducer(initial(), sse(planEvents.done()))
    expect(reducer(done, { type: 'conversation/loaded', conversation: { turns: [] } })).toEqual(initial())
    expect(reducer(done, { type: 'conversation/cleared' })).toEqual(initial())
  })

  test('an unknown action keeps identity', () => {
    const s = reducer(initial(), sse(planEvents.done()))
    expect(reducer(s, { type: 'noop' })).toBe(s)
    expect(reducer(s, sse({ type: 'slot_delta', slot: 'claude', text: 'x' }, 'send'))).toBe(s)
  })
})

describe('plan slice: pure helpers', () => {
  test('newestOkPlanTurn ignores degraded turns and turns for another fusion; newestFusionTurn is re-exported', () => {
    const turns = [
      { id: 'f1', type: 'fusion' },
      { id: 'p1', type: 'plan', of_fusion: 'f1', status: 'ok' },
      { id: 'p2', type: 'plan', of_fusion: 'f1', status: 'degraded' },
      { id: 'p3', type: 'plan', of_fusion: 'f2', status: 'ok' },
    ]
    expect(newestOkPlanTurn({ turns }, 'f1').id).toBe('p1')
    expect(newestOkPlanTurn({ turns }, 'f9')).toBeNull()
    expect(newestOkPlanTurn(null, 'f1')).toBeNull()
    expect(newestFusionTurn({ turns }).id).toBe('f1')
  })

  test('planGate: a persisted report on screen and no stream running', () => {
    const idle = { send: { status: 'idle' }, analyze: { status: 'idle' }, fusion: { status: 'done' } }
    expect(planGate({ fusion: { status: 'done', turnId: 'f1', notice: null }, streams: idle })).toEqual({ enabled: true, reason: null })
    expect(planGate({ fusion: { status: 'idle', turnId: null, notice: null }, streams: idle }).reason).toBe('no fusion report yet')
    expect(planGate({ fusion: { status: 'running', turnId: 'f1', notice: null }, streams: idle }).enabled).toBe(false)
    expect(planGate({ fusion: { status: 'done', turnId: null, notice: 'nothing_to_fuse' }, streams: idle }).enabled).toBe(false)
    expect(planGate({ fusion: { status: 'done', turnId: 'f1', notice: null }, streams: { ...idle, plan: { status: 'streaming' } } })).toEqual({ enabled: false, reason: 'a stream is running' })
    expect(planGate({ fusion: { status: 'done', turnId: 'f1', notice: null }, streams: { ...idle, send: { status: 'streaming' } } }).enabled).toBe(false)
    expect(planGate({ fusion: null, streams: idle }).enabled).toBe(false)
  })

  test('the default agent is the first web pane on the desktop and the OpenRouter slug in the browser', () => {
    expect(defaultPlanModel(true)).toBe(DEFAULT_MODEL_DESKTOP)
    expect(defaultPlanModel(false)).toBe(DEFAULT_MODEL)
    expect(DEFAULT_MODEL_DESKTOP).toBe('web:claude')
    expect(DEFAULT_MODEL).toBe('anthropic/claude-opus-5.5')
  })

  test('loadPlanModel / persistPlanModel round-trip through storage and never throw', () => {
    const store = new Map()
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
    expect(loadPlanModel(storage, true)).toBe('web:claude')
    expect(loadPlanModel(storage, false)).toBe('anthropic/claude-opus-5.5')
    persistPlanModel(storage, 'ollama:hermes3')
    expect(store.get(PLAN_MODEL_KEY)).toBe('ollama:hermes3')
    expect(loadPlanModel(storage, true)).toBe('ollama:hermes3')
    // junk in storage falls back to the default; junk is never written
    store.set(PLAN_MODEL_KEY, '   ')
    expect(loadPlanModel(storage, false)).toBe(DEFAULT_MODEL)
    persistPlanModel(storage, '')
    persistPlanModel(storage, 'has space')
    persistPlanModel(storage, null)
    expect(store.get(PLAN_MODEL_KEY)).toBe('   ')
    // a storage that throws, or none at all
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadPlanModel(broken, true)).toBe('web:claude')
    expect(() => persistPlanModel(broken, 'web:grok')).not.toThrow()
    expect(loadPlanModel(null, false)).toBe(DEFAULT_MODEL)
    expect(() => persistPlanModel(null, 'web:grok')).not.toThrow()
  })

  test('desktop groups: the web panes first, then the hidden analyst pages, local Ollama, and OpenRouter only with a key', () => {
    const noKey = planModelOptions({ items: DESKTOP_CATALOG, desktop: true, keyConfigured: false })
    expect(noKey.map((g) => g.label)).toEqual([WEB_PANE_GROUP, WEB_ANALYST_GROUP, OLLAMA_GROUP])
    expect(noKey[0].options).toEqual([
      { id: 'web:claude', name: "Claude — this conversation's chat" },
      { id: 'web:chatgpt', name: "ChatGPT — this conversation's chat" },
      { id: 'web:grok', name: "Grok — this conversation's chat" },
    ])
    expect(noKey[1].options.map((o) => o.id)).toEqual(['web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst'])
    expect(noKey[1].options[0].name).toContain('hidden analyst page')
    expect(noKey[2].options.map((o) => o.id)).toEqual(['ollama:hermes3', 'ollama:qwen3'])
    const withKey = planModelOptions({ items: DESKTOP_CATALOG, desktop: true, keyConfigured: true })
    expect(withKey.map((g) => g.label)).toEqual([WEB_PANE_GROUP, WEB_ANALYST_GROUP, OLLAMA_GROUP, OPENROUTER_GROUP])
    const or = withKey[3].options.map((o) => o.id)
    expect(or).toHaveLength(6)
    // structured outputs first (by name), then the rest (by name)
    expect(or.slice(0, 2)).toEqual(['google/gemini-2.5-pro', 'openai/gpt-5'])
    expect(or.slice(2)).toEqual(['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-r1', 'xiaomi/mimo-v2-flash', 'qwen/qwen3-235b-a22b'])
    // never a web: / ollama: id inside the OpenRouter group
    expect(or.some((id) => id.startsWith('web:') || id.startsWith('ollama:'))).toBe(false)
  })

  test('desktop groups with an empty catalog still offer the six fixed web ids', () => {
    const groups = planModelOptions({ items: [], desktop: true, keyConfigured: true })
    expect(groups.map((g) => g.label)).toEqual([WEB_PANE_GROUP, WEB_ANALYST_GROUP])
    expect(groups[1].options[1]).toEqual({ id: 'web:chatgpt:analyst', name: 'ChatGPT web session (hidden analyst page)' })
    // the catalog's own name wins when it lists the analyst page
    const named = planModelOptions({ items: [{ id: 'web:claude:analyst', name: 'Claude web session (hidden analyst page)' }], desktop: true })
    expect(named[1].options[0].name).toBe('Claude web session (hidden analyst page) (web:claude:analyst)')
  })

  test('browser groups: the OpenRouter catalog structured first, with the default id present even when the catalog lacks it', () => {
    const items = [
      { id: 'openai/gpt-5', name: 'GPT-5', structured_outputs: true },
      { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', structured_outputs: false },
      { id: 'x-ai/grok-4.6', name: 'Grok 4.6', structured_outputs: true },
      { id: 'web:claude', name: 'never in the browser' },
    ]
    const groups = planModelOptions({ items, desktop: false })
    expect(groups.map((g) => g.label)).toEqual([STRUCTURED_GROUP, OTHER_GROUP])
    expect(groups[0].options.map((o) => o.id)).toEqual(['openai/gpt-5', 'x-ai/grok-4.6'])
    expect(groups[1].options).toEqual([{ id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5 (anthropic/claude-opus-5.5)' }])
    const lacking = planModelOptions({ items: items.slice(0, 1), desktop: false })
    expect(lacking.map((g) => g.label)).toEqual([DEFAULT_GROUP, STRUCTURED_GROUP])
    expect(lacking[0].options).toEqual([{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }])
    expect(planModelOptions({ items: [], desktop: false })).toEqual([{ label: DEFAULT_GROUP, options: [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }] }])
    expect(planModelOptions()).toHaveLength(1)
    expect(hasOption(groups, 'x-ai/grok-4.6')).toBe(true)
    expect(hasOption(groups, 'web:claude')).toBe(false)
    expect(hasOption(null, 'x')).toBe(false)
  })

  test('checkedSteps / toggleStep keep one list per plan turn, and never throw', () => {
    const store = new Map()
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
    expect(checkedSteps(storage, 'p1')).toEqual([])
    expect(toggleStep(storage, 'p1', 2)).toEqual([2])
    expect(toggleStep(storage, 'p1', 1)).toEqual([1, 2])
    expect(toggleStep(storage, 'p1', 2)).toEqual([1])
    expect(store.get(`${PLAN_CHECKED_PREFIX}p1`)).toBe('[1]')
    expect(checkedSteps(storage, 'p2')).toEqual([])
    // junk is ignored
    store.set(`${PLAN_CHECKED_PREFIX}p3`, '{"no":"array"}')
    expect(checkedSteps(storage, 'p3')).toEqual([])
    store.set(`${PLAN_CHECKED_PREFIX}p4`, '[1,"x",2.5,3]')
    expect(checkedSteps(storage, 'p4')).toEqual([1, 3])
    expect(checkedSteps(storage, null)).toEqual([])
    expect(checkedSteps(null, 'p1')).toEqual([])
    expect(toggleStep(null, 'p1', 1)).toEqual([1])
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(checkedSteps(broken, 'p1')).toEqual([])
    expect(toggleStep(broken, 'p1', 1)).toEqual([1])
  })
})
