"""Effort -> OpenRouter `reasoning` object (owner: W1). Frozen signature."""

from __future__ import annotations

from typing import Any

from ..schemas import Effort, ModelMeta


def build(
    effort: Effort | None, meta: ModelMeta | None
) -> tuple[dict[str, Any] | None, Effort, bool]:
    """Returns (reasoning_param_or_None, effort_applied, coerced). Never raises."""
    raise NotImplementedError("W1: backend.llm.reasoning.build")
