"""Refactor endpoint (S11) — docs/api-contract.md.

    POST /api/conversations/{id}/refactor  body {of_turn?: str, force?: bool = false}
        -> text/event-stream: refactor_start{turn_id, of_turn}, refactor_retry{error}?,
           refactor_done{turn, cached} | refactor_degraded{turn}
        -> pre-stream JSON errors: 404 not_found (conversation | turn), 409 busy |
           incomplete_send_turn{missing} | no_send_turn, 422 not_a_send_turn

Same contract shape as Analyze, for the same reasons: every pre-check runs before the first yield so
those HTTPExceptions stay plain JSON errors, and the call runs inside
`bridge.conversation_scope(conv_id)` so the producer task inherits the conversation id for its bridge
requests (the desktop's analyst page is reached that way).
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..features.refactor import run_refactor
from ..llm.bridge import conversation_scope
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["refactor"])


class RefactorBody(BaseModel):
    of_turn: str | None = None
    force: bool = False


@router.post("/{conv_id}/refactor")
async def refactor(conv_id: str, body: RefactorBody | None = None) -> StreamingResponse:
    body = body or RefactorBody()
    with conversation_scope(conv_id):
        return await sse_response(run_refactor(conv_id, of_turn=body.of_turn, force=body.force))
