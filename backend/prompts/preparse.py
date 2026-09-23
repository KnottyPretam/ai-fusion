"""Pre-parse prompts — docs/semantics.md "Pre-parse".

Pre-parse is a PREVIEW step in front of Send: one analyst call restates the composer text clearly
and succinctly, and Triplex then appends a deterministic answer-format block so that the three
replies come back short and in a shape Refactor and Analyze can read in one message each. Measured
2026-09-22 on a live run: replies of 5,057 / 6,990 / 14,078 characters cost Refactor seven analyst
calls and Analyze seven condense calls before its comparison; a reply under 4,000 characters fits
one analyst message, and three of them stay under `analyze.SPLIT_MIN_CHARS`.

Two Triplex-authored texts leave this module, and only the first ever reaches the analyst:

- the RESTATE call: the question in, `{"question": "..."}` out. It restates, it never answers, and
  it must not narrow or widen what is asked — the same failure mode Refactor's map call guards
  against, because the restatement becomes the prompt the user sends. The question is QUOTED behind
  `QUOTED_DATA_NOTICE` (it is the user's own text and may contain anything) with the house pattern
  of `prompts/refactor.py`: rules + JSON instruction + schema, a fenced twin for a web analyst
  differing ONLY in the packaging clause (pinned in the tests), the shared instruction and retry
  strings imported from Refactor rather than copied.
- `ANSWER_FORMAT`: the block `compose()` appends to the restated question. It is appended
  deterministically, never asked of the model, and it goes LAST so the question is what the eye
  lands on in the composer. That ordering alone keeps `send.title_from_prompt` (`prompt[:60]`) on
  the question only for a question of 60 or more characters: a shorter one — the succinct
  restatement this step exists to produce — runs out before the cut, so the first Send has to
  title from `strip_format(prompt)`, never from the composed text, or the block's first line
  bleeds into the sidebar and every exported document. It asks for at most 8 claims, "most
  important first" (Analyze numbers divergences in order of appearance, so d1 becomes the most
  material one) in the `— because:` shape that maps 1:1 onto what Refactor's reply call and
  Analyze's `evidence_cited` extract, no tables (the markdown reader handles lists better), and it
  is English whatever the question's language — deterministic beats translated; a known limitation.

`strip_format()` is the inverse Triplex applies to its OWN scaffold before the analyst quotes the
question again (Refactor's map and reply calls, Analyze's raw-reply path, a second Pre-parse):
otherwise the map rules would faithfully fold "at most 8 claims… no tables" into the restated
question that heads the comparison prompt and the exported document. It removes exactly the
constant, never user text.

Every string here reaches a model or becomes the user's prompt, so it stays free of vendor/product
names, slot ids and R-labels (the leak tests scan it).
"""

from __future__ import annotations

from . import QUOTED_DATA_NOTICE, delimited
from .refactor import MAP_JSON_INSTRUCTION as RESTATE_JSON_INSTRUCTION
from .refactor import MAP_JSON_INSTRUCTION_FENCED as RESTATE_JSON_INSTRUCTION_FENCED
from .refactor import RETRY_FENCE_CLAUSE, RETRY_USER_MESSAGE, retry_message

# --------------------------------------------------------------------------- the restate call
_RESTATE_RULES = """You are restating a question so that it can be put to three experts clearly, and nothing else.

Rewrite the QUESTION clearly and succinctly. Keep every constraint, number, unit, named thing,
requested output form, and the asker's evident intent; if it asks several things, keep all of
them in the order asked. Drop hedging, repetition and throat-clearing. Do not answer it, do not
add assumptions, requirements or background the asker did not state, and do not narrow or widen
what is being asked: the restatement must be answerable by exactly the same answers as the
original. If the question is already clear, return it with minimal edits. Write in the language
the question is written in, as plain text: no markdown headings; a short numbered list only when
the question has several parts.

"""

_RESTATE_SCHEMA = '{"question": string}'

RESTATE_SYSTEM = _RESTATE_RULES + RESTATE_JSON_INSTRUCTION + "\n" + _RESTATE_SCHEMA
RESTATE_SYSTEM_FENCED = _RESTATE_RULES + RESTATE_JSON_INSTRUCTION_FENCED + "\n" + _RESTATE_SCHEMA

# Deliberately not Refactor's `Question:` so a fake site can key a canned reply on it.
QUESTION_HEADER = "Question to restate:"

# --------------------------------------------------------------------------- the answer block
ANSWER_FORMAT = """Answer format, follow it exactly:
First, one paragraph that answers the question directly.
Then a line "Key claims:" and a numbered list of at most 8 claims your answer rests on, most
important first. Each item is ONE sentence, then " — because: " and ONE sentence of reasoning
or evidence.
Then a line "Uncertain:" and one sentence naming what you are not sure of, or "none".
Keep the whole reply under 4,000 characters (about 500 words). No preamble, no closing
summary, no other headings, no tables, and no code fences unless the question asks for code."""


def compose(question: str) -> str:
    """The prompt Pre-parse hands back: the restated question, then the answer block. The block
    goes LAST so the question comes first in the composer; the auto-title has to be taken from
    `strip_format(prompt)`, because `prompt[:60]` of a question shorter than 60 characters would
    reach into the block."""
    text = question.strip()
    if not text:
        raise ValueError("cannot compose an empty question")
    return text + "\n\n" + ANSWER_FORMAT


def strip_format(prompt: str) -> str:
    """`prompt` without a trailing `ANSWER_FORMAT` (exact match after `rstrip`), the whitespace
    `compose` put between them gone too, so `strip_format(compose(q)) == q.strip()`. Anything else
    is returned untouched: this only ever removes Triplex's own constant, never user text."""
    text = prompt.rstrip()
    if text.endswith(ANSWER_FORMAT):
        return text[: -len(ANSWER_FORMAT)].rstrip()
    return prompt


def restate_messages(question: str, *, fenced: bool = False) -> list[dict[str, str]]:
    """`[system, user]` for the restate call — byte for byte the shape of `refactor.map_messages`,
    so its hostile-input tests transfer: the question is QUOTED, not interpolated."""
    user = f"{QUESTION_HEADER}\n\n{QUOTED_DATA_NOTICE}\n\n{delimited('QUESTION', question)}"
    return [
        {"role": "system", "content": RESTATE_SYSTEM_FENCED if fenced else RESTATE_SYSTEM},
        {"role": "user", "content": user},
    ]


__all__ = [
    "ANSWER_FORMAT",
    "QUESTION_HEADER",
    "RESTATE_JSON_INSTRUCTION",
    "RESTATE_JSON_INSTRUCTION_FENCED",
    "RESTATE_SYSTEM",
    "RESTATE_SYSTEM_FENCED",
    "RETRY_FENCE_CLAUSE",
    "RETRY_USER_MESSAGE",
    "compose",
    "restate_messages",
    "retry_message",
    "strip_format",
]
