"""Plan (2026-09-27) — ONE agent turns a Fusion report into an executable procedure.

docs/semantics.md "Plan". The user's request: after Fusion, the option to refactor its outcome into
an executable plan or procedure, made by ONE agent, defaulting to their own Claude subscription. A
`PlanTurn` holds a `Plan` (objective, prerequisites, numbered steps with action / why / inputs /
outputs / verify, decision points for what Fusion left standing, risks, done-when) for one fusion
turn, plus the model string that wrote it.

The model (`resolve_model`): the request's `model` -> the conversation's `slot_config.plan_model`
-> `default_model()`, which is `web:claude` in the desktop (the plan is TYPED INTO THIS
CONVERSATION'S CLAUDE CHAT through the pane and read back, so the site's own model setting applies)
and Claude Opus on OpenRouter otherwise. Nothing is validated beyond "a non-blank string": the
client's own routing reports a missing key, a disabled transport or a bridge failure as a DEGRADED
turn, exactly like Refactor, because a plan that could not be produced must not fail the request.

The input (`render_input`, pure): the Analyze turn Fusion fused, its send turn, and the newest ok
Refactor for that send turn (the restated question when there is one) rendered as sections, each
`prompts.delimited()` behind ONE `QUOTED_DATA_NOTICE`, with EVERY model-authored string (topic,
statement, claim, justification) passed through `anon.scrub` -- the anonymisation firewall is
load-bearing and the plan model must not learn who wrote what. The fusion rounds are folded in
through `export.latest_claim` / `export.latest_justification` (imported, not re-derived) and the
statuses come from `fusion_turn.final`; a divergence the extraction lists but Fusion never fused
(below the materiality floor) says so. Bounded at `PLAN_INPUT_MAX_CHARS` =
`analyze.CONDENSE_CHUNK_CHARS`, the measured one-message bound, with a pre-stream 422
`plan_input_too_large{chars, max}`: nothing is called, nothing persisted, never truncated.

ONE user message (`prompts/plan.py`): `bridge.text_for` types only the last user message into a
pane, so rules + instruction + schema + input travel together on every transport.

Shape, deliberately Refactor's (`features/refactor.py`): pre-checks (404 -> the fusion turn -> the
model -> the input bound) -> cache hit replays with no guard and no call -> busy guard LAST -> ONE
producer task owning the call and the writes, releasing the guard in its `finally` before the final
event is enqueued. The call is `refactor.validated_call` with this stage's own budget
(`MAX_TOKENS_STAGE["plan"]`, a Send-sized answer), so the web no-retry rule keeps its single
implementation; `purpose="extraction"` because the frozen `Purpose` literal has no room for a new
name (the meter reads it as analyst work).

Thread mirror, pane only: when the resolved model is `web:<slot>` (a PANE, not `:analyst`) and the
conversation's council seats that slot ON that pane (`slots[slot].model == "web:<slot>"`), the
site's chat now holds the exchange, so the slot's thread gets one `[plan_request(user),
plan_reply(assistant)]` pair PER ATTEMPT -- the typed prompt and its reply, then the correction
message and its reply when there was one -- each with `meta={"plan_turn": turn_id, "attempt": n}`,
appended in ONE write after a SUCCESSFUL parse, the way Fusion mirrors a challenge and its reply.
Nothing is appended on a degrade, for an analyst page, Ollama or OpenRouter, for a site outside the
council (`append_to_thread` would raise), or for a member seated on another transport (claude on
an OpenRouter slug while `web:claude` types into the hidden site view: that thread never saw the
exchange). `raw_attempts` is ONE entry per attempt (`validated_call`'s `on_attempt`), never the
joined text.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from .. import anon, api_errors
from ..config import ANALYST_EFFORT, MAX_TOKENS_STAGE
from ..export import latest_claim, latest_justification
from ..llm import bridge, client
from ..prompts import QUOTED_DATA_NOTICE, delimited
from ..prompts import plan as prompts
from ..prompts import preparse as preparse_prompts
from ..prompts.council import number_word
from ..schemas import (
    AnalyzeTurn,
    Conversation,
    FusionTurn,
    Plan,
    PlanTurn,
    SendTurn,
    SlotConfig,
    SlotId,
    ThreadMessage,
    council_labels,
    council_of,
)
from ..store import conversations as store
from . import refactor
from .analyze import CONDENSE_CHUNK_CHARS
from .fusion import find_turn, labels_with_position

log = logging.getLogger("triplex.features.plan")

ROLE = refactor.ROLE
PURPOSE = refactor.PURPOSE  # "extraction": the frozen Purpose literal has no room (docstring)
STAGE = "plan"  # the MAX_TOKENS_STAGE key (config.py, 2026-09-27)
# The most the rendered input may be: the measured single-message bound (module docstring).
PLAN_INPUT_MAX_CHARS = CONDENSE_CHUNK_CHARS
DEFAULT_MODEL_DESKTOP = "web:claude"
DEFAULT_MODEL = "anthropic/claude-opus-5.5"
NOTICE = "turning the fusion report into a procedure"
ANALYZE_GONE = "(the Analyze turn is no longer part of this conversation)"
NONE = "(none)"

# `RoundStatusValue` spelled out for the plan model; a divergence Fusion never fused has no entry
# in `fusion_turn.final` and gets `NOT_FUSED`.
STATUS_WORDS: dict[str, str] = {
    "resolved": "resolved",
    "resolved_unjustified": "resolved only through unjustified revisions",
    "standing": "still standing",
}
NOT_FUSED = "not fused (below the materiality floor)"
EXIT_WORDS: dict[str, str] = {
    "converged": "converged",
    "stalemate": "stalemate",
    "max_iterations": "max iterations reached",
    "error": "error",
}

_END: None = None


def new_id() -> str:
    return str(uuid.uuid4())


# --------------------------------------------------------------------------- pure helpers
def default_model() -> str:
    """`web:claude` in the desktop (the user's own Claude chat, typed through the pane), Claude
    Opus on OpenRouter otherwise. Read at CALL time: `TRIPLEX_DESKTOP` is an environment read."""
    return DEFAULT_MODEL_DESKTOP if client.desktop_mode() else DEFAULT_MODEL


def resolve_model(requested: str | None, cfg: SlotConfig) -> str:
    """The request's `model`, else `slot_config.plan_model`, else `default_model()`. A request that
    names a model but leaves it blank is a client bug and says so (422 `empty_model`); a stored
    blank `plan_model` is read as unset, because a config typo must not lock the feature until the
    config is fixed -- the stored value is the user's default, not a per-run choice."""
    if requested is not None:
        if not requested.strip():
            raise api_errors.unprocessable("empty_model")
        return requested.strip()
    stored = cfg.plan_model
    if isinstance(stored, str) and stored.strip():
        return stored.strip()
    return default_model()


def newest_fusion_turn(conv: Conversation) -> FusionTurn | None:
    for turn in reversed(conv.turns):
        if isinstance(turn, FusionTurn):
            return turn
    return None


def resolve_fusion_turn(conv: Conversation, of_fusion: str | None) -> FusionTurn:
    """The fusion turn to plan from; raises the pre-stream errors (module docstring)."""
    if of_fusion is None:
        turn = newest_fusion_turn(conv)
        if turn is None:
            raise api_errors.conflict("no_fusion_turn")
        return turn
    turn = find_turn(conv, of_fusion)
    if turn is None:
        raise api_errors.not_found("turn")
    if not isinstance(turn, FusionTurn):
        raise api_errors.unprocessable("not_a_fusion_turn", of_fusion=of_fusion)
    return turn


def cached_ok_turn(conv: Conversation, of_fusion: str) -> PlanTurn | None:
    """The newest ok Plan turn for `of_fusion`, or None."""
    for turn in reversed(conv.turns):
        if isinstance(turn, PlanTurn) and turn.of_fusion == of_fusion and turn.status == "ok":
            return turn
    return None


def pane_slot(model: str, cfg: SlotConfig) -> SlotId | None:
    """The council slot whose PANE `model` names (`web:<slot>`) AND whose seated member is on that
    very pane (`cfg.slots[slot].model == "web:<slot>"`), else None: an analyst page, a malformed or
    non-web model, a site the council does not seat, or a member seated on another transport (an
    OpenRouter slug, Ollama) all mean "no thread mirror" -- a thread only ever holds what its own
    transport saw."""
    try:
        slot, view = bridge.parse_web_model(model)
    except ValueError:
        return None
    if view != "pane":
        return None
    spec = cfg.slots.get(slot)
    return slot if spec is not None and spec.model == f"web:{slot}" else None


def question_of(conv: Conversation, send_turn: SendTurn | None) -> str:
    """The question the plan is for: the newest ok Refactor's restatement of the send turn when
    there is one, else the prompt with Triplex's own answer-format block stripped
    (`preparse.strip_format`: an exact-match strip of our constant, never user text). The
    restatement is the analyst's words and is `anon.scrub`bed like every other model-authored
    string; the prompt itself is the asker's own words, out of scope for the leak rule and quoted
    verbatim -- a `[model]` inside it would end up in the objective the person reads."""
    if send_turn is None:
        return ANALYZE_GONE
    refactored = refactor.cached_ok_turn(conv, send_turn.id)
    if refactored is not None and refactored.refactoring is not None:
        restated = anon.scrub(refactored.refactoring.question.strip())
        if restated:
            return restated
    return preparse_prompts.strip_format(send_turn.prompt)


def render_input(conv: Conversation, fusion_turn: FusionTurn) -> str:
    """The rendered outcome the plan model is shown (module docstring). Pure, no I/O. Every
    analyst- or model-authored string (a divergence's id, topic, statement, claim, justification,
    a Refactor's restatement) is `anon.scrub`bed and quoted inside a delimited block -- the user's
    own prompt is quoted verbatim; a fusion turn whose Analyze is gone renders `ANALYZE_GONE` with
    empty sections, never a crash."""
    analyze = find_turn(conv, fusion_turn.of_analyze)
    analyze = analyze if isinstance(analyze, AnalyzeTurn) else None
    send = find_turn(conv, analyze.of_turn) if analyze is not None else None
    send = send if isinstance(send, SendTurn) else None
    extraction = analyze.extraction if analyze is not None else None
    council = council_of(fusion_turn.slot_config)
    labels = council_labels(council)
    n = len(council)

    parts: list[str] = [QUOTED_DATA_NOTICE]
    if analyze is None:
        parts.append(f"Question: {ANALYZE_GONE}")
    else:
        parts.append("Question:\n" + delimited("QUESTION", question_of(conv, send)))

    agreements: list[str] = []
    for a in extraction.agreements if extraction is not None else []:
        who = ", ".join(a.models)
        agreements.append(f"- {anon.scrub(a.topic.strip())}: {anon.scrub(a.statement.strip())} ({who})")
    parts.append(
        f"What the {number_word(n)} experts agreed on:\n"
        + delimited("AGREEMENTS", "\n".join(agreements) or NONE)
    )

    status_of = {s.divergence_id: s.status for s in fusion_turn.final}
    divergences: list[str] = []
    for d in extraction.divergences if extraction is not None else []:
        status = STATUS_WORDS.get(status_of[d.id], status_of[d.id]) if d.id in status_of else NOT_FUSED
        lines = [
            f"{anon.scrub(d.id.strip())} — {anon.scrub(d.topic.strip())} — {d.materiality} — status: {status}"
        ]
        for label in labels_with_position(d, labels):
            claim = anon.scrub(latest_claim(fusion_turn.rounds, d, label).strip())
            justification = anon.scrub(latest_justification(fusion_turn.rounds, d, label).strip())
            lines.append(f"  {label}: {claim}")
            lines.append(f"    justification: {justification}")
        divergences.append("\n".join(lines))
    parts.append(
        "Where they differed, and what the fusion rounds settled:\n"
        + delimited("DIVERGENCES", "\n".join(divergences) or NONE)
    )

    exit_word = EXIT_WORDS.get(fusion_turn.exit_reason, fusion_turn.exit_reason)
    parts.append(
        f"Fusion exit: {exit_word}, {len(fusion_turn.rounds)} of {fusion_turn.max_iterations} rounds."
    )
    return "\n\n".join(parts)


def _max_tokens(model: str) -> int:
    """This stage's budget plus room for reasoning tokens -- the same rule and the same reason as
    `refactor._max_tokens`, with the plan stage's own base (`config.MAX_TOKENS_STAGE["plan"]`).
    `catalog` is imported here so tests can monkeypatch `get_meta`."""
    from ..llm import catalog, reasoning

    return reasoning.token_budget(MAX_TOKENS_STAGE[STAGE], catalog.get_meta(model), ANALYST_EFFORT)


# --------------------------------------------------------------------------- the producer
async def _produce(
    conv: Conversation,
    fusion_turn: FusionTurn,
    turn_id: str,
    model: str,
    rendered: str,
    queue: asyncio.Queue[dict[str, Any] | None],
    guard: Any,
) -> None:
    started = time.monotonic()
    final: dict[str, Any] | None = None
    try:
        queue.put_nowait(
            {"type": "plan_start", "turn_id": turn_id, "of_fusion": fusion_turn.id, "model": model}
        )
        fenced = client.transport_kind(model) == "web"
        n = len(council_of(fusion_turn.slot_config))
        messages = prompts.plan_messages(rendered, fenced=fenced, n=n)
        # One entry per attempt, and the text each attempt typed: the prompt first, then the
        # correction exactly as `validated_call` sends it (`on_retry` hands over the error it is
        # built from), so the mirror below is the pane's chat pair for pair.
        raw_attempts: list[str] = []
        requests: list[str] = [messages[-1]["content"]]

        def on_attempt(text: str) -> None:
            raw_attempts.append(text)

        def on_retry(validation_error: str) -> None:
            requests.append(prompts.retry_message(validation_error, fenced=fenced))
            queue.put_nowait({"type": "plan_retry", "error": validation_error})

        queue.put_nowait({"type": "plan_retry", "error": NOTICE})
        value, _joined, usage, error = await refactor.validated_call(
            model=model,
            messages=messages,
            schema_model=Plan,
            fenced=fenced,
            max_tokens=_max_tokens(model),
            on_attempt=on_attempt,
            on_retry=on_retry,
        )
        usage.set_wall_clock(max(1, int((time.monotonic() - started) * 1000)))
        plan = value if isinstance(value, Plan) else None

        if plan is not None:
            # The site's chat holds the exchange now; the thread mirrors it pair for pair, in one
            # write (module docstring): a corrected plan is two pairs, the chat holds both too.
            slot = pane_slot(model, conv.slot_config)
            if slot is not None:
                mirror: list[ThreadMessage] = []
                for attempt, (request, reply) in enumerate(
                    zip(requests, raw_attempts, strict=True), start=1
                ):
                    meta = {"plan_turn": turn_id, "attempt": attempt}
                    mirror.append(
                        ThreadMessage(
                            role="user",
                            content=request,
                            kind="plan_request",
                            turn_id=turn_id,
                            meta=dict(meta),
                        )
                    )
                    mirror.append(
                        ThreadMessage(
                            role="assistant",
                            content=reply,
                            kind="plan_reply",
                            turn_id=turn_id,
                            meta=dict(meta),
                        )
                    )
                await store.append_to_thread(conv.id, slot, mirror)

        turn = PlanTurn(
            id=turn_id,
            of_fusion=fusion_turn.id,
            model=model,
            plan=plan,
            status="ok" if plan is not None else "degraded",
            error=None if plan is not None else (error or "unknown error"),
            raw_attempts=raw_attempts,
            slot_config=conv.slot_config.model_copy(deep=True),
            usage=usage,
        )
        await store.append_turn(conv.id, turn)
        if turn.status == "ok":
            final = {"type": "plan_done", "turn": turn.model_dump(), "cached": False}
        else:
            final = {"type": "plan_degraded", "turn": turn.model_dump()}
    except Exception as e:
        log.exception("plan failed for conversation %s", conv.id)
        final = {"type": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        try:
            await guard.__aexit__(None, None, None)
        finally:
            if final is not None:
                queue.put_nowait(final)
            queue.put_nowait(_END)


async def run_plan(
    conv_id: str,
    *,
    of_fusion: str | None = None,
    force: bool = False,
    model: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    fusion_turn = resolve_fusion_turn(conv, of_fusion)
    resolved = resolve_model(model, conv.slot_config)
    rendered = render_input(conv, fusion_turn)
    if len(rendered) > PLAN_INPUT_MAX_CHARS:
        # Never truncated: the bound is the measured size one message can be answered for, and a
        # plan built from half the report would be a plan for a different outcome.
        raise api_errors.unprocessable(
            "plan_input_too_large", chars=len(rendered), max=PLAN_INPUT_MAX_CHARS
        )

    if not force:
        cached = cached_ok_turn(conv, fusion_turn.id)
        if cached is not None:
            yield {
                "type": "plan_start",
                "turn_id": cached.id,
                "of_fusion": fusion_turn.id,
                "model": cached.model,
            }
            yield {"type": "plan_done", "turn": cached.model_dump(), "cached": True}
            return

    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy
    turn_id = new_id()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    task = asyncio.create_task(_produce(conv, fusion_turn, turn_id, resolved, rendered, queue, guard))
    _background.add(task)
    task.add_done_callback(_background.discard)
    while True:
        event = await queue.get()
        if event is _END:
            break
        yield event


_background: set[asyncio.Task[None]] = set()


async def wait_for_background() -> None:
    """Tests only: await the producer tasks this module spawned."""
    while _background:
        await asyncio.gather(*list(_background), return_exceptions=True)


__all__ = [
    "ANALYZE_GONE",
    "DEFAULT_MODEL",
    "DEFAULT_MODEL_DESKTOP",
    "EXIT_WORDS",
    "NOTICE",
    "NOT_FUSED",
    "PLAN_INPUT_MAX_CHARS",
    "PURPOSE",
    "ROLE",
    "STATUS_WORDS",
    "cached_ok_turn",
    "default_model",
    "newest_fusion_turn",
    "pane_slot",
    "question_of",
    "render_input",
    "resolve_fusion_turn",
    "resolve_model",
    "run_plan",
    "wait_for_background",
]
