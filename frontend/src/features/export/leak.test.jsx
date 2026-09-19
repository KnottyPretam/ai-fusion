// LEAK GATE for the export control (binding decision, 2026-09-18): an Analyze or Fusion export is
// R1 / R2 / R3 only and must never reveal which slot is which; a Send export may name the columns
// because the Send columns are labelled Claude / ChatGPT / Grok on screen.
//
// What the renderer can leak is (a) what it renders next to the control and (b) what it puts in the
// export request. It can never leak the mapping itself — `to_public` strips `anon_map` from every
// response — so this file also plants a hostile conversation document that DOES carry one and
// proves nothing of it reaches the IPC payload or the export URL.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyzePane from '../analyze/index.jsx'
import FusionPane from '../fusion/index.jsx'
import SendPane from '../send/index.jsx'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import * as analyzeFx from '../analyze/fixtures.js'
import * as fusionFx from '../fusion/fixtures.js'
import { defaultBaseName, fileNameFor } from './formats.js'
import { exportPath } from './runExport.js'

// tests/helpers.py find_identity_leaks in spirit: vendors, products, slot ids and the slug code
// names the backend also forbids.
const IDENTITY = /\b(claude|chatgpt|gpt|grok|anthropic|openai|x-?ai|gemini|google)\b|-(luna|sol|astra)\b|anon_?map/i

const ANON_MAP = { R1: 'claude', R2: 'chatgpt', R3: 'grok' }
const PLANTED = { anon_map: ANON_MAP } // a document shaped like the PRIVATE conversation, never served

let exportTurn
beforeEach(() => {
  exportTurn = vi.fn(async () => ({ paths: ['/home/u/Documents/triplex-report.md'], cancelled: false }))
  vi.stubGlobal('triplex', { version: '0.1.0', slots: ['claude', 'chatgpt', 'grok'], exportTurn })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function scan(el) {
  // innerHTML, so title attributes and aria labels are scanned too, not just visible text.
  return el.innerHTML
}

async function runFrom(feature, format = 'all') {
  await userEvent.click(screen.getByTestId(`export-${feature}`))
  const menuHtml = scan(screen.getByTestId(`export-menu-${feature}`))
  await userEvent.click(screen.getByTestId(`export-format-${format}`))
  await waitFor(() => expect(exportTurn).toHaveBeenCalled())
  return { menuHtml, payload: exportTurn.mock.calls[0][0] }
}

describe('the export control never reveals which slot is which', () => {
  test('Analyze: the control, its menu, the request and the file name are label-free', async () => {
    const conv = analyzeFx.conversation([analyzeFx.sendTurn()], PLANTED)
    const state = applyEvents('analyze', [analyzeFx.events.loaded(conv), analyzeFx.events.done(analyzeFx.analyzeTurn())])
    const { container } = renderWithStore(<AnalyzePane />, { preloaded: state })

    const { menuHtml, payload } = await runFrom('analyze')
    expect(menuHtml).not.toMatch(IDENTITY)
    expect(scan(container)).not.toMatch(IDENTITY)
    expect(JSON.stringify(payload)).not.toMatch(IDENTITY)
    expect(Object.keys(payload).sort()).toEqual(['conversationId', 'formats', 'title', 'turnId', 'turnType'])
    expect(payload).toMatchObject({ turnId: 'a1', turnType: 'analyze', title: 'Test conversation' })
    // the report itself is R-labelled, as before the control existed
    expect(screen.getByTestId('analyze-report').textContent).toMatch(/R1|R2|R3/)
    expect(scan(screen.getByTestId('analyze-report'))).not.toMatch(IDENTITY)
  })

  test('Fusion: the control, its menu, the request and the file name are label-free', async () => {
    const conv = fusionFx.conversation()
    const state = applyEvents('fusion', [{ type: 'conversation/loaded', conversation: { ...conv, ...PLANTED } }, ...fusionFx.fullRun()])
    const { container } = renderWithStore(<FusionPane />, { preloaded: state })

    const { menuHtml, payload } = await runFrom('fusion')
    expect(menuHtml).not.toMatch(IDENTITY)
    expect(scan(container)).not.toMatch(IDENTITY)
    expect(JSON.stringify(payload)).not.toMatch(IDENTITY)
    expect(payload).toMatchObject({ conversationId: 'c1', turnId: 'f1', formats: ['md', 'html', 'pdf'] })
    expect(scan(screen.getByTestId('export-fusion').parentElement)).not.toMatch(IDENTITY)
    expect(screen.getByTestId('fusion-timeline').textContent).toMatch(/R1|R2|R3/)
  })

  test('the result line names files, never models', async () => {
    exportTurn = vi.fn(async () => ({ paths: ['/home/u/Documents/triplex-test-conversation-fusion-f1.md', '/home/u/Documents/triplex-test-conversation-fusion-f1.pdf'] }))
    vi.stubGlobal('triplex', { exportTurn })
    const state = applyEvents('fusion', [{ type: 'conversation/loaded', conversation: fusionFx.conversation() }, ...fusionFx.fullRun()])
    renderWithStore(<FusionPane />, { preloaded: state })
    await runFrom('fusion')
    const line = await screen.findByTestId('export-fusion-result')
    expect(line.textContent).toBe('Wrote triplex-test-conversation-fusion-f1.md, triplex-test-conversation-fusion-f1.pdf')
    expect(scan(line)).not.toMatch(IDENTITY)
  })

  test('the browser URL carries two ids and a format, so a proxy log cannot see a slot either', () => {
    for (const [turn, format] of [
      ['a1', 'md'],
      ['f1', 'html'],
    ]) {
      const path = exportPath('c1', turn, format)
      expect(path).not.toMatch(IDENTITY)
      expect(path).toBe(`/api/conversations/c1/export/${turn}?format=${format}`)
    }
  })

  test('the default file name derives from title + feature + turn — never from a slot', () => {
    for (const feature of ['analyze', 'fusion']) {
      const base = defaultBaseName({ title: 'Gyro range question', feature, turnId: 'a1' })
      expect(base).not.toMatch(IDENTITY)
      expect(fileNameFor(base, 'pdf')).not.toMatch(IDENTITY)
    }
    // a user title that happens to name a vendor is USER text (out of scope, like a prompt), and it
    // still cannot say which R-label that vendor is
    const fromTitle = defaultBaseName({ title: 'Ask Claude about SPI', feature: 'analyze', turnId: 'a1' })
    expect(fromTitle).toBe('triplex-ask-claude-about-spi-analyze-a1')
  })

  test('Send names its columns on screen, and still sends only ids', async () => {
    const conv = analyzeFx.conversation([analyzeFx.sendTurn()], PLANTED)
    renderWithStore(<SendPane />, { preloaded: { conversation: conv, slotConfig: analyzeFx.SLOT_CONFIG, models: { items: [], byId: {}, loaded: true, error: null } } })
    const { payload } = await runFrom('send')
    expect(JSON.stringify(payload)).not.toMatch(IDENTITY)
    expect(payload).toMatchObject({ conversationId: 'c1', turnId: 's1' })
    // the Send columns are labelled by vendor on screen by design — that is why a Send document may
    // name them, and why this assertion is the opposite of the two above
    expect(screen.getByTestId('send-grid').textContent).toMatch(/Claude/)
  })
})
