import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, getConversation, lastTurn, runAnalyze, sendPrompt, snap } from './helpers.js'

// MOCK_SCENARIO=truncated (docs/fixtures.md): chatgpt's reply stops with finish_reason "length"
// -> `slot_done{truncated:true}`, the reply is still appended, the column shows the warning and
// the meter counts it (PLAN §8 Phase 5 AC: "a cap-exceeded path truncates gracefully with a
// visible warning"). Run on its own ports:
//   MOCK_SCENARIO=truncated BACKEND_PORT=8015 VITE_PORT=5178 npx playwright test e2e/truncated.spec.js
test.skip(SCENARIO !== 'truncated', 'needs MOCK_SCENARIO=truncated')

test('a length-capped reply is appended with a visible warning and counted by the meter', async ({ page }) => {
  await page.goto('/')
  // "process noise" is in the prompt itself; the state-transition matrix appears only in the
  // three planted replies (sendPrompt checks the persisted assistant messages).
  const id = await sendPrompt(page, PROMPTS.truncated, { expectText: 'Phi = [[1, T], [0, 1]]' })

  // The chatgpt column carries the truncation warning; the other two do not.
  const warn = page.getByTestId('slot-chatgpt-truncated')
  await expect(warn).toBeVisible()
  await expect(warn).toContainText('Output truncated')
  await expect(warn).toContainText('finish_reason = length')
  await expect(page.getByTestId('slot-claude-truncated')).toHaveCount(0)
  await expect(page.getByTestId('slot-grok-truncated')).toHaveCount(0)
  await expect(page.getByTestId('slot-chatgpt-error')).toHaveCount(0)
  // The truncated reply is part of the thread (user + assistant), not an error.
  await expect(page.getByTestId('slot-chatgpt-message')).toHaveCount(2)
  await expect(page.getByTestId('slot-chatgpt-thread')).toContainText('Phi = [[1, T], [0, 1]]')
  // The meter's truncated count.
  await expect(page.getByTestId('meter-truncated')).toHaveText('truncated replies: 1')
  await expect(page.getByTestId('meter-send-calls')).toHaveText('3')
  await snap(page, 'truncated')

  // Persisted turn and thread.
  const conv = await getConversation(page, id)
  const turn = lastTurn(conv, 'send')
  expect(turn.truncated.chatgpt).toBe(true)
  expect(turn.truncated.claude).toBeFalsy()
  expect(turn.truncated.grok).toBeFalsy()
  expect(turn.responses.chatgpt).toBeTruthy()
  expect(turn.errors.chatgpt).toBeUndefined()
  expect(conv.threads.chatgpt).toHaveLength(2)
  expect(conv.threads.chatgpt[1].role).toBe('assistant')
  expect(conv.threads.chatgpt[1].content).toBe(turn.responses.chatgpt)

  // A truncated reply is still a complete send turn: Analyze runs; the only divergence is low
  // materiality (not fused), so Fusion has nothing to do.
  await runAnalyze(page)
  await expect(page.getByTestId('analyze-divergence-d1')).toHaveAttribute('data-fused', 'no')
  await expect(page.getByTestId('analyze-not-fused-d1')).toBeVisible()
  await expect(page.getByTestId('fusion-run')).toBeDisabled()
  await expect(page.getByTestId('fusion-gate-hint')).toContainText('nothing to fuse')
  await expect(page.getByTestId('meter-truncated')).toHaveText('truncated replies: 1')
})
