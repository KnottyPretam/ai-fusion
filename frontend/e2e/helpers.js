// Shared helpers for the browser specs (Stage 3, playwright). Not a spec: Playwright only picks
// up *.spec.js / *.test.js under e2e/.
//
// Every spec runs against the servers the frozen playwright.config.js starts (backend on
// BACKEND_PORT with MOCK_OPENROUTER=1 MOCK_SCENARIO=$MOCK_SCENARIO, Vite on VITE_PORT). The
// scenario is fixed per server start, so scenario-specific specs gate themselves with
// `test.skip(SCENARIO !== '<name>')` and are run on their own ports (see each spec's header).
import { expect } from '@playwright/test'

export const SLOTS = ['claude', 'chatgpt', 'grok']
export const LABELS = ['R1', 'R2', 'R3']
export const SCENARIO = process.env.MOCK_SCENARIO || 'planted_factual'

// The user prompt each scenario README documents (the mock never inspects the prompt; using the
// documented one keeps the screenshots coherent with the planted replies).
export const PROMPTS = {
  planted_factual: 'What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?',
  standing_at_cap: 'What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?',
  stalemate:
    'For a 250 g quadrotor flight controller running on a Cortex-M4 at 168 MHz, is a Mahony-style complementary filter or an extended Kalman filter the better choice for attitude estimation?',
  analyst_degrade: 'How should I synchronise the BMI088 accelerometer and gyroscope data-ready interrupts for a 1 kHz attitude estimator?',
  truncated: 'Derive the discrete-time process noise covariance Q for a constant-velocity Kalman filter with sample period T, assuming white acceleration noise.',
  grounded: 'What is the zero-rate offset specification of the BMI088 gyroscope, and where is it documented?',
}

// A leak in the report / timeline would show a vendor or slot name instead of R1/R2/R3.
export const IDENTITY_RE = /claude|chatgpt|grok|openai|anthropic|x-ai/i

// Screenshots land next to the ones the integrator flow already produces (docs/screenshots/).
export const shot = (name) => ({ path: `../docs/screenshots/${name}.png`, fullPage: true })

// The app is 100vh with an internally scrolling main column, so `fullPage` cannot reach the
// Analyze / Fusion panes below the fold: take the shot through a tall viewport, then restore it.
export async function snap(page, name, { height = 1700 } = {}) {
  const prev = page.viewportSize()
  await page.setViewportSize({ width: prev ? prev.width : 1280, height })
  await page.screenshot(shot(name))
  if (prev) await page.setViewportSize(prev)
}

export function selectedRow(page) {
  return page.locator('[data-testid="conv-row"][data-selected="true"]')
}

// Id of the conversation the sidebar marks as selected (the store's `conversation`).
export async function selectedConversationId(page) {
  const row = selectedRow(page)
  await expect(row).toHaveCount(1)
  const id = await row.getAttribute('data-id')
  expect(id).toBeTruthy()
  return id
}

// "+ New conversation": the per-column controls and the config bar stay disabled until a
// conversation exists ("Defaults apply until a conversation exists").
export async function newConversation(page) {
  await page.getByTestId('conv-new').click()
  const id = await selectedConversationId(page)
  await expect(page.getByTestId('slot-claude-model')).toBeEnabled()
  await expect(page.getByTestId('config-grounded')).toBeEnabled()
  return id
}

// Resolves with the next successful PUT …/slot_config response (the column / config-bar saves).
export function nextSlotConfigSave(page) {
  return page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/slot_config') && r.ok())
}

// Type into the main composer and Send. Waits until the turn is persisted and the page settled:
// the Analyze button is enabled only once the refetched send turn has all three responses and no
// stream is running; the composer unlocks once the post-stream refetch settled.
export async function sendPrompt(page, prompt, { expectText = null, timeout = 30_000 } = {}) {
  await page.getByTestId('send-composer').fill(prompt)
  await page.getByTestId('send-button').click()
  if (expectText) {
    for (const slot of SLOTS) await expect(page.getByTestId(`slot-${slot}-thread`)).toContainText(expectText, { timeout })
  }
  await expect(page.getByTestId('analyze-run')).toBeEnabled({ timeout })
  await expect(page.getByTestId('send-composer')).toBeEnabled({ timeout })
  return selectedConversationId(page)
}

export async function runAnalyze(page, { timeout = 30_000 } = {}) {
  await page.getByTestId('analyze-run').click()
  await expect(page.getByTestId('analyze-report')).toBeVisible({ timeout })
  await expect(page.getByTestId('analyze-run')).toBeEnabled({ timeout })
}

// Set the iterations stepper and run Fusion; resolves once the final report is shown.
export async function runFusion(page, iterations, { timeout = 90_000 } = {}) {
  const input = page.getByTestId('fusion-iterations')
  await expect(input).toBeVisible()
  await input.fill(String(iterations))
  await expect(input).toHaveValue(String(iterations))
  await expect(page.getByTestId('fusion-run')).toBeEnabled({ timeout: 10_000 })
  await page.getByTestId('fusion-run').click()
  await expect(page.getByTestId('fusion-exit-reason')).toBeVisible({ timeout })
  await expect(page.getByTestId('fusion-run')).toBeEnabled({ timeout: 15_000 })
}

// The persisted document, through the Vite proxy (same base URL as the page).
export async function getConversation(page, id) {
  const r = await page.request.get(`/api/conversations/${id}`)
  expect(r.ok(), `GET /api/conversations/${id} -> ${r.status()}`).toBeTruthy()
  return r.json()
}

export const turnsOf = (conv, type) => (conv.turns || []).filter((t) => t.type === type)
export const lastTurn = (conv, type) => turnsOf(conv, type).at(-1) ?? null
