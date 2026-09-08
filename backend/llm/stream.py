"""OpenRouter SSE line parser (owner: W1). Frozen signature."""

from __future__ import annotations

from collections.abc import Iterable, Iterator

from ..schemas import Delta


def parse_sse_lines(lines: Iterable[str]) -> Iterator[Delta]:
    raise NotImplementedError("W1: backend.llm.stream.parse_sse_lines")
