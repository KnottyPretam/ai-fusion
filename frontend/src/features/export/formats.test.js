import { describe, expect, test } from 'vitest'
import { BROWSER_FORMATS, FORMATS, allLabel, availableFormats, baseNameOf, defaultBaseName, fileNameFor, formatsFor, latestChatTurn, latestTurnOfType, shortId, slugify } from './formats.js'

describe('export naming', () => {
  test('slugify collapses punctuation, drops diacritics and never returns an empty stem', () => {
    expect(slugify('What is the BMI088 gyro range?')).toBe('what-is-the-bmi088-gyro-range')
    expect(slugify('  Übergröße / Föö  ')).toBe('ubergro-e-foo') // diacritics drop; ß is not decomposable and collapses like punctuation
    expect(slugify('')).toBe('conversation')
    expect(slugify(null)).toBe('conversation')
    expect(slugify('***')).toBe('conversation')
    expect(slugify('a'.repeat(80)).length).toBe(40)
    // a truncation that lands on a separator does not leave a trailing dash
    expect(slugify('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b')).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  test('the default base name carries title, feature and turn, and gets one extension per format', () => {
    const base = defaultBaseName({ title: 'BMI088 datasheet', feature: 'fusion', turnId: 'f1abcdef-1234-4000-8000-000000000000' })
    expect(base).toBe('triplex-bmi088-datasheet-fusion-f1abcdef')
    expect(fileNameFor(base, 'md')).toBe('triplex-bmi088-datasheet-fusion-f1abcdef.md')
    expect(fileNameFor(base, 'pdf')).toBe('triplex-bmi088-datasheet-fusion-f1abcdef.pdf')
    expect(defaultBaseName({ title: '', feature: 'send', turnId: '' })).toBe('triplex-conversation-send-turn')
    expect(shortId('s1')).toBe('s1')
  })

  test('baseNameOf takes the file name off a posix or windows path', () => {
    expect(baseNameOf('/home/u/Documents/report.md')).toBe('report.md')
    expect(baseNameOf('C:\\Users\\u\\report.pdf')).toBe('report.pdf')
    expect(baseNameOf('report.html')).toBe('report.html')
    expect(baseNameOf(null)).toBe('')
  })
})

describe('formats per shell', () => {
  test('the desktop offers all three, the browser only the two it can make itself', () => {
    expect(FORMATS).toEqual(['md', 'html', 'pdf'])
    expect(availableFormats(true)).toEqual(['md', 'html', 'pdf'])
    expect(availableFormats(false)).toEqual(BROWSER_FORMATS)
    expect(availableFormats(false)).not.toContain('pdf')
  })

  test('one choice resolves to the formats the shell can produce', () => {
    expect(formatsFor('md', false)).toEqual(['md'])
    expect(formatsFor('all', true)).toEqual(['md', 'html', 'pdf'])
    expect(formatsFor('all', false)).toEqual(['md', 'html'])
    expect(formatsFor('pdf', false)).toEqual([]) // never requested from the browser
    expect(formatsFor('pdf', true)).toEqual(['pdf'])
  })

  test('the "all" label never promises a PDF the browser cannot render', () => {
    expect(allLabel(true)).toContain('.pdf')
    expect(allLabel(false)).not.toContain('pdf')
  })
})

describe('latestTurnOfType', () => {
  const conv = { turns: [{ type: 'send', id: 's1' }, { type: 'analyze', id: 'a1' }, { type: 'send', id: 's2' }, { type: 'fusion', id: 'f1' }] }
  test('picks the last turn of the type, and null when there is none', () => {
    expect(latestTurnOfType(conv, 'send').id).toBe('s2')
    expect(latestTurnOfType(conv, 'analyze').id).toBe('a1')
    expect(latestTurnOfType(conv, 'fusion').id).toBe('f1')
    expect(latestTurnOfType({ turns: [] }, 'send')).toBeNull()
    expect(latestTurnOfType(null, 'send')).toBeNull()
  })

  test('the Send columns export the newest chat step: a solo continue after a send wins', () => {
    expect(latestChatTurn(conv).id).toBe('s2')
    const withContinue = { turns: [...conv.turns, { type: 'continue', id: 'k9', slot: 'claude' }] }
    expect(latestChatTurn(withContinue)).toMatchObject({ id: 'k9', type: 'continue' })
    // an analyze or fusion turn after it never becomes the chat step
    expect(latestChatTurn({ turns: [...withContinue.turns, { type: 'fusion', id: 'f2' }] }).id).toBe('k9')
    expect(latestChatTurn({ turns: [{ type: 'analyze', id: 'a1' }] })).toBeNull()
    expect(latestChatTurn(null)).toBeNull()
  })
})
