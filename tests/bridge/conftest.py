"""Per-area fixtures for tests/bridge (owner: bridge-backend S2). Shared fixtures live in
tests/conftest.py; the Stage 0 protocol test needs nothing from here.

Everything runs IN the test's event loop against the module singleton `bridge.hub` -- never a
starlette `TestClient` websocket mixed with the async ASGI `client` fixture (plan decision 19;
`test_router.py` uses `TestClient` for the handshake only and no `client`).

- `FakeConnection`: a `bridge.BridgeConnection` that records every frame the hub sends
  (`outbox`, plus an `outgoing` queue a fake desktop drains) and the close it receives.
- `hello(**overrides)`: a valid hello frame dict (token "e2e", every capture switch on, analyst
  chatgpt) -- the hub does not enforce the capture map (Electron does), it only reports it.
- `attached`: a `FakeConnection` already attached to the hub.
- `fake_desktop(script)`: starts a task that answers every `request` frame from `script`, keyed
  by `(slot, view, purpose)` (or `"*"` as the default): a `str` = the captured reply text
  (`planted(name)` reads `backend/llm/fixtures/scenarios/planted_factual/<name>` through
  `tests.e2e.conftest.fixture_text`), `"not_captured"` = `result captured:false`,
  `{"reject": code}` = `rejected`, `{"error": code, "partial"?: str}` = `result ok:false`,
  `{"delay_ms": n, "text"?: str}` = `accepted` now and the result after `n` ms,
  `"drop"` = no frame at all (no ack), `{"delay_ms": n, "drop": True}` = accepted then silence.
  A list is consumed one entry per request, sticky-last (the analyst retry). Pings are answered
  with pongs; `cancel` frames are recorded in `cancels`; every `request` in `requests`.
- `web_env`: the desktop slot config (`SLOT_*_MODEL=web:*`, `SLOT_*_EFFORT=off`,
  `ANALYST_MODEL=web:chatgpt:analyst`) set AFTER the root conftest's autouse `_no_real_key`
  deleted those keys (pytest orders autouse fixtures first), plus short bridge timeouts so a
  broken flow fails in seconds instead of hanging for `BRIDGE_TIMEOUT_S`. Every flow test asserts
  `mock.calls == []`: a web session never reaches the mock.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import pytest

from backend.llm import bridge
from backend.schemas import SLOT_IDS
from tests.e2e.conftest import fixture_text

SCENARIO = "planted_factual"
HELLO_TOKEN = "e2e"
DROP = "drop"
NOT_CAPTURED = "not_captured"
_MISSING = object()


def hello(**overrides: Any) -> dict[str, Any]:
    frame: dict[str, Any] = {
        "type": "hello",
        "protocol": 1,
        "token": HELLO_TOKEN,
        "version": "0.1.0",
        "sites": list(SLOT_IDS),
        "capture": {slot: True for slot in SLOT_IDS},
        "analyst": {"slot": "chatgpt"},
    }
    frame.update(overrides)
    return frame


def planted(name: str) -> str:
    """The text the mock would have streamed for `planted_factual/<name>`."""
    return fixture_text(SCENARIO, name)


def planted_script(
    overrides: dict[Any, Any] | None = None, *, analyst: str = "chatgpt"
) -> dict[Any, Any]:
    """Every (slot, view, purpose) the planted_factual flow needs, from the committed fixtures."""
    script: dict[Any, Any] = {}
    for slot in SLOT_IDS:
        script[(slot, "pane", "chat")] = planted(f"{slot}.chat.1.jsonl")
        script[(slot, "pane", "defense")] = planted(f"{slot}.defense.1.jsonl")
    script[(analyst, "analyst", "extraction")] = planted("analyst.extraction.1.jsonl")
    script[(analyst, "analyst", "convergence")] = planted("analyst.convergence.1.jsonl")
    script.update(overrides or {})
    return script


# --------------------------------------------------------------------------- fake connection
class FakeConnection:
    """Records what the hub sends; `close` records instead of closing."""

    def __init__(self) -> None:
        self.outbox: list[dict[str, Any]] = []
        self.outgoing: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.closed: tuple[int, str] | None = None

    async def send_json(self, obj: dict[str, Any]) -> None:
        if self.closed is not None:
            raise RuntimeError("connection closed")
        self.outbox.append(obj)
        self.outgoing.put_nowait(obj)

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)

    def sent(self, frame_type: str) -> list[dict[str, Any]]:
        return [f for f in self.outbox if f.get("type") == frame_type]


@pytest.fixture(autouse=True)
def _fresh_hub():
    bridge.hub.reset()
    yield
    bridge.hub.reset()


@pytest.fixture
async def attached() -> FakeConnection:
    conn = FakeConnection()
    bridge.hub.attach(conn, hello())
    return conn


@pytest.fixture
def web_env(monkeypatch):
    for slot in SLOT_IDS:
        monkeypatch.setenv(f"SLOT_{slot.upper()}_MODEL", f"web:{slot}")
        monkeypatch.setenv(f"SLOT_{slot.upper()}_EFFORT", "off")
    monkeypatch.setenv("ANALYST_MODEL", "web:chatgpt:analyst")
    monkeypatch.setenv("BRIDGE_ACCEPT_TIMEOUT_S", "3")
    monkeypatch.setenv("BRIDGE_TIMEOUT_S", "10")
    yield


# --------------------------------------------------------------------------- fake desktop
@dataclass
class FakeDesktop:
    conn: FakeConnection
    script: dict[Any, Any]
    requests: list[dict[str, Any]] = field(default_factory=list)
    cancels: list[str] = field(default_factory=list)
    pings: int = 0
    errors: list[str] = field(default_factory=list)
    _served: dict[tuple[str, str, str], int] = field(default_factory=dict)
    _tasks: set[asyncio.Task[Any]] = field(default_factory=set)
    _serve_task: asyncio.Task[Any] | None = None

    def start(self) -> None:
        self._serve_task = asyncio.create_task(self._serve(), name="fake-desktop")

    async def stop(self) -> None:
        tasks = [t for t in [*self._tasks, self._serve_task] if t is not None]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def of(self, slot: str, view: str, purpose: str) -> list[dict[str, Any]]:
        return [
            r
            for r in self.requests
            if (r["slot"], r["view"], r["purpose"]) == (slot, view, purpose)
        ]

    async def _serve(self) -> None:
        while True:
            frame = await self.conn.outgoing.get()
            kind = frame.get("type")
            if kind == "request":
                self.requests.append(frame)
                task = asyncio.create_task(self._answer(frame))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
            elif kind == "cancel":
                self.cancels.append(frame["req_id"])
            elif kind == "ping":
                self.pings += 1
                bridge.hub.dispatch({"type": "pong", "ts": frame["ts"]})

    def _entry(self, frame: dict[str, Any]) -> Any:
        key = (frame["slot"], frame["view"], frame["purpose"])
        entry = self.script.get(key, self.script.get("*", _MISSING))
        if isinstance(entry, list):
            n = self._served.get(key, 0)
            self._served[key] = n + 1
            entry = entry[min(n, len(entry) - 1)] if entry else _MISSING
        return entry

    async def _answer(self, frame: dict[str, Any]) -> None:
        try:
            await self._reply(frame)
        except Exception as e:  # surfaced by the test through `errors`
            self.errors.append(f"{type(e).__name__}: {e}")

    async def _reply(self, frame: dict[str, Any]) -> None:
        rid, slot, view = frame["req_id"], frame["slot"], frame["view"]
        entry = self._entry(frame)
        dispatch = bridge.hub.dispatch
        if entry is _MISSING:
            dispatch(
                {
                    "type": "rejected",
                    "req_id": rid,
                    "code": "unknown_site",
                    "message": f"no script for {slot}/{view}/{frame['purpose']}",
                }
            )
            return
        if entry == DROP:
            return
        delay_ms = 0
        if isinstance(entry, dict):
            delay_ms = int(entry.get("delay_ms", 0))
            if "reject" in entry:
                dispatch(
                    {
                        "type": "rejected",
                        "req_id": rid,
                        "code": entry["reject"],
                        "message": entry.get("message", f"{entry['reject']} on {slot}"),
                    }
                )
                return
        dispatch({"type": "accepted", "req_id": rid, "view": view, "slot": slot})
        if delay_ms:
            await asyncio.sleep(delay_ms / 1000)
        url = f"https://site.example/c/{rid[:8]}"
        if entry == NOT_CAPTURED:
            dispatch(
                {
                    "type": "result",
                    "req_id": rid,
                    "ok": True,
                    "captured": False,
                    "url": url,
                    "ms": 5,
                }
            )
        elif isinstance(entry, dict) and entry.get("drop"):
            return
        elif isinstance(entry, dict) and "error" in entry:
            dispatch(
                {
                    "type": "result",
                    "req_id": rid,
                    "ok": False,
                    "code": entry["error"],
                    "message": entry.get("message", f"{entry['error']} on {slot}"),
                    "partial": entry.get("partial"),
                }
            )
        else:
            text = entry.get("text", "(delayed reply)") if isinstance(entry, dict) else entry
            dispatch(
                {
                    "type": "result",
                    "req_id": rid,
                    "ok": True,
                    "captured": True,
                    "text": text,
                    "url": url,
                    "ms": 7,
                    "done_by": "quiet",
                }
            )


@pytest.fixture
async def fake_desktop() -> Callable[..., Awaitable[FakeDesktop]]:
    """`desk = await fake_desktop(script)`: attach a fake Electron client and serve `script`."""
    started: list[FakeDesktop] = []

    async def _start(
        script: dict[Any, Any], *, hello_frame: dict[str, Any] | None = None
    ) -> FakeDesktop:
        conn = FakeConnection()
        bridge.hub.attach(conn, hello_frame or hello())
        desk = FakeDesktop(conn=conn, script=script)
        desk.start()
        started.append(desk)
        return desk

    yield _start
    for desk in started:
        await desk.stop()
        bridge.hub.detach(desk.conn)
