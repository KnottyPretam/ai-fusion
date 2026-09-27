"""GET /api/ollama/models (2026-09-27, the Agents page's local-model list).

    -> {base_url, loopback, models: [name, ...]}

`ollama.list_local_models(timeout_s=2.0)`: the names Ollama reports at `<server>/api/tags`, read
from a LOOPBACK base URL only (a remote Ollama is served for calls, with the warning, but this
listing never reaches out across the network), never raises, `[]` on any failure -- a server that
is not running is the normal case on a machine without Ollama, not an error.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/api/ollama", tags=["ollama"])


@router.get("/models")
async def list_ollama_models() -> dict[str, Any]:
    from ..llm import ollama  # lazy: keeps the router import cheap and monkeypatchable

    base = ollama.base_url()
    loopback = ollama.is_loopback(base)
    models = await ollama.list_local_models(timeout_s=2.0) if loopback else []
    return {"base_url": base, "loopback": loopback, "models": models}
