"""Frozen SSE response helper. Routers wrap a feature generator with `sse_response(gen)`."""

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


def sse_response(events: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    async def gen() -> AsyncIterator[str]:
        async for ev in events:
            yield sse_frame(ev)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
