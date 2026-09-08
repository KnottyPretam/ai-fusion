"""Analyze feature (owner: W5). Frozen signature; yields analyze_* SSE event dicts.

Normative behaviour: docs/semantics.md "Analyze" (+ the producer-model addendum) and the
`analyze_*` events in docs/api-contract.md.

Pre-checks, in order and all before the first yield (so `sse.sse_response` turns them into plain
JSON errors): `store.load` -> 404; resolve `of_turn` (default: the newest send turn; explicit
unknown -> 404 not_found("turn"); explicit non-send -> 422 not_a_send_turn; no send turn at all ->
409 no_send_turn); every slot must have a response -> 409 incomplete_send_turn{missing}; the cache
rule (without `force`, the newest ok analyze turn for `of_turn` is replayed as
`analyze_start` + `analyze_done{cached:true}` with no busy guard and no LLM call); and LAST the
busy guard -> 409 busy.

A fresh run mints the turn id, enters the guard, and spawns ONE producer task that emits
`analyze_start{turn_id, of_turn}`, calls the analyst once (`complete_json(..., retries=0)`), on
failure emits `analyze_retry{error}` and calls once more carrying the validation error, persists
the AnalyzeTurn (`ok` or `degraded`) and only then emits `analyze_done{turn, cached:false}` or
`analyze_degraded{turn}` — the last event either way (no `error` follows a degrade). The task
releases the guard in its `finally` after the persistence write and runs to completion even when
the client disconnects; the generator only drains the task's queue.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from .. import anon, api_errors
from ..config import ANALYST_EFFORT, MAX_TOKENS_STAGE
from ..llm import client
from ..prompts import analyze as prompts
from ..schemas import (
    SLOT_IDS,
    AnalyzeTurn,
    Conversation,
    Extraction,
    FeatureUsage,
    Label,
    SendTurn,
    new_id,
)
from ..store import conversations as store

log = logging.getLogger("triplex.features.analyze")

ROLE = "analyst"
PURPOSE = "extraction"
# One retry driven here (docs/semantics.md): at most ATTEMPTS analyst calls per Analyze.
ATTEMPTS = 2

_END = None  # queue sentinel
# Strong references to running producer tasks (asyncio keeps only weak ones): a task must survive
# the generator that spawned it when the client disconnects.
_tasks: set[asyncio.Task[None]] = set()


# --------------------------------------------------------------------------- pre-checks
def resolve_send_turn(conv: Conversation, of_turn: str | None) -> SendTurn:
    """The send turn to analyze (docs/semantics.md "Analyze"); raises the pre-stream errors."""
    if of_turn is None:
        for turn in reversed(conv.turns):
            if turn.type == "send":
                return turn
        raise api_errors.conflict("no_send_turn")
    for turn in conv.turns:
        if turn.id == of_turn:
            if turn.type != "send":
                raise api_errors.unprocessable("not_a_send_turn")
            return turn
    raise api_errors.not_found("turn")


def missing_responses(send_turn: SendTurn) -> list[str]:
    return [slot for slot in SLOT_IDS if send_turn.responses.get(slot) is None]


def cached_ok_turn(conv: Conversation, of_turn: str) -> AnalyzeTurn | None:
    """The newest analyze turn with status ok for `of_turn` (degraded turns are never cached)."""
    for turn in reversed(conv.turns):
        if turn.type == "analyze" and turn.of_turn == of_turn and turn.status == "ok":
            return turn
    return None


def responses_by_label(conv: Conversation, send_turn: SendTurn) -> dict[Label, str]:
    """R-labelled responses via the persisted anon_map (never re-derived from position)."""
    return {label: send_turn.responses[slot] or "" for label, slot in anon.labels(conv).items()}


# --------------------------------------------------------------------------- producer
async def _attempt(
    *, model: str, messages: list[dict[str, Any]]
) -> tuple[Extraction | None, str, FeatureUsage, str | None]:
    parsed, raw, usage, error = await client.complete_json(
        role=ROLE,
        purpose=PURPOSE,
        model=model,
        messages=messages,
        schema_model=Extraction,
        effort=ANALYST_EFFORT,
        max_tokens=MAX_TOKENS_STAGE[PURPOSE],
        retries=0,
    )
    extraction = parsed if isinstance(parsed, Extraction) else None
    return extraction, raw, usage, error


async def _produce(
    conv: Conversation,
    send_turn: SendTurn,
    turn_id: str,
    queue: asyncio.Queue[dict[str, Any] | None],
    guard: Any,
) -> None:
    """All LLM calls and the persistence write; releases the busy guard in `finally`."""
    started = time.monotonic()
    final: dict[str, Any] | None = None
    try:
        queue.put_nowait({"type": "analyze_start", "turn_id": turn_id, "of_turn": send_turn.id})
        model = conv.slot_config.analyst_model
        messages = prompts.build_messages(send_turn.prompt, responses_by_label(conv, send_turn))
        usage = FeatureUsage()
        raw_attempts: list[str] = []

        extraction, raw, attempt_usage, error = await _attempt(model=model, messages=messages)
        usage.merge(attempt_usage)
        raw_attempts.append(raw)
        for _ in range(ATTEMPTS - 1):
            if extraction is not None:
                break
            queue.put_nowait({"type": "analyze_retry", "error": error or "unknown error"})
            if raw:
                # Parse / validation failure: carry the bad output and the error back.
                messages = [
                    *messages,
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": prompts.retry_message(error or "unknown error")},
                ]
            # A transport error produced no output to correct: retry the same request.
            extraction, raw, attempt_usage, error = await _attempt(model=model, messages=messages)
            usage.merge(attempt_usage)
            raw_attempts.append(raw)

        usage.set_wall_clock(max(1, int((time.monotonic() - started) * 1000)))
        turn = AnalyzeTurn(
            id=turn_id,
            of_turn=send_turn.id,
            extraction=extraction,
            status="ok" if extraction is not None else "degraded",
            error=None if extraction is not None else (error or "unknown error"),
            raw_attempts=raw_attempts,
            slot_config=conv.slot_config.model_copy(deep=True),
            usage=usage,
        )
        await store.append_turn(conv.id, turn)
        if turn.status == "ok":
            final = {"type": "analyze_done", "turn": turn.model_dump(), "cached": False}
        else:
            final = {"type": "analyze_degraded", "turn": turn.model_dump()}
    except Exception as e:  # after the first event only a terminal error event remains
        log.exception("analyze failed for conversation %s", conv.id)
        final = {"type": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        # Release after the last persistence write and BEFORE the client sees the final event,
        # so a Fusion fired on analyze_done never trips over a guard that is still held.
        await guard.__aexit__(None, None, None)
        if final is not None:
            queue.put_nowait(final)
        queue.put_nowait(_END)


# --------------------------------------------------------------------------- public API (frozen)
async def run_analyze(
    conv_id: str, *, of_turn: str | None = None, force: bool = False
) -> AsyncIterator[dict[str, Any]]:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    send_turn = resolve_send_turn(conv, of_turn)
    missing = missing_responses(send_turn)
    if missing:
        raise api_errors.conflict("incomplete_send_turn", missing=missing)

    if not force:
        cached = cached_ok_turn(conv, send_turn.id)
        if cached is not None:
            yield {"type": "analyze_start", "turn_id": cached.id, "of_turn": send_turn.id}
            yield {"type": "analyze_done", "turn": cached.model_dump(), "cached": True}
            return

    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy
    turn_id = new_id()  # minted before the first event
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    task = asyncio.create_task(
        _produce(conv, send_turn, turn_id, queue, guard), name=f"analyze:{turn_id}"
    )
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    while True:
        event = await queue.get()
        if event is _END:
            return
        yield event


__all__ = [
    "ATTEMPTS",
    "PURPOSE",
    "ROLE",
    "cached_ok_turn",
    "missing_responses",
    "resolve_send_turn",
    "responses_by_label",
    "run_analyze",
]
