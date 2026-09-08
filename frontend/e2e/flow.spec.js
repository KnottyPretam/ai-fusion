import { expect, test } from '@playwright/test'
import { IDENTITY_RE, PROMPTS, SCENARIO, shot } from './helpers.js'

// Integrator flow (Stage 3): Send -> Analyze -> Fusion -> solo continue, in mock mode
// (MOCK_SCENARIO=planted_factual, R1=claude R2=chatgpt R3=grok; d1 resolves in round 1).
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

const PROMPT = PROMPTS.planted_factual

test('send, analyze, fuse, continue', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('send-composer')).toBeVisible()

  // --- Send ---
  await page.getByTestId('send-composer').fill(PROMPT)
  await page.getByTestId('send-button').click()
  for (const slot of ['claude', 'chatgpt', 'grok']) {
    await expect(page.getByTestId(`slot-${slot}-thread`)).toContainText('deg/s', { timeout: 30_000 })
  }
  await expect(page.getByTestId('analyze-run')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByTestId('meter-row-send')).toBeVisible()
  await page.screenshot(shot('01-send'))

  // --- Analyze ---
  await page.getByTestId('analyze-run').click()
  await expect(page.getByTestId('analyze-report')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('analyze-divergence-d1')).toBeVisible()
  await expect(page.getByTestId('analyze-materiality-d1')).toContainText(/high/i)
  await expect(page.getByTestId('analyze-report')).not.toContainText(IDENTITY_RE)
  await expect(page.getByTestId('meter-row-analyze')).toBeVisible()
  await page.screenshot(shot('02-analyze'))

  // --- Fusion (2 iterations) ---
  const iterations = page.getByTestId('fusion-iterations')
  await expect(iterations).toBeVisible()
  await iterations.fill('2')
  await expect(page.getByTestId('fusion-run')).toBeEnabled({ timeout: 10_000 })
  await page.getByTestId('fusion-run').click()
  await expect(page.getByTestId('fusion-exit-reason')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('fusion-exit-reason')).toContainText(/converged/i)
  await expect(page.getByTestId('fusion-row-d1')).toBeVisible()
  await expect(page.getByTestId('fusion-timeline')).not.toContainText(IDENTITY_RE)
  await expect(page.getByTestId('meter-row-fusion')).toBeVisible()
  await expect(page.getByTestId('meter-fusion-multiplier')).toBeVisible()
  // fusion messages are marked in the challenged slots' threads
  await expect(page.getByTestId('slot-chatgpt-thread')).toContainText(/fusion/i)
  await page.screenshot(shot('03-fusion'))

  // --- Solo continue on grok leaves the other columns unchanged ---
  const claudeBefore = await page.getByTestId('slot-claude-thread').innerText()
  await page.getByTestId('slot-grok-composer').fill('Which register selects the range?')
  await page.getByTestId('slot-grok-continue').click()
  await expect(page.getByTestId('slot-grok-thread')).toContainText('Which register selects the range?', { timeout: 30_000 })
  await expect(page.getByTestId('analyze-run')).toBeEnabled({ timeout: 15_000 })
  expect(await page.getByTestId('slot-claude-thread').innerText()).toBe(claudeBefore)
  await page.screenshot(shot('04-continue'))
})
