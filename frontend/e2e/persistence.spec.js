import { expect, test } from '@playwright/test'
import { IDENTITY_RE, PROMPTS, SCENARIO, SLOTS, runAnalyze, runFusion, selectedRow, sendPrompt, snap } from './helpers.js'

// Persistence (planted_factual): after Send -> Analyze -> Fusion, a reload drops the selection;
// re-selecting the conversation in the sidebar restores the threads (fusion messages marked),
// the Analyze report and the Fusion timeline from the persisted document alone.
// Default run: `npx playwright test e2e/persistence.spec.js`.
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

test('threads, the Analyze report and the Fusion timeline are restored after a reload', async ({ page }) => {
  await page.goto('/')
  const id = await sendPrompt(page, PROMPTS.planted_factual, { expectText: 'deg/s' })
  await runAnalyze(page)
  await runFusion(page, 2)
  await expect(page.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'converged')
  for (const slot of SLOTS) await expect(page.getByTestId(`slot-${slot}-fusion-label`)).toHaveCount(2)

  // Snapshot what the live session shows.
  const threadsBefore = {}
  for (const slot of SLOTS) threadsBefore[slot] = await page.getByTestId(`slot-${slot}-thread`).innerText()
  const reportBefore = await page.getByTestId('analyze-report').innerText()
  const timelineBefore = await page.getByTestId('fusion-timeline').innerText()
  const finalBefore = await page.getByTestId('fusion-final').innerText()
  const title = await selectedRow(page).getByTestId('conv-title').innerText()
  expect(title).toBe(PROMPTS.planted_factual.slice(0, 60).trim()) // auto-title = prompt[:60]

  // --- reload: nothing selected, overlays hidden, the row is listed with its turn count ---
  await page.reload()
  await expect(page.getByTestId('conv-list')).toBeVisible()
  await expect(selectedRow(page)).toHaveCount(0)
  await expect(page.getByTestId('analyze-report')).toHaveCount(0)
  await expect(page.getByTestId('fusion-timeline')).toHaveCount(0)
  await expect(page.getByTestId('slot-claude-thread')).toContainText('No messages yet.')
  const row = page.locator(`[data-testid="conv-row"][data-id="${id}"]`)
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('conv-title')).toHaveText(title)
  await expect(row.getByTestId('conv-meta')).toContainText('3 turns')

  // --- re-select ---
  await row.getByTestId('conv-select').click()
  await expect(row).toHaveAttribute('data-selected', 'true')

  // Threads: the send exchange plus the round-1 challenge and reply in every slot, marked.
  for (const slot of SLOTS) {
    const thread = page.getByTestId(`slot-${slot}-thread`)
    await expect(thread).toContainText('deg/s')
    await expect(thread.locator('[data-kind="chat"]')).toHaveCount(2)
    await expect(thread.locator('[data-kind="fusion_challenge"]')).toHaveCount(1)
    await expect(thread.locator('[data-kind="fusion_reply"]')).toHaveCount(1)
    await expect(thread.getByTestId(`slot-${slot}-fusion-label`)).toHaveCount(2)
    await expect(thread).toContainText('Fusion round 1 · d1')
    await expect(thread).toContainText('"stance"')
    expect(await thread.innerText()).toBe(threadsBefore[slot])
  }
  await expect(page.getByTestId('slot-chatgpt-thread')).toContainText('"revise"')
  await expect(page.getByTestId('slot-claude-effort-badge')).toHaveText('medium')

  // Analyze report, restored from the persisted ok analyze turn (no analyst call).
  await expect(page.getByTestId('analyze')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('analyze-report')).toBeVisible()
  await expect(page.getByTestId('analyze-divergence-d1')).toBeVisible()
  await expect(page.getByTestId('analyze-materiality-d1')).toHaveText('high')
  await expect(page.getByTestId('analyze-not-fused-d2')).toBeVisible()
  await expect(page.getByTestId('analyze-rerun')).toBeVisible()
  await expect(page.getByTestId('analyze-report')).not.toContainText(IDENTITY_RE)
  expect(await page.getByTestId('analyze-report').innerText()).toBe(reportBefore)

  // Fusion timeline + final report, restored from the persisted fusion turn.
  await expect(page.getByTestId('fusion-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('fusion-timeline')).toBeVisible()
  await expect(page.getByTestId('fusion-row-d1')).toHaveAttribute('data-final-status', 'resolved')
  await expect(page.getByTestId('fusion-exchange-d1-1-R1')).toHaveAttribute('data-stance', 'defend')
  await expect(page.getByTestId('fusion-exchange-d1-1-R2')).toHaveAttribute('data-stance', 'revise')
  await expect(page.getByTestId('fusion-exchange-d1-1-R3')).toHaveAttribute('data-stance', 'defend')
  await expect(page.getByTestId('fusion-status-d1-1')).toHaveText('resolved')
  await expect(page.getByTestId('fusion-trace-d1')).toHaveText('R1 defends → R2 revises → R3 defends → resolved, round 1')
  await expect(page.getByTestId('fusion-exit-reason')).toHaveAttribute('data-exit-reason', 'converged')
  await expect(page.getByTestId('fusion-final-d1')).toHaveAttribute('data-status', 'resolved')
  await expect(page.getByTestId('fusion-final')).toContainText('convergence, not verified truth')
  await expect(page.getByTestId('fusion-usage')).toBeVisible()
  await expect(page.getByTestId('fusion-timeline')).not.toContainText(IDENTITY_RE)
  expect(await page.getByTestId('fusion-timeline').innerText()).toBe(timelineBefore)
  expect(await page.getByTestId('fusion-final').innerText()).toBe(finalBefore)

  // The meter is recomputed from the persisted turns.
  await expect(page.getByTestId('meter-send-conv-calls')).toHaveText('3')
  await expect(page.getByTestId('meter-analyze-conv-calls')).toHaveText('1')
  await expect(page.getByTestId('meter-fusion-conv-calls')).toHaveText('4')
  await expect(page.getByTestId('meter-fusion-multiplier')).toBeVisible()
  // Buttons follow the restored state: Analyze is cached, Fusion can run again.
  await expect(page.getByTestId('analyze-run')).toBeEnabled()
  await expect(page.getByTestId('fusion-run')).toBeEnabled()
  await expect(page.getByTestId('fusion-gate-hint')).toHaveText('1 standing divergence')
  await snap(page, 'persistence')
})
