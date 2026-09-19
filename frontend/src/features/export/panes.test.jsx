// The Export control as the three panes wire it: each pane offers the turn it is showing, and
// nothing before there is one. Renders the REAL panes so the derivation is covered end to end.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SendPane from '../send/index.jsx'
import AnalyzePane from '../analyze/index.jsx'
import FusionPane from '../fusion/index.jsx'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import * as analyzeFx from '../analyze/fixtures.js'
import * as fusionFx from '../fusion/fixtures.js'

// Preloaded so SendPane's mount effect does not fetch the catalog (an out-of-act dispatch).
const MODELS = { items: [], byId: {}, loaded: true, error: null }

let exportTurn
beforeEach(() => {
  exportTurn = vi.fn(async () => ({ paths: ['/home/u/Documents/r.md'], cancelled: false }))
  vi.stubGlobal('triplex', { version: '0.1.0', slots: ['claude', 'chatgpt', 'grok'], exportTurn })
  // SendPane loads the model catalog on mount.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function choose(feature, format) {
  await userEvent.click(screen.getByTestId(`export-${feature}`))
  await userEvent.click(screen.getByTestId(`export-format-${format}`))
  await waitFor(() => expect(exportTurn).toHaveBeenCalled())
  return exportTurn.mock.calls[exportTurn.mock.calls.length - 1][0]
}

describe('Send pane', () => {
  test('no send turn yet: the trigger is there but disabled', () => {
    renderWithStore(<SendPane />, { preloaded: { conversation: analyzeFx.conversation([]), slotConfig: analyzeFx.SLOT_CONFIG, models: MODELS } })
    expect(screen.getByTestId('export-send')).toBeDisabled()
  })

  test('exports the LATEST send turn of the conversation', async () => {
    const conv = analyzeFx.conversation([analyzeFx.sendTurn({ id: 's1' }), analyzeFx.analyzeTurn(), analyzeFx.sendTurn({ id: 's2' })])
    renderWithStore(<SendPane />, { preloaded: { conversation: conv, slotConfig: analyzeFx.SLOT_CONFIG, models: MODELS } })
    expect(screen.getByTestId('export-send')).toBeEnabled()
    const call = await choose('send', 'all')
    expect(call).toMatchObject({ conversationId: 'c1', turnId: 's2', formats: ['md', 'html', 'pdf'] })
    expect(exportTurn).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('export-send-result')).toHaveTextContent('Wrote r.md')
  })

  test('a solo continue after the send turn becomes the exported step', async () => {
    const conv = analyzeFx.conversation([analyzeFx.sendTurn({ id: 's1' }), { type: 'continue', id: 'k9', ts: '2026-09-07T00:01:00.000Z', slot: 'claude', prompt: 'and the bandwidth?', response: 'x', slot_config: analyzeFx.SLOT_CONFIG, usage: { calls: [], totals: {} } }])
    renderWithStore(<SendPane />, { preloaded: { conversation: conv, slotConfig: analyzeFx.SLOT_CONFIG, models: MODELS } })
    expect(await choose('send', 'md')).toMatchObject({ turnId: 'k9', turnType: 'continue', formats: ['md'] })
  })

  test('disabled while a send stream is running', () => {
    const conv = analyzeFx.conversation([analyzeFx.sendTurn()])
    const state = applyEvents('send', [{ type: 'conversation/loaded', conversation: conv }, { type: 'sse/start', feature: 'send' }], { preloaded: { slotConfig: analyzeFx.SLOT_CONFIG, models: MODELS } })
    renderWithStore(<SendPane />, { preloaded: state })
    expect(screen.getByTestId('export-send')).toBeDisabled()
  })

  test('still offered with the composer hidden (the desktop drawer renders the pane composer-less)', () => {
    const conv = analyzeFx.conversation([analyzeFx.sendTurn()])
    renderWithStore(<SendPane composer={false} />, { preloaded: { conversation: conv, slotConfig: analyzeFx.SLOT_CONFIG, models: MODELS } })
    expect(screen.queryByTestId('send-composer')).toBeNull()
    expect(screen.getByTestId('export-send')).toBeEnabled()
  })
})

describe('Analyze pane', () => {
  const conv = analyzeFx.conversation([analyzeFx.sendTurn()])

  test('no report yet: disabled', () => {
    renderWithStore(<AnalyzePane />, { preloaded: applyEvents('analyze', [analyzeFx.events.loaded(conv)]) })
    expect(screen.getByTestId('export-analyze')).toBeDisabled()
  })

  test('exports the analyze turn the pane is showing', async () => {
    const state = applyEvents('analyze', [analyzeFx.events.loaded(conv), analyzeFx.events.start(), analyzeFx.events.done(analyzeFx.analyzeTurn({ id: 'a42' }))])
    renderWithStore(<AnalyzePane />, { preloaded: state })
    expect(screen.getByTestId('export-analyze')).toBeEnabled()
    expect(await choose('analyze', 'md')).toMatchObject({ conversationId: 'c1', turnId: 'a42', formats: ['md'] })
  })

  test('a degraded turn is still a document (the raw attempts are the report)', async () => {
    const state = applyEvents('analyze', [analyzeFx.events.loaded(conv), analyzeFx.events.start(), analyzeFx.events.degraded(analyzeFx.degradedTurn())])
    renderWithStore(<AnalyzePane />, { preloaded: state })
    expect(await choose('analyze', 'html')).toMatchObject({ turnId: 'a2', formats: ['html'] })
  })

  test('a re-run takes the report off screen, so there is nothing to export until it lands', () => {
    const state = applyEvents('analyze', [analyzeFx.events.loaded(conv), analyzeFx.events.done(analyzeFx.analyzeTurn()), analyzeFx.events.start()])
    renderWithStore(<AnalyzePane />, { preloaded: state })
    expect(screen.getByTestId('export-analyze')).toBeDisabled()
    expect(screen.getByTestId('export-analyze')).toHaveAttribute('title', 'Export: no analyze report to export yet')
  })

  test('a report on screen while a send stream runs is not exportable until the stream ends', () => {
    const state = applyEvents('analyze', [analyzeFx.events.loaded(conv), analyzeFx.events.done(analyzeFx.analyzeTurn()), { type: 'sse/start', feature: 'send' }])
    renderWithStore(<AnalyzePane />, { preloaded: state })
    expect(screen.getByTestId('export-analyze')).toBeDisabled()
    expect(screen.getByTestId('export-analyze')).toHaveAttribute('title', 'Export: a stream is running')
  })
})

describe('Fusion pane', () => {
  test('no fusion report yet: disabled', () => {
    const state = applyEvents('fusion', [{ type: 'conversation/loaded', conversation: fusionFx.conversation() }])
    renderWithStore(<FusionPane />, { preloaded: state })
    expect(screen.getByTestId('export-fusion')).toBeDisabled()
    expect(screen.getByTestId('export-fusion')).toHaveAttribute('title', 'Export: no fusion report to export yet')
  })

  test('exports the fusion turn of the run it is showing', async () => {
    const state = applyEvents('fusion', [{ type: 'conversation/loaded', conversation: fusionFx.conversation() }, ...fusionFx.fullRun()])
    renderWithStore(<FusionPane />, { preloaded: state })
    expect(screen.getByTestId('export-fusion')).toBeEnabled()
    expect(await choose('fusion', 'pdf')).toMatchObject({ conversationId: 'c1', turnId: 'f1', formats: ['pdf'] })
  })

  test('disabled mid-run', () => {
    const state = applyEvents('fusion', [{ type: 'conversation/loaded', conversation: fusionFx.conversation() }, { type: 'sse/start', feature: 'fusion' }, fusionFx.fusionStart(), ...fusionFx.ROUND1])
    renderWithStore(<FusionPane />, { preloaded: state })
    expect(screen.getByTestId('export-fusion')).toBeDisabled()
    expect(screen.getByTestId('export-fusion')).toHaveAttribute('title', 'Export: Fusion is running')
  })
})
