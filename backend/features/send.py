"""Send / continue feature (owner: W4). Frozen signatures; yields SSE event dicts.

docs/semantics.md "Send/continue" (+ addendum), docs/api-contract.md send events.

Pre-checks (all BEFORE the first yield, so the router's `sse_response` turns them into plain JSON
errors): `store.load` -> 404 not_found; blank prompt -> 422 empty_prompt; unknown slot -> 404
not_found(slot); then `busy_guard` LAST -> 409 busy.

Producer model: ONE coordinator `asyncio.Task` per turn owns every LLM call and every persistence
write, pushes event dicts into one `asyncio.Queue`, and releases the busy guard in its `finally`
after the last write. The generator only drains that queue: a client that disconnects closes the
consumer, never the producer, so the turn still runs to completion and is persisted.

Per slot (the three slots in parallel for Send, one for continue): request =
`[to_openai(m) for m in threads[slot]] + user(prompt)` -- nothing else is Triplex-authored -- with
that slot's own model and configured effort (`slot_start.effort / effort_coerced` =
`reasoning.build(spec.effort, catalog.get_meta(spec.model))[1:]`), `max_tokens =
MAX_TOKENS_STAGE["send"|"continue"]`, `plugins=[{"id":"web", ...}]` iff `slot_config.grounded`.
The user message and the assistant reply are appended TOGETHER (atomically) when the slot ends
with `slot_done`; on `slot_error` nothing is appended (partial text is kept on the turn only). A
truncated reply (`finish_reason == "length"`) is still appended, flagged `truncated:true` -- but
only when it carries text: a `done` whose accumulated text is empty or whitespace is the slot
failure `slot_error{code:"empty_reply", error_type:"triplex", message:"model returned no text
(finish_reason=<fr>)", partial:""}` (an empty assistant message replayed on every later request
is rejected by providers, and Analyze must never run over nothing); `truncated` still reflects
the finish reason and the call's usage is still folded into `turn_done.usage`.

Every slot task is total: whatever fails inside it (the transport never raises; persistence and
this module's own bookkeeping can) becomes THAT slot's `slot_error{code:"internal_error"}` while
the other slots finish normally, and the coordinator gathers with `return_exceptions=True` so the
busy guard can never be released while a sibling is still writing. A slot's transport is closed
deterministically (`contextlib.aclosing`) once its terminal delta arrived -- before the pair is
persisted and before the client hears the slot's terminal event.

Event order: `turn_start{turn_id, feature, slots}` first; each slot's `slot_start` before its
`slot_delta | slot_reasoning | slot_citations`; exactly one `slot_done | slot_error` per slot;
`turn_done{turn_id, usage}` last, yielded only after `append_turn` completed. A failure after the
first event is the terminal `error{message}` event. The turn id is minted before the first event;
the turn stamps `conv.slot_config.model_copy(deep=True)`; the FIRST send of a conversation (no
turns yet) auto-titles it with `prompt[:60]`.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from .. import api_errors
from ..config import MAX_TOKENS_STAGE, settings
from ..llm import catalog
from ..llm import client as llm_client
from ..llm import reasoning as reasoning_mod
from ..llm.errors import EMPTY_REPLY
from ..prompts.send import PURPOSE, title_from_prompt, user_message, web_plugins
from ..schemas import (
    SLOT_IDS,
    ContinueTurn,
    Conversation,
    Delta,
    Effort,
    FeatureUsage,
    SendTurn,
    SlotId,
    ThreadMessage,
    Turn,
    Usage,
    new_id,
    to_openai,
)
from ..store import conversations as store

log = logging.getLogger("triplex.features.send")

Feature = Literal["send", "continue"]

# Codes minted here (never by the LLM layer) for failures inside a slot's own bookkeeping.
INTERNAL_ERROR = "internal_error"
# A `done` delta whose accumulated text is empty/whitespace (reasoning ate the whole budget, or the
# provider returned no content). Local until backend/llm/errors.py (W1) carries EMPTY_REPLY.
ERROR_TYPE_TRIPLEX = "triplex"

_END = object()  # queue sentinel: the coordinator has finished (guard released)
# asyncio keeps only weak references to tasks: hold the coordinators so a disconnected client
# (whose generator is gone) can never let a running turn be garbage-collected mid-flight.
_background: set[asyncio.Task[None]] = set()


# --------------------------------------------------------------------------- per-slot outcome
@dataclass
class SlotOutcome:
    slot: SlotId
    model: str
    effort_applied: Effort
    effort_coerced: bool
    text: str = ""
    reasoning: str = ""
    citations: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    truncated: bool = False
    usage: Usage | None = None
    error: str | None = None
    done: bool = False  # slot_done emitted: the [user, assistant] pair is persisted


# --------------------------------------------------------------------------- public API (frozen)
async def run_send(conv_id: str, prompt: str) -> AsyncIterator[dict[str, Any]]:
    started = time.monotonic()
    conv = await _precheck(conv_id, prompt)
    async for ev in _stream_turn(conv, prompt, "send", SLOT_IDS, started):
        yield ev


async def run_continue(conv_id: str, slot: SlotId, prompt: str) -> AsyncIterator[dict[str, Any]]:
    started = time.monotonic()
    conv = await _precheck(conv_id, prompt)
    if slot not in SLOT_IDS:
        raise api_errors.not_found("slot")
    async for ev in _stream_turn(conv, prompt, "continue", (slot,), started):
        yield ev


async def wait_for_background() -> None:
    """Await every coordinator task still running (tests / graceful shutdown)."""
    loop = asyncio.get_running_loop()
    pending = [t for t in _background if not t.done() and t.get_loop() is loop]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


# --------------------------------------------------------------------------- pre-checks
async def _precheck(conv_id: str, prompt: str) -> Conversation:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    if not isinstance(prompt, str) or not prompt.strip():
        raise api_errors.unprocessable("empty_prompt")
    return conv


# --------------------------------------------------------------------------- coordinator
async def _stream_turn(
    conv: Conversation,
    prompt: str,
    feature: Feature,
    slots: Sequence[SlotId],
    started: float,
) -> AsyncIterator[dict[str, Any]]:
    """Enter the busy guard (LAST pre-check), spawn the coordinator, drain its queue."""
    guard = store.busy_guard(conv.id)
    await guard.__aenter__()  # raises conflict("busy") before the first yield
    try:
        turn_id = new_id()  # minted BEFORE the first event
        queue: asyncio.Queue[Any] = asyncio.Queue()
        task = asyncio.create_task(
            _coordinate(conv, prompt, feature, tuple(slots), turn_id, queue, guard, started),
            name=f"triplex-{feature}-{turn_id}",
        )
    except BaseException:
        await guard.__aexit__(None, None, None)
        raise
    _background.add(task)
    task.add_done_callback(_background.discard)

    while True:
        ev = await queue.get()
        if ev is _END:
            return
        yield ev


async def _coordinate(
    conv: Conversation,
    prompt: str,
    feature: Feature,
    slots: tuple[SlotId, ...],
    turn_id: str,
    queue: asyncio.Queue[Any],
    guard: Any,
    started: float,
) -> None:
    """The ONE task that performs every LLM call and every persistence write for a turn."""
    try:
        await queue.put(
            {"type": "turn_start", "turn_id": turn_id, "feature": feature, "slots": list(slots)}
        )
        stage = "send" if feature == "send" else "continue"
        results = await asyncio.gather(
            *(_run_slot(conv, slot, prompt, turn_id, stage, queue) for slot in slots),
            return_exceptions=True,  # wait for EVERY slot, then fail as a whole (as fusion does)
        )
        outcomes: list[SlotOutcome] = []
        for result in results:
            if isinstance(result, BaseException):
                # `_run_slot` is total, so only a cancellation can land here -- and only after
                # every sibling finished its last persistence write.
                raise result
            outcomes.append(result)

        usage = FeatureUsage()
        for o in outcomes:
            if o.usage is not None:
                usage.add(o.usage)
        usage.set_wall_clock(int((time.monotonic() - started) * 1000))

        turn: Turn
        if feature == "send":
            turn = _build_send_turn(conv, prompt, turn_id, outcomes, usage)
            if not conv.turns:  # the conversation's FIRST send auto-titles it
                await store.rename(conv.id, title_from_prompt(prompt))
        else:
            turn = _build_continue_turn(conv, prompt, turn_id, outcomes[0], usage)
        await store.append_turn(conv.id, turn)  # completes BEFORE turn_done is yielded

        log.info(
            "%s turn conv=%s turn=%s slots=%s ok=%s errors=%s truncated=%s "
            "prompt_tokens=%d completion_tokens=%d reasoning_tokens=%d cost_usd=%.6f "
            "latency_ms=%d calls=%d",
            feature,
            conv.id,
            turn_id,
            ",".join(slots),
            ",".join(o.slot for o in outcomes if o.done) or "-",
            ",".join(o.slot for o in outcomes if not o.done) or "-",
            ",".join(o.slot for o in outcomes if o.truncated) or "-",
            usage.totals.prompt_tokens,
            usage.totals.completion_tokens,
            usage.totals.reasoning_tokens,
            usage.totals.cost_usd,
            usage.totals.latency_ms,
            usage.totals.calls,
        )
        await queue.put(
            {"type": "turn_done", "turn_id": turn_id, "usage": usage.model_dump(mode="json")}
        )
    except Exception as e:  # after the first event only a terminal error event is possible
        log.exception("%s turn %s on conversation %s failed", feature, turn_id, conv.id)
        await queue.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
    finally:
        try:
            await guard.__aexit__(None, None, None)  # after the last persistence write
        finally:
            await queue.put(_END)


# --------------------------------------------------------------------------- per-slot producer
async def _run_slot(
    conv: Conversation,
    slot: SlotId,
    prompt: str,
    turn_id: str,
    stage: str,
    queue: asyncio.Queue[Any],
) -> SlotOutcome:
    """One slot's whole life: request, stream, persistence, terminal event. Never raises."""
    spec = conv.slot_config.slots[slot]  # every slot is present (SlotConfig validator)
    out = SlotOutcome(slot=slot, model=spec.model, effort_applied=spec.effort, effort_coerced=False)
    started = False  # slot_start emitted (it must precede the slot's terminal event)
    try:
        _param, applied, coerced = reasoning_mod.build(spec.effort, catalog.get_meta(spec.model))
        out.effort_applied, out.effort_coerced = applied, coerced
        await queue.put(_slot_start(out))
        started = True
        # Exactly the slot's own history plus the verbatim prompt: nothing Triplex-authored.
        # `.get`: a document missing this thread key must not take the whole turn down (the
        # append below then fails for THIS slot only).
        messages = [to_openai(m) for m in conv.threads.get(slot, [])] + [user_message(prompt)]

        terminal: Delta | None = None
        # `aclosing`: the transport (httpx response/client, record tee) is torn down HERE, when
        # the terminal delta has arrived -- before the pair is persisted and before the client
        # hears slot_done/slot_error -- not whenever the garbage collector finalises it.
        async with contextlib.aclosing(
            llm_client.stream_completion(
                role=slot,
                purpose=PURPOSE,
                model=spec.model,
                messages=messages,
                effort=spec.effort,
                max_tokens=MAX_TOKENS_STAGE[stage],
                plugins=web_plugins(conv.slot_config.grounded, settings()),
            )
        ) as stream:
            async for d in stream:
                if d.kind == "text":
                    out.text += d.text
                    await queue.put({"type": "slot_delta", "slot": slot, "text": d.text})
                elif d.kind == "reasoning":
                    out.reasoning += d.text
                    await queue.put({"type": "slot_reasoning", "slot": slot, "text": d.text})
                elif d.kind == "citations":
                    out.citations.extend(d.items)
                    await queue.put(
                        {"type": "slot_citations", "slot": slot, "items": list(d.items)}
                    )
                else:  # done | error: the terminal delta, nothing follows it
                    terminal = d
                    break
        if terminal is None:  # the client contract makes this impossible; never a silent success
            raise RuntimeError("stream ended without a terminal delta")

        if terminal.kind == "error":
            out.error = terminal.message or (
                str(terminal.code) if terminal.code is not None else "error"
            )
            await queue.put(
                _slot_error(slot, terminal.code, terminal.error_type, out.error, out.text)
            )
            return out

        out.finish_reason = terminal.finish_reason
        out.truncated = bool(terminal.truncated)
        # The call is billed whatever it produced: usage is set BEFORE the empty-reply check so
        # the coordinator still folds it into turn_done.usage.
        out.usage = terminal.usage or Usage(model=spec.model, role=slot, purpose=PURPOSE)
        if not out.text.strip():
            # An empty reply is a slot failure, not a reply: nothing is appended (an empty
            # assistant message replayed later is rejected by providers), responses[slot] stays
            # None (Analyze must not run over nothing), truncated still reflects finish_reason.
            out.error = f"model returned no text (finish_reason={out.finish_reason})"
            await queue.put(_slot_error(slot, EMPTY_REPLY, ERROR_TYPE_TRIPLEX, out.error, ""))
            return out

        # The pair goes in together, atomically, before the client hears slot_done.
        await store.append_to_thread(
            conv.id,
            slot,
            [
                ThreadMessage(role="user", content=prompt, kind="chat", turn_id=turn_id),
                ThreadMessage(role="assistant", content=out.text, kind="chat", turn_id=turn_id),
            ],
        )
        out.done = True
        await queue.put(_slot_done(out))
    except Exception as e:  # persistence or an unexpected failure: this slot fails, the turn lives
        log.exception("slot %s failed during turn %s", slot, turn_id)
        out.done = False
        out.error = f"{type(e).__name__}: {e}"
        if not started:  # the consumer's invariant: slot_start before the terminal slot event
            await queue.put(_slot_start(out))
        await queue.put(_slot_error(slot, INTERNAL_ERROR, ERROR_TYPE_TRIPLEX, out.error, out.text))
    return out


def _slot_start(out: SlotOutcome) -> dict[str, Any]:
    return {
        "type": "slot_start",
        "slot": out.slot,
        "model": out.model,
        "effort": out.effort_applied,
        "effort_coerced": out.effort_coerced,
    }


def _slot_done(out: SlotOutcome) -> dict[str, Any]:
    assert out.usage is not None  # set from the terminal delta before the pair is persisted
    return {
        "type": "slot_done",
        "slot": out.slot,
        "usage": out.usage.model_dump(mode="json"),
        "finish_reason": out.finish_reason,
        "truncated": out.truncated,
    }


def _slot_error(
    slot: SlotId, code: int | str | None, error_type: str | None, message: str, partial: str
) -> dict[str, Any]:
    return {
        "type": "slot_error",
        "slot": slot,
        "code": code,
        "error_type": error_type,
        "message": message,
        "partial": partial,
    }


# --------------------------------------------------------------------------- turn builders
def _build_send_turn(
    conv: Conversation,
    prompt: str,
    turn_id: str,
    outcomes: Sequence[SlotOutcome],
    usage: FeatureUsage,
) -> SendTurn:
    return SendTurn(
        id=turn_id,
        slot_config=conv.slot_config.model_copy(deep=True),
        usage=usage,
        prompt=prompt,
        responses={o.slot: (o.text if o.done else None) for o in outcomes},
        errors={o.slot: (o.error or "error") for o in outcomes if not o.done},
        partial={o.slot: o.text for o in outcomes if not o.done},
        reasoning={o.slot: o.reasoning for o in outcomes if o.reasoning},
        citations={o.slot: list(o.citations) for o in outcomes if o.citations},
        truncated={o.slot: o.truncated for o in outcomes},
        effort_applied={o.slot: o.effort_applied for o in outcomes},
    )


def _build_continue_turn(
    conv: Conversation,
    prompt: str,
    turn_id: str,
    o: SlotOutcome,
    usage: FeatureUsage,
) -> ContinueTurn:
    return ContinueTurn(
        id=turn_id,
        slot_config=conv.slot_config.model_copy(deep=True),
        usage=usage,
        slot=o.slot,
        prompt=prompt,
        response=o.text if o.done else None,
        error=None if o.done else (o.error or "error"),
        reasoning=o.reasoning or None,
        citations=list(o.citations),
        truncated=o.truncated,
        effort_applied=o.effort_applied,
    )


__all__ = [
    "EMPTY_REPLY",
    "INTERNAL_ERROR",
    "SlotOutcome",
    "run_continue",
    "run_send",
    "wait_for_background",
]
