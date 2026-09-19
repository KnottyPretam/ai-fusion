import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExportControl from './ExportControl.jsx'

let clicks
beforeEach(() => {
  clicks = []
  URL.createObjectURL = vi.fn(() => 'blob:1')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
    clicks.push({ download: this.download })
  })
})
afterEach(() => {
  delete URL.createObjectURL
  delete URL.revokeObjectURL
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function desktop(exportTurn) {
  const fake = { version: '0.1.0', slots: ['claude', 'chatgpt', 'grok'], exportTurn }
  vi.stubGlobal('triplex', fake)
  return fake
}

const PROPS = { feature: 'send', conversationId: 'c1', turnId: 's1', title: 'BMI088 datasheet' }

function renderControl(over = {}) {
  return render(<ExportControl {...PROPS} {...over} />)
}

async function openMenu(feature = 'send') {
  await userEvent.click(screen.getByTestId(`export-${feature}`))
  return screen.getByTestId(`export-menu-${feature}`)
}

describe('ExportControl: availability', () => {
  test('disabled with no turn to export, enabled once the pane has one', () => {
    const { unmount } = renderControl({ turnId: null })
    const off = screen.getByTestId('export-send')
    expect(off).toBeDisabled()
    expect(off).toHaveAttribute('title', 'Export: no send turn to export yet')
    expect(screen.queryByTestId('export-menu-send')).toBeNull()
    unmount()

    renderControl()
    expect(screen.getByTestId('export-send')).toBeEnabled()
  })

  test('disabled while a stream is running, with the reason in the title', () => {
    renderControl({ busy: true })
    expect(screen.getByTestId('export-send')).toBeDisabled()
    expect(screen.getByTestId('export-send')).toHaveAttribute('title', 'Export: a stream is running')
    renderControl({ feature: 'analyze', busy: true, busyReason: 'Analyze is running' })
    expect(screen.getByTestId('export-analyze')).toHaveAttribute('title', 'Export: Analyze is running')
  })

  test('the enabled trigger names the formats the shell can actually make', () => {
    desktop(vi.fn())
    const { unmount } = renderControl()
    expect(screen.getByTestId('export-send')).toHaveAttribute('title', 'Export this send turn as Markdown, HTML, PDF or all three')
    unmount()
    vi.unstubAllGlobals()
    renderControl({ feature: 'analyze' })
    expect(screen.getByTestId('export-analyze')).toHaveAttribute('title', 'Export this analyze report as Markdown or HTML')
  })

  test('no conversation at all is also disabled', () => {
    renderControl({ conversationId: null, turnId: null })
    expect(screen.getByTestId('export-send')).toBeDisabled()
  })
})

describe('ExportControl: the desktop path', () => {
  test('each format triggers ONE call for that format and the turn the pane is showing', async () => {
    const exportTurn = vi.fn(async () => ({ paths: ['/home/u/r.md'], cancelled: false }))
    desktop(exportTurn)
    renderControl({ feature: 'analyze', turnId: 'a7' })

    for (const [testid, format] of [
      ['export-format-md', 'md'],
      ['export-format-html', 'html'],
      ['export-format-pdf', 'pdf'],
    ]) {
      await userEvent.click(screen.getByTestId('export-analyze'))
      await userEvent.click(screen.getByTestId(testid))
      await waitFor(() => expect(exportTurn).toHaveBeenCalled())
      const last = exportTurn.mock.calls[exportTurn.mock.calls.length - 1][0]
      expect(last.formats).toEqual([format])
      expect(last.turnId).toBe('a7')
      expect(last.conversationId).toBe('c1')
      // the desktop names the file from the title + the step, never from a renderer-built path
      expect(last).toMatchObject({ title: 'BMI088 datasheet', turnType: 'analyze' })
      // the menu closes on a choice
      expect(screen.queryByTestId('export-menu-analyze')).toBeNull()
    }
    expect(exportTurn).toHaveBeenCalledTimes(3)
  })

  test('"all three" is ONE call with all three formats, not three calls', async () => {
    const exportTurn = vi.fn(async () => ({ paths: ['/home/u/r.md', '/home/u/r.html', '/home/u/r.pdf'] }))
    desktop(exportTurn)
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-all'))
    await waitFor(() => expect(screen.getByTestId('export-send-result')).toBeInTheDocument())
    expect(exportTurn).toHaveBeenCalledTimes(1)
    expect(exportTurn.mock.calls[0][0].formats).toEqual(['md', 'html', 'pdf'])
    expect(screen.getByTestId('export-send-result')).toHaveTextContent('Wrote r.md, r.html, r.pdf')
    expect(screen.getByTestId('export-send-result')).toHaveAttribute('title', '/home/u/r.md\n/home/u/r.html\n/home/u/r.pdf')
  })

  test('a cancelled save dialog renders nothing at all', async () => {
    desktop(vi.fn(async () => ({ cancelled: true, paths: [] })))
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-md'))
    await waitFor(() => expect(screen.getByTestId('export-send')).toBeEnabled())
    expect(screen.queryByTestId('export-send-result')).toBeNull()
  })

  test('a failure renders the error code', async () => {
    desktop(vi.fn(async () => ({ ok: false, code: 'pdf_render_failed', message: 'print to PDF failed' })))
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-pdf'))
    const line = await screen.findByTestId('export-send-result')
    expect(line).toHaveTextContent('Export failed: pdf_render_failed')
  })

  test('a partial preload (no exportTurn) reports an unsupported build instead of throwing', async () => {
    vi.stubGlobal('triplex', {})
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-md'))
    expect(await screen.findByTestId('export-send-result')).toHaveTextContent('Export failed: export_unsupported')
  })

  test('the menu says how the save dialog behaves', async () => {
    desktop(vi.fn())
    renderControl()
    const menu = await openMenu()
    expect(menu.getAttribute('title')).toMatch(/save dialog/i)
    expect(menu.getAttribute('title')).toMatch(/All three/i)
    expect(screen.queryByTestId('export-note-send')).toBeNull()
  })
})

describe('ExportControl: the browser path', () => {
  test('downloads without window.triplex, hides PDF and says why', async () => {
    const fetchMock = vi.fn(async (url) => ({ ok: true, status: 200, text: async () => `body ${url}` }))
    vi.stubGlobal('fetch', fetchMock)
    renderControl({ feature: 'fusion', turnId: 'f3' })
    const menu = await openMenu('fusion')

    expect(within(menu).getByTestId('export-format-md')).toBeInTheDocument()
    expect(within(menu).getByTestId('export-format-html')).toBeInTheDocument()
    expect(within(menu).queryByTestId('export-format-pdf')).toBeNull()
    expect(menu.getAttribute('title')).toMatch(/PDF is not available in the browser/i)
    expect(within(menu).getByTestId('export-format-all')).toHaveTextContent('Both (.md + .html)')
    expect(within(menu).getByTestId('export-note-fusion')).toHaveTextContent('PDF needs the desktop app')

    await userEvent.click(within(menu).getByTestId('export-format-md'))
    const line = await screen.findByTestId('export-fusion-result')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/conversations/c1/export/f3?format=md'])
    expect(clicks.map((c) => c.download)).toEqual(['triplex-bmi088-datasheet-fusion-f3.md'])
    expect(line).toHaveTextContent('Downloaded triplex-bmi088-datasheet-fusion-f3.md')
  })

  test('"both" downloads the two available formats and never asks the server for a pdf', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-all'))
    await screen.findByTestId('export-send-result')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/conversations/c1/export/s1?format=md', '/api/conversations/c1/export/s1?format=html'])
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('pdf'))).toBe(false)
    expect(clicks.map((c) => c.download)).toEqual(['triplex-bmi088-datasheet-send-s1.md', 'triplex-bmi088-datasheet-send-s1.html'])
  })

  test('a server failure renders the error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ detail: { error: 'turn_not_found' } }) })))
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-md'))
    expect(await screen.findByTestId('export-send-result')).toHaveTextContent('Export failed: turn_not_found')
    expect(clicks).toHaveLength(0)
  })
})

describe('ExportControl: keyboard and focus', () => {
  test('tab reaches the trigger, Enter opens it, the first item takes focus', async () => {
    desktop(vi.fn(async () => ({ paths: ['/tmp/r.md'] })))
    renderControl()
    const trigger = screen.getByTestId('export-send')
    await userEvent.tab()
    expect(trigger).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('export-format-md')).toHaveFocus()
  })

  test('arrow keys walk the items and wrap', async () => {
    desktop(vi.fn())
    renderControl()
    await openMenu()
    expect(screen.getByTestId('export-format-md')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByTestId('export-format-html')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByTestId('export-format-md')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByTestId('export-format-all')).toHaveFocus() // wraps to the last item
  })

  test('Escape closes the menu and hands focus back to the trigger', async () => {
    desktop(vi.fn())
    renderControl()
    const trigger = screen.getByTestId('export-send')
    await openMenu()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('export-menu-send')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  test('a click outside closes the menu', async () => {
    desktop(vi.fn())
    renderControl()
    await openMenu()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('export-menu-send')).toBeNull()
  })

  test('the trigger toggles the menu shut again', async () => {
    desktop(vi.fn())
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-send'))
    expect(screen.queryByTestId('export-menu-send')).toBeNull()
  })
})

describe('ExportControl: result lifecycle', () => {
  test('a new turn drops the previous result line', async () => {
    desktop(vi.fn(async () => ({ paths: ['/tmp/r.md'] })))
    const { rerender } = render(<ExportControl {...PROPS} />)
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-md'))
    expect(await screen.findByTestId('export-send-result')).toHaveTextContent('Wrote r.md')
    rerender(<ExportControl {...PROPS} turnId="s2" />)
    expect(screen.queryByTestId('export-send-result')).toBeNull()
  })

  test('the trigger is disabled while the export is in flight', async () => {
    let release
    desktop(vi.fn(() => new Promise((r) => (release = () => r({ paths: ['/tmp/r.md'] })))))
    renderControl()
    await openMenu()
    await userEvent.click(screen.getByTestId('export-format-md'))
    expect(screen.getByTestId('export-send')).toBeDisabled()
    expect(screen.getByTestId('export-send-result')).toHaveTextContent('Exporting…')
    release()
    await waitFor(() => expect(screen.getByTestId('export-send')).toBeEnabled())
    expect(screen.getByTestId('export-send-result')).toHaveTextContent('Wrote r.md')
  })
})
