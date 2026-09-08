"""Frozen SSE response helper. Routers wrap a feature generator: `return await sse_response(gen)`."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from fastapi.responses import StreamingResponse

from .schemas import sse_frame

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


async def sse_response(events: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    """Await the FIRST event before building the response.

    Any HTTPException a feature raises before its first yield (404 not_found, 409 busy /
    incomplete_send_turn / nothing_to_fuse / analyze_degraded / no_send_turn, 422) therefore
    still becomes a plain JSON error with an HTTP status. Once the first event exists the status
    is committed to 200: later failures MUST be emitted as a terminal `error{message}` event.
    """
    it = events.__aiter__()
    try:
        first: dict[str, Any] | None = await it.__anext__()
    except StopAsyncIteration:
        first = None

    async def gen() -> AsyncIterator[str]:
        if first is not None:
            yield sse_frame(first)
        async for ev in it:
            yield sse_frame(ev)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
