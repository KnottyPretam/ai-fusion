import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, getConversation, lastTurn, newConversation, nextSlotConfigSave, sendPrompt, snap } from './helpers.js'

// MOCK_SCENARIO=grounded (docs/fixtures.md): with the config bar's Grounded toggle on, the claude
// reply carries two url_citation annotations -> `slot_citations`, rendered as domain-named links
// in the claude column and persisted on the turn (PLAN §8 Phase 5 AC: "a current-events question
// answers with citations in grounded mode"). Run on its own ports:
//   MOCK_SCENARIO=grounded BACKEND_PORT=8016 VITE_PORT=5179 npx playwright test e2e/grounded.spec.js
test.skip(SCENARIO !== 'grounded', 'needs MOCK_SCENARIO=grounded')

const DATASHEET = 'https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi088-ds001.pdf'
const PRODUCT = 'https://www.bosch-sensortec.com/products/motion-sensors/imus/bmi088/'

test('grounded mode sends with web search and shows citation links in the claude column', async ({ page }) => {
  await page.goto('/')
  const id = await newConversation(page)

  // Toggle Grounded on (PUT …/slot_config {grounded:true}).
  const grounded = page.getByTestId('config-grounded')
  await expect(grounded).not.toBeChecked()
  const saved = nextSlotConfigSave(page)
  await grounded.check()
  await saved
  await expect(grounded).toBeChecked()
  await expect(page.getByTestId('config-error')).toHaveCount(0)
  const cfg = await (await page.request.get(`/api/conversations/${id}/slot_config`)).json()
  expect(cfg.grounded).toBe(true)

  // "zero-rate offset" is in the prompt itself; every planted reply quotes the spec in deg/s.
  await sendPrompt(page, PROMPTS.grounded, { expectText: 'deg/s' })

  // Citation links, named by domain, in the claude column only.
  const cites = page.getByTestId('slot-claude-citations')
  await expect(cites).toBeVisible()
  await expect(cites).toContainText('Citations')
  const links = cites.locator('a')
  await expect(links).toHaveCount(2)
  await expect(links.nth(0)).toHaveText('bosch-sensortec.com')
  await expect(links.nth(0)).toHaveAttribute('href', DATASHEET)
  await expect(links.nth(0)).toHaveAttribute('target', '_blank')
  await expect(links.nth(0)).toHaveAttribute('rel', /noopener/)
  await expect(links.nth(1)).toHaveText('bosch-sensortec.com')
  await expect(links.nth(1)).toHaveAttribute('href', PRODUCT)
  await expect(cites).toContainText('BMI088 Datasheet (BST-BMI088-DS001)')
  await expect(cites).toContainText('BMI088 - Bosch Sensortec')
  await expect(page.getByTestId('citation-unlinked')).toHaveCount(0)
  await expect(page.getByTestId('slot-chatgpt-citations')).toHaveCount(0)
  await expect(page.getByTestId('slot-grok-citations')).toHaveCount(0)
  // The reasoning.text block is shown (collapsible); the encrypted block is ignored.
  await expect(page.getByTestId('slot-claude-reasoning')).toBeVisible()
  await snap(page, 'grounded')

  // Persisted: the turn is stamped grounded, citations live on the turn (never in the thread).
  const conv = await getConversation(page, id)
  expect(conv.slot_config.grounded).toBe(true)
  const turn = lastTurn(conv, 'send')
  expect(turn.slot_config.grounded).toBe(true)
  expect(turn.citations.claude.map((c) => c.url_citation.url)).toEqual([DATASHEET, PRODUCT])
  expect(turn.citations.claude.every((c) => c.type === 'url_citation')).toBe(true)
  expect(turn.citations.chatgpt ?? []).toEqual([])
  expect(turn.citations.grok ?? []).toEqual([])
  expect(JSON.stringify(conv.threads)).not.toContain('url_citation')
  expect(conv.threads.claude).toHaveLength(2)
})
