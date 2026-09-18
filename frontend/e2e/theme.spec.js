import { expect, test } from '@playwright/test'
import { PROMPTS, SCENARIO, SLOTS, messagesOf, runAnalyze, runFusion, snap } from './helpers.js'

// Dark-palette visual check (S7). The desktop shell and the web app share `index.css`, so driving the
// web app in dark exercises every token the desktop chrome uses plus the Analyze / Fusion / meter
// panes. This catches a rule that only ever ran on white — the kind the contrast audit measures but
// cannot see (an element that renders its own background, an icon baked light, an invisible border).
test.skip(SCENARIO !== 'planted_factual', 'needs MOCK_SCENARIO=planted_factual (the default)')

const PROMPT = PROMPTS.planted_factual

/** Every element whose own colours make it unreadable against what is actually behind it. */
async function unreadable(page) {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/)
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
    const ground = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const bg = parse(getComputedStyle(n).backgroundColor)
        if (bg && bg.a > 0.9) return bg
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }
    const bad = []
    for (const el of document.querySelectorAll('button, a, th, td, label, span, p, h1, h2, h3, li, option')) {
      const text = (el.textContent || '').trim()
      if (!text || el.children.length) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
      if (parseFloat(cs.opacity) < 0.5) continue // deliberately de-emphasised (disabled)
      const fg = parse(cs.color)
      if (!fg || fg.a < 0.5) continue
      const c = ratio(fg, ground(el))
      // 3:1 is the large-text floor; anything under it is unreadable at any size.
      if (c < 3) bad.push({ text: text.slice(0, 40), ratio: +c.toFixed(2), color: cs.color, testid: el.getAttribute('data-testid') })
    }
    return bad
  })
}

test('the dark palette is legible across Send, Analyze, Fusion and the meter', async ({ page }) => {
  await page.addInitScript(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.goto('/')
  await expect(page.getByTestId('send-composer')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  // the palette really switched: the page ground is dark, not the light default
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).not.toBe('rgb(255, 255, 255)')

  await page.getByTestId('send-composer').fill(PROMPT)
  await page.getByTestId('send-button').click()
  for (const slot of SLOTS) {
    await expect(messagesOf(page, slot, 'assistant').last()).toContainText('deg/s', { timeout: 30_000 })
  }
  await runAnalyze(page)
  await expect(page.getByTestId('analyze-report')).toBeVisible()
  await runFusion(page, 2)
  await expect(page.getByTestId('fusion-exit-reason')).toBeVisible()

  await snap(page, 'dark-flow')
  const bad = await unreadable(page)
  expect(bad, `unreadable text in dark: ${JSON.stringify(bad, null, 1)}`).toEqual([])
})
