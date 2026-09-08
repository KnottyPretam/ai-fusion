"""Analyze (extraction) prompts (owner: W5) — PLAN.md Appendix A, docs/semantics.md "Analyze".

Everything here is Triplex-authored text that reaches the analyst model, so it must stay free of
vendor/product names and slot ids (leak tests scan it). Model-authored responses are quoted data:
each one is wrapped with `prompts.delimited(label, response)` behind `QUOTED_DATA_NOTICE` so the
analyst never treats instructions found inside a response as its own.
"""

from __future__ import annotations

from ..schemas import LABELS, Label
from . import QUOTED_DATA_NOTICE, delimited

# System instructions: the analyst compares three anonymous responses on substance only.
SYSTEM = """You are an analyst comparing three anonymous expert responses (R1, R2, R3) to the same question.

Identify (a) substantive points where the responses agree, and (b) substantive points where they disagree or give incompatible specifics (numbers, limits, register values, recommendations, claims of fact). Ignore differences of style, order, or emphasis. Judge on substance, not length or confidence of tone: a short, tentative answer and a long, assertive one carry equal weight.

Rules for the output:
- Number the divergences d1, d2, ... in order of appearance in the responses.
- Rate each divergence's materiality as "high" (the answers are incompatible on the core question), "medium" (a meaningful difference in a supporting detail) or "low" (a minor or peripheral difference).
- For each divergence, list a position for EVERY label (R1, R2 or R3) that takes a stance on it, with that label's claim in one sentence and the evidence it cites (or null).
- An agreement names the labels that share the statement; do not invent agreement where a response is silent.
- Refer to the responses only as R1, R2 and R3.

Return ONLY valid JSON matching this schema (no prose, no code fences):
{"agreements": [{"topic": string, "statement": string, "models": ["R1" | "R2" | "R3", ...]}],
 "divergences": [{"id": "d1" | "d2" | ..., "topic": string,
                  "positions": [{"model": "R1" | "R2" | "R3", "claim": string, "evidence_cited": string | null}],
                  "materiality": "high" | "medium" | "low"}]}"""

# Sent as a follow-up user message when the first attempt fails lenient parsing or validation
# (docs/semantics.md "Analyze": Analyze drives its single retry itself).
RETRY_USER_MESSAGE = (
    "Your previous output failed validation: {error}. Return only the corrected JSON."
)

QUESTION_HEADER = "Question:"
RESPONSES_HEADER = "Responses:"


def build_user(question: str, responses: dict[Label, str]) -> str:
    """The user message: the question, the quoted-data notice, then one delimited block per
    label in R1/R2/R3 order (`responses` must carry every label)."""
    missing = [label for label in LABELS if label not in responses]
    if missing:
        raise ValueError(f"responses missing labels {missing}")
    blocks = [delimited(label, responses[label]) for label in LABELS]
    return "\n\n".join(
        [
            f"{QUESTION_HEADER}\n{question}",
            f"{RESPONSES_HEADER}\n{QUOTED_DATA_NOTICE}",
            *blocks,
        ]
    )


def build_messages(question: str, responses: dict[Label, str]) -> list[dict[str, str]]:
    """`[system(instructions), user(question + delimited R1/R2/R3 blocks)]`."""
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": build_user(question, responses)},
    ]


def retry_message(error: str) -> str:
    return RETRY_USER_MESSAGE.format(error=error)


__all__ = [
    "QUESTION_HEADER",
    "RESPONSES_HEADER",
    "RETRY_USER_MESSAGE",
    "SYSTEM",
    "build_messages",
    "build_user",
    "retry_message",
]
