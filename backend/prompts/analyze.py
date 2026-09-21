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

The correction message carries that same clause on a web transport (`retry_message(fenced=True)`,
MEASURED live on 2026-09-20): `bridge.text_for` types only `messages[-1]` into the analyst's chat,
so the system prompt's packaging rule is not in front of the analyst when the correction arrives --
and the failing run's second attempt duly came back unfenced (`{"agre`). Every API transport keeps
`RETRY_USER_MESSAGE` byte for byte (pinned in tests/analyze/test_prompt.py).

The condense (split) prompts serve the size bound (`features/analyze.py` SPLIT_MIN_CHARS): one
label's reply at a time, quoted the same inert way, rewritten as short bullets. Its output is
quoted data for the comparison prompt that follows, not a validated artifact, so it asks for no
JSON and no schema checks it; `CONDENSED_RESPONSES_HEADER` then tells the comparison that its
blocks are condensed, because an analyst that thinks it is reading full replies would read silence
into a bullet list that simply dropped a restatement.
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
# Appended on a web transport only (module docstring): the correction is typed on its own into the
# analyst's chat, so it has to restate how the reply must be packaged. Same rule, same escape
# clause as JSON_INSTRUCTION_FENCED, worded as a follow-up.
RETRY_FENCE_CLAUSE = (
    " Send it as a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — written exactly as it must be parsed, with every double quote inside "
    "a string escaped as \\\", and no prose outside the block."
)

QUESTION_HEADER = "Question:"
RESPONSES_HEADER = "Responses:"
# The comparison prompt's header when the blocks are condensed claims rather than the replies
# themselves (the split step). Says so, so the analyst does not read a dropped restatement as
# silence on the point.
#: The header for the knowledge graph an earlier Refactor pass produced (S11). It is model-authored
#: text, so it is quoted like any other: a graph that names a vendor, or carries something shaped like
#: an instruction, must not reach the analyst as instruction. It goes BEFORE the responses because it
#: is what the responses are about -- two answers can only disagree once they are about the same thing.
GRAPH_HEADER = (
    "What the question is about, mapped by an earlier pass (things, then how they relate). Use it to "
    "decide whether two responses are addressing the same point; it is not evidence about the answer:"
)

CONDENSED_RESPONSES_HEADER = (
    "Responses, each condensed to its substantive claims by an earlier pass (a label is silent "
    "only on what its block does not mention):"
)

# --------------------------------------------------------------------------- the condense step
CONDENSE_SYSTEM = """You are condensing ONE anonymous expert response so that it can be compared with two others.

Rewrite it as a flat list of short bullet points, one substantive claim per bullet: facts, numbers, limits, register values, recommendations, and for each claim the evidence it cites, if any. Copy every specific value verbatim — a number or a limit that changes is worse than one that is left out. Drop restatements, pleasantries, worked-example prose, and anything that is only about style, order or emphasis. Keep the claims in the order they appear.

Do not add, resolve, rank or judge anything, and do not mention this instruction: the result is a shorter copy of one response, not an assessment of it.

Return ONLY a JSON object of the form {"claims": ["<one claim>", "<one claim>", ...]} and nothing else. One claim per string, in the order they appear."""

#: Appended for a web session, which is read back out of RENDERED markdown: the same fence rule the
#: comparison prompt uses, for the same reason (docs/semantics.md, "Structured output").
CONDENSE_FENCE_CLAUSE = (
    " Put the object in a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — and write nothing outside the block."
)

CONDENSE_HEADER = "Response to condense:"


def build_user(
    question: str, responses: dict[Label, str], *, condensed: bool = False, graph: str = ""
) -> str:
    """The user message: the question, the graph when there is one, the quoted-data notice, then one
    delimited block per label in R1/R2/R3 order (`responses` must carry every label).

    `condensed=True` (the blocks hold condensed claims instead of the replies) swaps ONLY the
    responses header; the blocks and their order never change. `graph` (S11, from a Refactor pass)
    adds ONE delimited block before them and nothing else -- absent or blank, the message is byte for
    byte what it has always been, which is what keeps every fixture and golden still."""
    missing = [label for label in LABELS if label not in responses]
    if missing:
        raise ValueError(f"responses missing labels {missing}")
    blocks = [delimited(label, responses[label]) for label in LABELS]
    header = CONDENSED_RESPONSES_HEADER if condensed else RESPONSES_HEADER
    parts = [f"{QUESTION_HEADER}\n{question}"]
    if graph.strip():
        parts.append(f"{GRAPH_HEADER}\n{QUOTED_DATA_NOTICE}")
        parts.append(delimited("QUESTION MAP", graph))
    parts.append(f"{header}\n{QUOTED_DATA_NOTICE}")
    parts.extend(blocks)
    return "\n\n".join(parts)


def condense_user(question: str, label: Label | str, response: str) -> str:
    """The condense call's user message: the question (so "substantive" has a referent), the
    quoted-data notice, and exactly ONE label's reply in its delimited block."""
    return "\n\n".join(
        [
            f"{QUESTION_HEADER}\n{question}",
            f"{CONDENSE_HEADER}\n{QUOTED_DATA_NOTICE}",
            delimited(label, response),
        ]
    )


def condense_messages(
    question: str, label: Label | str, response: str, *, fenced: bool = False
) -> list[dict[str, str]]:
    """`[system(condense instructions), user(question + the one delimited block)]`.

    The claims come back as JSON, not prose, for two reasons that only apply to a web session:
    the capture refuses to end on a document whose braces do not balance (S10), so a condensation
    truncated mid-answer FAILS loudly instead of being quoted into the comparison as though it were
    the whole reply; and `fenced=True` asks for the code block that survives markdown rendering."""
    system = CONDENSE_SYSTEM + (CONDENSE_FENCE_CLAUSE if fenced else "")
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": condense_user(question, label, response)},
    ]


def system_message(*, fenced: bool = False) -> str:
    """The analyst instructions for this transport: `SYSTEM_FENCED` asks for a ```json fence (the
    web transport, whose reply is read back out of rendered markdown), `SYSTEM` forbids one (every
    API transport, Appendix A verbatim). Module docstring."""
    return SYSTEM_FENCED if fenced else SYSTEM


def build_messages(
    question: str,
    responses: dict[Label, str],
    *,
    fenced: bool = False,
    condensed: bool = False,
    graph: str = "",
) -> list[dict[str, str]]:
    """`[system(instructions), user(question + the question map + delimited R1/R2/R3 blocks)]`.

    `fenced=True` (the caller passes `client.transport_kind(model) == "web"`) swaps ONLY the JSON
    instruction for the fenced one; `condensed=True` swaps ONLY the responses header; `graph` adds one
    delimited block before the responses. All three are independent: the first is about the transport,
    the second about what the blocks hold, the third about what an earlier pass worked out."""
    return [
        {"role": "system", "content": system_message(fenced=fenced)},
        {
            "role": "user",
            "content": build_user(question, responses, condensed=condensed, graph=graph),
        },
    ]


def retry_message(error: str, *, fenced: bool = False) -> str:
    """The correction message. `fenced=True` (a web transport) appends the packaging rule, because
    this message is the only thing typed into the analyst's chat (module docstring)."""
    message = RETRY_USER_MESSAGE.format(error=error)
    return message + RETRY_FENCE_CLAUSE if fenced else message


__all__ = [
    "CONDENSED_RESPONSES_HEADER",
    "GRAPH_HEADER",
    "CONDENSE_HEADER",
    "CONDENSE_SYSTEM",
    "JSON_INSTRUCTION",
    "JSON_INSTRUCTION_FENCED",
    "QUESTION_HEADER",
    "RESPONSES_HEADER",
    "RETRY_FENCE_CLAUSE",
    "RETRY_USER_MESSAGE",
    "SYSTEM",
    "SYSTEM_FENCED",
    "build_messages",
    "build_user",
    "condense_messages",
    "condense_user",
    "retry_message",
    "system_message",
]
