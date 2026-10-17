// The answer-format block (2026-10-15) — what the prompt bar's "Concise answers" switch appends to a
// Send. A VERBATIM mirror of backend/prompts/preparse.py `ANSWER_FORMAT` (features never import the
// backend): keep the two in step, byte for byte — tests/analyze/test_preparse.py reads the template
// literal below out of this file and pins it against the Python constant. The literal holds no
// backslash, backtick or `${`, so the source text IS the runtime value; keep it that way.
//
// Why it exists on the renderer too: measured 2026-10-15, replies of 7,747 / 24,963 / 6,065
// characters cost Analyze 16 sequential condense calls (34.5 min on the analyst page) and still
// degraded. Pre-parse appends this block, but only after an analyst round-trip; the switch appends the
// same block with no call, so the replies come back short enough for Analyze to compare in one call.
// The backend recognises it as its own scaffold (`strip_format`): the auto-title, Refactor and
// Analyze see the question without it.

export const ANSWER_FORMAT = `Answer format, follow it exactly:
First, one paragraph that answers the question directly.
Then a line "Key claims:" and a numbered list of at most 8 claims your answer rests on, most
important first. Each item is ONE sentence, then " — because: " and ONE sentence of reasoning
or evidence.
Then a line "Uncertain:" and one sentence naming what you are not sure of, or "none".
Never ask a clarifying question or wait for input: if something is ambiguous, state your
assumption and answer under it.
Keep the whole reply under 4,000 characters (about 500 words). No preamble, no closing
summary, no other headings, no tables, and no code fences unless the question asks for code.`

/**
 * `text` with the answer block appended the way backend `compose()` appends it: trailing whitespace
 * dropped, a blank line, the block. A text whose trimmed end already IS the block (a Pre-parsed
 * prompt — the backend's `strip_format` test) is returned untouched, so the block is never doubled.
 * A blank text is returned as it is: the block alone is not a question (`compose()` refuses one).
 * Leading whitespace is the user's and is kept.
 */
export function withAnswerFormat(text) {
  const trimmed = text.trimEnd()
  if (trimmed.trim() === '' || trimmed.endsWith(ANSWER_FORMAT)) return text
  return `${trimmed}\n\n${ANSWER_FORMAT}`
}
