"""GET /api/models (owner: W1 -> desktop-catalog-and-ollama S3): the model catalog as a bare JSON
array of ModelMeta.

Under `TRIPLEX_DESKTOP=1` (docs/desktop-contract.md section 6) the response is
`webmodels.desktop_catalog()` -- the `web:*` / `ollama:*` entries, built in memory, never a network
call, `force_refresh` ignored; the catalog module is not touched, so `catalog.get_meta` keeps
answering None for those ids. Otherwise the endpoint is byte-identical to before: the OpenRouter
catalog via `catalog.get_catalog(force_refresh=...)`. The flag is read per request
(`client.desktop_mode`, a private env read -- config.py is frozen).
"""

from __future__ import annotations

from fastapi import APIRouter

from ..schemas import ModelMeta

router = APIRouter(prefix="/api", tags=["models"])


@router.get("/models", response_model=list[ModelMeta])
async def list_models(force_refresh: bool = False) -> list[ModelMeta]:
    from ..llm import catalog, webmodels  # lazy: keeps router import cheap and monkeypatchable
    from ..llm.client import desktop_mode

    if desktop_mode():
        return webmodels.desktop_catalog()
    return await catalog.get_catalog(force_refresh=force_refresh)
