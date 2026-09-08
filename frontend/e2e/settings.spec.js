import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, getConversation, lastTurn, newConversation, nextSlotConfigSave, sendPrompt, snap } from './helpers.js'

// Per-column settings (PLAN §7 slot header, R2): the effort selector and the model dropdown in a
// column header change the request that slot sends and the as-run `slot_config` stamped on the
// turn. Default run: `npx playwright test e2e/settings.spec.js` (MOCK_SCENARIO=planted_factual).
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

const optionValues = (select) => select.locator('option').evaluateAll((os) => os.map((o) => o.value))

test('column effort / model changes reach the effort badge, the model label and the persisted turn', async ({ page }) => {
  await page.goto('/')
  const id = await newConversation(page)

  const claudeEffort = page.getByTestId('slot-claude-effort')
  const grokModel = page.getByTestId('slot-grok-model')
  const grokEffort = page.getByTestId('slot-grok-effort')

  // Defaults (backend/config.py DEFAULT_SLOT_CONFIG): claude medium, grok x-ai/grok-4.6.
  await expect(claudeEffort).toHaveValue('medium')
  await expect(grokModel).toHaveValue('x-ai/grok-4.6')
  await expect(grokEffort).toHaveValue('medium')

  // Effort options come from GET /api/models: x-ai/grok-4.6 has mandatory reasoning, so once the
  // catalog is loaded the selector hides "off" (the four-value fallback shows until then).
  await expect(grokModel.locator('option[value="x-ai/grok-4.3"]')).toHaveCount(1)
  await expect(grokEffort.locator('option[value="off"]')).toHaveCount(0)
  expect(await optionValues(grokEffort)).toEqual(['low', 'medium', 'high'])
  // claude-opus-5 can turn reasoning off.
  await expect(claudeEffort.locator('option[value="off"]')).toHaveCount(1)

  // claude -> high (PUT …/slot_config with the merged full config)
  let saved = nextSlotConfigSave(page)
  await claudeEffort.selectOption('high')
  await saved
  await expect(claudeEffort).toHaveValue('high')

  // grok -> x-ai/grok-4.3: reasoning is optional there, so "off" appears; the configured effort
  // (medium) is supported and stays.
  saved = nextSlotConfigSave(page)
  await grokModel.selectOption('x-ai/grok-4.3')
  await saved
  await expect(grokModel).toHaveValue('x-ai/grok-4.3')
  await expect(grokEffort.locator('option[value="off"]')).toHaveCount(1)
  expect(await optionValues(grokEffort)).toEqual(['off', 'low', 'medium', 'high'])
  await expect(grokEffort).toHaveValue('medium')
  await expect(page.getByTestId('slot-grok-config-error')).toHaveCount(0)

  // The stored config already carries both changes.
  const cfgResponse = await page.request.get(`/api/conversations/${id}/slot_config`)
  expect(cfgResponse.ok()).toBeTruthy()
  const cfg = await cfgResponse.json()
  expect(cfg.slots.claude.effort).toBe('high')
  expect(cfg.slots.claude.model).toBe('anthropic/claude-opus-5')
  expect(cfg.slots.grok.model).toBe('x-ai/grok-4.3')
  expect(cfg.slots.grok.effort).toBe('medium')

  // --- Send with the new settings ---
  await sendPrompt(page, PROMPTS.planted_factual, { expectText: 'deg/s' })

  // The chip shows the applied effort (slot_start.effort live, effort_applied after the refetch)
  // and carries the model that answered.
  const claudeBadge = page.getByTestId('slot-claude-effort-badge')
  await expect(claudeBadge).toHaveText('high')
  await expect(claudeBadge).toHaveAttribute('data-coerced', 'false')
  await expect(claudeBadge).toHaveAttribute('title', 'anthropic/claude-opus-5')
  const grokBadge = page.getByTestId('slot-grok-effort-badge')
  await expect(grokBadge).toHaveText('medium')
  await expect(grokBadge).toHaveAttribute('data-coerced', 'false')
  await expect(grokBadge).toHaveAttribute('title', 'x-ai/grok-4.3')
  await expect(page.getByTestId('slot-chatgpt-effort-badge')).toHaveText('medium')
  // The column headers still show the chosen settings after the refetch.
  await expect(claudeEffort).toHaveValue('high')
  await expect(grokModel).toHaveValue('x-ai/grok-4.3')
  await expect(grokEffort).toHaveValue('medium')
  await snap(page, 'settings')

  // --- The persisted turn is stamped with the as-run config ---
  const conv = await getConversation(page, id)
  expect(conv.slot_config.slots.claude.effort).toBe('high')
  expect(conv.slot_config.slots.grok.model).toBe('x-ai/grok-4.3')
  const turn = lastTurn(conv, 'send')
  expect(turn).not.toBeNull()
  expect(turn.slot_config.slots.claude).toEqual({ model: 'anthropic/claude-opus-5', effort: 'high' })
  expect(turn.slot_config.slots.grok).toEqual({ model: 'x-ai/grok-4.3', effort: 'medium' })
  expect(turn.slot_config.slots.chatgpt).toEqual({ model: 'openai/gpt-5.6-sol', effort: 'medium' })
  expect(turn.effort_applied).toEqual({ claude: 'high', chatgpt: 'medium', grok: 'medium' })
  const byRole = Object.fromEntries(turn.usage.calls.map((u) => [u.role, u]))
  expect(byRole.claude.model).toBe('anthropic/claude-opus-5')
  expect(byRole.grok.model).toBe('x-ai/grok-4.3')
  expect(byRole.chatgpt.model).toBe('openai/gpt-5.6-sol')
})
