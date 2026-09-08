import { expect, test } from '@playwright/test'
import { IDENTITY_RE, LABELS, PROMPTS, SCENARIO, getConversation, lastTurn, runAnalyze, runFusion, sendPrompt, snap } from './helpers.js'

// MOCK_SCENARIO=standing_at_cap (docs/fixtures.md): every round R2 re-words a justified revise,
// the analyst keeps d1 standing, so with the stepper at 5 the loop runs to the cap and exits
// `max_iterations` with d1 still standing. Run on its own ports:
//   MOCK_SCENARIO=standing_at_cap BACKEND_PORT=8013 VITE_PORT=5176 npx playwright test e2e/cap.spec.js
test.skip(SCENARIO !== 'standing_at_cap', 'needs MOCK_SCENARIO=standing_at_cap')

test('five iterations run to the cap and exit max_iterations with d1 standing', async ({ page }) => {
  await page.goto('/')
  const id = await sendPrompt(page, PROMPTS.standing_at_cap, { expectText: 'deg/s' })
  await runAnalyze(page)
  await expect(page.getByTestId('analyze-divergence-d1')).toHaveAttribute('data-fused', 'yes')
  await expect(page.getByTestId('analyze-not-fused-d2')).toBeVisible()

  // The stepper is clamped to 1..5; "+" is disabled at the cap.
  await runFusion(page, 5)
  await expect(page.getByTestId('fusion-iterations')).toHaveValue('5')
  await expect(page.getByTestId('fusion-iterations-inc')).toBeDisabled()

  const exit = page.getByTestId('fusion-exit-reason')
  await expect(exit).toHaveAttribute('data-exit-reason', 'max_iterations')
  await expect(exit).toContainText(/max iterations/i)
  await expect(page.getByTestId('fusion-final')).toContainText('5 of 5 rounds')

  // Five round columns; every round R1/R3 defend and R2 revises (justified), status standing.
  await expect(page.locator('[data-testid^="fusion-round-head-"]')).toHaveCount(5)
  for (let n = 1; n <= 5; n++) {
    await expect(page.getByTestId(`fusion-round-head-${n}`)).toHaveText(`round ${n}`)
    await expect(page.getByTestId(`fusion-exchange-d1-${n}-R1`)).toHaveAttribute('data-stance', 'defend')
    await expect(page.getByTestId(`fusion-exchange-d1-${n}-R2`)).toHaveAttribute('data-stance', 'revise')
    await expect(page.getByTestId(`fusion-exchange-d1-${n}-R3`)).toHaveAttribute('data-stance', 'defend')
    await expect(page.getByTestId(`fusion-status-d1-${n}`)).toHaveText('standing')
  }
  await expect(page.getByTestId('fusion-round-head-6')).toHaveCount(0)
  await expect(page.getByTestId('fusion-flag-unjustified')).toHaveCount(0)
  await expect(page.getByTestId('fusion-trace-d1')).toContainText('standing, round 5')
  await expect(page.getByTestId('fusion-row-d1')).toHaveAttribute('data-final-status', 'standing')

  // Final standing, with both sides' latest justifications.
  await expect(page.getByTestId('fusion-final-d1')).toHaveAttribute('data-status', 'standing')
  for (const label of LABELS) await expect(page.getByTestId(`fusion-side-d1-${label}`)).toBeVisible()
  await expect(page.getByTestId('fusion-side-d1-R1')).toContainText('2000 deg/s the power-on default')
  await expect(page.getByTestId('fusion-not-fused')).toContainText('d2')
  await expect(page.getByTestId('fusion-timeline')).not.toContainText(IDENTITY_RE)
  await expect(page.getByTestId('fusion-final')).not.toContainText(IDENTITY_RE)
  await snap(page, 'cap')

  // Persisted FusionTurn: 5 rounds x (3 defense + 1 convergence) calls, d1 never resolved.
  const conv = await getConversation(page, id)
  const fusion = lastTurn(conv, 'fusion')
  expect(fusion).not.toBeNull()
  expect(fusion.max_iterations).toBe(5)
  expect(fusion.exit_reason).toBe('max_iterations')
  expect(fusion.standing).toEqual(['d1'])
  expect(fusion.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4, 5])
  for (const r of fusion.rounds) {
    expect(r.changed).toBe(true)
    expect(r.post_round_status).toEqual([{ divergence_id: 'd1', status: 'standing' }])
    expect(r.exchanges.map((e) => [e.model, e.stance, e.flagged_unjustified])).toEqual([
      ['R1', 'defend', false],
      ['R2', 'revise', false],
      ['R3', 'defend', false],
    ])
  }
  expect(fusion.final).toEqual([{ divergence_id: 'd1', status: 'standing' }])
  expect(fusion.usage.totals.calls).toBe(20)
  expect(fusion.usage.calls.filter((u) => u.purpose === 'convergence')).toHaveLength(5)
  // The standing item shows R2's LATEST revised claim and justification (round 5).
  const r2 = fusion.rounds[4].exchanges.find((e) => e.model === 'R2')
  await expect(page.getByTestId('fusion-side-d1-R2')).toContainText(r2.revised_claim)
  await expect(page.getByTestId('fusion-side-d1-R2')).toContainText(r2.justification.slice(0, 60))
  // Each slot's thread got one challenge + reply per round.
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    expect(conv.threads[slot].filter((m) => m.kind === 'fusion_reply')).toHaveLength(5)
    await expect(page.getByTestId(`slot-${slot}-fusion-label`)).toHaveCount(10)
  }
})
