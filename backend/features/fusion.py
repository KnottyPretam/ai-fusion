"""Fusion feature (owner: W6). Frozen signature; yields fusion_* (and auto-run analyze_*) events."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any


async def run_fusion(
    conv_id: str, *, of_analyze: str | None, max_iterations: int
) -> AsyncIterator[dict[str, Any]]:
    raise NotImplementedError("W6: backend.features.fusion.run_fusion")
    yield  # pragma: no cover
