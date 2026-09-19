import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { codeOf, exportPath, exportViaBrowser, exportViaDesktop, fetchDocument, isDesktop, resultLine, runExport, safeSuggestedName, suggestedName } from './runExport.js'

// A Response-like object with headers, so the endpoint's own filename suggestion is exercised.
function docResponse(text, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { ok: true, status: 200, text: async () => text, headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null } }
}

// jsdom has no object-URL support; the module falls back to a data: URL, so the tests patch it
// only to prove the blob round trip and the revoke.
let clicks
let created
beforeEach(() => {
  clicks = []
  created = []
  URL.createObjectURL = vi.fn((blob) => {
    created.push(blob)
    return `blob:${created.length}`
  })
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
    clicks.push({ href: this.href, download: this.download, attached: !!this.parentNode })
  })
})
afterEach(() => {
  delete URL.createObjectURL
  delete URL.revokeObjectURL
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ARGS = { conversationId: 'c1', turnId: 's1', baseName: 'triplex-t-send-s1', title: 'T', turnType: 'send' }

describe('the desktop path', () => {
  test('"all three" is ONE call carrying all three formats, and reports the written files', async () => {
    const exportTurn = vi.fn(async () => ({ paths: ['/home/u/Documents/r.md', '/home/u/Documents/r.html', '/home/u/Documents/r.pdf'], cancelled: false }))
    const w = { triplex: { exportTurn } }
    const out = await exportViaDesktop({ ...ARGS, formats: ['md', 'html', 'pdf'] }, w)
    expect(exportTurn).toHaveBeenCalledTimes(1)
    expect(exportTurn.mock.calls[0][0]).toEqual({ conversationId: 'c1', turnId: 's1', formats: ['md', 'html', 'pdf'], title: 'T', turnType: 'send' })
    expect(out.state).toBe('done')
    expect(out.names).toEqual(['r.md', 'r.html', 'r.pdf'])
    expect(resultLine(out)).toBe('Wrote r.md, r.html, r.pdf')
  })

  test('a cancelled save dialog is not a failure and renders nothing', async () => {
    const w = { triplex: { exportTurn: vi.fn(async () => ({ cancelled: true, paths: [] })) } }
    const out = await exportViaDesktop({ ...ARGS, formats: ['md'] }, w)
    expect(out.state).toBe('cancelled')
    expect(resultLine(out)).toBeNull()
    // the American spelling of the flag is accepted too
    const out2 = await exportViaDesktop({ ...ARGS, formats: ['md'] }, { triplex: { exportTurn: vi.fn(async () => ({ canceled: true })) } })
    expect(out2.state).toBe('cancelled')
  })

  test('a failure is reported by its code, however the desktop shapes it', async () => {
    const byCode = await exportViaDesktop({ ...ARGS, formats: ['pdf'] }, { triplex: { exportTurn: vi.fn(async () => ({ ok: false, code: 'pdf_render_failed', message: 'print to PDF failed' })) } })
    expect(byCode).toMatchObject({ state: 'error', code: 'pdf_render_failed' })
    expect(resultLine(byCode)).toBe('Export failed: pdf_render_failed')

    const thrown = await exportViaDesktop({ ...ARGS, formats: ['md'] }, { triplex: { exportTurn: vi.fn(async () => { throw Object.assign(new Error('bad_request'), { code: 'bad_request' }) } ) } })
    expect(thrown).toMatchObject({ state: 'error', code: 'bad_request' })

    const empty = await exportViaDesktop({ ...ARGS, formats: ['md'] }, { triplex: { exportTurn: vi.fn(async () => undefined) } })
    expect(empty).toMatchObject({ state: 'error', code: 'export_failed' })
  })

  test('a partial stub cannot throw: a preload without exportTurn is an unsupported build', async () => {
    const out = await exportViaDesktop({ ...ARGS, formats: ['md'] }, { triplex: {} })
    expect(out).toMatchObject({ state: 'error', code: 'export_unsupported' })
    expect(resultLine(out)).toBe('Export failed: export_unsupported')
    expect(isDesktop({ triplex: {} })).toBe(true)
    expect(isDesktop({})).toBe(false)
    expect(isDesktop(undefined)).toBe(false)
  })
})

describe('the browser path', () => {
  test('GETs each document and hands it to the browser as a download', async () => {
    const fetchMock = vi.fn(async (url) => ({ ok: true, status: 200, text: async () => `doc for ${url}` }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await exportViaBrowser({ ...ARGS, formats: ['md', 'html'] })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/conversations/c1/export/s1?format=md', '/api/conversations/c1/export/s1?format=html'])
    expect(clicks.map((c) => c.download)).toEqual(['triplex-t-send-s1.md', 'triplex-t-send-s1.html'])
    expect(clicks.every((c) => c.attached)).toBe(true) // a detached anchor never downloads
    expect(created).toHaveLength(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(document.querySelectorAll('a[download]')).toHaveLength(0) // removed again
    expect(out).toMatchObject({ state: 'done', downloaded: true })
    expect(resultLine(out)).toBe('Downloaded triplex-t-send-s1.md, triplex-t-send-s1.html')
  })

  test('an HTTP failure stops at the first format and reports the API error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ detail: { error: 'turn_not_found' } }) })))
    const out = await exportViaBrowser({ ...ARGS, formats: ['md', 'html'] })
    expect(out).toMatchObject({ state: 'error', code: 'turn_not_found' })
    expect(clicks).toHaveLength(0)
    expect(resultLine(out)).toBe('Export failed: turn_not_found')
  })

  test('a status with no error envelope still names the failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } })))
    const out = await exportViaBrowser({ ...ARGS, formats: ['md'] })
    expect(out).toMatchObject({ state: 'error', code: 'http_500' })
    expect(codeOf(null)).toBe('export_failed')
  })

  test('the path is url-encoded and carries nothing but the two ids and the format', () => {
    const p = exportPath('c 1', 's/1', 'md')
    expect(p).toBe('/api/conversations/c%201/export/s%2F1?format=md')
    expect(p).not.toMatch(/claude|chatgpt|grok|anon/i)
  })

  test("the endpoint's own filename suggestion names the download, from either header", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('html') ? docResponse('<h1/>', { 'content-disposition': 'attachment; filename="triplex-fusion-gyro-20260918-120000.html"' }) : docResponse('# doc', { 'x-triplex-export-filename': 'triplex-fusion-gyro-20260918-120000.md' }))))
    const out = await exportViaBrowser({ ...ARGS, turnId: 'f1', formats: ['md', 'html'] })
    expect(clicks.map((c) => c.download)).toEqual(['triplex-fusion-gyro-20260918-120000.md', 'triplex-fusion-gyro-20260918-120000.html'])
    expect(out.state).toBe('done')
  })

  test('a header that is a path, an extension swap or junk falls back to our own name', async () => {
    expect(safeSuggestedName('../../etc/passwd.md', 'md')).toBeNull()
    expect(safeSuggestedName('/abs/report.md', 'md')).toBeNull()
    expect(safeSuggestedName('C:\\win\\report.md', 'md')).toBeNull()
    expect(safeSuggestedName('.hidden.md', 'md')).toBeNull()
    expect(safeSuggestedName('report.html', 'md')).toBeNull() // asked for md, offered html
    expect(safeSuggestedName('', 'md')).toBeNull()
    expect(safeSuggestedName(`${'a'.repeat(300)}.md`, 'md')).toBeNull()
    expect(safeSuggestedName('report.md', 'md')).toBe('report.md')
    expect(suggestedName(null, 'md')).toBeNull()
    expect(suggestedName({ get: () => null }, 'md')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => docResponse('# doc', { 'x-triplex-export-filename': '../../etc/passwd.md' })))
    await exportViaBrowser({ ...ARGS, formats: ['md'] })
    expect(clicks.map((c) => c.download)).toEqual(['triplex-t-send-s1.md'])
  })

  test('fetchDocument returns the body text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '# Fusion report' })))
    await expect(fetchDocument('c1', 'f1', 'md')).resolves.toEqual({ text: '# Fusion report', suggested: null })
  })
})

describe('runExport dispatch', () => {
  test('the desktop preload wins, the browser path runs without it', async () => {
    const exportTurn = vi.fn(async () => ({ paths: ['/tmp/r.md'] }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => 'x' })))
    const viaDesktop = await runExport({ ...ARGS, formats: ['md'] }, { w: { triplex: { exportTurn } } })
    expect(viaDesktop.state).toBe('done')
    expect(exportTurn).toHaveBeenCalledTimes(1)

    const viaBrowser = await runExport({ ...ARGS, formats: ['md'] }, { w: {} })
    expect(viaBrowser).toMatchObject({ state: 'done', downloaded: true })
  })

  test('nothing to export and no format are refused before any call', async () => {
    const exportTurn = vi.fn()
    expect(await runExport({ conversationId: 'c1', turnId: null, formats: ['md'] }, { w: { triplex: { exportTurn } } })).toMatchObject({ state: 'error', code: 'nothing_to_export' })
    expect(await runExport({ ...ARGS, formats: [] }, { w: { triplex: { exportTurn } } })).toMatchObject({ state: 'error', code: 'no_format' })
    expect(exportTurn).not.toHaveBeenCalled()
  })

  test('resultLine: null for no outcome, null for a cancel, the files otherwise', () => {
    expect(resultLine(null)).toBeNull()
    expect(resultLine({ state: 'done', names: [] })).toBeNull()
    expect(resultLine({ state: 'error' })).toBe('Export failed: export_failed')
  })
})
