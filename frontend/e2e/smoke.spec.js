import { expect, test } from '@playwright/test'

// Stage 0 smoke: the shell renders and the Vite proxy reaches the backend in mock mode.
// The Analyze / Fusion panes render nothing until a conversation exists and the frozen layout
// hides an empty section (`.app-analyze:empty, .app-fusion:empty { display: none }` in App.css),
// so they are asserted attached first and visible once "+ New conversation" selected one.
test('shell renders six panes and the /api proxy reaches the backend', async ({ page }) => {
  await page.goto('/')
  for (const id of ['sidebar', 'config-bar', 'send-pane', 'cost-meter']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  for (const id of ['analyze-pane', 'fusion-pane']) {
    await expect(page.getByTestId(id)).toBeAttached()
  }
  // The frozen webServer runs the backend in mock mode, where GET /api/models serves the offline
  // fixture: a bare, non-empty JSON array of ModelMeta (docs/api-contract.md). A 404 (router not
  // mounted) or 500 (backend crashed) is exactly the failure this check exists to catch.
  const r = await page.request.get('/api/models')
  expect(r.status(), 'GET /api/models through the Vite proxy').toBe(200)
  const items = await r.json()
  expect(Array.isArray(items)).toBe(true)
  expect(items.length).toBeGreaterThan(0)
  expect(items[0]).toHaveProperty('id')
  expect(items[0]).toHaveProperty('efforts')

  await page.getByTestId('conv-new').click()
  for (const id of ['sidebar', 'config-bar', 'send-pane', 'analyze-pane', 'fusion-pane', 'cost-meter']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
})
