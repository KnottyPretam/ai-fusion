"""Pre-parse — a preview step in front of Send (docs/semantics.md "Pre-parse").

The user's request: a new prompt should reach the three sites clear and succinct, and each reply
should come back concise and parsable for Analyze. Pre-parse is the button beside Send that does
the first half and asks for the second: ONE analyst call restates the composer text
(`prompts.preparse.restate_messages`, the same hidden analyst page and the same validated primitive
Refactor uses — `refactor.validated_call`), and the restatement comes back with Triplex's
deterministic answer-format block appended LAST (`prompts.preparse.compose`). The user reviews or
edits it and presses Send as usual: Send stays byte-verbatim, nothing here is persisted, and there
is no new turn type — the Send that follows persists whatever text the user approved. The restated
question is model-authored text that BECOMES the user's prompt, so it is deliberately not scrubbed
(scrubbing would put `[model]` into what the user sends).

Pre-checks, in order and all before the first yield (so `sse.sse_response` turns them into plain
JSON errors): `store.load` -> 404 `not_found(conversation)`; a blank prompt -> 422 `empty_prompt`
(a prompt that is nothing but the answer block counts as blank: `strip_format` leaves nothing to
restate); the question over `PREPARSE_MAX_CHARS` -> 422 `prompt_too_long{chars, max}` — never
truncated, the message says why (`analyze.CONDENSE_CHUNK_CHARS` is the measured bound on what one
analyst message can be answered for); and LAST the busy guard -> 409 `busy`. Why per-conversation
at all when nothing is written: the busy guard is the only thing serialising this call against an
Analyze, Fusion or Refactor on the same hidden analyst view, and a correction attempt on a web
analyst (`fresh:false`) continues the analyst chat the conversation id names — without the id the
desktop would type the correction alone into an empty chat, the hazard `web_retry_suppressed`
exists for.

INLINE, AND CANCELLATION-AWARE — the one deliberate deviation from the one-producer-task shape
every other feature has. The producer task exists so that a client disconnect can never lose a
persistence write; Pre-parse writes nothing, so the analyst call runs in the generator's own task:
`preparse_start{}` -> `preparse_retry{error: NOTICE}` (progress, as `refactor_retry`) -> the call
-> `preparse_done{prompt, original, question, usage}` | `preparse_degraded{error, original,
raw_attempts, usage}`, with an unexpected exception after the first event becoming the terminal
`error{message}` as in Refactor. Starlette cancels the response body task when the client
disconnects (`StreamingResponse.listen_for_disconnect` on the spec the servers speak), the
`finally` here releases the guard, the `CancelledError` propagates after the release, and on the
way out the bridge closes `hub.request` — a `cancel` frame frees the analyst view. That is what
makes the composer's Cancel button real rather than cosmetic: a stuck analyst would otherwise hold
the composer for the whole analyst grant (`BRIDGE_ANALYST_TIMEOUT_S`, 1,800 s). One consequence of
running inline: the `conversation_scope` the router opened has ended by the time the streaming
task drives this generator past its first event (the producer features inherit it by copying the
context when they spawn), so the scope is re-entered here around the call, from the id the route
already carries.

`purpose` is `"extraction"` (the frozen `Purpose` literal has no room for a new name, exactly as
Refactor) and `role` `"analyst"`: the meter reads this as analyst work, which it is.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel

from .. import api_errors
from ..llm import bridge, client
from ..prompts import preparse as prompts
from ..store import conversations as store
from . import refactor
from .analyze import CONDENSE_CHUNK_CHARS

log = logging.getLogger("triplex.features.preparse")

ROLE = refactor.ROLE
PURPOSE = refactor.PURPOSE  # "extraction": the frozen Purpose literal has no room (docstring)
# The most a question may be: the measured single-message bound (`analyze.CONDENSE_CHUNK_CHARS`).
PREPARSE_MAX_CHARS = CONDENSE_CHUNK_CHARS
NOTICE = "restating the question concisely"
EMPTY_RESTATEMENT = "the analyst returned an empty restatement"


class _RestateResult(BaseModel):
    """The restate call's validated shape. Local, not in `schemas.py`: it is this feature's wire
    format and nothing persists it."""

    question: str


async def run_preparse(conv_id: str, prompt: str) -> AsyncIterator[dict[str, Any]]:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    text = prompt.strip() if isinstance(prompt, str) else ""
    if not text:
        raise api_errors.unprocessable("empty_prompt")
    question = prompts.strip_format(text)
    if not question:
        raise api_errors.unprocessable("empty_prompt")  # nothing but Triplex's own scaffold
    if len(question) > PREPARSE_MAX_CHARS:
        raise api_errors.unprocessable(
            "prompt_too_long", chars=len(question), max=PREPARSE_MAX_CHARS
        )

    guard = store.busy_guard(conv_id)
    await guard.__aenter__()  # LAST pre-check: 409 busy
    started = time.monotonic()
    final: dict[str, Any]
    try:
        yield {"type": "preparse_start"}
        yield {"type": "preparse_retry", "error": NOTICE}
        model = conv.slot_config.analyst_model
        # Transport-aware packaging (prompts/preparse.py): a web analyst is asked for a fence.
        fenced = client.transport_kind(model) == "web"
        # Inline, so the router's scope has already ended (module docstring): re-enter it for the
        # call, which is where the bridge reads the conversation id for its request frame.
        with bridge.conversation_scope(conv_id):
            value, raw, usage, error = await refactor.validated_call(
                model=model,
                messages=prompts.restate_messages(question, fenced=fenced),
                schema_model=_RestateResult,
                fenced=fenced,
            )
        usage.set_wall_clock(max(1, int((time.monotonic() - started) * 1000)))
        restated = value.question.strip() if isinstance(value, _RestateResult) else ""
        if value is None:
            final = {
                "type": "preparse_degraded",
                "error": refactor._error_of(None, error),
                "original": text,
                "raw_attempts": [raw],
                "usage": usage.model_dump(),
            }
        elif not restated:
            final = {
                "type": "preparse_degraded",
                "error": EMPTY_RESTATEMENT,
                "original": text,
                "raw_attempts": [raw],
                "usage": usage.model_dump(),
            }
        else:
            final = {
                "type": "preparse_done",
                "prompt": prompts.compose(restated),
                "original": text,
                "question": restated,
                "usage": usage.model_dump(),
            }
    except Exception as e:
        log.exception("preparse failed for conversation %s", conv_id)
        final = {"type": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        # Released before the final event is handed over, as every feature does — and on a
        # cancellation (the client went away) or a close, before the exception propagates.
        await guard.__aexit__(None, None, None)
    yield final


__all__ = [
    "EMPTY_RESTATEMENT",
    "NOTICE",
    "PREPARSE_MAX_CHARS",
    "PURPOSE",
    "ROLE",
    "run_preparse",
]
