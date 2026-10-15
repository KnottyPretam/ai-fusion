"""Read-again endpoint (2026-10-15) -- docs/api-contract.md.

    POST /api/conversations/{id}/turns/{turn_id}/slots/{slot}/reread   (no body)
        -> text/event-stream: reread_start{turn_id, slot},
           reread_done{turn_id, slot, chars, done_by} | reread_error{turn_id, slot, code, message, error_type}
        -> pre-stream JSON errors: 404 not_found (conversation | turn | slot), 409 already_captured |
           reread_stale{since} | busy, 422 not_a_send_turn | not_a_web_pane{model}

`slot` is a plain `str` (a Literal would 422 an unknown slot instead of the contract's 404), and
the call runs inside `bridge.conversation_scope(conv_id)` like every feature that reaches a pane.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..features.reread import run_reread
from ..llm.bridge import conversation_scope
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["reread"])


@router.post("/{conv_id}/turns/{turn_id}/slots/{slot}/reread")
async def reread(conv_id: str, turn_id: str, slot: str) -> StreamingResponse:
    with conversation_scope(conv_id):
        return await sse_response(run_reread(conv_id, turn_id, slot))
