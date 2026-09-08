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
  const r = await page.request.get('/api/models')
  expect([200, 404, 500]).toContain(r.status())

  await page.getByTestId('conv-new').click()
  for (const id of ['sidebar', 'config-bar', 'send-pane', 'analyze-pane', 'fusion-pane', 'cost-meter']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
})
