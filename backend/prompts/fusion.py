"""Fusion prompts (owner: W6): the per-label challenge and the analyst convergence check.

PLAN.md Appendix A, tuned per docs/semantics.md "Fusion". Everything here is Triplex-authored
text that reaches a model, so it must stay free of vendor/product names and slot ids (leak tests
scan it); models are only ever named R1/R2/R3.

- The challenge is a USER message appended to the challenged slot's own thread ("On the question
  above ..."). The divergence topic, the label's current claim, its latest justification and the
  anonymised peer block are quoted material: each sits inside the shared `delimited()` markers,
  preceded by `QUOTED_DATA_NOTICE`, so an instruction planted in a model response can only ever
  appear between `<<<X>>>` and `<<<END X>>>` (docs/semantics.md addendum "Delimiter breakout":
  the topic is analyst-authored text derived from the responses, so it is never interpolated
  into the instruction zone; the caller scrubs it with `anon.scrub` first -- this package cannot
  import `anon`). The peer block comes from `anon.render_peer_block` (already scrubbed,
  delimited per peer and prefixed with the notice) and is treated as opaque.
- The anti-sycophancy clause is Appendix A verbatim and the JSON instruction asks for
  `persuaded_by`: a `revise` that names no specific peer point is flagged by
  `schemas.is_unjustified`.
- The convergence check goes to the analyst as `[system, user]`; the user message carries one
  object per divergence `{"divergence_id", "topic", "claims": {"R1": ..., ...}}` inside a
  delimited block and the analyst is told to answer only `resolved | standing`.
- Transport-aware JSON instruction (S7 review, MEASURED live on 2026-09-17): only the LEAD of each
  JSON instruction depends on the transport (`DEFENSE_JSON_LEAD` / `CONVERGENCE_JSON_LEAD` vs
  their `_FENCED` twins). An API transport is told "no prose, no code fences" (Appendix A
  verbatim); a `web:` session — a real chat page driven by the desktop bridge, whose reply is read
  back out of the page's RENDERED markdown by `desktop/preload/site.cjs` — is asked for a ```json
  fence, because a rendered paragraph resolves CommonMark backslash escapes (a correct
  `\\"quote\\"` inside a JSON string comes back as a bare `"quote"`, which no longer parses)
  while a fenced code block resolves nothing and survives byte for byte. The key list, the form,
  the anti-sycophancy clause, the round counter and every delimited block are shared, so the API
  payloads stay byte-identical (`backend/prompts/analyze.py` carries the same rule).
"""

from __future__ import annotations

import json
from typing import Any

from . import QUOTED_DATA_NOTICE, delimited

CLAIM_LABEL = "YOUR CLAIM"
JUSTIFICATION_LABEL = "YOUR JUSTIFICATION"
DIVERGENCES_LABEL = "DIVERGENCES"
TOPIC_LABEL = "TOPIC"

TOPIC_LEAD = "On the question above, regarding this topic:"
POSITION_LEAD = "Your current position is:"
JUSTIFICATION_LEAD = "Your latest justification for it:"
PEERS_LEAD = "Anonymous peer reviewers currently hold:"

# PLAN.md Appendix A, verbatim. Tests assert this clause is present in every challenge payload.
ANTI_SYCOPHANCY_CLAUSE = (
    "Either DEFEND your position with your strongest specific justification (cite sources or "
    "reasoning, not authority), or REVISE it — but only if a specific point above actually "
    "persuades you. Being persuaded by a correct peer is success; caving without cause is "
    "failure."
)
ROUND_COUNTER = "This is round {round} of at most {max_iterations}."

# The one transport-dependent clause of each JSON instruction (module docstring). The `_LEAD`
# constants are the only difference between the API and the web variant; the key list and the
# form below them are shared byte for byte.
DEFENSE_JSON_LEAD = "Return ONLY valid JSON (no prose, no code fences) with exactly these keys:\n"
DEFENSE_JSON_LEAD_FENCED = (
    "Return ONLY a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — and no prose outside the block. Inside the block write the JSON "
    "exactly as it must be parsed, with every double quote inside a string escaped as \\\". "
    "The JSON must have exactly these keys:\n"
)
_DEFENSE_KEYS = (
    '{"stance": "defend" | "revise", '
    '"justification": "your strongest specific justification", '
    '"revised_claim": "your revised claim, or null when you defend", '
    '"confidence": 0.0-1.0, '
    '"persuaded_by": "the specific peer point that persuaded you, or null when you defend"}'
)
DEFENSE_JSON_INSTRUCTION = DEFENSE_JSON_LEAD + _DEFENSE_KEYS
DEFENSE_JSON_INSTRUCTION_FENCED = DEFENSE_JSON_LEAD_FENCED + _DEFENSE_KEYS

_CONVERGENCE_RULES = (
    "You are an analyst checking whether three anonymous expert reviewers (R1, R2, R3) now "
    "agree. For each divergence below, compare the reviewers' CURRENT claims after this "
    'round\'s revisions. Mark "resolved" only if the claims are now substantively compatible; '
    'otherwise "standing". Judge on substance, not on length, wording or confidence of tone. '
    + QUOTED_DATA_NOTICE
)
CONVERGENCE_JSON_LEAD = " Return ONLY valid JSON (no prose, no code fences) of the form "
CONVERGENCE_JSON_LEAD_FENCED = (
    " Return ONLY a fenced code block tagged json — a line with ```json, then the JSON, then a "
    "closing line with ``` — and no prose outside the block, of the form "
)
_CONVERGENCE_FORM = (
    '{"statuses": [{"divergence_id": "...", "status": "resolved" | "standing"}]} '
    "with exactly one entry per divergence listed and no other status values."
)
CONVERGENCE_SYSTEM = _CONVERGENCE_RULES + CONVERGENCE_JSON_LEAD + _CONVERGENCE_FORM
CONVERGENCE_SYSTEM_FENCED = (
    _CONVERGENCE_RULES + CONVERGENCE_JSON_LEAD_FENCED + _CONVERGENCE_FORM
)

CONVERGENCE_USER_LEAD = (
    "Divergences with each reviewer's current claim after this round, as a JSON array of "
    '{"divergence_id", "topic", "claims"}:'
)
CONVERGENCE_USER_TAIL = (
    'Answer ONLY with the JSON object {"statuses": [...]} using the status values '
    '"resolved" or "standing".'
)


def challenge_prompt(
    *,
    topic: str,
    current_claim: str,
    latest_justification: str,
    peer_block: str,
    round: int,
    max_iterations: int,
    fenced: bool = False,
) -> str:
    """The user message that challenges one label on one divergence (Appendix A order).

    `topic` is analyst-authored: pass it through `anon.scrub` first; it is quoted inside its own
    delimited block here, never interpolated into the instruction text.

    `fenced=True` (the caller passes `client.transport_kind(spec.model) == "web"`) swaps ONLY the
    JSON instruction's lead for the fenced one (module docstring); every other clause — the
    quoted-data notice, the delimited blocks, the anti-sycophancy clause, the round counter and
    the key list — is identical on every transport."""
    return "\n\n".join(
        [
            QUOTED_DATA_NOTICE,
            TOPIC_LEAD + "\n" + delimited(TOPIC_LABEL, topic),
            POSITION_LEAD + "\n" + delimited(CLAIM_LABEL, current_claim),
            JUSTIFICATION_LEAD + "\n" + delimited(JUSTIFICATION_LABEL, latest_justification),
            PEERS_LEAD + "\n" + peer_block,
            ANTI_SYCOPHANCY_CLAUSE
            + " "
            + ROUND_COUNTER.format(round=round, max_iterations=max_iterations),
            DEFENSE_JSON_INSTRUCTION_FENCED if fenced else DEFENSE_JSON_INSTRUCTION,
        ]
    )


def convergence_payload(items: list[dict[str, Any]]) -> str:
    """Serialise `[{"divergence_id", "topic", "claims": {label: claim}}]` for the analyst."""
    return json.dumps(items, ensure_ascii=False, indent=2)


def convergence_messages(
    items: list[dict[str, Any]], *, fenced: bool = False
) -> list[dict[str, str]]:
    """`[system(instructions), user(notice + delimited payload + answer rule)]`.

    `fenced=True` (the caller passes `client.transport_kind(analyst_model) == "web"`) swaps ONLY
    the system message's JSON instruction for the fenced one; the user message never depends on
    the transport."""
    user = "\n\n".join(
        [
            QUOTED_DATA_NOTICE,
            CONVERGENCE_USER_LEAD,
            delimited(DIVERGENCES_LABEL, convergence_payload(items)),
            CONVERGENCE_USER_TAIL,
        ]
    )
    return [
        {"role": "system", "content": CONVERGENCE_SYSTEM_FENCED if fenced else CONVERGENCE_SYSTEM},
        {"role": "user", "content": user},
    ]


__all__ = [
    "ANTI_SYCOPHANCY_CLAUSE",
    "CLAIM_LABEL",
    "CONVERGENCE_JSON_LEAD",
    "CONVERGENCE_JSON_LEAD_FENCED",
    "CONVERGENCE_SYSTEM",
    "CONVERGENCE_SYSTEM_FENCED",
    "CONVERGENCE_USER_LEAD",
    "CONVERGENCE_USER_TAIL",
    "DEFENSE_JSON_INSTRUCTION",
    "DEFENSE_JSON_INSTRUCTION_FENCED",
    "DEFENSE_JSON_LEAD",
    "DEFENSE_JSON_LEAD_FENCED",
    "DIVERGENCES_LABEL",
    "JUSTIFICATION_LABEL",
    "JUSTIFICATION_LEAD",
    "PEERS_LEAD",
    "POSITION_LEAD",
    "ROUND_COUNTER",
    "TOPIC_LABEL",
    "TOPIC_LEAD",
    "challenge_prompt",
    "convergence_messages",
    "convergence_payload",
]
