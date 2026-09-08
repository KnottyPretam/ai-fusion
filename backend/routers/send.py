"""Send / continue endpoints (owner: W4) — docs/api-contract.md.

    POST /api/conversations/{id}/send                    body {prompt: str}
    POST /api/conversations/{id}/slots/{slot}/continue   body {prompt: str}

Both stream SSE (`text/event-stream`) through `sse.sse_response`, which awaits the feature's first
event so every pre-check stays a plain JSON error in FastAPI's `{detail:{error}}` envelope:
404 `not_found/conversation`, 422 `empty_prompt`, 404 `not_found/slot`, 409 `busy`. The `slot`
path parameter is declared `str` (a `SlotId` Literal would produce a 422 validation array) and
an unknown slot is rejected here with `api_errors.not_found("slot")`.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import api_errors
from ..features.send import run_continue, run_send
from ..schemas import SLOT_IDS
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["send"])


class PromptBody(BaseModel):
    prompt: str


@router.post("/{conv_id}/send")
async def send(conv_id: str, body: PromptBody) -> StreamingResponse:
    return await sse_response(run_send(conv_id, body.prompt))


@router.post("/{conv_id}/slots/{slot}/continue")
async def continue_slot(conv_id: str, slot: str, body: PromptBody) -> StreamingResponse:
    if slot not in SLOT_IDS:
        raise api_errors.not_found("slot")
    return await sse_response(run_continue(conv_id, slot, body.prompt))  # type: ignore[arg-type]
