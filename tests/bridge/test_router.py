"""`WS /api/bridge` handshake and `GET /api/bridge/status` through starlette's `TestClient`
(handshake only -- never mixed with the async ASGI `client` fixture; `with TestClient(app)` keeps
every session on ONE portal loop, so the hub's supersede close lands on the right loop)."""

from __future__ import annotations

import json
import logging
import time

import pytest
from starlette.testclient import TestClient

from backend.llm import bridge
from backend.routers import bridge as bridge_router
from backend.schemas import SLOT_IDS
from tests.bridge.conftest import hello

TOKEN = "9f86d081884c7d659a2feaa0c55ad015"
ACK = {"type": "hello_ack", "protocol": 1, "backend_version": "0.1.0", "ping_s": 20}


@pytest.fixture
def tc(monkeypatch):
    from backend.main import create_app

    monkeypatch.setenv("BRIDGE_TOKEN", TOKEN)
    monkeypatch.delenv("BRIDGE_PING_S", raising=False)
    with TestClient(create_app()) as client:
        yield client


def wait_until(predicate, timeout_s: float = 2.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not predicate():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.01)


def status(tc: TestClient) -> dict:
    r = tc.get("/api/bridge/status")
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- handshake
def test_hello_is_acked_and_status_reports_connected(tc):
    assert status(tc)["connected"] is False
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == ACK
        st = status(tc)
        assert st["connected"] is True and st["protocol"] == 1 and st["version"] == "0.1.0"
        assert st["analyst"] == "chatgpt" and st["inflight"] == 0
        assert isinstance(st["since"], str)
        assert all(st["sites"][s]["capture"] is True for s in SLOT_IDS)
    wait_until(lambda: status(tc)["connected"] is False)


def test_bad_token_closes_4003_before_any_ack(tc):
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token="wrong"))
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 4003
    assert status(tc)["connected"] is False


def test_no_hello_in_time_closes_4004(tc, monkeypatch):
    monkeypatch.setattr(bridge_router, "HELLO_TIMEOUT_S", 0.2)
    with tc.websocket_connect("/api/bridge") as ws:
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 4004
    assert status(tc)["connected"] is False


@pytest.mark.parametrize(
    "first",
    [
        json.dumps({"type": "pong", "ts": 1}),  # a valid frame, but not a hello
        json.dumps({**hello(token=TOKEN), "protocol": 2}),  # invalid hello
        "not json at all",
    ],
)
def test_malformed_first_frame_closes_4001(tc, first):
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_text(first)
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 4001
    assert status(tc)["connected"] is False


def test_binary_or_malformed_frame_after_the_handshake_closes_4001(tc):
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == ACK
        ws.send_text(json.dumps({"type": "pong"}))
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 4001
    wait_until(lambda: status(tc)["connected"] is False)
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == ACK
        ws.send_bytes(b"\x00\x01")
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 4001


def test_second_connection_supersedes_the_first(tc):
    with tc.websocket_connect("/api/bridge") as ws1:
        ws1.send_json(hello(token=TOKEN, version="0.1.0"))
        assert ws1.receive_json() == ACK
        with tc.websocket_connect("/api/bridge") as ws2:
            ws2.send_json(hello(token=TOKEN, version="0.2.0"))
            assert ws2.receive_json() == ACK
            closed = ws1.receive()
            assert closed["type"] == "websocket.close" and closed["code"] == 4002
            assert closed.get("reason") == "superseded"
            st = status(tc)
            assert st["connected"] is True and st["version"] == "0.2.0"
        wait_until(lambda: status(tc)["connected"] is False)
    assert status(tc)["connected"] is False


def test_unset_token_accepts_any_hello_with_a_warning(tc, monkeypatch, caplog):
    monkeypatch.delenv("BRIDGE_TOKEN")
    caplog.set_level(logging.WARNING, logger="triplex.routers.bridge")
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token="anything"))
        assert ws.receive_json() == ACK
        assert status(tc)["connected"] is True
    warnings = [
        r
        for r in caplog.records
        if r.levelno == logging.WARNING and "BRIDGE_TOKEN" in r.getMessage()
    ]
    assert len(warnings) == 1
    assert all("anything" not in r.getMessage() for r in caplog.records)


def test_ping_interval_comes_from_env(tc, monkeypatch):
    monkeypatch.setenv("BRIDGE_PING_S", "5")
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == {**ACK, "ping_s": 5}


# --------------------------------------------------------------------------- status + caches
def test_status_shape(tc):
    st = status(tc)
    assert set(st) == {"connected", "protocol", "version", "since", "sites", "analyst", "inflight"}
    assert set(st["sites"]) == set(SLOT_IDS)
    for site in st["sites"].values():
        assert set(site) == {"capture", "health", "health_ts"}
    assert st == bridge.hub.status()


def test_cache_frames_update_status(tc):
    health = {
        "composer": True,
        "send": True,
        "reply": None,
        "stop": None,
        "session": "logged_out",
        "matched": {"composer": None, "send": None, "reply": None, "stop": None, "error": None},
        "url": "https://site.example/login",
        "host": "site.example",
        "title": "Site",
        "ts": 1710000001000,
    }
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == ACK
        ws.send_json(
            {"type": "capture", "capture": {"claude": False, "chatgpt": False, "grok": True}}
        )
        ws.send_json({"type": "health", "slot": "claude", "health": health})
        ws.send_json({"type": "analyst", "analyst": {"slot": "grok"}})
        wait_until(lambda: status(tc)["analyst"] == "grok")
        st = status(tc)
        assert [st["sites"][s]["capture"] for s in SLOT_IDS] == [False, False, True]
        assert st["sites"]["claude"]["health"] == health
        assert isinstance(st["sites"]["claude"]["health_ts"], int)


# --------------------------------------------------------------------------- logging
def test_accept_log_line_never_carries_the_token(tc, caplog):
    caplog.set_level(logging.INFO, logger="triplex.routers.bridge")
    with tc.websocket_connect("/api/bridge") as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == ACK
    accepted = [
        r.getMessage() for r in caplog.records if "bridge client accepted" in r.getMessage()
    ]
    assert len(accepted) == 1
    assert "version=0.1.0" in accepted[0] and "sites=claude,chatgpt,grok" in accepted[0]
    for record in caplog.records:
        assert TOKEN not in record.getMessage()
        assert TOKEN not in str(record.args or "")
