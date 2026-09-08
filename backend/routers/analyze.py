"""Analyze endpoint (owner: W5) — docs/api-contract.md.

    POST /api/conversations/{id}/analyze   body {of_turn?: str, force?: bool = false}
        -> text/event-stream: analyze_start{turn_id, of_turn}, analyze_retry{error}?,
           analyze_done{turn, cached} | analyze_degraded{turn}
        -> pre-stream JSON errors: 404 not_found (conversation | turn), 409 busy |
           incomplete_send_turn{missing} | no_send_turn, 422 not_a_send_turn

The feature performs every pre-check before its first yield; `sse_response` awaits that first
event so those HTTPExceptions stay plain JSON errors in FastAPI's `{detail:{error}}` envelope.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..features.analyze import run_analyze
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["analyze"])


class AnalyzeBody(BaseModel):
    of_turn: str | None = None
    force: bool = False


@router.post("/{conv_id}/analyze")
async def analyze(conv_id: str, body: AnalyzeBody | None = None) -> StreamingResponse:
    body = body or AnalyzeBody()
    return await sse_response(run_analyze(conv_id, of_turn=body.of_turn, force=body.force))
