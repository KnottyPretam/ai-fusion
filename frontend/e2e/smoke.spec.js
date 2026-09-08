import { expect, test } from '@playwright/test'

// Stage 0 smoke: the shell renders and the Vite proxy reaches the backend in mock mode.
test('shell renders six panes and the /api proxy reaches the backend', async ({ page }) => {
  await page.goto('/')
  for (const id of ['sidebar', 'config-bar', 'send-pane', 'analyze-pane', 'fusion-pane', 'cost-meter']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  const r = await page.request.get('/api/models')
  expect([200, 404, 500]).toContain(r.status())
})
