"""Per-conversation slot configuration endpoints (owner: W2) — docs/api-contract.md.

    GET /api/conversations/{id}/slot_config -> 200 SlotConfig           (404 not_found/conversation)
    PUT /api/conversations/{id}/slot_config -> 200 the STORED SlotConfig (not the conversation)
        body = a full SlotConfig (pydantic 422 list otherwise);
        422 {detail:{error:"unsupported_effort", slot, model, effort, supported:[...]}} only when
        the catalog knows the model and the effort is not in meta.efforts (features/slot_config.py).

Order of checks on PUT: body validation (FastAPI) -> 404 when the conversation is missing ->
422 unsupported_effort -> store.update_slot_config, which REPLACES the stored object.
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import api_errors
from ..features.slot_config import validate_slot_config
from ..schemas import SlotConfig
from ..store import conversations as store

router = APIRouter(prefix="/api/conversations", tags=["config"])


@router.get("/{conv_id}/slot_config", response_model=SlotConfig)
async def get_slot_config(conv_id: str) -> SlotConfig:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    return conv.slot_config


@router.put("/{conv_id}/slot_config", response_model=SlotConfig)
async def put_slot_config(conv_id: str, cfg: SlotConfig) -> SlotConfig:
    if await store.load(conv_id) is None:
        raise api_errors.not_found("conversation")
    validate_slot_config(cfg)
    conv = await store.update_slot_config(conv_id, cfg)  # not_found() if deleted meanwhile
    return conv.slot_config
