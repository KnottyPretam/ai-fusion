"""The desktop model catalog (owner: desktop-catalog-and-ollama S3). Pure: no network, no cache.

docs/desktop-contract.md section 6 -- `GET /api/models` under `TRIPLEX_DESKTOP=1` returns
`desktop_catalog()` instead of the OpenRouter catalog: `web:<slot>` for the site panes,
`web:<slot>:analyst` for the hidden analyst page on each site, then `ollama:<name>` for every name
in `OLLAMA_MODELS` (default `hermes3`), in that order (sites in `SLOT_IDS` order). Since
2026-09-27 the sites are `vendors.WEB_SITES` -- the three with a Stage-1 adapter, never the whole
seven-vendor catalog -- and their names / vendors come from `vendors.CATALOG`. Every entry has
`efforts == ["off"]` (the site or the local server decides; `reasoning.build` sends nothing),
`mandatory_reasoning False`, `structured_outputs False` (lenient JSON parse, never a strict
`response_format`), no prices and no context length, and `raw == {"transport": "web" | "ollama"}`
for the config bar's grouping. Vendors: `anthropic` / `openai` / `x-ai` for the panes,
`triplex-analyst` for the analyst pages, `ollama` for local models.

`tag_openrouter(models)` (2026-09-27) is what `routers/models.py` appends when a session key is
configured: COPIES of the OpenRouter entries a council row can seat, each with
`raw.transport == "openrouter"` beside the entry's own raw fields. Copies, because the originals
are `catalog._mem` -- the objects `catalog.get_meta` serves to every feature -- and a router must
never mutate them.

The catalog module is untouched: nothing here is cached into `catalog._mem`, so
`catalog.get_meta("web:...")` / `get_meta("ollama:...")` stay None -- an unknown model means
`complete_json` parses leniently and `validate_slot_config` accepts any effort.

Readings where the contract is silent (also listed in the S3 report):
- `OLLAMA_MODELS` is comma-separated; entries are stripped, blanks dropped, duplicates kept once
  (first occurrence wins), a leading `ollama:` is tolerated so a copied id works, and an all-blank
  value falls back to the default.
- Display names: `web:<slot>` -> "<Site> (web session)", `web:<slot>:analyst` -> "<Site> web
  session (hidden analyst page)", `ollama:<name>` -> "<name> (local Ollama)".
"""

from __future__ import annotations

import os
from collections.abc import Iterable

from ..schemas import ModelMeta, SlotId
from ..vendors import BY_ID, WEB_SITES
from . import ollama

ENV_OLLAMA_MODELS = "OLLAMA_MODELS"
DEFAULT_OLLAMA_MODELS = "hermes3"

SITE_NAMES: dict[SlotId, str] = {slot: BY_ID[slot].name for slot in WEB_SITES}
SITE_VENDORS: dict[SlotId, str] = {slot: BY_ID[slot].prefixes[0] for slot in WEB_SITES}
ANALYST_VENDOR = "triplex-analyst"
OLLAMA_VENDOR = "ollama"
TRANSPORT_WEB = "web"
TRANSPORT_OLLAMA = "ollama"
TRANSPORT_OPENROUTER = "openrouter"


def ollama_models() -> list[str]:
    """The bare names in `OLLAMA_MODELS` (see the module docstring); `["hermes3"]` by default."""
    raw = os.environ.get(ENV_OLLAMA_MODELS, "")
    names: list[str] = []
    for part in raw.split(","):
        name = ollama.model_name(part.strip())
        if name and name not in names:
            names.append(name)
    return names or [DEFAULT_OLLAMA_MODELS]


def _entry(model_id: str, *, name: str, vendor: str, transport: str) -> ModelMeta:
    return ModelMeta(
        id=model_id,
        name=name,
        vendor=vendor,
        context_length=None,
        price_prompt=None,
        price_completion=None,
        efforts=["off"],
        mandatory_reasoning=False,
        structured_outputs=False,
        raw={"transport": transport},
    )


def desktop_catalog() -> list[ModelMeta]:
    """Fresh `ModelMeta` objects on every call (a caller may mutate what it gets)."""
    out: list[ModelMeta] = []
    for slot in WEB_SITES:
        out.append(
            _entry(
                f"web:{slot}",
                name=f"{SITE_NAMES[slot]} (web session)",
                vendor=SITE_VENDORS[slot],
                transport=TRANSPORT_WEB,
            )
        )
    for slot in WEB_SITES:
        out.append(
            _entry(
                f"web:{slot}:analyst",
                name=f"{SITE_NAMES[slot]} web session (hidden analyst page)",
                vendor=ANALYST_VENDOR,
                transport=TRANSPORT_WEB,
            )
        )
    for name in ollama_models():
        out.append(
            _entry(
                f"ollama:{name}",
                name=f"{name} (local Ollama)",
                vendor=OLLAMA_VENDOR,
                transport=TRANSPORT_OLLAMA,
            )
        )
    return out


def tag_openrouter(models: Iterable[ModelMeta]) -> list[ModelMeta]:
    """Deep copies of `models`, each tagged `raw.transport == "openrouter"`; the input objects
    (the catalog's own cache entries) are never touched."""
    out: list[ModelMeta] = []
    for m in models:
        copy = m.model_copy(deep=True)
        copy.raw = {**copy.raw, "transport": TRANSPORT_OPENROUTER}
        out.append(copy)
    return out


__all__ = [
    "ANALYST_VENDOR",
    "DEFAULT_OLLAMA_MODELS",
    "OLLAMA_VENDOR",
    "SITE_NAMES",
    "SITE_VENDORS",
    "TRANSPORT_OLLAMA",
    "TRANSPORT_OPENROUTER",
    "TRANSPORT_WEB",
    "desktop_catalog",
    "ollama_models",
    "tag_openrouter",
]
