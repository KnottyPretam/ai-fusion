"""Conversation CRUD endpoints (owner: W2) — docs/api-contract.md.

    GET    /api/conversations              -> 200 list[ConversationSummary] (newest updated_at first)
    POST   /api/conversations              -> 201 ConversationPublic  body {title?, slot_config?}
    GET    /api/conversations/{id}         -> 200 ConversationPublic  (404 not_found/conversation)
    DELETE /api/conversations/{id}         -> 204 empty                (404 if missing)
    PATCH  /api/conversations/{id}/title   -> 200 ConversationPublic  body {title: 1..200 chars}

The `anon_map` never appears in a response: every document goes through `schemas.to_public`.
The slot_config endpoints live in `routers/config.py`. A POST without `slot_config` seats the
council the desktop pushed (`routers/session.py` `session_defaults()`, 2026-09-27) when there is
one, else `settings().default_slot_config`; a POST WITH one runs `validate_slot_config` exactly as
`PUT …/slot_config` does (422 `web_slot_mismatch` / `unsupported_effort`), so the desktop's
create-with-council path keeps the same mistakes out of the document.
"""

from __future__ import annotations

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from .. import api_errors
from ..features.slot_config import validate_slot_config
from ..schemas import ConversationPublic, ConversationSummary, SlotConfig, to_public
from ..store import conversations as store
from .session import session_defaults

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class CreateConversationBody(BaseModel):
    title: str | None = None
    slot_config: SlotConfig | None = None


class TitleBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.get("", response_model=list[ConversationSummary])
async def list_conversations() -> list[ConversationSummary]:
    return await store.list_summaries()


@router.post("", status_code=201, response_model=ConversationPublic)
async def create_conversation(body: CreateConversationBody | None = None) -> ConversationPublic:
    body = body or CreateConversationBody()
    # The body's config, else the council the desktop pushed (`PUT /api/session/defaults`), else
    # `settings().default_slot_config` (store.create's own fallback when given None).
    if body.slot_config is not None:
        validate_slot_config(body.slot_config)  # the same 422s as a PUT, before anything is written
    cfg = body.slot_config or session_defaults()
    conv = await store.create(slot_config=cfg, title=body.title)
    return to_public(conv)


@router.get("/{conv_id}", response_model=ConversationPublic)
async def get_conversation(conv_id: str) -> ConversationPublic:
    conv = await store.load(conv_id)
    if conv is None:
        raise api_errors.not_found("conversation")
    return to_public(conv)


@router.delete("/{conv_id}", status_code=204, response_class=Response)
async def delete_conversation(conv_id: str) -> Response:
    if not await store.delete(conv_id):
        raise api_errors.not_found("conversation")
    return Response(status_code=204)


@router.patch("/{conv_id}/title", response_model=ConversationPublic)
async def rename_conversation(conv_id: str, body: TitleBody) -> ConversationPublic:
    conv = await store.rename(conv_id, body.title)  # raises not_found() when missing
    return to_public(conv)
