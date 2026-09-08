import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, SLOTS, getConversation, lastTurn, runAnalyze, runFusion, selectedConversationId, snap } from './helpers.js'

// Streaming guard + meter (planted_factual). While a Send streams, the sidebar's New / select /
// delete and every composer are locked; they re-enable when the stream ends. After Analyze and
// Fusion the meter shows the three feature rows with Fusion's multiplier vs the fused Send.
// Recommended run (paced replay so the locked state is also visible by eye in the trace):
//   MOCK_DELAY_MS=200 BACKEND_PORT=8017 VITE_PORT=5180 npx playwright test e2e/guard.spec.js
// The lock assertions do not depend on the pacing: the spec holds the send response for HOLD_MS
// before handing it to the page, so they pass at the default MOCK_DELAY_MS too.
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

const HOLD_MS = 1500
const SEND_URL = '**/api/conversations/*/send'

test('sidebar and composers lock while a send streams; the meter books all three features', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('conv-new')).toBeEnabled()

  // Fetch the reply in full, then hold it: `sse/start` is dispatched before the fetch, so the
  // page is in the streaming state for at least HOLD_MS regardless of MOCK_DELAY_MS.
  await page.route(SEND_URL, async (route) => {
    const response = await route.fetch()
    const body = await response.body()
    await new Promise((r) => setTimeout(r, HOLD_MS))
    await route.fulfill({ response, body })
  })

  await page.getByTestId('send-composer').fill(PROMPTS.planted_factual)
  await page.getByTestId('send-button').click()

  // --- locked ---
  await expect(page.getByTestId('conv-busy-hint')).toBeVisible()
  await expect(page.getByTestId('conv-busy-hint')).toHaveText('a stream is running')
  await expect(page.getByTestId('conv-new')).toBeDisabled()
  await expect(page.getByTestId('conv-select').first()).toBeDisabled()
  await expect(page.getByTestId('conv-delete').first()).toBeDisabled()
  await expect(page.getByTestId('send-composer')).toBeDisabled()
  await expect(page.getByTestId('send-button')).toBeDisabled()
  await expect(page.getByTestId('send-button')).toHaveText('Streaming…')
  for (const slot of SLOTS) {
    await expect(page.getByTestId(`slot-${slot}-composer`)).toBeDisabled()
    await expect(page.getByTestId(`slot-${slot}-continue`)).toBeDisabled()
    await expect(page.getByTestId(`slot-${slot}-pending`)).toHaveText(PROMPTS.planted_factual)
  }
  await expect(page.getByTestId('analyze-run')).toBeDisabled()
  await expect(page.getByTestId('analyze-hint')).toBeVisible() // "send a prompt first": no send turn is persisted yet
  await expect(page.getByTestId('fusion-run')).toBeDisabled()
  await snap(page, 'guard')
  const id = await selectedConversationId(page)

  // --- unlocked once the stream ends and the refetch settled ---
  await expect(page.getByTestId('conv-busy-hint')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('conv-new')).toBeEnabled()
  await expect(page.getByTestId('conv-select').first()).toBeEnabled()
  await expect(page.getByTestId('conv-delete').first()).toBeEnabled()
  await expect(page.getByTestId('send-composer')).toBeEnabled({ timeout: 15_000 })
  for (const slot of SLOTS) {
    await expect(page.getByTestId(`slot-${slot}-composer`)).toBeEnabled()
    await expect(page.getByTestId(`slot-${slot}-thread`)).toContainText('deg/s')
    await expect(page.getByTestId(`slot-${slot}-pending`)).toHaveCount(0)
  }
  await expect(page.getByTestId('analyze-run')).toBeEnabled()
  await page.unroute(SEND_URL)

  // The Send row is booked (3 calls); Analyze / Fusion rows are still empty.
  await expect(page.getByTestId('meter-send-calls')).toHaveText('3')
  await expect(page.getByTestId('meter-analyze-calls')).toHaveText('0')
  await expect(page.getByTestId('meter-fusion-calls')).toHaveText('0')
  await expect(page.getByTestId('meter-fusion-multiplier')).toHaveCount(0)

  // --- Analyze + Fusion: three feature rows and the multiplier badge ---
  await runAnalyze(page)
  await expect(page.getByTestId('meter-analyze-calls')).toHaveText('1')
  await runFusion(page, 2)
  await expect(page.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'converged')
  for (const name of ['send', 'analyze', 'fusion']) {
    await expect(page.getByTestId(`meter-row-${name}`)).toBeVisible()
    await expect(page.getByTestId(`meter-${name}-cost`)).not.toHaveText(/^\$0$/)
    await expect(page.getByTestId(`meter-${name}-conv-cost`)).not.toHaveText(/^\$0$/)
  }
  await expect(page.getByTestId('meter-send-calls')).toHaveText('3')
  await expect(page.getByTestId('meter-analyze-calls')).toHaveText('1')
  await expect(page.getByTestId('meter-fusion-calls')).toHaveText('4')
  await expect(page.getByTestId('meter-row-total')).toBeVisible()
  await expect(page.getByTestId('meter-total-conv-calls')).toHaveText('8')
  const mult = page.getByTestId('meter-fusion-multiplier')
  await expect(mult).toBeVisible()
  await expect(mult).toHaveText(/^×\d+\.\d vs Send$/)
  await snap(page, 'guard-meter')

  // The badge is the last Fusion's cost over the cost of the Send it fused.
  const conv = await getConversation(page, id)
  const send = lastTurn(conv, 'send')
  const fusion = lastTurn(conv, 'fusion')
  const expected = (fusion.usage.totals.cost_usd / send.usage.totals.cost_usd).toFixed(1)
  await expect(mult).toHaveText(`×${expected} vs Send`)
  expect(fusion.usage.totals.calls).toBe(4)
})
