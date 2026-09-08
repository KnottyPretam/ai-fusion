"""Fusion endpoint (owner: W6) — docs/api-contract.md.

    POST /api/conversations/{id}/fusion   body {of_analyze?: str, max_iterations: int (1..5, required)}
        -> text/event-stream: (the auto-run analyze_* sequence first when no ok Analyze turn
           exists for the newest send turn) fusion_start, round_start, exchange*, round_done,
           ... fusion_done | error{message}
        -> pre-stream JSON errors: 404 not_found (conversation | turn), 409 busy /
           nothing_to_fuse / analyze_degraded / no_send_turn / incomplete_send_turn{missing},
           422 not_an_analyze_turn; a missing or out-of-range `max_iterations` is FastAPI's own
           validation array.

Every pre-check runs inside `run_fusion` before its first yield; `sse_response` awaits that
first event so those HTTPExceptions stay plain JSON errors in FastAPI's `{detail:{error}}`
envelope.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import MAX_ITERATIONS_CAP
from ..features.fusion import run_fusion
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["fusion"])


class FusionBody(BaseModel):
    of_analyze: str | None = None
    max_iterations: int = Field(ge=1, le=MAX_ITERATIONS_CAP)


@router.post("/{conv_id}/fusion")
async def fusion(conv_id: str, body: FusionBody) -> StreamingResponse:
    gen = run_fusion(conv_id, of_analyze=body.of_analyze, max_iterations=body.max_iterations)
    return await sse_response(gen)
