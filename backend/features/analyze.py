"""Analyze feature (owner: W5). Frozen signature; yields analyze_* SSE event dicts."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any


async def run_analyze(
    conv_id: str, *, of_turn: str | None = None, force: bool = False
) -> AsyncIterator[dict[str, Any]]:
    raise NotImplementedError("W5: backend.features.analyze.run_analyze")
    yield  # pragma: no cover
