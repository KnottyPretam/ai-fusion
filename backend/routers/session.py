"""Session state (integrator-owned): the process-level cost total behind the cap, and -- since
2026-09-27 -- what the desktop pushes at connect: the OpenRouter key and the default council.

    GET    /api/session/cost                   -> metering.session_cost_status()   (no token)
    GET    /api/session/openrouter_key         -> session_key.status()
    PUT    /api/session/openrouter_key {key}   -> session_key.status()   422 empty_key when blank
    DELETE /api/session/openrouter_key         -> session_key.status()
    GET    /api/session/defaults               -> {slot_config} | {slot_config: null}
    PUT    /api/session/defaults {slot_config} -> {slot_config}   the in-process default council
    DELETE /api/session/defaults               -> {slot_config: null}

Every key / defaults route requires `Authorization: Bearer <BRIDGE_TOKEN>` (`require_bridge_token`):
403 `bridge_token_unset` when the backend has no token to compare against (a backend started
without one has no business accepting a key), 401 `missing_token` without a Bearer header, 403
`bad_token` on a mismatch (`hmac.compare_digest`). The key never appears in a response body or a log
line: the responses carry `session_key.status()` only, and the PUT body is read by hand
(`request.json()`) so that no validation 422 can echo the value back -- anything but
`{"key": <non-blank str>}`, a bare string and malformed JSON included, is the minted `empty_key`. `POST /api/conversations {}` picks up the pushed default
(`session_defaults()`), so the sidebar's "New conversation" honours the council the user assembled
in the desktop app; `settings().default_slot_config` stays the fallback. A pushed default goes
through `validate_slot_config` exactly as a PUT on a conversation would, so a `web:` model on the
wrong slot or an unsupported effort is refused at push time, never at the next "New conversation".
"""

from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

from .. import api_errors
from ..features.slot_config import validate_slot_config
from ..llm import bridge, metering, session_key
from ..schemas import SlotConfig

router = APIRouter(prefix="/api/session")

_defaults: SlotConfig | None = None  # the council the desktop pushed; None = settings() default


def session_defaults() -> SlotConfig | None:
    """A fresh copy of the pushed default `SlotConfig`, or None when nothing was pushed."""
    return None if _defaults is None else _defaults.model_copy(deep=True)


def set_session_defaults(cfg: SlotConfig | None) -> None:
    """Replace the in-process default (the routes below, and tests)."""
    global _defaults
    _defaults = None if cfg is None else SlotConfig.model_validate(cfg.model_dump())


def require_bridge_token(authorization: str | None = Header(default=None)) -> None:
    expected = bridge.bridge_token()
    if expected is None:
        raise HTTPException(status_code=403, detail={"error": "bridge_token_unset"})
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail={"error": "missing_token"})
    if not hmac.compare_digest(token.strip().encode(), expected.encode()):
        raise HTTPException(status_code=403, detail={"error": "bad_token"})


class DefaultsBody(BaseModel):
    slot_config: SlotConfig


@router.get("/cost")
async def session_cost() -> dict:
    return metering.session_cost_status()


# --------------------------------------------------------------------------- the key
@router.get("/openrouter_key", dependencies=[Depends(require_bridge_token)])
async def get_openrouter_key() -> dict[str, Any]:
    return session_key.status()


@router.put("/openrouter_key", dependencies=[Depends(require_bridge_token)])
async def put_openrouter_key(request: Request) -> dict[str, Any]:
    # Not a typed parameter ON PURPOSE: FastAPI's own 422 carries the offending `input`, which
    # for a bare-string or list body would be the key itself.
    try:
        body = await request.json()
    except ValueError:
        body = None
    key = body.get("key") if isinstance(body, dict) else None
    if not isinstance(key, str) or not key.strip():
        raise api_errors.unprocessable("empty_key")
    session_key.set_key(key)
    return session_key.status()


@router.delete("/openrouter_key", dependencies=[Depends(require_bridge_token)])
async def delete_openrouter_key() -> dict[str, Any]:
    session_key.clear_key()
    return session_key.status()


# --------------------------------------------------------------------------- the defaults
@router.get("/defaults", dependencies=[Depends(require_bridge_token)])
async def get_defaults() -> dict[str, Any]:
    cfg = session_defaults()
    return {"slot_config": None if cfg is None else cfg.model_dump(mode="json")}


@router.put("/defaults", dependencies=[Depends(require_bridge_token)])
async def put_defaults(body: DefaultsBody) -> dict[str, Any]:
    validate_slot_config(body.slot_config)  # 422 web_slot_mismatch / unsupported_effort, as a PUT
    set_session_defaults(body.slot_config)
    return {"slot_config": body.slot_config.model_dump(mode="json")}


@router.delete("/defaults", dependencies=[Depends(require_bridge_token)])
async def delete_defaults() -> dict[str, Any]:
    set_session_defaults(None)
    return {"slot_config": None}
