// answerFormat (2026-10-15): the renderer's mirror of backend/prompts/preparse.py ANSWER_FORMAT and the
// compose() rule the "Concise answers" switch applies. The byte-for-byte pin against the Python constant
// is tests/analyze/test_preparse.py; these pin the append rule.
import { describe, expect, test } from 'vitest'
import { ANSWER_FORMAT, withAnswerFormat } from './answerFormat.js'

describe('answerFormat', () => {
  test('the block is the answer format Analyze reads: at most 8 claims, under 4,000 characters, no tables', () => {
    expect(ANSWER_FORMAT.startsWith('Answer format, follow it exactly:\n')).toBe(true)
    for (const phrase of ['at most 8 claims', 'Key claims:', 'Uncertain:', '4,000 characters', 'no tables']) expect(ANSWER_FORMAT).toContain(phrase)
    expect(ANSWER_FORMAT).not.toMatch(/\r/)
    expect(ANSWER_FORMAT).toBe(ANSWER_FORMAT.trim())
  })

  test('appends after a blank line, as compose() does; trailing whitespace goes, leading whitespace and inner newlines stay', () => {
    expect(withAnswerFormat('q')).toBe(`q\n\n${ANSWER_FORMAT}`)
    expect(withAnswerFormat('q  \n\t\n')).toBe(`q\n\n${ANSWER_FORMAT}`)
    expect(withAnswerFormat('  q\nline two')).toBe(`  q\nline two\n\n${ANSWER_FORMAT}`)
  })

  test('never doubles the block: a Pre-parsed prompt (trailing whitespace too) is returned untouched', () => {
    const composed = withAnswerFormat('q')
    expect(withAnswerFormat(composed)).toBe(composed)
    expect(withAnswerFormat(`${composed}\n  `)).toBe(`${composed}\n  `)
    expect(withAnswerFormat(ANSWER_FORMAT)).toBe(ANSWER_FORMAT)
  })

  test('a block that is not at the end, or a different block, is user text: the block is still appended', () => {
    const mid = `${ANSWER_FORMAT}\n\nand one more question`
    expect(withAnswerFormat(mid)).toBe(`${mid}\n\n${ANSWER_FORMAT}`)
    const loose = 'q\n\nAnswer format, follow it loosely'
    expect(withAnswerFormat(loose)).toBe(`${loose}\n\n${ANSWER_FORMAT}`)
  })

  test('a blank text is returned as it is: the block alone is not a question', () => {
    expect(withAnswerFormat('')).toBe('')
    expect(withAnswerFormat('   \n')).toBe('   \n')
  })
})
