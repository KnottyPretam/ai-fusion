import { expect, test } from '@playwright/test'
import { IDENTITY_RE, LABELS, PROMPTS, SCENARIO, getConversation, lastTurn, runAnalyze, runFusion, sendPrompt, snap } from './helpers.js'

// MOCK_SCENARIO=stalemate (docs/fixtures.md): d1 high, round 1 all-defend -> exit `stalemate`
// after round 1 with NO analyst convergence call; the standing item shows every side's
// justification (PLAN §8 Phase 4 AC: "a planted stalemate exits ... with standing status and both
// justifications shown"). Run on its own ports:
//   MOCK_SCENARIO=stalemate BACKEND_PORT=8012 VITE_PORT=5175 npx playwright test e2e/stalemate.spec.js
test.skip(SCENARIO !== 'stalemate', 'needs MOCK_SCENARIO=stalemate')

test('an all-defend round exits as stalemate with every side still standing', async ({ page }) => {
  await page.goto('/')
  const id = await sendPrompt(page, PROMPTS.stalemate, { expectText: 'filter' })

  await runAnalyze(page)
  await expect(page.getByTestId('analyze-divergence-d1')).toBeVisible()
  await expect(page.getByTestId('analyze-materiality-d1')).toHaveText('high')
  await expect(page.getByTestId('analyze-divergence-d1')).toHaveAttribute('data-fused', 'yes')
  await expect(page.getByTestId('fusion-gate-hint')).toHaveText('1 standing divergence')

  await runFusion(page, 2)

  // Exit reason and the single round column: the loop stopped after round 1 of 2.
  const exit = page.getByTestId('fusion-exit-reason')
  await expect(exit).toHaveAttribute('data-exit-reason', 'stalemate')
  await expect(exit).toContainText(/stalemate/i)
  await expect(page.getByTestId('fusion-final')).toContainText('1 of 2 rounds')
  await expect(page.getByTestId('fusion-round-head-1')).toBeVisible()
  await expect(page.getByTestId('fusion-round-head-2')).toHaveCount(0)

  // All-defend cells.
  for (const label of LABELS) {
    const cell = page.getByTestId(`fusion-exchange-d1-1-${label}`)
    await expect(cell).toBeVisible()
    await expect(cell).toHaveAttribute('data-stance', 'defend')
    await expect(cell).toContainText(`${label} defends`)
  }
  await expect(page.getByTestId('fusion-flag-unjustified')).toHaveCount(0)
  await expect(page.getByTestId('fusion-status-d1-1')).toHaveText('standing')
  await expect(page.getByTestId('fusion-trace-d1')).toHaveText('R1 defends → R2 defends → R3 defends → standing, round 1')
  await expect(page.getByTestId('fusion-row-d1')).toHaveAttribute('data-final-status', 'standing')

  // The standing item is called out with each side's latest justification (never averaged).
  const final = page.getByTestId('fusion-final-d1')
  await expect(final).toHaveAttribute('data-status', 'standing')
  await expect(final).toContainText('standing')
  await expect(page.getByTestId('fusion-sides-d1')).toBeVisible()
  await expect(page.getByTestId('fusion-side-d1-R1')).toContainText('the EKF\'s adaptive covariance buys little')
  await expect(page.getByTestId('fusion-side-d1-R2')).toContainText('the covariance also carries the gyro-bias uncertainty')
  await expect(page.getByTestId('fusion-side-d1-R3')).toContainText('it does not remove tuning, it relocates it')
  await expect(page.getByTestId('fusion-timeline')).not.toContainText(IDENTITY_RE)
  await expect(page.getByTestId('fusion-final')).not.toContainText(IDENTITY_RE)
  await snap(page, 'stalemate')

  // Persisted FusionTurn: one round, nothing changed, no convergence call (3 defense calls only).
  const conv = await getConversation(page, id)
  const fusion = lastTurn(conv, 'fusion')
  expect(fusion).not.toBeNull()
  expect(fusion.exit_reason).toBe('stalemate')
  expect(fusion.max_iterations).toBe(2)
  expect(fusion.standing).toEqual(['d1'])
  expect(fusion.rounds).toHaveLength(1)
  expect(fusion.rounds[0].changed).toBe(false)
  expect(fusion.rounds[0].exchanges.map((e) => [e.model, e.stance])).toEqual([
    ['R1', 'defend'],
    ['R2', 'defend'],
    ['R3', 'defend'],
  ])
  expect(fusion.rounds[0].post_round_status).toEqual([{ divergence_id: 'd1', status: 'standing' }])
  expect(fusion.final).toEqual([{ divergence_id: 'd1', status: 'standing' }])
  expect(fusion.usage.totals.calls).toBe(3)
  expect(fusion.usage.calls.map((u) => u.purpose)).toEqual(['defense', 'defense', 'defense'])
  // Every side's justification is on the exchange and rendered in the standing item.
  for (const ex of fusion.rounds[0].exchanges) {
    expect(ex.justification.length).toBeGreaterThan(80)
    await expect(page.getByTestId(`fusion-side-d1-${ex.model}`)).toContainText(ex.justification.slice(0, 60))
  }
  // Challenge + reply were appended to every slot's thread, marked as fusion messages.
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    expect(conv.threads[slot].map((m) => m.kind)).toEqual(['chat', 'chat', 'fusion_challenge', 'fusion_reply'])
    await expect(page.getByTestId(`slot-${slot}-fusion-label`)).toHaveCount(2)
  }
})
