"""Pre-parse endpoint — docs/api-contract.md.

    POST /api/conversations/{id}/preparse  body {prompt: str}
        -> text/event-stream: preparse_start{}, preparse_retry{error} (progress),
           preparse_done{prompt, original, question, usage}
           | preparse_degraded{error, original, raw_attempts, usage}
        -> pre-stream JSON errors: 404 not_found (conversation), 409 busy,
           422 empty_prompt | prompt_too_long{chars, max} (a missing `prompt` is pydantic's own 422)

Nothing is persisted: the stream hands back a prompt for the composer, and the Send that follows
is what writes. Every pre-check runs before the first yield so those HTTPExceptions stay plain
JSON errors; the call is wrapped in `bridge.conversation_scope(conv_id)` like every feature route,
and the feature re-enters the scope itself for the call it runs inline (see its module docstring).
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..features.preparse import run_preparse
from ..llm.bridge import conversation_scope
from ..sse import sse_response

router = APIRouter(prefix="/api/conversations", tags=["preparse"])


class PreparseBody(BaseModel):
    prompt: str


@router.post("/{conv_id}/preparse")
async def preparse(conv_id: str, body: PreparseBody) -> StreamingResponse:
    with conversation_scope(conv_id):
        return await sse_response(run_preparse(conv_id, body.prompt))
