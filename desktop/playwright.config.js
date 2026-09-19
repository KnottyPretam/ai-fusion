import { defineConfig } from '@playwright/test'

// Two projects (contract §5):
//   adapters — system Chrome against the fake site (the only server a worktree agent may start).
//   app      — Electron app spec; gated by TRIPLEX_E2E_APP=1 (specs call test.skip(!process.env.TRIPLEX_E2E_APP)).
// Playwright's `webServer` list is global, not per project, so the app project's extra servers
// (Vite 5184, backend 8021) are only listed when TRIPLEX_E2E_APP is set: a plain
// `playwright test --project adapters` starts only the fake site.

// Ports are env-overridable so a run can stand beside a Triplex that is already using the
// defaults (the app holds 8021 and, in dev, 5184); nothing changes when they are unset.
const FAKE_PORT = process.env.TRIPLEX_FAKE_PORT || '5199'
const APP = !!process.env.TRIPLEX_E2E_APP
const VITE_PORT = process.env.VITE_PORT || '5184'
const BACKEND_PORT = process.env.TRIPLEX_BACKEND_PORT || process.env.BACKEND_PORT || '8021'
const DATA_DIR = process.env.TRIPLEX_E2E_DATA_DIR || './data/e2e-desktop'

const fakeSite = {
  command: `node test/fake-site/serve.js`,
  url: `http://127.0.0.1:${FAKE_PORT}/health`,
  reuseExistingServer: false,
  timeout: 30_000,
  env: { TRIPLEX_FAKE_PORT: FAKE_PORT },
}

const vite = {
  command: `cd ../frontend && npx vite --port ${VITE_PORT} --strictPort`,
  url: `http://localhost:${VITE_PORT}`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: { BACKEND_PORT, VITE_PORT },
}

const backend = {
  command: `cd .. && .venv/bin/python -m backend.main`,
  url: `http://127.0.0.1:${BACKEND_PORT}/`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: {
    PORT: BACKEND_PORT,
    DATA_DIR,
    TRIPLEX_DESKTOP: '1',
    BRIDGE_TOKEN: 'e2e',
    SLOT_CLAUDE_MODEL: 'web:claude',
    SLOT_CHATGPT_MODEL: 'web:chatgpt',
    SLOT_GROK_MODEL: 'web:grok',
    SLOT_CLAUDE_EFFORT: 'off',
    SLOT_CHATGPT_EFFORT: 'off',
    SLOT_GROK_EFFORT: 'off',
    LOG_LEVEL: 'WARNING',
  },
}

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  webServer: APP ? [fakeSite, vite, backend] : [fakeSite],
  projects: [
    {
      name: 'adapters',
      testDir: 'test/adapters',
      use: {
        channel: 'chrome',
        headless: true,
        baseURL: `http://127.0.0.1:${FAKE_PORT}`,
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'app',
      testDir: 'test/app',
      use: { trace: 'retain-on-failure' },
    },
  ],
})
