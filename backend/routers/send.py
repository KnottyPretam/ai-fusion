"""Send / continue endpoints (owner: W4 -> bridge-backend S2) — docs/api-contract.md.

    POST /api/conversations/{id}/send                    body {prompt: str, slots?: list[str] | null}
    POST /api/conversations/{id}/slots/{slot}/continue   body {prompt: str}

Both stream SSE (`text/event-stream`) through `sse.sse_response`, which awaits the feature's first
event so every pre-check stays a plain JSON error in FastAPI's `{detail:{error}}` envelope:
404 `not_found/conversation`, 422 `empty_prompt`, 404 `not_found/slot`, 422 `empty_slots`,
409 `busy`. The `slot` path parameter is declared `str` (a `SlotId` Literal would produce a 422
validation array) and an unknown slot is rejected here with `api_errors.not_found("slot")`.

Desktop addendum: `slots` (omitted / null = all three) selects a subset for a Send
(`features.send.run_send(..., slots=)` validates it); `…/continue` is unchanged. Each call runs
inside `bridge.conversation_scope(conv_id)`: `sse_response` awaits the first event inside the
scope, so the producer task the feature spawns inherits the conversation id and every bridge
`request` frame carries it.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import api_errors
from ..features.send import run_continue, run_send
from ..llm.bridge import conversation_scope
from ..schemas import SLOT_IDS
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["send"])


class PromptBody(BaseModel):
    prompt: str
    slots: list[str] | None = None


@router.post("/{conv_id}/send")
async def send(conv_id: str, body: PromptBody) -> StreamingResponse:
    with conversation_scope(conv_id):
        return await sse_response(run_send(conv_id, body.prompt, slots=body.slots))


@router.post("/{conv_id}/slots/{slot}/continue")
async def continue_slot(conv_id: str, slot: str, body: PromptBody) -> StreamingResponse:
    if slot not in SLOT_IDS:
        raise api_errors.not_found("slot")
    with conversation_scope(conv_id):
        return await sse_response(run_continue(conv_id, slot, body.prompt))  # type: ignore[arg-type]
