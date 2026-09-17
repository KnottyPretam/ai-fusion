"""`bridge.BridgeHub` against an in-loop `FakeConnection`: multiplexing, every failure code,
supersede, cancel on timeout / early close, ping-pong liveness, the status caches."""

from __future__ import annotations

import asyncio

import pytest

from backend.llm import bridge
from backend.llm import bridge_protocol as bp
from backend.llm.bridge import BridgeError
from backend.schemas import SLOT_IDS
from tests.bridge.conftest import FakeConnection, hello

hub = bridge.hub


def req(req_id: str, *, slot: str = "chatgpt", view: str = "pane", purpose: str = "chat"):
    frame = {
        "type": "request",
        "req_id": req_id,
        "model": f"web:{slot}" + (":analyst" if view == "analyst" else ""),
        "slot": slot,
        "view": view,
        "fresh": view == "analyst",
        "text": "hello there",
        "role": "analyst" if view == "analyst" else slot,
        "purpose": purpose,
        "conversation_id": None,
        "timeout_s": 600,
    }
    return bp.parse_server_frame(frame).model_dump(mode="json")


def accepted(req_id: str, slot: str = "chatgpt", view: str = "pane"):
    return {"type": "accepted", "req_id": req_id, "view": view, "slot": slot}


def rejected(req_id: str, code: str = "logged_out"):
    return {"type": "rejected", "req_id": req_id, "code": code, "message": f"{code} message"}


def result_ok(req_id: str, text: str):
    return {
        "type": "result",
        "req_id": req_id,
        "ok": True,
        "captured": True,
        "text": text,
        "url": "https://site.example/c/1",
        "ms": 3,
        "done_by": "quiet",
    }


async def run(frame, *, accept_timeout_s: float = 1.0, timeout_s: float = 2.0):
    return [
        r async for r in hub.request(frame, accept_timeout_s=accept_timeout_s, timeout_s=timeout_s)
    ]


# --------------------------------------------------------------------------- multiplexing
async def test_out_of_order_replies_land_on_their_own_request(attached: FakeConnection):
    t1 = asyncio.create_task(run(req("a", slot="claude")))
    t2 = asyncio.create_task(run(req("b", slot="grok")))
    await asyncio.sleep(0)
    assert [f["req_id"] for f in attached.sent("request")] == ["a", "b"]
    assert hub.status()["inflight"] == 2
    hub.dispatch(accepted("b", "grok"))
    hub.dispatch(result_ok("b", "grok text"))
    hub.dispatch(accepted("a", "claude"))
    hub.dispatch(result_ok("a", "claude text"))
    r1, r2 = await t1, await t2
    assert [r["type"] for r in r1] == ["accepted", "result"] and r1[1]["text"] == "claude text"
    assert [r["type"] for r in r2] == ["accepted", "result"] and r2[1]["text"] == "grok text"
    assert r1[0]["slot"] == "claude" and r2[0]["slot"] == "grok"
    assert hub.status()["inflight"] == 0
    assert attached.sent("cancel") == []


async def test_rejected_ends_the_request_without_a_result(attached: FakeConnection):
    task = asyncio.create_task(run(req("r1")))
    await asyncio.sleep(0)
    hub.dispatch(rejected("r1", "view_busy"))
    replies = await task
    assert [r["type"] for r in replies] == ["rejected"] and replies[0]["code"] == "view_busy"
    assert hub.status()["inflight"] == 0 and attached.sent("cancel") == []


async def test_result_without_accepted_is_an_implicit_accept(attached: FakeConnection):
    task = asyncio.create_task(run(req("r1")))
    await asyncio.sleep(0)
    hub.dispatch(result_ok("r1", "quick"))
    replies = await task
    assert [r["type"] for r in replies] == ["result"] and replies[0]["text"] == "quick"


async def test_stray_replies_for_unknown_requests_are_ignored(attached: FakeConnection):
    hub.dispatch(accepted("nope"))
    hub.dispatch(result_ok("nope", "x"))
    hub.dispatch(rejected("nope"))
    assert hub.status()["inflight"] == 0


def test_dispatch_parses_dicts_and_rejects_malformed_frames():
    with pytest.raises(ValueError):
        hub.dispatch({"type": "pong"})
    with pytest.raises(ValueError):
        hub.dispatch({"type": "request", "req_id": "x"})  # a server frame is never a client frame


# --------------------------------------------------------------------------- failure codes
async def test_no_connection_is_bridge_unavailable():
    assert not hub.connected
    with pytest.raises(BridgeError) as ei:
        await run(req("x"))
    assert ei.value.code == "bridge_unavailable"


async def test_no_ack_is_bridge_no_ack_and_sends_cancel(attached: FakeConnection):
    with pytest.raises(BridgeError) as ei:
        await run(req("x"), accept_timeout_s=0.05, timeout_s=5)
    assert ei.value.code == "bridge_no_ack" and "0.05" in ei.value.message
    assert [f["req_id"] for f in attached.sent("cancel")] == ["x"]
    assert hub.status()["inflight"] == 0


async def test_result_timeout_sends_cancel_and_raises_timeout(attached: FakeConnection):
    task = asyncio.create_task(run(req("x"), accept_timeout_s=1, timeout_s=0.1))
    await asyncio.sleep(0)
    hub.dispatch(accepted("x"))
    with pytest.raises(BridgeError) as ei:
        await task
    assert ei.value.code == "timeout" and "cancel sent" in ei.value.message
    assert [f["req_id"] for f in attached.sent("cancel")] == ["x"]  # exactly once
    assert hub.status()["inflight"] == 0


async def test_accept_wait_never_exceeds_the_overall_timeout(attached: FakeConnection):
    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(BridgeError) as ei:
        await run(req("x"), accept_timeout_s=5, timeout_s=0.05)
    assert ei.value.code == "bridge_no_ack"
    assert loop.time() - started < 1.0


async def test_detach_mid_request_fails_bridge_disconnected(attached: FakeConnection):
    task = asyncio.create_task(run(req("x")))
    await asyncio.sleep(0)
    hub.dispatch(accepted("x"))
    await asyncio.sleep(0)
    assert hub.detach(attached) is True
    with pytest.raises(BridgeError) as ei:
        await task
    assert ei.value.code == "bridge_disconnected"
    assert attached.sent("cancel") == []  # nobody left to cancel
    assert hub.status() == {
        "connected": False,
        "protocol": None,
        "version": None,
        "since": None,
        "sites": {s: {"capture": False, "health": None, "health_ts": None} for s in SLOT_IDS},
        "analyst": None,
        "inflight": 0,
    }


async def test_detach_of_a_stale_connection_is_a_no_op(attached: FakeConnection):
    other = FakeConnection()
    assert hub.detach(other) is False
    assert hub.connected and hub.connection is attached


# --------------------------------------------------------------------------- supersede
async def test_second_hello_supersedes_closes_old_4002_and_fails_its_pending(
    attached: FakeConnection,
):
    task = asyncio.create_task(run(req("x")))
    await asyncio.sleep(0)
    hub.dispatch(accepted("x"))
    newer = FakeConnection()
    old = hub.attach(newer, hello(version="0.2.0"))
    assert old is attached
    with pytest.raises(BridgeError) as ei:
        await task
    assert ei.value.code == "bridge_disconnected"
    await asyncio.sleep(0)  # the close is scheduled on the running loop
    assert attached.closed == (4002, "superseded")
    assert newer.closed is None and hub.connection is newer
    assert hub.status()["version"] == "0.2.0" and hub.status()["inflight"] == 0
    # The old socket's late frames and its detach never touch the new client.
    hub.dispatch(result_ok("x", "too late"))
    assert hub.detach(attached) is False and hub.connection is newer
    # A new request goes to the new connection only.
    t2 = asyncio.create_task(run(req("y")))
    await asyncio.sleep(0)
    assert [f["req_id"] for f in newer.sent("request")] == ["y"]
    assert [f["req_id"] for f in attached.sent("request")] == ["x"]
    hub.dispatch(accepted("y"))
    hub.dispatch(result_ok("y", "fresh"))
    assert (await t2)[-1]["text"] == "fresh"


async def test_attach_requires_a_hello_frame(attached: FakeConnection):
    with pytest.raises(ValueError):
        hub.attach(FakeConnection(), {"type": "pong", "ts": 1})
    with pytest.raises(ValueError):
        hub.attach(FakeConnection(), hello(token=""))
    assert hub.connection is attached


# --------------------------------------------------------------------------- early close
async def test_aclose_sends_cancel_and_forgets_the_request(attached: FakeConnection):
    agen = hub.request(req("x"), accept_timeout_s=1, timeout_s=5)
    first = asyncio.create_task(agen.__anext__())
    await asyncio.sleep(0)
    hub.dispatch(accepted("x"))
    assert (await first)["type"] == "accepted"
    assert hub.status()["inflight"] == 1
    await agen.aclose()
    assert [f["req_id"] for f in attached.sent("cancel")] == ["x"]
    assert hub.status()["inflight"] == 0
    hub.dispatch(result_ok("x", "late"))  # ignored: nobody is waiting


async def test_aclose_after_the_result_sends_no_cancel(attached: FakeConnection):
    agen = hub.request(req("x"), accept_timeout_s=1, timeout_s=5)
    first = asyncio.create_task(agen.__anext__())
    await asyncio.sleep(0)
    hub.dispatch(accepted("x"))
    hub.dispatch(result_ok("x", "done"))
    await first
    assert (await agen.__anext__())["text"] == "done"
    await agen.aclose()
    assert attached.sent("cancel") == []


# --------------------------------------------------------------------------- liveness
async def test_two_missed_pongs_close_1011_and_fail_pending(attached: FakeConnection):
    task = asyncio.create_task(run(req("x")))
    await asyncio.sleep(0)
    hub.dispatch(accepted("x"))
    assert await hub.ping(attached) is True  # ping 1 sent
    hub.dispatch({"type": "pong", "ts": attached.sent("ping")[-1]["ts"]})
    assert await hub.ping(attached) is True  # ping 2: answered, no miss
    assert await hub.ping(attached) is True  # ping 3: one miss
    assert attached.closed is None
    assert await hub.ping(attached) is False  # ping 4: second miss -> closed
    assert attached.closed == (1011, "pong timeout")
    assert len(attached.sent("ping")) == 3
    with pytest.raises(BridgeError) as ei:
        await task
    assert ei.value.code == "bridge_disconnected"
    assert hub.status()["connected"] is False and hub.status()["inflight"] == 0
    assert await hub.ping(attached) is False  # stale: never pings again


async def test_ping_for_a_stale_connection_is_false(attached: FakeConnection):
    assert await hub.ping(FakeConnection()) is False
    assert attached.sent("ping") == []


# --------------------------------------------------------------------------- status caches
async def test_status_reflects_hello_and_later_cache_frames(attached: FakeConnection):
    st = hub.status()
    assert st["connected"] is True and st["protocol"] == 1 and st["version"] == "0.1.0"
    assert isinstance(st["since"], str) and st["since"].endswith("Z")
    assert st["analyst"] == "chatgpt" and st["inflight"] == 0
    assert set(st["sites"]) == set(SLOT_IDS)
    assert all(
        v == {"capture": True, "health": None, "health_ts": None} for v in st["sites"].values()
    )

    hub.dispatch({"type": "capture", "capture": {"claude": False, "chatgpt": True, "grok": False}})
    hub.dispatch({"type": "analyst", "analyst": None})
    health = {
        "composer": True,
        "send": True,
        "reply": None,
        "stop": None,
        "session": "ok",
        "matched": {
            "composer": "#prompt",
            "send": "button",
            "reply": None,
            "stop": None,
            "error": None,
        },
        "url": "https://site.example/c/1",
        "host": "site.example",
        "title": "Site",
        "ts": 1710000000000,
    }
    hub.dispatch({"type": "health", "slot": "grok", "health": health})
    st = hub.status()
    assert [st["sites"][s]["capture"] for s in SLOT_IDS] == [False, True, False]
    assert st["analyst"] is None
    assert st["sites"]["grok"]["health"] == health
    assert (
        isinstance(st["sites"]["grok"]["health_ts"], int) and st["sites"]["grok"]["health_ts"] > 0
    )
    assert st["sites"]["claude"]["health"] is None

    hub.dispatch({"type": "analyst", "analyst": {"slot": "grok"}})
    assert hub.status()["analyst"] == "grok"
    # A hello on an attached connection is ignored, not re-attached.
    hub.dispatch(hello(version="9.9.9"))
    assert hub.status()["version"] == "0.1.0"
