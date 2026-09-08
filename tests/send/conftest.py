"""Per-area fixtures for tests/send (owned by W4). Shared fixtures live in tests/conftest.py.

Everything goes through the ASGI `client` fixture and the mock transport (`MOCK_SCENARIO`,
default `planted_factual`); assertions on what reached the model use `backend.llm.mock.calls`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from backend.schemas import SLOT_IDS
from tests.conftest import DEFAULT_PROMPT
from tests.helpers import parse_sse_text

SEND_URL = "/api/conversations/{cid}/send"
CONTINUE_URL = "/api/conversations/{cid}/slots/{slot}/continue"
CONV_URL = "/api/conversations/{cid}"

SLOT_EVENT_TYPES = (
    "slot_start",
    "slot_delta",
    "slot_reasoning",
    "slot_citations",
    "slot_done",
    "slot_error",
)
TERMINAL_SLOT_TYPES = ("slot_done", "slot_error")


# --------------------------------------------------------------------------- event helpers
def types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


def of_type(events: list[dict], *kinds: str) -> list[dict]:
    return [e for e in events if e["type"] in kinds]


def for_slot(events: list[dict], slot: str) -> list[dict]:
    return [e for e in events if e.get("slot") == slot]


def one(events: list[dict], kind: str, slot: str | None = None) -> dict:
    """The single event of `kind` (optionally for `slot`); asserts there is exactly one."""
    hits = [e for e in of_type(events, kind) if slot is None or e.get("slot") == slot]
    assert len(hits) == 1, f"expected exactly one {kind} for {slot or 'the turn'}, got {hits}"
    return hits[0]


def slot_text(events: list[dict], slot: str, kind: str = "slot_delta") -> str:
    return "".join(e["text"] for e in for_slot(events, slot) if e["type"] == kind)


def assert_stream_invariants(events: list[dict], slots: tuple[str, ...] = SLOT_IDS) -> None:
    """The contract's ordering rules: turn_start first, each slot's slot_start before any of its
    other events, exactly one slot_done|slot_error per slot, turn_done last."""
    assert events, "empty stream"
    assert all("type" in e for e in events)
    assert events[0]["type"] == "turn_start"
    assert events[-1]["type"] == "turn_done"
    assert types(events).count("turn_start") == 1 and types(events).count("turn_done") == 1
    assert not of_type(events, "error")
    assert sorted(events[0]["slots"]) == sorted(slots)
    for slot in slots:
        mine = for_slot(events, slot)
        assert mine and mine[0]["type"] == "slot_start", f"{slot}: slot_start not first: {mine}"
        assert types(mine).count("slot_start") == 1
        terminals = [e for e in mine if e["type"] in TERMINAL_SLOT_TYPES]
        assert len(terminals) == 1, f"{slot}: expected one terminal slot event, got {terminals}"
        assert mine[-1] is terminals[0], f"{slot}: events after its terminal event: {mine}"
    for e in events:
        if e["type"] in SLOT_EVENT_TYPES:
            assert e["slot"] in slots
        else:
            assert e["type"] in ("turn_start", "turn_done")
    turn_id = events[0]["turn_id"]
    assert events[-1]["turn_id"] == turn_id


# --------------------------------------------------------------------------- HTTP helpers
@pytest.fixture
def new_conv(client) -> Callable[..., Awaitable[dict]]:
    """POST /api/conversations (body kwargs) -> the ConversationPublic dict."""

    async def _mk(**body: Any) -> dict:
        r = await client.post("/api/conversations", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    return _mk


@pytest.fixture
async def cid(new_conv) -> str:
    return (await new_conv())["id"]


@pytest.fixture
def get_conv(client) -> Callable[[str], Awaitable[dict]]:
    async def _get(conv_id: str) -> dict:
        r = await client.get(CONV_URL.format(cid=conv_id))
        assert r.status_code == 200, r.text
        return r.json()

    return _get


@pytest.fixture
def send(client) -> Callable[..., Awaitable[list[dict]]]:
    """POST .../send and return the parsed SSE events (asserts a 200 event-stream)."""

    async def _send(conv_id: str, prompt: str = DEFAULT_PROMPT) -> list[dict]:
        r = await client.post(SEND_URL.format(cid=conv_id), json={"prompt": prompt})
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/event-stream")
        return parse_sse_text(r.text)

    return _send


@pytest.fixture
def cont(client) -> Callable[..., Awaitable[list[dict]]]:
    """POST .../slots/{slot}/continue and return the parsed SSE events."""

    async def _cont(conv_id: str, slot: str, prompt: str) -> list[dict]:
        r = await client.post(CONTINUE_URL.format(cid=conv_id, slot=slot), json={"prompt": prompt})
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/event-stream")
        return parse_sse_text(r.text)

    return _cont
