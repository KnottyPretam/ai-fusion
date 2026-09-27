"""GET /api/models (owner: W1 -> desktop-catalog-and-ollama S3): the model catalog as a bare JSON
array of ModelMeta.

Under `TRIPLEX_DESKTOP=1` (docs/desktop-contract.md section 6) the response starts with
`webmodels.desktop_catalog()` -- the `web:*` / `ollama:*` entries, built in memory -- and, since
2026-09-27, continues with the OpenRouter models a council row can seat WHEN a session key has been
pushed (`session_key.get_key()`): `catalog.get_catalog(force_refresh=...)` filtered by
`vendors.openrouter_filter` and tagged `raw.transport == "openrouter"` on COPIES
(`webmodels.tag_openrouter`, so `catalog._mem` keeps the untagged entries `get_meta` serves).
Without a key nothing reaches the network and the response is the desktop catalog alone. Outside
desktop mode the endpoint is byte-identical to before: the OpenRouter catalog via
`catalog.get_catalog(force_refresh=...)`. The flag is read per request (`client.desktop_mode`, a
private env read -- config.py is frozen).
"""

from __future__ import annotations

from fastapi import APIRouter

from ..schemas import ModelMeta

router = APIRouter(prefix="/api", tags=["models"])


@router.get("/models", response_model=list[ModelMeta])
async def list_models(force_refresh: bool = False) -> list[ModelMeta]:
    from ..llm import catalog, session_key, webmodels  # lazy: cheap import, monkeypatchable
    from ..llm.client import desktop_mode
    from ..vendors import openrouter_filter

    if desktop_mode():
        out = webmodels.desktop_catalog()
        if session_key.get_key():
            live = await catalog.get_catalog(force_refresh=force_refresh)
            out.extend(webmodels.tag_openrouter(openrouter_filter(live)))
        return out
    return await catalog.get_catalog(force_refresh=force_refresh)
