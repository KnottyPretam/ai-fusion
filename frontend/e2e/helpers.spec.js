import { expect, test } from '@playwright/test'
import { IDENTITY_RE, assertPublic, getConversation } from './helpers.js'

// Regression tests for the shared helpers. Not scenario-gated: they hold under every server start.

test.describe('IDENTITY_RE mirrors the backend forbidden lists (backend/config.py)', () => {
  test('every vendor, product and slot name trips it, in any case, on word boundaries', () => {
    const names = ['claude', 'ChatGPT', 'grok', 'OpenAI', 'Anthropic', 'xAI', 'x-ai', 'spacexai', 'GPT', 'Opus', 'Sonnet', 'Fable']
    for (const s of names) {
      expect(`R2 (${s}) revised`, s).toMatch(IDENTITY_RE)
      expect(`said ${s}.`, s).toMatch(IDENTITY_RE)
    }
  })

  test('slug code names trip it only in slug context (preceded by "-")', () => {
    for (const s of ['gpt-5.6-sol', 'openai/gpt-5.6-luna', 'gpt-6-astra', 'model -sol here']) expect(s, s).toMatch(IDENTITY_RE)
    for (const s of ['per sol', 'ad astra', 'Luna 9', 'the solar day', 'astral']) expect(s, s).not.toMatch(IDENTITY_RE)
  })

  test('ordinary words that merely contain a name do not trip it', () => {
    for (const s of ['grokking', 'sonnets', 'egregious', 'opuses', 'fabled', 'R1 / R2 / R3 only', 'resolved, round 1']) {
      expect(s, s).not.toMatch(IDENTITY_RE)
    }
  })
})

test('getConversation returns the public document and refuses one that leaks anon_map', async ({ page }) => {
  const created = await page.request.post('/api/conversations', { data: {} })
  expect(created.status()).toBe(201)
  const doc = await created.json()
  expect(doc).not.toHaveProperty('anon_map')
  try {
    // The real document passes the guard ...
    const conv = await getConversation(page, doc.id)
    expect(conv.id).toBe(doc.id)
    expect(conv.threads).toEqual({ claude: [], chatgpt: [], grok: [] })
    // ... and the guard itself rejects a leaked map: this is what every spec's fetch relies on.
    expect(() => assertPublic({ ...conv, anon_map: { R1: 'claude', R2: 'chatgpt', R3: 'grok' } })).toThrow(/anon_map/)
  } finally {
    expect((await page.request.delete(`/api/conversations/${doc.id}`)).status()).toBe(204)
  }
})
