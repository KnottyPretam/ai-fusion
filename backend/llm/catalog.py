"""Model catalog (owner: W1). Frozen signatures."""

from __future__ import annotations

from ..schemas import ModelMeta


async def get_catalog(*, force_refresh: bool = False) -> list[ModelMeta]:
    raise NotImplementedError("W1: backend.llm.catalog.get_catalog")


def get_meta(model: str) -> ModelMeta | None:
    """From the in-memory cache / offline fixture; None when the model is unknown."""
    raise NotImplementedError("W1: backend.llm.catalog.get_meta")
