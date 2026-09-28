"""Plan endpoint (2026-09-27) — docs/api-contract.md.

    POST /api/conversations/{id}/plan  body {of_fusion?: str, force?: bool = false, model?: str}
        -> text/event-stream: plan_start{turn_id, of_fusion, model}, plan_retry{error}?,
           plan_done{turn, cached} | plan_degraded{turn}
        -> pre-stream JSON errors: 404 not_found (conversation | turn), 409 no_fusion_turn | busy,
           422 not_a_fusion_turn | empty_model | plan_input_too_large{chars, max}

Same contract shape as Refactor, for the same reasons: every pre-check runs before the first yield
so those HTTPExceptions stay plain JSON errors, and the call runs inside
`bridge.conversation_scope(conv_id)` so the producer task inherits the conversation id for its
bridge request -- which is how the default plan model, the user's own Claude PANE, is typed into
THIS conversation's chat rather than a fresh one.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..features.plan import run_plan
from ..llm.bridge import conversation_scope
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["plan"])


class PlanBody(BaseModel):
    of_fusion: str | None = None
    force: bool = False
    model: str | None = None


@router.post("/{conv_id}/plan")
async def plan(conv_id: str, body: PlanBody | None = None) -> StreamingResponse:
    body = body or PlanBody()
    with conversation_scope(conv_id):
        return await sse_response(
            run_plan(conv_id, of_fusion=body.of_fusion, force=body.force, model=body.model)
        )
