"""Analyze (extraction) prompts (owner: W5) — PLAN.md Appendix A, docs/semantics.md "Analyze".

Everything here is Triplex-authored text that reaches the analyst model, so it must stay free of
vendor/product names and slot ids (leak tests scan it). Model-authored responses are quoted data:
each one is wrapped with `prompts.delimited(label, response)` behind `QUOTED_DATA_NOTICE` so the
analyst never treats instructions found inside a response as its own. `delimited` neutralises
every `<<<` inside the quoted text (docs/semantics.md "Delimiter breakout"), so a response that
quotes the closing marker can never end its own block and spill into the instruction zone; the
blocks are otherwise verbatim.

Transport-aware JSON instruction (S7 review, MEASURED live on 2026-09-17): the ONE clause that
tells the analyst how to package its JSON is chosen by the transport, everything else in `SYSTEM`
is shared byte for byte (`SYSTEM_FENCED == SYSTEM.replace(JSON_INSTRUCTION,
JSON_INSTRUCTION_FENCED)`, pinned by tests/analyze/test_prompt.py).

- API transports (OpenRouter, Ollama): `JSON_INSTRUCTION` — "no prose, no code fences", PLAN.md
  Appendix A verbatim. The reply arrives as raw bytes, so a bare object is the cheapest shape.
- The web transport (`web:<slot>:analyst`, a hidden chat page driven by the desktop bridge):
  `JSON_INSTRUCTION_FENCED` asks for a ```json fence instead. The reply is read back out of the
  page's RENDERED markdown (`desktop/preload/site.cjs` `toMarkdown`/`replyText`), and a rendered
  paragraph is lossy: CommonMark resolves a backslash escape before any ASCII punctuation, so a
  correct `"he said \\"hi\\""` inside a JSON string renders as `"he said "hi""` and the captured
  text is no longer valid JSON. That is exactly how a real Analyze degraded with
  `parse_error: no JSON object found in the response` on both attempts. Inside a fenced code
  block markdown resolves nothing, so the bytes survive the round trip (proved end to end by the
  fake site's `?reply=fidelity`, whose fenced body carries `\\"quote\\"` and still JSON-parses).
"""

from __future__ import annotations

from ..schemas import LABELS, Label
from . import QUOTED_DATA_NOTICE, delimited

# System instructions: the analyst compares three anonymous responses on substance only.
_SYSTEM_RULES = """You are an analyst comparing three anonymous expert responses (R1, R2, R3) to the same question.

Identify (a) substantive points where the responses agree, and (b) substantive points where they disagree or give incompatible specifics (numbers, limits, register values, recommendations, claims of fact). Ignore differences of style, order, or emphasis. Judge on substance, not length or confidence of tone: a short, tentative answer and a long, assertive one carry equal weight.

Rules for the output:
- Number the divergences d1, d2, ... in order of appearance in the responses.
- Rate each divergence's materiality as "high" (the answers are incompatible on the core question), "medium" (a meaningful difference in a supporting detail) or "low" (a minor or peripheral difference).
- For each divergence, list a position for EVERY label (R1, R2 or R3) that takes a stance on it, with that label's claim in one sentence and the evidence it cites (or null).
- An agreement names the labels that share the statement; do not invent agreement where a response is silent.
- Refer to the responses only as R1, R2 and R3.

"""

# The one transport-dependent clause (module docstring). `JSON_INSTRUCTION` is Appendix A verbatim.
JSON_INSTRUCTION = "Return ONLY valid JSON matching this schema (no prose, no code fences):"
JSON_INSTRUCTION_FENCED = (
    "Return ONLY a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — and no prose outside the block. Inside the block write the JSON "
    "exactly as it must be parsed, with every double quote inside a string escaped as \\\". "
    "The JSON must match this schema:"
)

_SCHEMA = """{"agreements": [{"topic": string, "statement": string, "models": ["R1" | "R2" | "R3", ...]}],
 "divergences": [{"id": "d1" | "d2" | ..., "topic": string,
                  "positions": [{"model": "R1" | "R2" | "R3", "claim": string, "evidence_cited": string | null}],
                  "materiality": "high" | "medium" | "low"}]}"""

SYSTEM = _SYSTEM_RULES + JSON_INSTRUCTION + "\n" + _SCHEMA
SYSTEM_FENCED = _SYSTEM_RULES + JSON_INSTRUCTION_FENCED + "\n" + _SCHEMA

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


def system_message(*, fenced: bool = False) -> str:
    """The analyst instructions for this transport: `SYSTEM_FENCED` asks for a ```json fence (the
    web transport, whose reply is read back out of rendered markdown), `SYSTEM` forbids one (every
    API transport, Appendix A verbatim). Module docstring."""
    return SYSTEM_FENCED if fenced else SYSTEM


def build_messages(
    question: str, responses: dict[Label, str], *, fenced: bool = False
) -> list[dict[str, str]]:
    """`[system(instructions), user(question + delimited R1/R2/R3 blocks)]`.

    `fenced=True` (the caller passes `client.transport_kind(model) == "web"`) swaps ONLY the JSON
    instruction for the fenced one; the user message never depends on the transport."""
    return [
        {"role": "system", "content": system_message(fenced=fenced)},
        {"role": "user", "content": build_user(question, responses)},
    ]


def retry_message(error: str) -> str:
    return RETRY_USER_MESSAGE.format(error=error)


__all__ = [
    "JSON_INSTRUCTION",
    "JSON_INSTRUCTION_FENCED",
    "QUESTION_HEADER",
    "RESPONSES_HEADER",
    "RETRY_USER_MESSAGE",
    "SYSTEM",
    "SYSTEM_FENCED",
    "build_messages",
    "build_user",
    "retry_message",
    "system_message",
]
