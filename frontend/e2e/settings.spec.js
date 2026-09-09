import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, SLOTS, getConversation, lastTurn, newConversation, nextSlotConfigSave, sendPrompt, snap } from './helpers.js'

// Per-column settings (PLAN §7 slot header, R2): the effort selector and the model dropdown in a
// column header change the request that slot sends and the as-run `slot_config` stamped on the
// turn. Default run: `npx playwright test e2e/settings.spec.js` (MOCK_SCENARIO=planted_factual).
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

// backend/config.py DEFAULT_SLOT_CONFIG. A new conversation's config is `settings().default_slot_config`,
// i.e. these defaults plus any `.env` SLOT_<X>_MODEL / _EFFORT override (.env.example), and the frozen
// webServer command does not blank them, so the spec skips unless the stored config is the stock one.
const STOCK = {
  claude: { model: 'anthropic/claude-opus-5', effort: 'medium' },
  chatgpt: { model: 'openai/gpt-5.6-sol', effort: 'medium' },
  grok: { model: 'x-ai/grok-4.6', effort: 'medium' },
}

const optionValues = (select) => select.locator('option').evaluateAll((os) => os.map((o) => o.value))

test('column effort / model changes reach the effort badge, the model label and the persisted turn', async ({ page }) => {
  await page.goto('/')
  const id = await newConversation(page)

  const baseResponse = await page.request.get(`/api/conversations/${id}/slot_config`)
  expect(baseResponse.ok()).toBeTruthy()
  const base = await baseResponse.json()
  test.skip(
    SLOTS.some((s) => base.slots[s].model !== STOCK[s].model || base.slots[s].effort !== STOCK[s].effort),
    `needs the stock slot defaults (.env SLOT_* overrides are set): ${JSON.stringify(base.slots)}`,
  )

  const claudeEffort = page.getByTestId('slot-claude-effort')
  const grokModel = page.getByTestId('slot-grok-model')
  const grokEffort = page.getByTestId('slot-grok-effort')

  // The headers show the stored config: claude medium, grok x-ai/grok-4.6 medium.
  await expect(claudeEffort).toHaveValue(base.slots.claude.effort)
  await expect(grokModel).toHaveValue(base.slots.grok.model)
  await expect(grokEffort).toHaveValue(base.slots.grok.effort)

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
  expect(cfg.slots.claude.model).toBe(base.slots.claude.model)
  expect(cfg.slots.grok.model).toBe('x-ai/grok-4.3')
  expect(cfg.slots.grok.effort).toBe('medium')
  expect(cfg.slots.chatgpt).toEqual(base.slots.chatgpt)

  // --- Send with the new settings ---
  await sendPrompt(page, PROMPTS.planted_factual, { expectText: 'deg/s' })

  // The chip shows the applied effort (slot_start.effort live, effort_applied after the refetch)
  // and carries the model that answered.
  const claudeBadge = page.getByTestId('slot-claude-effort-badge')
  await expect(claudeBadge).toHaveText('high')
  await expect(claudeBadge).toHaveAttribute('data-coerced', 'false')
  await expect(claudeBadge).toHaveAttribute('title', base.slots.claude.model)
  const grokBadge = page.getByTestId('slot-grok-effort-badge')
  await expect(grokBadge).toHaveText('medium')
  await expect(grokBadge).toHaveAttribute('data-coerced', 'false')
  await expect(grokBadge).toHaveAttribute('title', 'x-ai/grok-4.3')
  await expect(page.getByTestId('slot-chatgpt-effort-badge')).toHaveText(base.slots.chatgpt.effort)
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
  expect(turn.slot_config.slots.claude).toEqual({ model: base.slots.claude.model, effort: 'high' })
  expect(turn.slot_config.slots.grok).toEqual({ model: 'x-ai/grok-4.3', effort: 'medium' })
  expect(turn.slot_config.slots.chatgpt).toEqual(base.slots.chatgpt)
  expect(turn.effort_applied).toEqual({ claude: 'high', chatgpt: base.slots.chatgpt.effort, grok: 'medium' })
  const byRole = Object.fromEntries(turn.usage.calls.map((u) => [u.role, u]))
  expect(byRole.claude.model).toBe(base.slots.claude.model)
  expect(byRole.grok.model).toBe('x-ai/grok-4.3')
  expect(byRole.chatgpt.model).toBe(base.slots.chatgpt.model)
})
