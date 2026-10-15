"""Read again (2026-10-15): fill a Send slot whose web-pane capture gave up -- docs/semantics.md
"Read again", docs/api-contract.md.

    POST /api/conversations/{conv_id}/turns/{turn_id}/slots/{slot}/reread  (no body)

Why: a pane capture has a budget, and a site can think for longer than any budget (measured that
morning: claude.ai still thinking at 300 s with its stop control up, the answer landing minutes
after the capture gave up). Nothing could fill that slot afterwards, and Analyze refuses a Send
with a missing reply, so the whole turn was lost. This reads the reply out of the pane again --
typing nothing -- and completes the Send exactly as `slot_done` would have.

Pre-checks, all before the first yield (plain JSON errors): 404 not_found(conversation) -> 404
not_found(turn) -> 422 not_a_send_turn -> 404 not_found(slot) (a slot this Send did not run) -> 409
already_captured (the slot holds a reply) -> 422 not_a_web_pane{model} (the slot's model in the
turn is not `web:<site>`: an OpenRouter / Ollama reply cannot be read from a page, and a
`web:<site>:analyst` member was answered on the hidden page) -> 409 reread_stale{since} (anything
but an Analyze or a Refactor after this Send: a later Send, a continue, Fusion or a Plan may have
typed into that pane, and the newest prompt there is no longer this turn's -- `since` is the first
such turn's type) -> busy guard LAST -> 409 busy.

Producer: ONE task, like every feature. `bridge.reread(slot, text=turn.prompt, conversation_id)`:
Electron opens the conversation's recorded chat when the pane shows another, then follows the reply
of the user turn that holds the prompt -- to its end, when the site is still writing it -- and
never hands back another turn's reply (`requireAnchor`). A reply -> `store.complete_send_slot`
(the response, the slot's error / partial / truncation cleared, the `[user, assistant]` pair in
`threads[slot]` under the Send's own turn id, in one write) -> `reread_done`. A failure (still
answering when the pane grant ran out, capture off, the prompt not in the chat, the bridge down)
-> `reread_error`, and NOTHING is written: the turn keeps its original error. A blank reply is a
failure (`empty_reply`), never persisted.

Events: `reread_start{turn_id, slot}` first; then exactly one of `reread_done{turn_id, slot, chars,
done_by}` | `reread_error{turn_id, slot, code, message, error_type}`; a failure of this module
after the first event is the terminal `error{message}`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

from .. import api_errors
from ..llm import bridge
from ..llm.errors import EMPTY_REPLY, ERROR_TYPE_TRIPLEX
from ..schemas import Conversation, SendTurn
from ..store import conversations as store

log = logging.getLogger("triplex.features.reread")

# The turns that never type into a pane: Analyze and Refactor run on the hidden analyst page.
QUIET_TURN_TYPES = frozenset({"analyze", "refactor"})

_END: None = None


def resolve(conv: Conversation, turn_id: str, slot: str) -> SendTurn:
    """Every pre-check but the guard, in contract order; returns the Send turn."""
    index = next((i for i, t in enumerate(conv.turns) if t.id == turn_id), None)
    if index is None:
        raise api_errors.not_found("turn")
    turn = conv.turns[index]
    if not isinstance(turn, SendTurn):
        raise api_errors.unprocessable("not_a_send_turn")
    if slot not in turn.responses:
        raise api_errors.not_found("slot")
    if turn.responses[slot] is not None:
        raise api_errors.conflict("already_captured")
    spec = turn.slot_config.slots.get(slot)
    model = spec.model if spec is not None else ""
    try:
        site, view = bridge.parse_web_model(model)
    except ValueError:
        site, view = None, None
    if site != slot or view != "pane":
        raise api_errors.unprocessable("not_a_web_pane", model=model)
    later = next((t for t in conv.turns[index + 1 :] if t.type not in QUIET_TURN_TYPES), None)
    if later is not None:
        raise api_errors.conflict("reread_stale", since=later.type)
    return turn


async def _produce(
    conv_id: str,
    turn: SendTurn,
    slot: str,
    queue: asyncio.Queue[dict[str, Any] | None],
    guard: Any,
) -> None:
    final: dict[str, Any] | None = None
    head = {"turn_id": turn.id, "slot": slot}
    try:
        queue.put_nowait({"type": "reread_start", **head})
        got = await bridge.reread(slot=slot, text=turn.prompt, conversation_id=conv_id)
        if got.text is not None and not got.text.strip():
            got = bridge.RereadOutcome(
                code=EMPTY_REPLY,
                message="the pane's reply holds no text",
                error_type=ERROR_TYPE_TRIPLEX,
            )
        if got.text is None:
            final = {
                "type": "reread_error",
                **head,
                "code": got.code,
                "message": got.message,
                "error_type": got.error_type,
            }
        else:
            await store.complete_send_slot(conv_id, turn.id, slot, got.text)
            log.info(
                "reread conv=%s turn=%s slot=%s chars=%d done_by=%s",
                conv_id,
                turn.id,
                slot,
                len(got.text),
                got.done_by or "-",
            )
            final = {"type": "reread_done", **head, "chars": len(got.text), "done_by": got.done_by}
    except Exception as e:
        log.exception("reread failed for conversation %s", conv_id)
        final = {"type": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        try:
            await guard.__aexit__(None, None, None)
        finally:
            if final is not None:
                queue.put_nowait(final)
            queue.put_nowait(_END)


async def run_reread(conv_id: str, turn_id: str, slot: str) -> AsyncIterator[dict[str, Any]]:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    turn = resolve(conv, turn_id, slot)
    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    task = asyncio.create_task(_produce(conv_id, turn, slot, queue, guard))
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


__all__ = ["QUIET_TURN_TYPES", "resolve", "run_reread", "wait_for_background"]
