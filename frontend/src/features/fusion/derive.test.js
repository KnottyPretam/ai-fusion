import { describe, expect, test } from 'vitest'
import { SIZE_REFUSAL_MARKERS, buildTimeline, clampIterations, fusionGate, isSendComplete, latestClaim, latestJustification, latestSendTurn, newestOkAnalyze, standingIds, traceText, usageSummary } from './derive.js'
import { EXTRACTION, ROUND1, ROUND2, SLOT_CONFIG, USAGE, analyzeTurn, conversation, exchange, roundDone, sendTurn } from './fixtures.js'

const idle = { send: { status: 'idle' }, analyze: { status: 'idle' }, fusion: { status: 'idle' } }
const withRounds = (rs) => rs.map((r) => ({ ...r, complete: true }))
const round1 = { round: 1, exchanges: ROUND1.filter((e) => e.type === 'exchange').map(({ type, round, ...e }) => e), post_round_status: ROUND1[ROUND1.length - 1].post_round_status, changed: true }
const round2 = { round: 2, exchanges: ROUND2.filter((e) => e.type === 'exchange').map(({ type, round, ...e }) => e), post_round_status: ROUND2[ROUND2.length - 1].post_round_status, changed: false }

describe('standing set and send-turn rules', () => {
  test('standingIds applies the materiality rank threshold in extraction order', () => {
    expect(standingIds(EXTRACTION, 'medium')).toEqual(['d1', 'd2'])
    expect(standingIds(EXTRACTION, 'high')).toEqual(['d1'])
    expect(standingIds(EXTRACTION, 'low')).toEqual(['d1', 'd2', 'd3'])
    expect(standingIds(EXTRACTION, undefined)).toEqual(['d1', 'd2']) // default medium
    expect(standingIds(null, 'medium')).toEqual([])
  })

  test('latest send turn is the LAST send turn; completeness needs all three responses', () => {
    const conv = conversation([sendTurn('s1'), analyzeTurn(), sendTurn('s2', { claude: 'a', chatgpt: null, grok: 'c' })])
    expect(latestSendTurn(conv).id).toBe('s2')
    expect(isSendComplete(latestSendTurn(conv))).toBe(false)
    expect(isSendComplete(sendTurn())).toBe(true)
    expect(isSendComplete(null)).toBe(false)
    expect(latestSendTurn(conversation([]))).toBeNull()
  })

  test('newestOkAnalyze skips degraded turns and other send turns', () => {
    const conv = conversation([sendTurn('s1'), analyzeTurn('a1', 's1'), analyzeTurn('a2', 's1', null, 'degraded'), analyzeTurn('a3', 's0')])
    expect(newestOkAnalyze(conv, 's1').id).toBe('a1')
    expect(newestOkAnalyze(conv, 's9')).toBeNull()
  })

  test('clampIterations bounds 1..5 and tolerates junk', () => {
    expect(clampIterations(0)).toBe(1)
    expect(clampIterations(9)).toBe(5)
    expect(clampIterations('3')).toBe(3)
    expect(clampIterations('x')).toBe(1)
    expect(clampIterations(2.6)).toBe(3)
  })
})

describe('fusionGate (docs/api-contract.md button rule)', () => {
  test('no conversation / no send turn / incomplete send -> disabled', () => {
    expect(fusionGate({ conversation: null, slotConfig: SLOT_CONFIG, streams: idle }).enabled).toBe(false)
    expect(fusionGate({ conversation: conversation([]), slotConfig: SLOT_CONFIG, streams: idle })).toMatchObject({ enabled: false, reason: 'no send turn yet' })
    const incomplete = conversation([sendTurn('s1', { claude: 'a', chatgpt: null, grok: 'c' })])
    expect(fusionGate({ conversation: incomplete, slotConfig: SLOT_CONFIG, streams: idle })).toMatchObject({ enabled: false, reason: 'latest send turn is incomplete' })
  })

  test('complete send with no ok analyze -> enabled with autoAnalyze', () => {
    expect(fusionGate({ conversation: conversation([sendTurn()]), slotConfig: SLOT_CONFIG, streams: idle })).toEqual({ enabled: true, reason: null, autoAnalyze: true, standing: null })
    // a degraded analyze is not an ok analyze: the backend will auto-run Analyze again
    const degraded = conversation([sendTurn(), analyzeTurn('a1', 's1', null, 'degraded')])
    expect(fusionGate({ conversation: degraded, slotConfig: SLOT_CONFIG, streams: idle })).toMatchObject({ enabled: true, autoAnalyze: true })
  })

  test('ok analyze with standing divergences -> enabled; empty standing set -> disabled', () => {
    expect(fusionGate({ conversation: conversation(), slotConfig: SLOT_CONFIG, streams: idle })).toEqual({ enabled: true, reason: null, autoAnalyze: false, standing: ['d1', 'd2'] })
    // the CURRENT slotConfig materiality_min decides, so it matches the next run
    const strict = fusionGate({ conversation: conversation(), slotConfig: { ...SLOT_CONFIG, materiality_min: 'high' }, streams: idle })
    expect(strict).toMatchObject({ enabled: true, standing: ['d1'] })
    const onlyLow = conversation([sendTurn(), analyzeTurn('a1', 's1', { agreements: [], divergences: [EXTRACTION.divergences[2]] })])
    const g = fusionGate({ conversation: onlyLow, slotConfig: SLOT_CONFIG, streams: idle })
    expect(g.enabled).toBe(false)
    expect(g.reason).toMatch(/nothing to fuse/)
    expect(fusionGate({ conversation: onlyLow, slotConfig: { ...SLOT_CONFIG, materiality_min: 'low' }, streams: idle }).enabled).toBe(true)
    const none = conversation([sendTurn(), analyzeTurn('a1', 's1', { agreements: [], divergences: [] })])
    expect(fusionGate({ conversation: none, slotConfig: SLOT_CONFIG, streams: idle }).enabled).toBe(false)
  })

  test('a newer send turn without analyze re-enables (latest send is what counts)', () => {
    const conv = conversation([sendTurn('s1'), analyzeTurn('a1', 's1', { agreements: [], divergences: [] }), sendTurn('s2')])
    expect(fusionGate({ conversation: conv, slotConfig: SLOT_CONFIG, streams: idle })).toMatchObject({ enabled: true, autoAnalyze: true })
  })

  test('any streaming feature disables', () => {
    for (const f of ['send', 'analyze', 'fusion']) {
      const streams = { ...idle, [f]: { status: 'streaming' } }
      expect(fusionGate({ conversation: conversation(), slotConfig: SLOT_CONFIG, streams })).toMatchObject({ enabled: false, reason: 'a stream is running' })
    }
    expect(fusionGate({ conversation: conversation(), slotConfig: SLOT_CONFIG, streams: { ...idle, send: { status: 'done' } } }).enabled).toBe(true)
  })

  test('falls back to the conversation slot_config when the slotConfig slice is null', () => {
    expect(fusionGate({ conversation: conversation(), slotConfig: null, streams: idle }).enabled).toBe(true)
  })

  // 2026-10-15: an Analyze that degraded on SIZE is not auto-re-run by Fusion (it replayed a 16-call
  // condense chain to the same refusal) until a Refactor of that Send gives Analyze a new input.
  // One real message per backend source (backend/features/analyze.py), so each marker is exercised.
  const SIZE_ERRORS = {
    oversize_message: "R2's reply is 31,250 characters, over the 30,000 the analyst can take in one message. Ask that slot again for a shorter answer, or analyze a Send whose replies fit — Triplex will not compare a truncated one.",
    condense_ineffective: "the comparison message would still be 33,196 characters (the condensed replies plus the question) after 2 condense passes, over the 20,000 one analyst message is sized for (the largest block is R2's at 24,963). Condensing did not shorten them enough to compare, and nothing was truncated to force it.",
  }
  const SIZE_BLOCKED = { enabled: false, reason: 'Analyze could not fit these replies into one comparison — run Refactor, then Analyze', autoAnalyze: false, standing: null }
  const degradedWith = (id, ofTurn, error) => ({ ...analyzeTurn(id, ofTurn, null, 'degraded'), error })
  const refactorTurn = (id, ofTurn, status = 'ok') => ({ type: 'refactor', id, ts: '2026-09-07T00:00:02.000Z', slot_config: SLOT_CONFIG, usage: USAGE, of_turn: ofTurn, refactoring: status === 'ok' ? {} : null, status, error: status === 'ok' ? null : 'parse_error', raw_attempts: [] })

  test('a size-degraded Analyze blocks Fusion instead of auto-analyzing (each marker)', () => {
    expect(SIZE_REFUSAL_MARKERS).toEqual(['can take in one message', 'condense passes'])
    for (const [source, error] of Object.entries(SIZE_ERRORS)) {
      const conv = conversation([sendTurn(), degradedWith('a1', 's1', error)])
      expect(fusionGate({ conversation: conv, slotConfig: SLOT_CONFIG, streams: idle }), source).toEqual(SIZE_BLOCKED)
    }
    // the NEWEST analyze of the send decides: a size degrade after a non-size one still blocks
    const twice = conversation([sendTurn(), degradedWith('a1', 's1', 'parse_error: no JSON object found'), degradedWith('a2', 's1', SIZE_ERRORS.condense_ineffective)])
    expect(fusionGate({ conversation: twice, slotConfig: SLOT_CONFIG, streams: idle })).toEqual(SIZE_BLOCKED)
    // …and the other way round: a non-size degrade NEWER than a size one auto-analyzes again
    const later = conversation([sendTurn(), degradedWith('a1', 's1', SIZE_ERRORS.condense_ineffective), degradedWith('a2', 's1', 'not_captured')])
    expect(fusionGate({ conversation: later, slotConfig: SLOT_CONFIG, streams: idle })).toEqual({ enabled: true, reason: null, autoAnalyze: true, standing: null })
  })

  test('an ok Refactor of that Send NEWER than the size degrade re-enables with autoAnalyze', () => {
    const after = conversation([sendTurn(), degradedWith('a1', 's1', SIZE_ERRORS.condense_ineffective), refactorTurn('r1', 's1')])
    expect(fusionGate({ conversation: after, slotConfig: SLOT_CONFIG, streams: idle })).toEqual({ enabled: true, reason: null, autoAnalyze: true, standing: null })
    // an ok Refactor BEFORE the degrade was already Analyze's input: still blocked
    const before = conversation([sendTurn(), refactorTurn('r1', 's1'), degradedWith('a1', 's1', SIZE_ERRORS.condense_ineffective)])
    expect(fusionGate({ conversation: before, slotConfig: SLOT_CONFIG, streams: idle })).toEqual(SIZE_BLOCKED)
    // a degraded Refactor, or an ok one of another Send, changes nothing
    const failed = conversation([sendTurn(), degradedWith('a1', 's1', SIZE_ERRORS.oversize_message), refactorTurn('r1', 's1', 'degraded')])
    expect(fusionGate({ conversation: failed, slotConfig: SLOT_CONFIG, streams: idle })).toEqual(SIZE_BLOCKED)
    const other = conversation([sendTurn(), degradedWith('a1', 's1', SIZE_ERRORS.oversize_message), refactorTurn('r1', 's0')])
    expect(fusionGate({ conversation: other, slotConfig: SLOT_CONFIG, streams: idle })).toEqual(SIZE_BLOCKED)
  })

  test('a degrade for any other reason still auto-analyzes', () => {
    // a condense CALL that failed (condense_failure) is retried, not refused: the cache re-asks only the failed pieces
    for (const error of ['parse_error: no JSON object found', "validation_error: unknown label(s) ['R4']; only R1, R2, R3 exist", 'not_captured', "could not condense R2's reply for the comparison: timeout", null]) {
      const conv = conversation([sendTurn(), degradedWith('a1', 's1', error)])
      expect(fusionGate({ conversation: conv, slotConfig: SLOT_CONFIG, streams: idle })).toEqual({ enabled: true, reason: null, autoAnalyze: true, standing: null })
    }
  })

  test('a size-degraded Analyze of a PREVIOUS Send does not block the latest Send', () => {
    const conv = conversation([sendTurn('s1'), degradedWith('a1', 's1', SIZE_ERRORS.condense_ineffective), sendTurn('s2')])
    expect(fusionGate({ conversation: conv, slotConfig: SLOT_CONFIG, streams: idle })).toEqual({ enabled: true, reason: null, autoAnalyze: true, standing: null })
  })

  test('an ok Analyze wins over a size degrade, newer or older', () => {
    const okStanding = { enabled: true, reason: null, autoAnalyze: false, standing: ['d1', 'd2'] }
    const newer = conversation([sendTurn(), degradedWith('a1', 's1', SIZE_ERRORS.condense_ineffective), analyzeTurn('a2', 's1')])
    expect(fusionGate({ conversation: newer, slotConfig: SLOT_CONFIG, streams: idle })).toEqual(okStanding)
    // a forced re-run that degraded on size: the backend still fuses the newest OK analyze
    const older = conversation([sendTurn(), analyzeTurn('a1', 's1'), degradedWith('a2', 's1', SIZE_ERRORS.condense_ineffective)])
    expect(fusionGate({ conversation: older, slotConfig: SLOT_CONFIG, streams: idle })).toEqual(okStanding)
  })
})

describe('timeline derivation', () => {
  const divs = Object.fromEntries(EXTRACTION.divergences.map((d) => [d.id, d]))

  test('one row per standing id, one cell per round, statuses after each round', () => {
    const rows = buildTimeline(['d1', 'd2'], withRounds([round1, round2]))
    expect(rows.map((r) => r.id)).toEqual(['d1', 'd2'])
    const [d1, d2] = rows
    expect(d1.cells.map((c) => c.status)).toEqual(['resolved', 'resolved'])
    expect(d1.cells[0].exchanges.map((e) => `${e.model}:${e.stance}`)).toEqual(['R1:defend', 'R2:revise', 'R3:defend'])
    expect(d1.cells[1]).toMatchObject({ skipped: true, exchanges: [] })
    expect(d1).toMatchObject({ finalStatus: 'resolved', resolvedRound: 1 })
    expect(d2.cells.map((c) => c.status)).toEqual(['standing', 'standing'])
    expect(d2.cells[1].exchanges.map((e) => e.stance)).toEqual(['defend', 'unavailable'])
    expect(d2).toMatchObject({ finalStatus: 'standing', resolvedRound: null })
    expect(traceText(d1)).toBe('R1 defends → R2 revises → R3 defends → resolved, round 1')
    expect(traceText(d2)).toBe('R1 defends → R3 defends → R1 defends → R3 unavailable → standing, round 2')
  })

  test('an in-progress round has a null status and an open trace', () => {
    const live = [{ ...round1, complete: true }, { round: 2, exchanges: [round2.exchanges[0]], post_round_status: [], changed: false, complete: false }]
    const [d1, d2] = buildTimeline(['d1', 'd2'], live)
    expect(d2.cells[1]).toMatchObject({ status: null, complete: false, skipped: false })
    expect(traceText(d2)).toBe('R1 defends → R3 defends → R1 defends → …')
    expect(d1.cells[1]).toMatchObject({ skipped: true, status: 'resolved' })
    expect(buildTimeline(['d1'], [])[0]).toMatchObject({ cells: [], finalStatus: null })
    expect(traceText(buildTimeline(['d1'], [])[0])).toBe('…')
  })

  test('resolved_unjustified is carried through and flagged revises are marked in the trace', () => {
    const ex = exchange(1, 'd1', 'R2', 'revise', { flagged_unjustified: true, justification: 'You are right, I revise.', persuaded_by: null })
    const rs = withRounds([{ round: 1, exchanges: [{ ...exchange(1, 'd1', 'R1', 'defend') }, ex].map(({ type, round, ...e }) => e), post_round_status: roundDone(1, { d1: 'resolved_unjustified' }, true).post_round_status, changed: true }])
    const [row] = buildTimeline(['d1'], rs)
    expect(row).toMatchObject({ finalStatus: 'resolved_unjustified', resolvedRound: 1 })
    expect(traceText(row)).toBe('R1 defends → R2 revises (unjustified) → resolved_unjustified, round 1')
  })

  test('latest claim / justification follow the most recent revise / spoken exchange', () => {
    const rs = withRounds([round1, round2])
    expect(latestClaim(rs, divs.d1, 'R2')).toBe('revised claim of R2 on d1 (r1)')
    expect(latestClaim(rs, divs.d1, 'R1')).toBe('2000 deg/s')
    expect(latestJustification(rs, divs.d2, 'R1')).toBe('R1 defends d2 in round 2 with datasheet specifics.')
    // R3 was unavailable in round 2: its round-1 justification is the latest spoken one
    expect(latestJustification(rs, divs.d2, 'R3')).toBe('R3 defends d2 in round 1 with datasheet specifics.')
    // no exchange at all: evidence_cited, else "(none given)"
    expect(latestJustification([], divs.d2, 'R3')).toBe('register map')
    expect(latestJustification([], divs.d2, 'R1')).toBe('(none given)')
    expect(latestClaim([], divs.d3, 'R1')).toBeNull()
  })

  test('usage summary shows tokens / $ / ms / calls', () => {
    expect(usageSummary(USAGE)).toBe('1540 tokens (1200 in / 340 out) · $0.0123 · 4200 ms · 7 calls')
    expect(usageSummary({ totals: { prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 3, cost_usd: 0.000123, latency_ms: 9, calls: 1 } })).toBe('3 tokens (1 in / 2 out / 3 reasoning) · $0.00012 · 9 ms · 1 calls')
    expect(usageSummary(null)).toBe('0 tokens (0 in / 0 out) · $0.0000 · 0 ms · 0 calls')
  })
})
