"""GET /api/models (owner: W1): the model catalog as a bare JSON array of ModelMeta."""

from __future__ import annotations

from fastapi import APIRouter

from ..schemas import ModelMeta

router = APIRouter(prefix="/api", tags=["models"])


@router.get("/models", response_model=list[ModelMeta])
async def list_models(force_refresh: bool = False) -> list[ModelMeta]:
    from ..llm import catalog  # lazy: keeps router import cheap and monkeypatchable

    return await catalog.get_catalog(force_refresh=force_refresh)
