// Phase 5 meter verification (PLAN §8 Phase 5, §11 "Fusion cost blowup"). The usage numbers come
// straight from the planted_factual scenario fixtures — the files the mock transport replays and
// the offline e2e suite checks server-side — and are fed through the meter slice as the
// slot_done / turn_done / analyze_done / fusion_done events the backend derives from them. The
// rows and the Fusion multiplier must match the fixture costs; a reload of the persisted turns
// must show the same numbers. Tokens, costs and call counts are derived from the loaded fixture
// files (add a chat.2 or defense.2 file and the expected values move with it); only the first
// test pins the README's exact file set. Wall-clock latency is test-supplied (WALL below): the
// fixtures carry no latency, the backend measures it live, and the meter only reports it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import CostMeter, { fmtInt, fmtUsd } from './index.jsx' // registers the 'meter' slice
import { meterFromConversation } from './slice.js'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'

const SCENARIO = 'planted_factual'
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../backend/llm/fixtures/scenarios', SCENARIO)
const SLOT_ORDER = ['claude', 'chatgpt', 'grok']
// docs/fixtures.md: every call carries role + purpose; the meter books purposes by feature.
const ROW_OF_PURPOSE = { chat: 'send', extraction: 'analyze', defense: 'fusion', convergence: 'fusion' }
const WALL = { send: 800, analyze: 1200, fusion: 9000 } // test-supplied: wall clocks are measured live, the files carry none

const round8 = (v) => Math.round(v * 1e8) / 1e8
const cents = (v) => Math.round(v * 100)

// One fixture -> the Usage the backend builds from its final usage chunk (docs/fixtures.md
// "Canonical chunk lines": a successful fixture ends with the chunk carrying `usage.cost`;
// reasoning tokens sit in completion_tokens_details).
function readUsage(file) {
  const chunks = fs
    .readFileSync(path.join(DIR, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const last = chunks[chunks.length - 1]
  if (!last.usage || typeof last.usage.cost !== 'number') throw new Error(`${file}: expected a final usage chunk with cost`)
  const [role, purpose] = file.split('.')
  const details = last.usage.completion_tokens_details || {}
  return {
    prompt_tokens: last.usage.prompt_tokens,
    completion_tokens: last.usage.completion_tokens,
    reasoning_tokens: details.reasoning_tokens || 0,
    cost_usd: last.usage.cost,
    latency_ms: 0,
    model: last.model,
    role,
    purpose,
    generation_id: chunks[0].id,
  }
}

// backend/schemas.py FeatureUsage: per-field sums, cost rounded to 8 decimals per call, and
// totals.latency_ms = the feature's wall clock.
function featureUsage(calls, wall) {
  const t = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: wall, calls: 0 }
  for (const u of calls) {
    t.prompt_tokens += u.prompt_tokens
    t.completion_tokens += u.completion_tokens
    t.reasoning_tokens += u.reasoning_tokens
    t.cost_usd = round8(t.cost_usd + u.cost_usd)
    t.calls += 1
  }
  return { calls, totals: t }
}

function loadScenario() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
  const rows = { send: [], analyze: [], fusion: [] }
  for (const f of files) {
    const u = readUsage(f)
    const row = ROW_OF_PURPOSE[u.purpose]
    if (!row) throw new Error(`${f}: unknown purpose ${u.purpose}`)
    rows[row].push(u)
  }
  rows.send.sort((a, b) => SLOT_ORDER.indexOf(a.role) - SLOT_ORDER.indexOf(b.role))
  const usage = { send: featureUsage(rows.send, WALL.send), analyze: featureUsage(rows.analyze, WALL.analyze), fusion: featureUsage(rows.fusion, WALL.fusion) }
  const sendTurn = {
    id: 't1',
    type: 'send',
    prompt: 'What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?',
    responses: { claude: 'a', chatgpt: 'b', grok: 'c' },
    truncated: { claude: false, chatgpt: false, grok: false },
    effort_applied: { claude: 'medium', chatgpt: 'medium', grok: 'medium' },
    usage: usage.send,
  }
  const analyzeTurn = { id: 'a1', type: 'analyze', of_turn: 't1', status: 'ok', extraction: { agreements: [], divergences: [] }, raw_attempts: [], usage: usage.analyze }
  const fusionTurn = {
    id: 'f1',
    type: 'fusion',
    of_analyze: 'a1',
    max_iterations: 2,
    standing: ['d1'],
    rounds: [],
    final: [{ divergence_id: 'd1', status: 'resolved' }],
    exit_reason: 'converged',
    usage: usage.fusion,
  }
  const events = {
    send: [
      { type: 'turn_start', turn_id: 't1', feature: 'send', slots: SLOT_ORDER },
      ...rows.send.map((u) => ({ type: 'slot_start', slot: u.role, model: u.model, effort: 'medium', effort_coerced: false })),
      ...rows.send.map((u) => ({ type: 'slot_done', slot: u.role, usage: u, finish_reason: 'stop', truncated: false })),
      { type: 'turn_done', turn_id: 't1', usage: usage.send },
    ],
    analyze: [
      { type: 'analyze_start', turn_id: 'a1', of_turn: 't1' },
      { type: 'analyze_done', turn: analyzeTurn, cached: false },
    ],
    fusion: [
      { type: 'fusion_start', turn_id: 'f1', of_analyze: 'a1', max_iterations: 2, standing: ['d1'] },
      { type: 'round_start', round: 1 },
      { type: 'round_done', round: 1, post_round_status: [{ divergence_id: 'd1', status: 'resolved' }], changed: true },
      { type: 'fusion_done', turn: fusionTurn, exit_reason: 'converged', usage: usage.fusion },
    ],
  }
  return { files, rows, usage, events, turns: [sendTurn, analyzeTurn, fusionTurn] }
}

const expectedRow = (fu) => ({ ...fu.totals, truncated: 0 })

describe(`meter vs backend/llm/fixtures/scenarios/${SCENARIO}`, () => {
  test('the scenario is the one its README describes: 3 chat, 1 extraction, 3 defense, 1 convergence files, each with a cost', () => {
    const { files, rows } = loadScenario()
    expect(files).toHaveLength(8)
    expect(rows.send.map((u) => u.role)).toEqual(SLOT_ORDER)
    expect(rows.send.every((u) => u.purpose === 'chat')).toBe(true)
    expect(rows.analyze.map((u) => `${u.role}.${u.purpose}`)).toEqual(['analyst.extraction'])
    expect(rows.fusion.map((u) => `${u.role}.${u.purpose}`).sort()).toEqual(['analyst.convergence', 'chatgpt.defense', 'claude.defense', 'grok.defense'])
    for (const u of [...rows.send, ...rows.analyze, ...rows.fusion]) {
      expect(u.cost_usd).toBeGreaterThan(0)
      expect(u.prompt_tokens).toBeGreaterThan(0)
      expect(u.completion_tokens).toBeGreaterThan(0)
    }
  })

  test('live events: Send / Analyze / Fusion rows, the last-invocation rows and the total equal the fixture usage sums', () => {
    const { files, usage, events } = loadScenario()
    let s = applyEvents('send', events.send)
    s = applyEvents('analyze', events.analyze, { state: s })
    s = applyEvents('fusion', events.fusion, { state: s })
    for (const row of ['send', 'analyze', 'fusion']) {
      expect(s.meter[row], row).toEqual(expectedRow(usage[row]))
      expect(s.meter.last[row], `last ${row}`).toEqual(expectedRow(usage[row]))
    }
    const all = round8(usage.send.totals.cost_usd + usage.analyze.totals.cost_usd + usage.fusion.totals.cost_usd)
    expect(s.meter.total.cost_usd).toBeCloseTo(all, 8)
    expect(cents(s.meter.total.cost_usd)).toBe(cents(all)) // to the cent
    expect(s.meter.total.calls).toBe(files.length) // one call per fixture file
    expect(s.meter.total.prompt_tokens).toBe(usage.send.totals.prompt_tokens + usage.analyze.totals.prompt_tokens + usage.fusion.totals.prompt_tokens)
    expect(s.meter.total.completion_tokens).toBe(usage.send.totals.completion_tokens + usage.analyze.totals.completion_tokens + usage.fusion.totals.completion_tokens)
    expect(s.meter.total.reasoning_tokens).toBe(usage.send.totals.reasoning_tokens + usage.analyze.totals.reasoning_tokens + usage.fusion.totals.reasoning_tokens)
    // The multiplier's denominator is the fused Send (t1 -> a1 -> f1), i.e. the three chat calls.
    expect(s.meter.sendCostByTurn).toEqual({ t1: usage.send.totals.cost_usd })
    expect(s.meter.analyzeOfTurn).toEqual({ a1: 't1' })
    expect(s.meter.fusedSendCost).toBe(usage.send.totals.cost_usd)
    expect(s.meter.costCapExceeded).toBe(false)
  })

  test('the footer renders those numbers and a Fusion multiplier = fusion cost / send cost (> 1: one round is 3 defenses + a convergence check)', () => {
    const { files, rows, usage, events } = loadScenario()
    let s = applyEvents('send', events.send)
    s = applyEvents('analyze', events.analyze, { state: s })
    s = applyEvents('fusion', events.fusion, { state: s })
    renderWithStore(<CostMeter />, { preloaded: { meter: s.meter } })
    const sendCost = usage.send.totals.cost_usd
    const fusionCost = usage.fusion.totals.cost_usd
    for (const row of ['send', 'analyze', 'fusion']) {
      const t = usage[row].totals
      expect(screen.getByTestId(`meter-${row}-cost`)).toHaveTextContent(fmtUsd(t.cost_usd))
      expect(screen.getByTestId(`meter-${row}-conv-cost`)).toHaveTextContent(fmtUsd(t.cost_usd))
      expect(screen.getByTestId(`meter-${row}-tokens`)).toHaveTextContent(`${fmtInt(t.prompt_tokens)} / ${fmtInt(t.completion_tokens)}`)
      // One call per fixture file booked under that row (ROW_OF_PURPOSE).
      expect(screen.getByTestId(`meter-${row}-calls`)).toHaveTextContent(String(rows[row].length))
      expect(screen.getByTestId(`meter-${row}-conv-calls`)).toHaveTextContent(String(rows[row].length))
    }
    const mult = fusionCost / sendCost
    expect(mult).toBeGreaterThan(1)
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveTextContent(`×${mult.toFixed(1)} vs Send`)
    expect(screen.getByTestId('meter-fusion-multiplier')).toHaveAttribute('title', expect.stringContaining(fmtUsd(sendCost)))
    const all = round8(sendCost + usage.analyze.totals.cost_usd + fusionCost)
    expect(screen.getByTestId('meter-total-conv-cost')).toHaveTextContent(fmtUsd(all))
    expect(screen.getByTestId('meter-total-conv-calls')).toHaveTextContent(String(files.length))
    expect(screen.getByTestId('meter-truncated')).toHaveTextContent('truncated replies: 0')
    expect(screen.queryByTestId('meter-cost-cap')).toBeNull()
  })

  test('reloading the persisted turns (conversation/loaded) shows exactly what the live stream showed', () => {
    const { events, turns, usage } = loadScenario()
    let live = applyEvents('send', events.send)
    live = applyEvents('analyze', events.analyze, { state: live })
    live = applyEvents('fusion', events.fusion, { state: live })
    const conversation = { id: 'c1', title: 't', threads: { claude: [], chatgpt: [], grok: [] }, turns }
    const reloaded = applyEvents('send', [{ type: 'conversation/loaded', conversation }])
    for (const row of ['send', 'analyze', 'fusion']) {
      expect(reloaded.meter[row], row).toEqual(live.meter[row])
      expect(reloaded.meter.last[row], `last ${row}`).toEqual(live.meter.last[row])
    }
    expect(reloaded.meter.total).toEqual(live.meter.total)
    expect(reloaded.meter.fusedSendCost).toBe(live.meter.fusedSendCost)
    expect(meterFromConversation(conversation).fusedSendCost).toBe(usage.send.totals.cost_usd)
    expect(reloaded.meter.sendCostByTurn).toEqual(live.meter.sendCostByTurn)
    expect(reloaded.meter.analyzeOfTurn).toEqual(live.meter.analyzeOfTurn)
  })
})
