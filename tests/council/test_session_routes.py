"""`/api/session/openrouter_key` and `/api/session/defaults` (2026-09-27): what the desktop pushes
at connect. Bearer BRIDGE_TOKEN required; the key never leaves the process in a body or a log line;
`POST /api/conversations {}` seats the pushed default council."""

from __future__ import annotations

import logging

import pytest

from backend.llm import session_key
from backend.routers import session as session_router
from backend.schemas import DEFAULT_COUNCIL, SlotConfig, council_of

KEY = "sk-or-v1-testtesttesttesttest"
TOKEN = "e2e-token"
KEY_URL = "/api/session/openrouter_key"
DEFAULTS_URL = "/api/session/defaults"

PAIR = {
    "slots": {
        "chatgpt": {"model": "openai/gpt-5.6-sol", "effort": "medium"},
        "qwen": {"model": "qwen/qwen3.7-max", "effort": "medium"},
    },
    "analyst_model": "openai/gpt-5.6-luna",
    "max_iterations": 2,
    "materiality_min": "medium",
    "grounded": False,
}


@pytest.fixture(autouse=True)
def _clean_session(monkeypatch):
    monkeypatch.setenv("BRIDGE_TOKEN", TOKEN)
    session_key.clear_key()
    session_router.set_session_defaults(None)
    yield
    session_key.clear_key()
    session_router.set_session_defaults(None)


def _auth(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- the token gate
@pytest.mark.parametrize("method,url", [("get", KEY_URL), ("put", KEY_URL), ("delete", KEY_URL), ("get", DEFAULTS_URL), ("put", DEFAULTS_URL), ("delete", DEFAULTS_URL)])
async def test_every_key_and_defaults_route_requires_the_bridge_token(client, method, url):
    body = {"key": KEY} if url == KEY_URL else {"slot_config": PAIR}
    kw = {"json": body} if method == "put" else {}
    r = await client.request(method, url, **kw)
    assert r.status_code == 401 and r.json() == {"detail": {"error": "missing_token"}}
    r = await client.request(method, url, headers={"Authorization": "Basic abc"}, **kw)
    assert r.status_code == 401
    r = await client.request(method, url, headers=_auth("wrong"), **kw)
    assert r.status_code == 403 and r.json() == {"detail": {"error": "bad_token"}}
    assert session_key.get_key() is None and session_router.session_defaults() is None


async def test_an_unset_bridge_token_refuses_the_push_outright(client, monkeypatch):
    monkeypatch.delenv("BRIDGE_TOKEN")
    r = await client.put(KEY_URL, json={"key": KEY}, headers=_auth())
    assert r.status_code == 403 and r.json() == {"detail": {"error": "bridge_token_unset"}}
    assert session_key.get_key() is None


async def test_cost_route_needs_no_token(client, monkeypatch):
    monkeypatch.delenv("BRIDGE_TOKEN")
    r = await client.get("/api/session/cost")
    assert r.status_code == 200 and "spent_usd" in r.json()


# --------------------------------------------------------------------------- the key
async def test_key_round_trip_never_echoes_the_key(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = await client.get(KEY_URL, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"configured": False, "prefix": None, "length": 0}

    r = await client.put(KEY_URL, json={"key": f"  {KEY}  "}, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"configured": True, "prefix": "sk-or-v1-", "length": len(KEY)}
    assert session_key.get_key() == KEY
    assert KEY not in r.text

    r = await client.get(KEY_URL, headers=_auth())
    assert r.json()["configured"] is True and KEY not in r.text

    r = await client.delete(KEY_URL, headers=_auth())
    assert r.status_code == 200 and r.json()["configured"] is False
    assert session_key.get_key() is None

    for record in caplog.records:
        assert KEY not in record.getMessage() and KEY not in str(record.args or "")


@pytest.mark.parametrize(
    "body",
    [{}, {"key": ""}, {"key": "   "}, {"key": None}, {"key": 42}, {"token": KEY}, KEY, [KEY], {"key": [KEY]}],
)
async def test_blank_or_missing_key_is_422_empty_key_and_never_clears(client, body):
    """Including bodies that are not an object at all (a bare string, a list): the route reads the
    body by hand, so no pydantic 422 with an `input` field can ever hand the key back."""
    session_key.set_key(KEY)
    r = await client.put(KEY_URL, json=body, headers=_auth())
    assert r.status_code == 422 and r.json() == {"detail": {"error": "empty_key"}}
    assert session_key.get_key() == KEY  # a bad PUT never clears; DELETE does
    assert KEY not in r.text


async def test_a_malformed_key_body_is_422_empty_key_and_never_echoed(client):
    session_key.set_key(KEY)
    r = await client.put(KEY_URL, content=KEY.encode(), headers={**_auth(), "content-type": "application/json"})
    assert r.status_code == 422 and r.json() == {"detail": {"error": "empty_key"}}
    assert session_key.get_key() == KEY and KEY not in r.text


def test_session_key_module_state():
    assert session_key.status() == {"configured": False, "prefix": None, "length": 0}
    with pytest.raises(ValueError):
        session_key.set_key("")
    with pytest.raises(ValueError):
        session_key.set_key(None)  # type: ignore[arg-type]
    session_key.set_key(KEY)
    status = session_key.status()
    assert status == {"configured": True, "prefix": KEY[: session_key.PREFIX_CHARS], "length": len(KEY)}
    assert KEY not in str(status)
    session_key.clear_key()
    assert session_key.get_key() is None


# --------------------------------------------------------------------------- the defaults
async def test_defaults_round_trip_and_new_conversation_seats_them(client):
    r = await client.get(DEFAULTS_URL, headers=_auth())
    assert r.status_code == 200 and r.json() == {"slot_config": None}

    r = await client.put(DEFAULTS_URL, json={"slot_config": PAIR}, headers=_auth())
    assert r.status_code == 200
    assert r.json()["slot_config"]["slots"] == PAIR["slots"]
    stored = session_router.session_defaults()
    assert stored is not None and council_of(stored) == ("chatgpt", "qwen")
    assert session_router.session_defaults() is not stored  # a fresh copy each time

    r = await client.get(DEFAULTS_URL, headers=_auth())
    assert r.json()["slot_config"]["slots"] == PAIR["slots"]

    # The sidebar's "New conversation" (no body / empty body) honours the pushed council...
    for body in (None, {}):
        r = await client.post("/api/conversations", json=body)
        assert r.status_code == 201, r.text
        conv = r.json()
        assert list(conv["slot_config"]["slots"]) == ["chatgpt", "qwen"]
        assert set(conv["threads"]) == {"chatgpt", "qwen"}
    # ...an explicit config in the body still wins...
    three = SlotConfig.model_validate(PAIR).model_dump()
    three["slots"] = {
        s: {"model": f"web:{s}", "effort": "off"} for s in DEFAULT_COUNCIL
    }
    r = await client.post("/api/conversations", json={"slot_config": three})
    assert r.status_code == 201 and list(r.json()["slot_config"]["slots"]) == list(DEFAULT_COUNCIL)

    # ...and DELETE goes back to settings().default_slot_config (the three).
    r = await client.delete(DEFAULTS_URL, headers=_auth())
    assert r.status_code == 200 and r.json() == {"slot_config": None}
    r = await client.post("/api/conversations", json={})
    assert r.status_code == 201 and list(r.json()["slot_config"]["slots"]) == list(DEFAULT_COUNCIL)


async def test_defaults_are_validated_like_a_put_slot_config(client):
    bad = {**PAIR, "slots": {"chatgpt": {"model": "web:claude", "effort": "off"}, "qwen": PAIR["slots"]["qwen"]}}
    r = await client.put(DEFAULTS_URL, json={"slot_config": bad}, headers=_auth())
    assert r.status_code == 422
    assert r.json()["detail"] == {"error": "web_slot_mismatch", "slot": "chatgpt", "model": "web:claude"}
    assert session_router.session_defaults() is None

    one = {**PAIR, "slots": {"qwen": PAIR["slots"]["qwen"]}}
    r = await client.put(DEFAULTS_URL, json={"slot_config": one}, headers=_auth())
    assert r.status_code == 422  # pydantic: a council is 2..5
    assert session_router.session_defaults() is None
