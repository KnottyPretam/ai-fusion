"""Fusion prompts (owner: W6): the per-label challenge and the analyst convergence check.

PLAN.md Appendix A, tuned per docs/semantics.md "Fusion". Everything here is Triplex-authored
text that reaches a model, so it must stay free of vendor/product names and slot ids (leak tests
scan it); models are only ever named R1/R2/R3.

- The challenge is a USER message appended to the challenged slot's own thread ("On the question
  above ..."). The label's current claim, its latest justification and the anonymised peer block
  are quoted material: each sits inside the shared `delimited()` markers, preceded by
  `QUOTED_DATA_NOTICE`, so an instruction planted in a model response can only ever appear
  between `<<<X>>>` and `<<<END X>>>`. The peer block comes from `anon.render_peer_block`
  (already scrubbed, delimited per peer and prefixed with the notice) and is treated as opaque.
- The anti-sycophancy clause is Appendix A verbatim and the JSON instruction asks for
  `persuaded_by`: a `revise` that names no specific peer point is flagged by
  `schemas.is_unjustified`.
- The convergence check goes to the analyst as `[system, user]`; the user message carries one
  object per divergence `{"divergence_id", "topic", "claims": {"R1": ..., ...}}` inside a
  delimited block and the analyst is told to answer only `resolved | standing`.
"""

from __future__ import annotations

import json
from typing import Any

from . import QUOTED_DATA_NOTICE, delimited

CLAIM_LABEL = "YOUR CLAIM"
JUSTIFICATION_LABEL = "YOUR JUSTIFICATION"
DIVERGENCES_LABEL = "DIVERGENCES"

POSITION_LEAD = 'On the question above, regarding "{topic}", your current position is:'
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

DEFENSE_JSON_INSTRUCTION = (
    "Return ONLY valid JSON (no prose, no code fences) with exactly these keys:\n"
    '{"stance": "defend" | "revise", '
    '"justification": "your strongest specific justification", '
    '"revised_claim": "your revised claim, or null when you defend", '
    '"confidence": 0.0-1.0, '
    '"persuaded_by": "the specific peer point that persuaded you, or null when you defend"}'
)

CONVERGENCE_SYSTEM = (
    "You are an analyst checking whether three anonymous expert reviewers (R1, R2, R3) now "
    "agree. For each divergence below, compare the reviewers' CURRENT claims after this "
    'round\'s revisions. Mark "resolved" only if the claims are now substantively compatible; '
    'otherwise "standing". Judge on substance, not on length, wording or confidence of tone. '
    + QUOTED_DATA_NOTICE
    + " Return ONLY valid JSON (no prose, no code fences) of the form "
    '{"statuses": [{"divergence_id": "...", "status": "resolved" | "standing"}]} '
    "with exactly one entry per divergence listed and no other status values."
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
) -> str:
    """The user message that challenges one label on one divergence (Appendix A order)."""
    return "\n\n".join(
        [
            QUOTED_DATA_NOTICE,
            POSITION_LEAD.format(topic=topic) + "\n" + delimited(CLAIM_LABEL, current_claim),
            JUSTIFICATION_LEAD + "\n" + delimited(JUSTIFICATION_LABEL, latest_justification),
            PEERS_LEAD + "\n" + peer_block,
            ANTI_SYCOPHANCY_CLAUSE
            + " "
            + ROUND_COUNTER.format(round=round, max_iterations=max_iterations),
            DEFENSE_JSON_INSTRUCTION,
        ]
    )


def convergence_payload(items: list[dict[str, Any]]) -> str:
    """Serialise `[{"divergence_id", "topic", "claims": {label: claim}}]` for the analyst."""
    return json.dumps(items, ensure_ascii=False, indent=2)


def convergence_messages(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """`[system(instructions), user(notice + delimited payload + answer rule)]`."""
    user = "\n\n".join(
        [
            QUOTED_DATA_NOTICE,
            CONVERGENCE_USER_LEAD,
            delimited(DIVERGENCES_LABEL, convergence_payload(items)),
            CONVERGENCE_USER_TAIL,
        ]
    )
    return [
        {"role": "system", "content": CONVERGENCE_SYSTEM},
        {"role": "user", "content": user},
    ]


__all__ = [
    "ANTI_SYCOPHANCY_CLAUSE",
    "CLAIM_LABEL",
    "CONVERGENCE_SYSTEM",
    "CONVERGENCE_USER_LEAD",
    "CONVERGENCE_USER_TAIL",
    "DEFENSE_JSON_INSTRUCTION",
    "DIVERGENCES_LABEL",
    "JUSTIFICATION_LABEL",
    "JUSTIFICATION_LEAD",
    "PEERS_LEAD",
    "POSITION_LEAD",
    "ROUND_COUNTER",
    "challenge_prompt",
    "convergence_messages",
    "convergence_payload",
]
