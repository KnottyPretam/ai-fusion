// Council (2026-09-27): the desktop analyst picker offers the catalog's OpenRouter models — the
// structured-outputs ones first — once main reports a configured key (`panes.openRouterKey`, read
// by slice key), and never without one. The web picker is byte-identical (config.test.jsx).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen } from '@testing-library/react'
import SlotConfigBar, { GROUNDED_TITLE, OLLAMA_GROUP, OPENROUTER_OTHER_GROUP, OPENROUTER_STRUCTURED_GROUP, SITES, SITE_LABELS, WEB_ANALYST_GROUP, desktopAnalystGroups } from './index.jsx'
import { renderWithStore } from '../../state/testing.jsx'

afterEach(() => vi.unstubAllGlobals())

const CATALOG = [
  { id: 'web:claude:analyst', name: 'Claude web session (hidden analyst page)', vendor: 'triplex-analyst', raw: { transport: 'web' } },
  { id: 'web:chatgpt:analyst', name: 'ChatGPT web session (hidden analyst page)', vendor: 'triplex-analyst', raw: { transport: 'web' } },
  { id: 'web:grok:analyst', name: 'Grok web session (hidden analyst page)', vendor: 'triplex-analyst', raw: { transport: 'web' } },
  { id: 'web:claude', name: 'Claude (web session)', vendor: 'anthropic', raw: { transport: 'web' } },
  { id: 'ollama:hermes3', name: 'hermes3 (local Ollama)', vendor: 'ollama', raw: { transport: 'ollama' } },
  { id: 'openai/gpt-5', name: 'GPT-5', vendor: 'openai', structured_outputs: true, raw: { transport: 'openrouter' } },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', vendor: 'qwen', structured_outputs: false, raw: { transport: 'openrouter' } },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'google', structured_outputs: true, raw: { transport: 'openrouter' } },
]
const models = { items: CATALOG, byId: Object.fromEntries(CATALOG.map((m) => [m.id, m])), loaded: true, error: null }
const CFG = { slots: { claude: { model: 'web:claude', effort: 'off' }, qwen: { model: 'qwen/qwen3-235b-a22b', effort: 'off' } }, analyst_model: 'web:chatgpt:analyst', max_iterations: 2, materiality_min: 'medium', grounded: false }
const CONV = { id: 'c1', title: 'T', slot_config: CFG, threads: { claude: [], qwen: [] }, turns: [] }
const panes = (openRouterKey) => ({ mode: 'split', active: 'chatgpt', targets: {}, health: {}, lastSend: {}, sending: false, zoom: {}, capture: {}, bridge: { connected: false }, turn: {}, drawerOpen: false, analyst: { slot: null, visible: false, health: null }, council: null, openRouterKey })
const groupsOf = () => [...screen.getByTestId('config-analyst-model').querySelectorAll('optgroup')].map((g) => [g.getAttribute('label'), [...g.querySelectorAll('option')].map((o) => o.value)])

describe('desktopAnalystGroups', () => {
  test('SITES / SITE_LABELS name the three sites with a view; the grounded title no longer counts to three', () => {
    expect(SITES).toEqual(['claude', 'chatgpt', 'grok'])
    expect(SITE_LABELS).toEqual({ claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' })
    expect(GROUNDED_TITLE).toContain('every Send (one call per agent)')
  })

  test('without a key the OpenRouter groups are empty; with one they hold the tagged slugs, structured first, name-sorted', () => {
    const none = desktopAnalystGroups(CATALOG)
    expect(none.web.map((m) => m.id)).toEqual(['web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst'])
    expect(none.ollama.map((m) => m.id)).toEqual(['ollama:hermes3'])
    expect(none.openrouter).toEqual({ structured: [], other: [] })
    const keyed = desktopAnalystGroups(CATALOG, { keyConfigured: true })
    expect(keyed.openrouter.structured.map((m) => m.id)).toEqual(['google/gemini-2.5-pro', 'openai/gpt-5'])
    expect(keyed.openrouter.other.map((m) => m.id)).toEqual(['qwen/qwen3-235b-a22b'])
    // an untagged slug (the web app's catalog) is not offered in desktop mode: only raw.transport says openrouter
    expect(desktopAnalystGroups([{ id: 'openai/gpt-5', vendor: 'openai' }], { keyConfigured: true }).openrouter).toEqual({ structured: [], other: [] })
  })
})

describe('SlotConfigBar in desktop mode', () => {
  test('lists the OpenRouter analysts only while panes.openRouterKey says configured', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => CATALOG })))
    const { unmount } = renderWithStore(<SlotConfigBar desktop analyst="web:chatgpt:analyst" onAnalystChange={() => {}} />, { preloaded: { conversation: CONV, slotConfig: CFG, models, panes: panes(null) } })
    expect(groupsOf()).toEqual([
      [WEB_ANALYST_GROUP, ['web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst']],
      [OLLAMA_GROUP, ['ollama:hermes3']],
    ])
    unmount()
    renderWithStore(<SlotConfigBar desktop analyst="web:chatgpt:analyst" onAnalystChange={() => {}} />, {
      preloaded: { conversation: CONV, slotConfig: { ...CFG, analyst_model: 'openai/gpt-5' }, models, panes: panes({ configured: true, prefix: 'sk-or-v1-', length: 73, pushed: true }) },
    })
    expect(groupsOf()).toEqual([
      [WEB_ANALYST_GROUP, ['web:claude:analyst', 'web:chatgpt:analyst', 'web:grok:analyst']],
      [OLLAMA_GROUP, ['ollama:hermes3']],
      [OPENROUTER_STRUCTURED_GROUP, ['google/gemini-2.5-pro', 'openai/gpt-5']],
      [OPENROUTER_OTHER_GROUP, ['qwen/qwen3-235b-a22b']],
    ])
    // the conversation's OpenRouter analyst is a known option now, not an "unknown" stray
    const select = screen.getByTestId('config-analyst-model')
    expect(select).toHaveValue('openai/gpt-5')
    expect([...select.querySelectorAll(':scope > option')].map((o) => o.value)).toEqual([''])
  })
})
