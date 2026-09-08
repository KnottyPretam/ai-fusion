import { defineConfig } from '@playwright/test'

// Uses the system Google Chrome (channel: 'chrome') — no `playwright install` needed.
// Dedicated ports so a running dev server (8001/5173) is never reused.
const BACKEND_PORT = process.env.BACKEND_PORT || '8011'
const VITE_PORT = process.env.VITE_PORT || '5174'
const SCENARIO = process.env.MOCK_SCENARIO || 'planted_factual'
const DELAY = process.env.MOCK_DELAY_MS || '20'
const HOME = process.env.HOME

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: `http://localhost:${VITE_PORT}`, channel: 'chrome', headless: true, trace: 'retain-on-failure' },
  webServer: [
    {
      command: `cd .. && PATH=${HOME}/.local/bin:$PATH MOCK_OPENROUTER=1 MOCK_SCENARIO=${SCENARIO} MOCK_DELAY_MS=${DELAY} PORT=${BACKEND_PORT} DATA_DIR=./data/e2e-${BACKEND_PORT} LOG_LEVEL=WARNING uv run python -m backend.main`,
      url: `http://127.0.0.1:${BACKEND_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `BACKEND_PORT=${BACKEND_PORT} VITE_PORT=${VITE_PORT} npx vite --port ${VITE_PORT} --strictPort`,
      url: `http://localhost:${VITE_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
