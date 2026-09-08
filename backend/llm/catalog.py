"""Model catalog (owner: W1). Frozen signatures: `get_catalog(*, force_refresh)`, `get_meta(model)`.

- Live: `GET {OPENROUTER_BASE_URL}/models` (no auth needed), cached in memory and on disk at
  `settings().data_dir / "models.json"` with TTL `settings().catalog_ttl_s`.
- Mock mode (`MOCK_OPENROUTER=1`) or ANY fetch failure: the offline fixture
  `backend/llm/fixtures/models.json` (same shape as the real endpoint: `{"data": [...]}`). A
  failed live fetch is not retried for `FETCH_RETRY_S` (the fixture is served from memory), so
  the UI's `GET /api/models` on every mount does not hammer an unreachable endpoint;
  `force_refresh=True` always retries.
- `get_meta(model)` reads the in-memory cache, then the offline fixture; None when unknown. It
  never performs network I/O (and nothing here does in mock mode).

Mapping (docs/api-contract.md): `vendor` = slug prefix before the first "/", `name` = OpenRouter
`name`, `efforts` / `mandatory_reasoning` via `schemas.efforts_from_reasoning_meta(entry.reasoning)`,
`structured_outputs` = "structured_outputs" in `supported_parameters`, prices =
`float(pricing.prompt / pricing.completion)` (USD per token), `raw` = the entry verbatim.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

from ..config import settings
from ..schemas import ModelMeta, efforts_from_reasoning_meta

log = logging.getLogger("triplex.llm.catalog")

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "models.json"
DISK_CACHE_NAME = "models.json"
FETCH_TIMEOUT_S = 30.0
FETCH_RETRY_S = 60.0  # after a failed live fetch: serve the fixture from memory this long

# In-memory cache (filled by get_catalog) and the memoised offline fixture (get_meta fallback).
_mem: list[ModelMeta] | None = None
_mem_by_id: dict[str, ModelMeta] = {}
_mem_loaded_at: float = 0.0
_mem_source: str | None = None  # "network" | "disk" | "fixture"
_fetch_failed_at: float | None = None  # time.time() of the last failed live fetch
_offline: list[ModelMeta] | None = None
_offline_by_id: dict[str, ModelMeta] = {}


# --------------------------------------------------------------------------- mapping
def _price(pricing: Any, key: str) -> float | None:
    if not isinstance(pricing, dict):
        return None
    v = pricing.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_meta(entry: dict[str, Any]) -> ModelMeta | None:
    """One raw `/models` entry -> ModelMeta (None when the entry has no usable id)."""
    if not isinstance(entry, dict):
        return None
    slug = entry.get("id")
    if not isinstance(slug, str) or not slug:
        return None
    reasoning = entry.get("reasoning")
    efforts, mandatory = efforts_from_reasoning_meta(
        reasoning if isinstance(reasoning, dict) else None
    )
    params = entry.get("supported_parameters")
    params = params if isinstance(params, list) else []
    ctx = entry.get("context_length")
    name = entry.get("name")
    return ModelMeta(
        id=slug,
        name=name if isinstance(name, str) else "",
        vendor=slug.split("/", 1)[0] if "/" in slug else "",
        context_length=int(ctx) if isinstance(ctx, int | float) else None,
        price_prompt=_price(entry.get("pricing"), "prompt"),
        price_completion=_price(entry.get("pricing"), "completion"),
        efforts=efforts,
        mandatory_reasoning=mandatory,
        structured_outputs="structured_outputs" in params,
        raw=entry,
    )


def map_entries(entries: Any) -> list[ModelMeta]:
    out: list[ModelMeta] = []
    if not isinstance(entries, list):
        return out
    for e in entries:
        m = to_meta(e)
        if m is not None:
            out.append(m)
    return out


def _entries_of(doc: Any) -> list[Any]:
    if isinstance(doc, dict):
        data = doc.get("data")
        return data if isinstance(data, list) else []
    return doc if isinstance(doc, list) else []


# --------------------------------------------------------------------------- offline fixture
def load_offline() -> list[ModelMeta]:
    """The packaged offline fixture, memoised. Never raises (empty list on a broken file)."""
    global _offline, _offline_by_id
    if _offline is None:
        try:
            with FIXTURE_PATH.open("r", encoding="utf-8") as fh:
                doc = json.load(fh)
            models = map_entries(_entries_of(doc))
        except (OSError, ValueError) as e:  # pragma: no cover - packaged file
            log.error("offline model fixture unreadable at %s: %s", FIXTURE_PATH, e)
            models = []
        _offline = models
        _offline_by_id = {m.id: m for m in models}
    return _offline


# --------------------------------------------------------------------------- disk cache
def _disk_cache_path() -> Path:
    return settings().data_dir / DISK_CACHE_NAME


def _read_disk_cache(path: Path) -> tuple[float, list[Any]] | None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    fetched_at = doc.get("fetched_at")
    entries = doc.get("data")
    if not isinstance(fetched_at, int | float) or not isinstance(entries, list):
        return None
    return float(fetched_at), entries


def _write_disk_cache(path: Path, fetched_at: float, entries: list[Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump({"fetched_at": fetched_at, "data": entries}, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError as e:
        log.warning("could not write model catalog cache %s: %s", path, e)


# --------------------------------------------------------------------------- cache state
def _set_mem(models: list[ModelMeta], source: str, loaded_at: float) -> None:
    global _mem, _mem_by_id, _mem_loaded_at, _mem_source, _fetch_failed_at
    _mem = list(models)
    _mem_by_id = {m.id: m for m in _mem}
    _mem_loaded_at = loaded_at
    _mem_source = source
    if source != "fixture":
        _fetch_failed_at = None


def _reset_cache() -> None:
    """Tests only: forget every cached catalog (memory + memoised fixture)."""
    global _mem, _mem_by_id, _mem_loaded_at, _mem_source, _offline, _offline_by_id
    global _fetch_failed_at
    _mem = None
    _mem_by_id = {}
    _mem_loaded_at = 0.0
    _mem_source = None
    _fetch_failed_at = None
    _offline = None
    _offline_by_id = {}


def cache_source() -> str | None:
    """Where the in-memory catalog came from ("network" | "disk" | "fixture" | None)."""
    return _mem_source


# --------------------------------------------------------------------------- network
async def _fetch_entries(base_url: str, timeout_s: float) -> list[Any]:
    url = base_url.rstrip("/") + "/models"
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.get(url, headers={"Accept": "application/json"})
        resp.raise_for_status()
        doc = resp.json()
    entries = _entries_of(doc)
    if not entries:
        raise ValueError("catalog response carried no models")
    return entries


# --------------------------------------------------------------------------- public API
async def get_catalog(*, force_refresh: bool = False) -> list[ModelMeta]:
    global _fetch_failed_at
    s = settings()
    if s.mock_openrouter:
        models = load_offline()
        _set_mem(models, "fixture", time.time())
        return list(models)

    now = time.time()
    ttl = float(s.catalog_ttl_s)
    if (
        not force_refresh
        and _mem is not None
        and _mem_source in ("network", "disk")
        and now - _mem_loaded_at < ttl
    ):
        return list(_mem)
    if (
        not force_refresh
        and _mem is not None
        and _fetch_failed_at is not None
        and now - _fetch_failed_at < FETCH_RETRY_S
    ):
        return list(_mem)  # recent fetch failure: do not retry on every call

    path = _disk_cache_path()
    if not force_refresh:
        cached = _read_disk_cache(path)
        if cached is not None and now - cached[0] < ttl:
            models = map_entries(cached[1])
            if models:
                _set_mem(models, "disk", cached[0])
                return list(models)

    try:
        entries = await _fetch_entries(
            s.openrouter_base_url, min(FETCH_TIMEOUT_S, s.request_timeout_s)
        )
        models = map_entries(entries)
        if not models:
            raise ValueError("catalog response mapped to zero models")
    except Exception as e:  # any failure -> offline fixture
        log.warning(
            "model catalog fetch failed (%s: %s); using offline fixture", type(e).__name__, e
        )
        models = load_offline()
        _set_mem(models, "fixture", now)
        _fetch_failed_at = now
        return list(models)

    _write_disk_cache(path, now, entries)
    _set_mem(models, "network", now)
    log.info("model catalog refreshed: %d models", len(models))
    return list(models)


def get_meta(model: str) -> ModelMeta | None:
    """From the in-memory cache / offline fixture; None when the model is unknown."""
    if not isinstance(model, str) or not model:
        return None
    m = _mem_by_id.get(model)
    if m is not None:
        return m
    load_offline()
    return _offline_by_id.get(model)
