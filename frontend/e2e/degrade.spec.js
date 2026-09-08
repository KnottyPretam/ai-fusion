import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, getConversation, sendPrompt, snap, turnsOf } from './helpers.js'

// MOCK_SCENARIO=analyst_degrade (docs/fixtures.md): both extraction attempts are invalid ->
// `analyze_degraded`; the pane shows the degraded box with the raw attempts and "Fusion disabled";
// an explicit Fusion on that turn is a pre-stream 409, the button's auto-run path ends with the
// documented `error{analyze_degraded}` notice and persists no fusion turn. Run on its own ports:
//   MOCK_SCENARIO=analyst_degrade BACKEND_PORT=8014 VITE_PORT=5177 npx playwright test e2e/degrade.spec.js
test.skip(SCENARIO !== 'analyst_degrade', 'needs MOCK_SCENARIO=analyst_degrade')

test('a doubly invalid extraction degrades Analyze and disables Fusion for that turn', async ({ page }) => {
  await page.goto('/')
  const id = await sendPrompt(page, PROMPTS.analyst_degrade, { expectText: '1000 Hz' })

  // --- Analyze degrades after its single retry ---
  await page.getByTestId('analyze-run').click()
  const degraded = page.getByTestId('analyze-degraded')
  await expect(degraded).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('analyze')).toHaveAttribute('data-status', 'degraded')
  await expect(degraded).toContainText('Analysis degraded.')
  await expect(page.getByTestId('analyze-fusion-disabled')).toHaveText('Fusion disabled for this turn.')
  await expect(page.getByTestId('analyze-report')).toHaveCount(0)
  await expect(page.getByTestId('analyze-error')).toHaveCount(0)
  const attempts = page.getByTestId('analyze-raw-attempts')
  await expect(attempts).toContainText('raw analyst attempts (2)')
  await attempts.locator('summary').click()
  // attempt 1: prose, no JSON object (lenient parse fails); attempt 2: JSON violating the schema
  await expect(page.getByTestId('analyze-raw-attempt-1')).toBeVisible()
  await expect(page.getByTestId('analyze-raw-attempt-1')).toContainText('Here is my comparison of the three reviewers.')
  await expect(page.getByTestId('analyze-raw-attempt-2')).toBeVisible()
  await expect(page.getByTestId('analyze-raw-attempt-2')).toContainText('"Reviewer 1"')
  await expect(page.getByTestId('analyze-raw-attempt-3')).toHaveCount(0)
  await expect(page.getByTestId('analyze-run')).toBeEnabled()
  await expect(page.getByTestId('analyze-rerun')).toBeEnabled()
  await expect(page.getByTestId('meter-analyze-calls')).toHaveText('2')
  await snap(page, 'degrade')

  // --- Fusion button rule (docs/api-contract.md "Derived rules for panes") ---
  // No OK analyze turn exists for the send turn, so the button stays enabled and a run auto-runs
  // Analyze first ...
  const fusionRun = page.getByTestId('fusion-run')
  await expect(fusionRun).toBeEnabled()
  await expect(page.getByTestId('fusion-gate-hint')).toHaveText('will run Analyze first')
  await fusionRun.click()
  // ... which degrades again (sticky-last extraction.2 twice) and ends with the terminal
  // `error{analyze_degraded}`: a documented non-crash end, shown as a notice, no fusion turn.
  const notice = page.getByTestId('fusion-notice')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  await expect(notice).toHaveAttribute('data-notice', 'analyze_degraded')
  await expect(notice).toContainText('Fusion is unavailable for this turn')
  await expect(page.getByTestId('fusion-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('fusion-status')).toHaveText('stopped')
  await expect(page.getByTestId('fusion-error')).toHaveCount(0)
  await expect(page.getByTestId('fusion-timeline')).toHaveCount(0)
  await expect(page.getByTestId('fusion-exit-reason')).toHaveCount(0)
  await expect(page.getByTestId('fusion-final')).toHaveCount(0)
  // The Analyze pane reflects the second degraded attempt; both buttons are usable again.
  await expect(degraded).toBeVisible()
  await expect(page.getByTestId('analyze')).toHaveAttribute('data-status', 'degraded')
  await expect(fusionRun).toBeEnabled()
  await expect(page.getByTestId('analyze-run')).toBeEnabled()
  await expect(page.getByTestId('meter-fusion-calls')).toHaveText('0')
  await expect(page.getByTestId('meter-analyze-conv-calls')).toHaveText('4')
  await expect(page.getByTestId('meter-fusion-multiplier')).toHaveCount(0)

  // --- Persisted state and the explicit-Fusion contract ---
  const conv = await getConversation(page, id)
  const analyzes = turnsOf(conv, 'analyze')
  expect(analyzes).toHaveLength(2)
  for (const t of analyzes) {
    expect(t.status).toBe('degraded')
    expect(t.extraction).toBeNull()
    expect(t.raw_attempts).toHaveLength(2)
    expect(t.error).toBeTruthy()
    expect(t.usage.totals.calls).toBe(2)
  }
  expect(turnsOf(conv, 'fusion')).toHaveLength(0)
  // Explicit Fusion on a degraded analyze turn: pre-stream 409 {detail:{error:"analyze_degraded"}}.
  const r = await page.request.post(`/api/conversations/${id}/fusion`, { data: { of_analyze: analyzes[0].id, max_iterations: 2 } })
  expect(r.status()).toBe(409)
  expect((await r.json()).detail.error).toBe('analyze_degraded')
  expect(turnsOf(await getConversation(page, id), 'fusion')).toHaveLength(0)
})
