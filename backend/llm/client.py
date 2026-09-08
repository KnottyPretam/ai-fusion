"""OpenRouter client (owner: W1). Frozen signatures; bodies raise until W1 lands."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel

from ..schemas import Delta, Effort, FeatureUsage


async def stream_completion(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    effort: Effort | None,
    max_tokens: int | None,
    response_format: dict[str, Any] | None = None,
    plugins: list[dict[str, Any]] | None = None,
) -> AsyncIterator[Delta]:
    raise NotImplementedError("W1: backend.llm.client.stream_completion")
    yield  # pragma: no cover  (makes this an async generator)


async def complete_json(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    schema_model: type[BaseModel],
    effort: Effort | None,
    max_tokens: int | None,
    retries: int = 1,
) -> tuple[BaseModel | None, str, FeatureUsage, str | None]:
    """Returns (parsed, raw_text, usage, error). Streams internally (docs/semantics.md)."""
    raise NotImplementedError("W1: backend.llm.client.complete_json")
