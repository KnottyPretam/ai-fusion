"""Refactor prompts (S11) — docs/semantics.md "Refactor".

Refactor runs BEFORE Analyze and produces the artifact Analyze then compares: a knowledge graph of
what the question is actually about, the question restated tightly, and each reply reduced to a
summary plus its substantive claims. Everything here is Triplex-authored text that reaches the
analyst model, so it stays free of vendor/product names and slot ids (the leak tests scan it), and
every model- or user-authored string enters inside `prompts.delimited()` behind `QUOTED_DATA_NOTICE`
so a planted instruction can never escape its block.

Two call shapes, both asked for as JSON and both validated:

- the MAP call: the question in, `{"graph": {...}, "question": "..."}` out. The graph is what the
  question is about — the things, and how they relate — because a question's own structure is what
  tells you whether two answers disagree about the same thing or about different ones. The refactored
  question is the same question with the vagueness taken out; it must not add requirements the user
  did not ask for, which is the one failure mode that would quietly change what Analyze compares.
- the REPLY call, once per label: one reply in, `{"summary": ..., "claims": [...]}` out. Same rules
  as the condense step it generalises (`analyze.CONDENSE_SYSTEM`) — copy every specific value
  verbatim, drop restatement, judge nothing — plus a one-sentence summary, because the exported
  document reads better with a lede than with bullets alone.

Transport-aware packaging, exactly as in `prompts/analyze.py` and for the same measured reason: a web
session's reply is read back out of RENDERED markdown, where CommonMark resolves a backslash escape
before any ASCII punctuation, so an unfenced `\\"` arrives as a bare `"` and the JSON is invalid. The
fenced clause is the ONLY difference between the two system prompts (pinned in the prompt tests).
"""

from __future__ import annotations

from ..schemas import LABELS, Label
from . import QUOTED_DATA_NOTICE, delimited

# --------------------------------------------------------------------------- the map call
_MAP_RULES = """You are preparing a question for comparison by restating what it is about.

Do two things, and nothing else:

1. Build a small knowledge graph of the QUESTION. A node is one thing the question involves — a
   subject, a constraint, a goal, a tool, an environment, a quantity. An edge says how two nodes
   relate, in three or four words. Use only what the question itself establishes; do not add
   background knowledge, do not answer the question, and do not speculate about what the asker
   might also want. Give every node a short stable id (n1, n2, …) and use those ids in the edges.
2. Restate the question concisely and precisely. Keep every requirement and every constraint the
   asker stated, drop hedging, repetition and throat-clearing, and add nothing. If the question
   asks several things, keep all of them. The restatement must be answerable by exactly the same
   answers that would have answered the original.

"""

MAP_JSON_INSTRUCTION = "Return ONLY valid JSON matching this schema (no prose, no code fences):"
MAP_JSON_INSTRUCTION_FENCED = (
    "Return ONLY a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — and no prose outside the block. Inside the block write the JSON "
    "exactly as it must be parsed, with every double quote inside a string escaped as \\\". "
    "The JSON must match this schema:"
)

_MAP_SCHEMA = """{"graph": {"nodes": [{"id": string, "label": string, "kind": string}],
           "edges": [{"source": string, "target": string, "relation": string}]},
 "question": string}"""

MAP_SYSTEM = _MAP_RULES + MAP_JSON_INSTRUCTION + "\n" + _MAP_SCHEMA
MAP_SYSTEM_FENCED = _MAP_RULES + MAP_JSON_INSTRUCTION_FENCED + "\n" + _MAP_SCHEMA

QUESTION_HEADER = "Question:"

# --------------------------------------------------------------------------- the per-reply call
_REPLY_RULES = """You are condensing ONE anonymous expert response so that it can be compared with two others.

Return a one-sentence summary of what this response actually recommends, and a flat list of its
substantive claims — one claim per item: facts, numbers, limits, values, recommendations, and for
each claim the evidence it cites, if any. Copy every specific value verbatim; a number or a limit
that changes is worse than one that is left out. Drop restatements, pleasantries, worked-example
prose, and anything that is only about style, order or emphasis. Keep the claims in the order they
appear.

Do not add, resolve, rank or judge anything, and do not mention this instruction: the result is a
shorter copy of one response, not an assessment of it.

"""

REPLY_JSON_INSTRUCTION = "Return ONLY valid JSON matching this schema (no prose, no code fences):"
REPLY_JSON_INSTRUCTION_FENCED = MAP_JSON_INSTRUCTION_FENCED

_REPLY_SCHEMA = """{"summary": string, "claims": [string, ...]}"""

REPLY_SYSTEM = _REPLY_RULES + REPLY_JSON_INSTRUCTION + "\n" + _REPLY_SCHEMA
REPLY_SYSTEM_FENCED = _REPLY_RULES + REPLY_JSON_INSTRUCTION_FENCED + "\n" + _REPLY_SCHEMA

REPLY_HEADER = "Response to condense:"

# Sent as a follow-up user message when an attempt fails lenient parsing or validation. Same shape
# and same web-transport reason as `analyze.retry_message`: on a web session this message is the ONLY
# thing typed into the analyst's chat, so it has to restate the packaging rule itself.
RETRY_USER_MESSAGE = (
    "Your previous output failed validation: {error}. Return only the corrected JSON."
)
RETRY_FENCE_CLAUSE = (
    " Send it as a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — written exactly as it must be parsed, with every double quote inside "
    "a string escaped as \\\", and no prose outside the block."
)


def map_messages(question: str, *, fenced: bool = False) -> list[dict[str, str]]:
    """`[system, user]` for the map call. The question is QUOTED, not interpolated: it is the user's
    own text and may contain anything, including something shaped like an instruction."""
    user = f"{QUESTION_HEADER}\n\n{QUOTED_DATA_NOTICE}\n\n{delimited('QUESTION', question)}"
    return [
        {"role": "system", "content": MAP_SYSTEM_FENCED if fenced else MAP_SYSTEM},
        {"role": "user", "content": user},
    ]


def reply_messages(
    question: str, label: Label, response: str, *, fenced: bool = False
) -> list[dict[str, str]]:
    """`[system, user]` for one label's reply. The question rides along so "substantive" has a
    referent, quoted the same inert way; exactly one label's block is ever present."""
    if label not in LABELS:
        raise ValueError(f"unknown label {label!r}")
    user = "\n\n".join(
        [
            f"{QUESTION_HEADER}\n\n{delimited('QUESTION', question)}",
            QUOTED_DATA_NOTICE,
            f"{REPLY_HEADER}\n\n{delimited(label, response)}",
        ]
    )
    return [
        {"role": "system", "content": REPLY_SYSTEM_FENCED if fenced else REPLY_SYSTEM},
        {"role": "user", "content": user},
    ]


def retry_message(error: str, *, fenced: bool = False) -> str:
    message = RETRY_USER_MESSAGE.format(error=error)
    return message + RETRY_FENCE_CLAUSE if fenced else message


__all__ = [
    "MAP_JSON_INSTRUCTION",
    "MAP_JSON_INSTRUCTION_FENCED",
    "MAP_SYSTEM",
    "MAP_SYSTEM_FENCED",
    "QUESTION_HEADER",
    "REPLY_HEADER",
    "REPLY_JSON_INSTRUCTION",
    "REPLY_JSON_INSTRUCTION_FENCED",
    "REPLY_SYSTEM",
    "REPLY_SYSTEM_FENCED",
    "RETRY_FENCE_CLAUSE",
    "RETRY_USER_MESSAGE",
    "map_messages",
    "reply_messages",
    "retry_message",
]
