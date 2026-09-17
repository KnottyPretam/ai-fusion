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
from tests.bridge.conftest import FakeConnection, hello

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


# --------------------------------------------------------------------------- origin / host
@pytest.mark.parametrize(
    "origin",
    [
        "http://evil.example",
        "http://evil.example:8021",
        "https://127.0.0.1.evil.example:8021",
        "http://[::2]:8021",
        "null",
        "",
        "not a url",
    ],
)
def test_non_loopback_origin_closes_4003_before_any_hello(tc, monkeypatch, caplog, origin):
    monkeypatch.setattr(bridge_router, "HELLO_TIMEOUT_S", 0.5)  # a miss would be 4004, not a hang
    caplog.set_level(logging.WARNING, logger="triplex.routers.bridge")
    with tc.websocket_connect("/api/bridge", headers={"Origin": origin}) as ws:
        msg = ws.receive()  # closed at once: no hello was sent
        assert msg["type"] == "websocket.close" and msg["code"] == 4003
    assert status(tc)["connected"] is False
    assert any("Origin" in r.getMessage() for r in caplog.records)
    assert all("evil" not in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize(
    "origin",
    [
        None,
        "http://127.0.0.1:8021",
        "http://localhost:5173",
        "http://[::1]:8021",
        "HTTP://LOCALHOST",
    ],
)
def test_loopback_or_missing_origin_is_accepted(tc, origin):
    headers = {} if origin is None else {"Origin": origin}
    with tc.websocket_connect("/api/bridge", headers=headers) as ws:
        ws.send_json(hello(token=TOKEN))
        assert ws.receive_json() == ACK
        assert status(tc)["connected"] is True


def test_origin_is_loopback_rule():
    ok = bridge_router.origin_is_loopback
    assert ok(None) is True
    assert ok("http://127.0.0.1:8021") and ok("http://localhost") and ok("http://[::1]:1")
    assert ok("HTTP://LOCALHOST:8021") is True
    assert not ok("") and not ok("null") and not ok("http://evil.example")
    assert not ok("http://127.0.0.1.evil.example") and not ok("http://localhost.evil.example")
    assert not ok("http://[::2]") and not ok("http://192.168.1.2:8021")


@pytest.mark.parametrize("desktop,evil_status", [("1", 400), ("0", 201)])
def test_desktop_mode_serves_loopback_hosts_only(monkeypatch, desktop, evil_status):
    """The integrator's `TrustedHostMiddleware` (main.py, `TRIPLEX_DESKTOP=1`): a DNS-rebinding
    page's Host never reaches a router; the web backend (8001) is unchanged."""
    from backend.main import create_app

    monkeypatch.setenv("TRIPLEX_DESKTOP", desktop)
    with TestClient(create_app()) as client:
        r = client.post("/api/conversations", headers={"Host": "evil.example:8021"})
        assert r.status_code == evil_status, r.text
        r = client.get("/api/bridge/status", headers={"Host": "evil.example:8021"})
        assert r.status_code == (400 if desktop == "1" else 200), r.text
        for host in ("127.0.0.1:8021", "localhost:8021", "testserver"):
            r = client.post("/api/conversations", headers={"Host": host})
            assert r.status_code == 201, (host, r.text)
            r = client.get("/api/bridge/status", headers={"Host": host})
            assert r.status_code == 200, (host, r.text)


# --------------------------------------------------------------------------- ack before attach
class _DeadAfterHello:
    """A starlette-shaped WebSocket: accepts, hands over one hello, then every send fails (the
    peer closed right after its hello)."""

    def __init__(self, hello_frame: dict) -> None:
        self.headers: dict[str, str] = {}
        self._frames = [{"type": "websocket.receive", "text": json.dumps(hello_frame)}]
        self.sent: list[str] = []
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        pass

    async def receive(self) -> dict:
        if self._frames:
            return self._frames.pop(0)
        return {"type": "websocket.disconnect", "code": 1006}

    async def send_text(self, text: str) -> None:
        self.sent.append(text)
        raise RuntimeError('Cannot call "send" once a close message has been sent.')

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason or "")


async def test_failed_ack_send_never_attaches(monkeypatch, caplog):
    monkeypatch.setenv("BRIDGE_TOKEN", TOKEN)
    caplog.set_level(logging.INFO, logger="triplex.routers.bridge")
    ws = _DeadAfterHello(hello(token=TOKEN))
    await bridge_router.bridge_socket(ws)  # returns without raising
    assert len(ws.sent) == 1 and json.loads(ws.sent[0])["type"] == "hello_ack"
    assert bridge.hub.status()["connected"] is False and bridge.hub.connection is None
    messages = [r.getMessage() for r in caplog.records]
    assert not any("bridge client accepted" in m for m in messages)
    assert any("hello_ack could not be sent" in m for m in messages)
    # An existing client is left in place: the dead peer never supersedes it.
    existing = FakeConnection()
    bridge.hub.attach(existing, hello(version="0.0.9"))
    await bridge_router.bridge_socket(_DeadAfterHello(hello(token=TOKEN)))
    assert bridge.hub.connection is existing and existing.closed is None
    assert bridge.hub.status()["version"] == "0.0.9"


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
