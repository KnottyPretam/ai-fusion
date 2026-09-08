"""Send / continue feature (owner: W4). Frozen signatures; yields SSE event dicts."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ..schemas import SlotId


async def run_send(conv_id: str, prompt: str) -> AsyncIterator[dict[str, Any]]:
    raise NotImplementedError("W4: backend.features.send.run_send")
    yield  # pragma: no cover


async def run_continue(conv_id: str, slot: SlotId, prompt: str) -> AsyncIterator[dict[str, Any]]:
    raise NotImplementedError("W4: backend.features.send.run_continue")
    yield  # pragma: no cover
