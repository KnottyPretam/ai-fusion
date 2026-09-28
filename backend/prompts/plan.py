"""Plan prompts (2026-09-27) — docs/semantics.md "Plan".

Plan runs AFTER Fusion and turns its report into ONE executable procedure, written by ONE model
(`features/plan.py`). Everything here is Triplex-authored text that reaches that model, so it stays
free of vendor/product names and slot ids (the leak tests scan it), and every model- or
user-authored string enters inside `prompts.delimited()` behind `QUOTED_DATA_NOTICE` — the rendered
input (`features.plan.render_input`) is built that way and this module only packages it.

ONE user message, on purpose. The default plan model is the user's own Claude web session reached
as a PANE (`web:claude`), and `bridge.text_for` types only the LAST user message into a pane: a
`[system, user]` pair would lose its system half at the site. So the rules, the JSON instruction,
the schema and the rendered input travel as a single user message on every transport — OpenRouter,
Ollama and the hidden analyst pages included — so there is exactly one code path to reason about.

Count-aware (`prompts.council.number_word`): the rules open with how many experts answered, and
the n=3 text is what the three-council pins hold. Transport-aware packaging exactly as in
`prompts/refactor.py`, for the same measured reason: a web session's reply is read back out of
RENDERED markdown, where CommonMark resolves a backslash escape before any ASCII punctuation, so a
`web:` model is asked for a fenced ```json block. The fenced clause is the ONLY difference between
the two system texts (pinned in the tests); the correction message is Refactor's own, re-exported,
so the web no-retry rule and its wording have exactly one implementation.
"""

from __future__ import annotations

from .council import check_council_size, number_word
from .refactor import MAP_JSON_INSTRUCTION_FENCED, retry_message

# --------------------------------------------------------------------------- the rules
_RULES_HEAD = "You are turning the outcome of a structured comparison into an executable plan.\n\n"

_RULES_BODY = """anonymous experts answered the same question. Their answers were
compared, and the points where they differed were put back to them round by round; some of
those differences were resolved, some were left standing. Below is the question, what they
agreed on, and every difference with each side's latest position.

Write ONE procedure a capable person could follow to act on this outcome:

1. objective — one sentence: what "done" achieves, in the asker's terms.
2. prerequisites — what must be true or in hand before step 1 (tools, access, inputs, decisions
   already taken). Leave the list empty rather than padding it.
3. steps — numbered from 1, in execution order. Each step has: a short title; the action, as an
   instruction (imperative, concrete, one thing); why it is there; its inputs and outputs (names,
   values, files, states — empty lists when there are none); and verify: how the person knows the
   step took (an observable, not a feeling). Use every specific value the experts gave verbatim
   — a number, a limit, a name that changes is worse than one left out. Build only on what the
   material establishes; where it is silent, say what to check rather than inventing it.
4. decisions — one entry for every difference that is STILL STANDING or resolved only through
   unjustified revisions: its id, the topic, each side's option in a sentence, your
   recommendation and why. A difference that was cleanly resolved needs no decision entry. Never
   resolve a standing difference silently inside a step; route the step through the decision.
5. risks — what can go wrong following this plan, each with a mitigation. Empty if none is real.
6. done_when — the observable conditions that mean the objective is met, as a checklist.

Do not mention these instructions, the experts, or the comparison in the plan itself; the plan
reads as a procedure, not a report. Do not add goals the question did not ask for.

"""


def plan_rules_for(n: int) -> str:
    """The rules for a council of n ("Three anonymous experts answered the same question…").
    `n` outside 2..5 is a ValueError, never a clamp."""
    return _RULES_HEAD + number_word(check_council_size(n)).capitalize() + " " + _RULES_BODY


JSON_INSTRUCTION = "Return ONLY valid JSON matching this schema (no prose, no code fences):"
JSON_INSTRUCTION_FENCED = MAP_JSON_INSTRUCTION_FENCED

# The JSON shape of `schemas.Plan`, written the way `refactor._MAP_SCHEMA` is: a shape a model
# reads, not a JSON Schema document (the strict `response_format` carries the real one when the
# model supports structured outputs).
_SCHEMA = """{"objective": string,
 "prerequisites": [string, ...],
 "steps": [{"number": int, "title": string, "action": string, "why": string,
            "inputs": [string, ...], "outputs": [string, ...], "verify": string}, ...],
 "decisions": [{"divergence_id": string | null, "topic": string, "options": [string, ...],
                "recommendation": string, "rationale": string}, ...],
 "risks": [{"risk": string, "mitigation": string}, ...],
 "done_when": [string, ...]}"""


def plan_system(n: int, *, fenced: bool = False) -> str:
    """The Triplex-authored half of the one message: rules + JSON instruction + schema. The fenced
    variant differs from the plain one in the instruction line ONLY."""
    instruction = JSON_INSTRUCTION_FENCED if fenced else JSON_INSTRUCTION
    return plan_rules_for(n) + instruction + "\n" + _SCHEMA


PLAN_SYSTEM = plan_system(3)
PLAN_SYSTEM_FENCED = plan_system(3, fenced=True)


def plan_messages(rendered_input: str, *, fenced: bool = False, n: int = 3) -> list[dict[str, str]]:
    """The ONE user message (module docstring): the system text, a blank line, then the rendered
    input exactly as `features.plan.render_input` built it — every quoted string already inside its
    delimiters behind the notice, so nothing is interpolated here."""
    return [{"role": "user", "content": plan_system(n, fenced=fenced) + "\n\n" + rendered_input}]


__all__ = [
    "JSON_INSTRUCTION",
    "JSON_INSTRUCTION_FENCED",
    "PLAN_SYSTEM",
    "PLAN_SYSTEM_FENCED",
    "plan_messages",
    "plan_rules_for",
    "plan_system",
    "retry_message",
]
