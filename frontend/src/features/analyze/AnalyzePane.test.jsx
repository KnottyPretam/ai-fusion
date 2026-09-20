import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import AnalyzePane from './index.jsx'
import { isSplitNotice } from './AnalyzePane.jsx'
import { applyEvents, renderWithStore } from '../../state/testing.jsx'
import { analyzeTurn, conversation, degradedTurn, events, sendTurn } from './fixtures.js'
import { NOT_CAPTURED_MESSAGE_PREFIX } from './slice.js'
// Imported ONLY to pin the mirror: product code in features/analyze never imports features/desktop
// (the constant is duplicated with a pointer, like SLOT_VENDORS), so this assertion is the guard
// that the two copies still say the same thing.
import { NOT_CAPTURED_MESSAGE_PREFIX as DESKTOP_NOT_CAPTURED_MESSAGE_PREFIX } from '../desktop/slice.js'
import { APP_NAME } from '../../branding.js'

const SLOT_NAMES = /claude|chatgpt|grok|anthropic|openai|x-ai/i

// Full store state: a loaded conversation with a complete send turn, then the given events.
function stateWith(evs = [], { conv = conversation([sendTurn()]), feature = 'analyze' } = {}) {
  return applyEvents(feature, [events.loaded(conv), ...evs])
}

function renderPane(preloaded) {
  return renderWithStore(<AnalyzePane />, { preloaded })
}

afterEach(() => vi.unstubAllGlobals())

describe('AnalyzePane: report rendering', () => {
  test('analyze_start / analyze_retry / analyze_done renders the Differs table with per-label cells and materiality badges', () => {
    renderPane(stateWith([events.start(), events.retry('Field required'), events.done(analyzeTurn())]))
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-status', 'done')
    expect(screen.queryByTestId('analyze-retry')).toBeNull()
    expect(screen.queryByTestId('analyze-status')).toBeNull()
    const report = screen.getByTestId('analyze-report')
    expect(report).toBeInTheDocument()

    // Similar: agreements with topic, statement and label chips, captioned
    expect(within(report).getByText('convergence, not verified truth')).toBeInTheDocument()
    const ag1 = screen.getByTestId('analyze-agreement-1')
    expect(ag1).toHaveTextContent('range selectability')
    expect(ag1).toHaveTextContent('The full-scale range is selectable.')
    expect(screen.getByTestId('analyze-agreement-1-R1')).toHaveTextContent('R1')
    expect(screen.getByTestId('analyze-agreement-1-R3')).toHaveTextContent('R3')
    expect(screen.queryByTestId('analyze-agreement-1-R2')).toBeNull()
    expect(screen.getByTestId('analyze-agreement-2-R2')).toHaveTextContent('R2')

    // Differs: header is topic | R1 | R2 | R3 | materiality
    const table = screen.getByTestId('analyze-divergences')
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toEqual(['topic', 'R1', 'R2', 'R3', 'materiality'])
    expect(within(table).getAllByRole('row')).toHaveLength(4) // header + d1..d3

    const d1 = screen.getByTestId('analyze-divergence-d1')
    expect(d1).toHaveTextContent('maximum range')
    expect(screen.getByTestId('analyze-cell-d1-R1')).toHaveTextContent('Selectable up to 2000 deg/s.')
    expect(screen.getByTestId('analyze-cell-d1-R1')).toHaveTextContent('evidence: datasheet table 3')
    expect(screen.getByTestId('analyze-cell-d1-R2')).toHaveTextContent('Tops out at 1000 deg/s.')
    expect(screen.getByTestId('analyze-cell-d1-R2')).toHaveTextContent('no evidence cited')
    expect(screen.getByTestId('analyze-cell-d1-R3')).toHaveTextContent('Ranges from 125 up to 2000 deg/s.')
    // a label without a position on a divergence shows a dash
    expect(screen.getByTestId('analyze-cell-d2-R2')).toHaveTextContent('—')
    expect(screen.getByTestId('analyze-cell-d3-R1')).toHaveTextContent('—')
    expect(screen.getByTestId('analyze-cell-d2-R3')).toHaveTextContent('evidence: register map')

    expect(screen.getByTestId('analyze-materiality-d1')).toHaveTextContent('high')
    expect(screen.getByTestId('analyze-materiality-d2')).toHaveTextContent('low')
    expect(screen.getByTestId('analyze-materiality-d3')).toHaveTextContent('medium')
    expect(screen.queryByTestId('analyze-cached')).toBeNull()
    expect(screen.getByTestId('analyze-rerun')).toBeInTheDocument()
  })

  test('retry indicator while status is retrying (no report yet)', () => {
    renderPane(stateWith([{ type: 'sse/start', feature: 'analyze' }, events.start(), events.retry('Extraction.divergences: Field required')]))
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-status', 'retrying')
    const retry = screen.getByTestId('analyze-retry')
    expect(retry).toHaveTextContent(/Retrying/)
    expect(retry).toHaveTextContent('Extraction.divergences: Field required')
    expect(screen.queryByTestId('analyze-report')).toBeNull()
    expect(screen.getByTestId('analyze-run')).toBeDisabled() // the analyze stream is still open
  })

  test('running indicator after analyze_start', () => {
    renderPane(stateWith([events.start()]))
    expect(screen.getByTestId('analyze-status')).toHaveTextContent(/Analyzing/)
    expect(screen.queryByTestId('analyze-report')).toBeNull()
  })

  test('analyze_degraded renders the raw attempts (collapsible) and "Fusion disabled for this turn"', () => {
    const turn = degradedTurn()
    renderPane(stateWith([events.start('a2'), events.retry(), events.degraded(turn)]))
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-status', 'degraded')
    const box = screen.getByTestId('analyze-degraded')
    expect(box).toHaveTextContent('Analysis degraded.')
    expect(screen.getByTestId('analyze-fusion-disabled')).toHaveTextContent('Fusion disabled for this turn.')
    expect(box).toHaveTextContent('Field required')
    const details = screen.getByTestId('analyze-raw-attempts')
    expect(details.tagName).toBe('DETAILS')
    expect(details).toHaveTextContent('raw analyst attempts (2)')
    expect(screen.getByTestId('analyze-raw-attempt-1')).toHaveTextContent('```json {"agreements": [')
    expect(screen.getByTestId('analyze-raw-attempt-2')).toHaveTextContent('{"agreements": []}')
    expect(screen.queryByTestId('analyze-report')).toBeNull()
    expect(screen.queryByTestId('analyze-retry')).toBeNull()
    // a degraded turn can still be re-run
    expect(screen.getByTestId('analyze-rerun')).toBeEnabled()
  })

  test("events under feature 'fusion' (auto-run) drive the same pane", () => {
    renderPane(stateWith([events.start(), events.done(analyzeTurn())], { feature: 'fusion' }))
    expect(screen.getByTestId('analyze-report')).toBeInTheDocument()
    expect(screen.getByTestId('analyze-cell-d1-R2')).toHaveTextContent('Tops out at 1000 deg/s.')
  })

  test('cached chip when analyze_done carries cached:true', () => {
    renderPane(stateWith([events.start(), events.done(analyzeTurn(), true)]))
    expect(screen.getByTestId('analyze-cached')).toHaveTextContent('cached')
    expect(screen.getByTestId('analyze-report')).toBeInTheDocument()
  })

  test('error box for a terminal stream error', () => {
    renderPane(stateWith([events.start(), events.error('analyst unavailable')]))
    expect(screen.getByTestId('analyze-error')).toHaveTextContent('analyst unavailable')
    expect(screen.queryByTestId('analyze-report')).toBeNull()
  })

  test('error box for a pre-stream failure keeps the previous report visible', () => {
    const s = stateWith([events.start(), events.done(analyzeTurn()), { type: 'sse/start', feature: 'analyze' }, { type: 'sse/end', feature: 'analyze', ok: false, error: 'busy', status: 409 }])
    renderPane(s)
    expect(screen.getByTestId('analyze-error')).toHaveTextContent('busy')
    expect(screen.getByTestId('analyze-report')).toBeInTheDocument()
  })

  test('a reload shows the last ok report (hydrated from the conversation)', () => {
    const conv = conversation([sendTurn(), degradedTurn({ id: 'a0' }), analyzeTurn({ id: 'a1' })])
    renderPane(stateWith([], { conv }))
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-status', 'done')
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-of-turn', 's1')
    expect(screen.getByTestId('analyze-cell-d1-R1')).toHaveTextContent('Selectable up to 2000 deg/s.')
    expect(screen.queryByTestId('analyze-cached')).toBeNull()
  })

  test('empty extraction shows the empty states', () => {
    renderPane(stateWith([events.start(), events.done(analyzeTurn({ extraction: { agreements: [], divergences: [] } }))]))
    expect(screen.getByText('No agreements identified.')).toBeInTheDocument()
    expect(screen.getByText('No divergences identified.')).toBeInTheDocument()
  })

  test('renders R-labels only — never a slot or vendor name', () => {
    const { container } = renderPane(stateWith([events.start(), events.done(analyzeTurn())]))
    expect(container.textContent).not.toMatch(SLOT_NAMES)
    expect(container.innerHTML).not.toMatch(SLOT_NAMES)
    expect(container.textContent).toMatch(/R1/)
  })
})

describe('AnalyzePane: "not fused" marker follows slotConfig.materiality_min', () => {
  test('materiality_min = medium marks only the low row', () => {
    renderPane(stateWith([events.start(), events.done(analyzeTurn())]))
    expect(screen.getByTestId('analyze-divergence-d1')).toHaveAttribute('data-fused', 'yes')
    expect(screen.getByTestId('analyze-divergence-d2')).toHaveAttribute('data-fused', 'no')
    expect(screen.getByTestId('analyze-divergence-d3')).toHaveAttribute('data-fused', 'yes')
    expect(screen.getByTestId('analyze-not-fused-d2')).toHaveTextContent('not fused')
    expect(screen.queryByTestId('analyze-not-fused-d1')).toBeNull()
    expect(screen.queryByTestId('analyze-not-fused-d3')).toBeNull()
  })

  test('materiality_min = high marks medium and low rows; low marks none', () => {
    const base = stateWith([events.start(), events.done(analyzeTurn())])
    const high = applyEvents('analyze', [{ type: 'slotConfig/update', patch: { materiality_min: 'high' } }], { state: base })
    const r1 = renderPane(high)
    expect(screen.getByTestId('analyze-divergence-d1')).toHaveAttribute('data-fused', 'yes')
    expect(screen.getByTestId('analyze-divergence-d2')).toHaveAttribute('data-fused', 'no')
    expect(screen.getByTestId('analyze-divergence-d3')).toHaveAttribute('data-fused', 'no')
    expect(screen.getByTestId('analyze-not-fused-d3')).toBeInTheDocument()
    expect(screen.getByText(/rows below materiality "high" are not fused/)).toBeInTheDocument()
    r1.unmount()

    const low = applyEvents('analyze', [{ type: 'slotConfig/update', patch: { materiality_min: 'low' } }], { state: base })
    renderPane(low)
    for (const id of ['d1', 'd2', 'd3']) {
      expect(screen.getByTestId(`analyze-divergence-${id}`)).toHaveAttribute('data-fused', 'yes')
      expect(screen.queryByTestId(`analyze-not-fused-${id}`)).toBeNull()
    }
  })
})

describe('AnalyzePane: button gating', () => {
  test('no conversation -> nothing rendered', () => {
    const { container } = renderPane(applyEvents('analyze', []))
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('analyze-run')).toBeNull()
  })

  test('conversation without a send turn -> disabled with a hint', () => {
    renderPane(stateWith([], { conv: conversation([]) }))
    expect(screen.getByTestId('analyze-run')).toBeDisabled()
    expect(screen.getByTestId('analyze-hint')).toHaveTextContent('send a prompt first')
    expect(screen.queryByTestId('analyze-rerun')).toBeNull()
  })

  test('latest send turn with a null slot response -> disabled', () => {
    const conv = conversation([sendTurn({ id: 's1' }), sendTurn({ id: 's2', responses: { claude: 'a', chatgpt: null, grok: 'c' }, errors: { chatgpt: 'boom' } })])
    renderPane(stateWith([], { conv }))
    expect(screen.getByTestId('analyze-run')).toBeDisabled()
    // The slot FAILED (errors.chatgpt), so "waiting for all three responses" would send the user
    // back to the models; the hint names the slot, the reason, and the only way out (a new Send).
    expect(screen.getByTestId('analyze-hint')).toHaveTextContent('no reply came back from chatgpt: boom')
    expect(screen.getByTestId('analyze-hint')).toHaveTextContent('Send again')
  })

  test('complete latest send turn and idle streams -> enabled', () => {
    renderPane(stateWith([]))
    expect(screen.getByTestId('analyze-run')).toBeEnabled()
    expect(screen.queryByTestId('analyze-hint')).toBeNull()
  })

  test('a later continue turn does not change the latest send turn', () => {
    const conv = conversation([sendTurn({ id: 's1' }), { type: 'continue', id: 'k1', slot: 'grok', prompt: 'p', response: null, error: 'x' }])
    renderPane(stateWith([], { conv }))
    expect(screen.getByTestId('analyze-run')).toBeEnabled()
  })

  test.each(['send', 'analyze', 'fusion'])('disabled while the %s stream is streaming', (feature) => {
    renderPane(stateWith([{ type: 'sse/start', feature }]))
    expect(screen.getByTestId('analyze-run')).toBeDisabled()
    expect(screen.getByTestId('analyze-hint')).toHaveTextContent('a stream is running')
  })

  test('re-enabled once the stream ends', () => {
    renderPane(stateWith([{ type: 'sse/start', feature: 'send' }, { type: 'sse/end', feature: 'send', ok: true }]))
    expect(screen.getByTestId('analyze-run')).toBeEnabled()
  })
})

// --- the incomplete-turn hint ----------------------------------------------------------------
// The hint is the pane's whole explanation of a disabled Analyze button, and it is rendered in both
// shells (the web page and the desktop drawer). Three rules it has to keep:
//   * a LIVE Send wins over any verdict about the persisted (previous) turn — `send` is the
//     persisted turn and the refetch only lands after the stream ends;
//   * every failed slot gets its OWN reason, never the first slot's reason for all of them;
//   * only the capture-off branch (a desktop-only message) may speak of "capture".
const CAPTURE_OFF = (slot) => `capture is off for ${slot}; the reply is in the site pane` // backend/llm/bridge.py

function hintFor(errors, { responses = { claude: null, chatgpt: null, grok: null }, evs = [] } = {}) {
  const conv = conversation([sendTurn({ id: 's2', responses, errors })])
  renderPane(stateWith(evs, { conv }))
  return screen.getByTestId('analyze-hint')
}

describe('AnalyzePane: the incomplete-turn hint', () => {
  test('web: one failed slot names the slot and its reason, and never says "captured"', () => {
    const hint = hintFor({ chatgpt: 'transport_error: connection reset' }, { responses: { claude: 'a', chatgpt: null, grok: 'c' } })
    expect(hint).toHaveTextContent('no reply came back from chatgpt: transport_error: connection reset')
    expect(hint).toHaveTextContent('This turn cannot be analyzed — Send again.')
    // "capture" is desktop vocabulary for an act the web product never performs.
    expect(hint.textContent.toLowerCase()).not.toContain('captur')
  })

  test('several failed slots each get their own reason (not the first slot\'s for all of them)', () => {
    const hint = hintFor({ claude: 'cost_cap_exceeded: session cap reached', grok: 'timeout: no reply in 300s' })
    expect(hint).toHaveTextContent('claude: cost_cap_exceeded: session cap reached')
    expect(hint).toHaveTextContent('grok: timeout: no reply in 300s')
    // one tail, not one per slot
    expect(hint.textContent.match(/Send again/g)).toHaveLength(1)
  })

  test('a blank reason degrades to "no reason given" rather than an empty clause', () => {
    expect(hintFor({ grok: '   ' })).toHaveTextContent('no reply came back from grok: no reason given')
  })

  test('desktop, capture off for one slot: the wording is singular and points at that pane header', () => {
    const hint = hintFor({ grok: CAPTURE_OFF('grok') }, { responses: { claude: 'a', chatgpt: 'b', grok: null } })
    expect(hint).toHaveTextContent(`grok replied on screen but capture was off, so ${APP_NAME} never read it`)
    expect(hint).toHaveTextContent('Turn Capture on in that pane header and Send again: capture applies to the next Send, not this one.')
    expect(hint.textContent).not.toContain('no reply came back')
  })

  test('desktop, capture off for all three: the wording is plural', () => {
    const hint = hintFor({ claude: CAPTURE_OFF('claude'), chatgpt: CAPTURE_OFF('chatgpt'), grok: CAPTURE_OFF('grok') })
    expect(hint).toHaveTextContent(`claude, chatgpt, grok replied on screen but capture were off, so ${APP_NAME} never read them`)
    expect(hint).toHaveTextContent('those pane headers')
  })

  test('mixed: one slot capture-off and one slot errored -> the error branch with the capture clause', () => {
    const hint = hintFor(
      { chatgpt: CAPTURE_OFF('chatgpt'), grok: 'site_error: reply_not_found' },
      { responses: { claude: 'a', chatgpt: null, grok: null } },
    )
    expect(hint).toHaveTextContent('no reply came back from grok: site_error: reply_not_found (and capture was off for chatgpt). This turn cannot be analyzed — Send again.')
    // the capture-off slot is not reported as a failure
    expect(hint.textContent).not.toContain('chatgpt: capture is off')
  })

  test.each(['send', 'analyze', 'fusion'])('a live %s stream wins over a verdict about the previous turn', (feature) => {
    // The persisted turn failed, but a stream is in flight: the refetch has not landed yet, so
    // "Send again" would describe a turn that is no longer on screen while the user is sending.
    const hint = hintFor({ claude: 'boom', grok: CAPTURE_OFF('grok') }, { evs: [{ type: 'sse/start', feature }] })
    expect(hint).toHaveTextContent('a stream is running')
    expect(hint.textContent).not.toContain('Send again')
  })

  test('an incomplete turn with no errors at all still waits for the models', () => {
    expect(hintFor({}, { responses: { claude: 'a', chatgpt: null, grok: 'c' } })).toHaveTextContent('waiting for all three responses')
  })

  test('the not_captured prefix is the same string the desktop slice exports (mirrored constant)', () => {
    expect(NOT_CAPTURED_MESSAGE_PREFIX).toBe(DESKTOP_NOT_CAPTURED_MESSAGE_PREFIX)
    expect(CAPTURE_OFF('grok').startsWith(NOT_CAPTURED_MESSAGE_PREFIX)).toBe(true)
  })
})

// --- streaming through a stubbed fetch -------------------------------------------------------
function sseResponse(evs) {
  const enc = new TextEncoder()
  const chunks = [enc.encode(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))]
  let i = 0
  return {
    ok: true,
    status: 200,
    json: async () => null,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
        cancel: async () => {},
        releaseLock() {},
      }),
    },
  }
}

function jsonResponse(obj, status = 200) {
  return { ok: status < 400, status, json: async () => obj }
}

describe('AnalyzePane: actions', () => {
  test('Analyze posts {} to /api/conversations/<id>/analyze, renders the stream, then refetches the conversation', async () => {
    const conv = conversation([sendTurn()])
    const convAfter = conversation([sendTurn(), analyzeTurn()])
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return sseResponse([events.start(), events.done(analyzeTurn(), false)])
      return jsonResponse(convAfter)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPane(stateWith([], { conv }))

    fireEvent.click(screen.getByTestId('analyze-run'))
    await waitFor(() => expect(screen.getByTestId('analyze-report')).toBeInTheDocument())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/conversations/c1/analyze')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})
    expect(fetchMock.mock.calls[1][0]).toBe('/api/conversations/c1')
    // the report survives the refetch and the button is enabled again
    await waitFor(() => expect(screen.getByTestId('analyze-run')).toBeEnabled())
    expect(screen.getByTestId('analyze-report')).toBeInTheDocument()
    expect(screen.getByTestId('analyze')).toHaveAttribute('data-status', 'done')
  })

  test('Re-run posts {force:true}; a cached Analyze shows the chip', async () => {
    const conv = conversation([sendTurn(), analyzeTurn()])
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body)
        return body.force
          ? sseResponse([events.start('a2'), events.done(analyzeTurn({ id: 'a2' }), false)])
          : sseResponse([events.start('a1'), events.done(analyzeTurn({ id: 'a1' }), true)])
      }
      return jsonResponse(conv)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPane(stateWith([], { conv }))
    expect(screen.getByTestId('analyze-report')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('analyze-run'))
    await waitFor(() => expect(screen.getByTestId('analyze-cached')).toBeInTheDocument())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({})

    fireEvent.click(screen.getByTestId('analyze-rerun'))
    await waitFor(() => expect(screen.queryByTestId('analyze-cached')).toBeNull())
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, i]) => i && i.method === 'POST')).toHaveLength(2))
    const forced = fetchMock.mock.calls.filter(([, i]) => i && i.method === 'POST')[1]
    expect(JSON.parse(forced[1].body)).toEqual({ force: true })
    expect(screen.getByTestId('analyze-report')).toBeInTheDocument()
  })

  test('a 409 from the server shows the error box and does not throw', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: { error: 'incomplete_send_turn', missing: ['grok'] } }, 409))
    vi.stubGlobal('fetch', fetchMock)
    renderPane(stateWith([]))
    fireEvent.click(screen.getByTestId('analyze-run'))
    await waitFor(() => expect(screen.getByTestId('analyze-error')).toHaveTextContent('incomplete_send_turn'))
    expect(fetchMock).toHaveBeenCalledTimes(1) // no refetch after a pre-stream failure
    expect(screen.getByTestId('analyze-run')).toBeEnabled()
  })

  test('a degraded stream refetches and keeps the degraded box', async () => {
    const conv = conversation([sendTurn()])
    const fetchMock = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return sseResponse([events.start('a2'), events.retry(), events.degraded(degradedTurn())])
      return jsonResponse(conversation([sendTurn(), degradedTurn()]))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPane(stateWith([], { conv }))
    fireEvent.click(screen.getByTestId('analyze-run'))
    await waitFor(() => expect(screen.getByTestId('analyze-degraded')).toBeInTheDocument())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('analyze-run')).toBeEnabled())
    expect(screen.getByTestId('analyze-degraded')).toBeInTheDocument()
    expect(screen.getByTestId('analyze-fusion-disabled')).toBeInTheDocument()
  })
})

describe('the retry line narrates a split as a split', () => {
  const NOTICE =
    "splitting the analyst prompt: 27,252 characters of replies is over 12,000, so R2's reply " +
    '(13,677 characters) is being condensed to its substantive claims first'

  test('a condense notice is shown as itself, not as a validation failure', () => {
    renderPane(stateWith([{ type: 'sse/start', feature: 'analyze' }, events.start(), events.retry(NOTICE)]))
    const line = screen.getByTestId('analyze-retry')
    expect(line).toHaveTextContent('is being condensed')
    expect(line).not.toHaveTextContent('failed validation')
    expect(line.querySelector('details')).toBeNull()
  })

  test('a real validation failure still reads as one, with the error tucked away', () => {
    renderPane(stateWith([{ type: 'sse/start', feature: 'analyze' }, events.start(), events.retry('parse_error: no JSON object found')]))
    const line = screen.getByTestId('analyze-retry')
    expect(line).toHaveTextContent('failed validation')
    expect(line.querySelector('details')).not.toBeNull()
  })

  test('isSplitNotice keys on the prefix the backend actually writes', () => {
    expect(isSplitNotice(NOTICE)).toBe(true)
    expect(isSplitNotice('parse_error: no JSON object found')).toBe(false)
    expect(isSplitNotice(null)).toBe(false)
    expect(isSplitNotice(undefined)).toBe(false)
  })
})
