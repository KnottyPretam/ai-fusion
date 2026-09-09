import { expect, test } from '@playwright/test'
import { IDENTITY_RE, PROMPTS, SCENARIO, SLOTS, getConversation, lastTurn, messagesOf, selectedConversationId, shot, snap } from './helpers.js'

// Integrator flow (Stage 3): Send -> Analyze -> Fusion -> solo continue, in mock mode
// (MOCK_SCENARIO=planted_factual, R1=claude R2=chatgpt R3=grok; d1 resolves in round 1).
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

const PROMPT = PROMPTS.planted_factual
const FOLLOW_UP = 'Which register selects the range?'

test('send, analyze, fuse, continue', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('send-composer')).toBeVisible()

  // --- Send ---
  await page.getByTestId('send-composer').fill(PROMPT)
  await page.getByTestId('send-button').click()
  for (const slot of SLOTS) {
    await expect(messagesOf(page, slot, 'assistant').last()).toContainText('deg/s', { timeout: 30_000 })
  }
  await expect(page.getByTestId('analyze-run')).toBeEnabled({ timeout: 15_000 })
  // The meter renders every feature row unconditionally, so the booked call count is the proof.
  await expect(page.getByTestId('meter-send-calls')).toHaveText('3')
  const id = await selectedConversationId(page)
  await page.screenshot(shot('01-send'))

  // --- Analyze ---
  await page.getByTestId('analyze-run').click()
  await expect(page.getByTestId('analyze-report')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('analyze-divergence-d1')).toBeVisible()
  await expect(page.getByTestId('analyze-materiality-d1')).toContainText(/high/i)
  await expect(page.getByTestId('analyze-report')).not.toContainText(IDENTITY_RE)
  await expect(page.getByTestId('meter-analyze-calls')).toHaveText('1')
  await snap(page, '02-analyze')

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
  await expect(page.getByTestId('meter-fusion-calls')).toHaveText('4') // 3 defense + 1 convergence
  await expect(page.getByTestId('meter-fusion-multiplier')).toBeVisible()
  // fusion messages are marked in the challenged slots' threads
  await expect(page.getByTestId('slot-chatgpt-thread')).toContainText(/fusion/i)
  await snap(page, '03-fusion')

  // --- Solo continue on grok: only grok's thread and the persisted document change ---
  // Baseline once the post-Fusion refetch has landed in every column (round-1 challenge + reply),
  // so the grok message count below cannot be reached by that refetch arriving late.
  for (const slot of SLOTS) await expect(page.getByTestId(`slot-${slot}-fusion-label`)).toHaveCount(2)
  await expect(page.getByTestId('fusion-run')).toBeEnabled({ timeout: 15_000 })
  await expect(messagesOf(page, 'grok')).toHaveCount(4)
  const uiBefore = {}
  for (const slot of ['claude', 'chatgpt']) uiBefore[slot] = await page.getByTestId(`slot-${slot}-thread`).innerText()
  const docBefore = await getConversation(page, id)
  expect(docBefore.threads.grok).toHaveLength(4)
  const threadsBefore = { claude: JSON.stringify(docBefore.threads.claude), chatgpt: JSON.stringify(docBefore.threads.chatgpt) }

  await page.getByTestId('slot-grok-composer').fill(FOLLOW_UP)
  await page.getByTestId('slot-grok-continue').click()
  // A plain "grok thread contains the prompt" check is satisfied by the pending bubble the instant
  // the button is clicked, so the reply is proven on the PERSISTED message list instead: the 6th
  // grok message exists only after the post-stream refetch (SendPane loadConversation), and the
  // main composer unlocks only once that refetch settled (SendPane inFlight). The continue reads
  // grok.chat.2, absent in planted_factual, so the sticky grok.chat.1 reply ("deg/s") comes back.
  const grokMsgs = messagesOf(page, 'grok')
  await expect(grokMsgs.nth(5)).toContainText('deg/s', { timeout: 30_000 })
  await expect(page.getByTestId('send-composer')).toBeEnabled({ timeout: 30_000 })
  await expect(page.getByTestId('slot-grok-pending')).toHaveCount(0)
  await expect(page.getByTestId('slot-grok-live')).toHaveCount(0)
  await expect(grokMsgs).toHaveCount(6) // 2 chat + challenge + reply + 2 chat
  await expect(grokMsgs.nth(4)).toHaveAttribute('data-role', 'user')
  await expect(grokMsgs.nth(4)).toHaveAttribute('data-kind', 'chat')
  await expect(grokMsgs.nth(4)).toContainText(FOLLOW_UP)
  await expect(grokMsgs.nth(5)).toHaveAttribute('data-role', 'assistant')
  await expect(grokMsgs.nth(5)).toHaveAttribute('data-kind', 'chat')
  await expect(grokMsgs.nth(5)).toContainText('deg/s')
  // The other two columns are byte-identical to the baseline, on screen ...
  for (const slot of ['claude', 'chatgpt']) expect(await page.getByTestId(`slot-${slot}-thread`).innerText()).toBe(uiBefore[slot])
  // ... and in the persisted document; grok's thread grew by exactly [user, assistant].
  const conv = await getConversation(page, id)
  expect(JSON.stringify(conv.threads.claude)).toBe(threadsBefore.claude)
  expect(JSON.stringify(conv.threads.chatgpt)).toBe(threadsBefore.chatgpt)
  expect(conv.threads.grok).toHaveLength(6)
  expect(conv.threads.grok.slice(0, 4)).toEqual(docBefore.threads.grok)
  expect(conv.threads.grok.at(-2)).toMatchObject({ role: 'user', kind: 'chat', content: FOLLOW_UP })
  expect(conv.threads.grok.at(-1)).toMatchObject({ role: 'assistant', kind: 'chat' })
  expect(conv.threads.grok.at(-1).content).toContain('deg/s')
  const cont = lastTurn(conv, 'continue')
  expect(cont).toMatchObject({ slot: 'grok', prompt: FOLLOW_UP, error: null })
  expect(cont.response).toContain('deg/s')
  expect(conv.turns.at(-1).id).toBe(cont.id)
  expect(conv.threads.grok.at(-1)).toMatchObject({ turn_id: cont.id, content: cont.response })
  // The continue is booked under the Send row (last invocation = 1 call; 3 + 1 for the conversation).
  await expect(page.getByTestId('meter-send-calls')).toHaveText('1')
  await expect(page.getByTestId('meter-send-conv-calls')).toHaveText('4')
  await expect(page.getByTestId('analyze-run')).toBeEnabled()
  await snap(page, '04-continue')
})
