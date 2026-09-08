"""store.busy_guard: one feature call per conversation at a time (docs/api-contract.md, the
busy_guard docstring, docs/semantics.md "Producer model for every feature and the busy guard")."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from backend.sse import sse_response
from backend.store import conversations as store
from tests.helpers import parse_sse_text

CID = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


async def _expect_busy(conv_id: str = CID) -> None:
    g = store.busy_guard(conv_id)
    with pytest.raises(HTTPException) as ei:
        await g.__aenter__()
    assert ei.value.status_code == 409 and ei.value.detail == {"error": "busy"}
    await g.__aexit__(None, None, None)  # never acquired -> exit is a no-op
    assert store.is_busy(conv_id)


async def _acquire_release(conv_id: str = CID) -> None:
    async with store.busy_guard(conv_id):
        assert store.is_busy(conv_id)
    assert not store.is_busy(conv_id)


async def test_second_concurrent_holder_gets_409_busy(run_foreign):
    g1 = store.busy_guard(CID)
    assert await g1.__aenter__() is None
    assert store.is_busy(CID)
    try:
        await run_foreign(_expect_busy())
        await run_foreign(_acquire_release(OTHER))  # other ids are independent
    finally:
        await g1.__aexit__(None, None, None)
    assert not store.is_busy(CID)
    await run_foreign(_acquire_release())  # released: a foreign task can acquire now
    await _acquire_release()  # and so can this one


async def test_async_with_releases_on_normal_exit_and_on_exception(run_foreign):
    async with store.busy_guard(CID):
        await run_foreign(_expect_busy())
    assert not store.is_busy(CID)
    with pytest.raises(RuntimeError):
        async with store.busy_guard(CID):
            assert store.is_busy(CID)
            raise RuntimeError("feature blew up")
    assert not store.is_busy(CID)
    await run_foreign(_acquire_release())


async def test_reentrant_enter_exit_in_one_task_keeps_the_id_busy_until_the_outer_exits(
    run_foreign,
):
    outer = store.busy_guard(CID)
    await outer.__aenter__()
    inner = store.busy_guard(CID)
    assert await inner.__aenter__() is None  # same task -> no-op, no 409
    await inner.__aexit__(None, None, None)  # no-op exit: only the acquiring object releases
    assert store.is_busy(CID)
    await run_foreign(_expect_busy())  # still busy for another task

    # `async with` re-entry inside the holder is a no-op too.
    async with store.busy_guard(CID):
        pass
    assert store.is_busy(CID)
    await run_foreign(_expect_busy())

    # A task CREATED FROM the holder (asyncio.create_task copies the context) is re-entrant.
    async def child() -> None:
        g = store.busy_guard(CID)
        await g.__aenter__()
        await g.__aexit__(None, None, None)
        assert store.is_busy(CID)

    await asyncio.create_task(child())
    await run_foreign(_expect_busy())

    await outer.__aexit__(None, None, None)
    assert not store.is_busy(CID)
    await run_foreign(_acquire_release())


async def test_producer_task_releases_the_guard_in_its_finally(run_foreign):
    """The documented feature pattern: the generator enters the guard before its first yield,
    a spawned producer task does the work and releases in `finally`."""
    guard = store.busy_guard(CID)
    await guard.__aenter__()
    started, released = asyncio.Event(), asyncio.Event()

    async def producer() -> None:
        try:
            started.set()
            async with store.busy_guard(CID):  # nested run_analyze-style re-entry: no-op
                await asyncio.sleep(0.01)
            assert store.is_busy(CID), "the nested no-op exit did not release"
        finally:
            await guard.__aexit__(None, None, None)  # released from a context COPY
            released.set()

    task = asyncio.create_task(producer())
    await started.wait()
    await run_foreign(_expect_busy())
    await released.wait()
    await task
    assert not store.is_busy(CID)
    await run_foreign(_acquire_release())
    await _acquire_release()  # the original acquiring context sees the release too


async def test_guard_is_per_conversation():
    async with store.busy_guard(CID):
        async with store.busy_guard(OTHER):
            assert store.is_busy(CID) and store.is_busy(OTHER)
        assert store.is_busy(CID) and not store.is_busy(OTHER)
    assert not store.is_busy(CID)


async def test_busy_is_a_plain_json_409_through_sse_response(run_foreign):
    """A feature that enters the guard before its first yield turns a busy conversation into
    the pre-stream JSON envelope {"detail": {"error": "busy"}}; a free one streams."""
    app = FastAPI()

    async def feature(conv_id: str):
        guard = store.busy_guard(conv_id)
        await guard.__aenter__()  # LAST pre-check, before the first yield
        try:
            yield {"type": "turn_start", "turn_id": "t"}
            yield {"type": "turn_done", "turn_id": "t"}
        finally:
            await guard.__aexit__(None, None, None)

    @app.post("/c/{conv_id}/send")
    async def send(conv_id: str):
        return await sse_response(feature(conv_id))

    holder = store.busy_guard(CID)
    await holder.__aenter__()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as c:
            r = await run_foreign(c.post(f"/c/{CID}/send"))
            assert r.status_code == 409 and r.json() == {"detail": {"error": "busy"}}
            r = await run_foreign(c.post(f"/c/{OTHER}/send"))
            assert r.status_code == 200
            assert [e["type"] for e in parse_sse_text(r.text)] == ["turn_start", "turn_done"]
            assert not store.is_busy(OTHER)
    finally:
        await holder.__aexit__(None, None, None)
    assert not store.is_busy(CID)


async def test_stale_context_entry_never_bypasses_a_later_acquisition():
    """Regression (S1 review + W5): acquire in context A, release from a producer task (a context
    COPY), then let a foreign task acquire and hold the id. A's stale `_held` entry must NOT count
    as re-entrant: A gets 409 busy, while the foreign holder's own children stay re-entrant."""
    import asyncio

    from fastapi import HTTPException

    from backend.store import locking
    from backend.store.conversations import busy_guard

    cid = "00000000-0000-4000-8000-00000000abcd"
    g = busy_guard(cid)
    await g.__aenter__()
    await asyncio.create_task(g.__aexit__(None, None, None))  # released from a context copy
    assert not locking.is_busy(cid)

    acquired = asyncio.Event()
    release = asyncio.Event()
    nested_ok: list[bool] = []

    async def holder() -> None:
        foreign = busy_guard(cid)
        await foreign.__aenter__()
        acquired.set()
        await release.wait()

        async def _nested() -> None:  # child of the holder: re-entrant no-op enter/exit
            inner = busy_guard(cid)
            await inner.__aenter__()
            await inner.__aexit__(None, None, None)
            nested_ok.append(locking.is_busy(cid))

        await asyncio.create_task(_nested())
        await foreign.__aexit__(None, None, None)

    task = asyncio.create_task(holder())
    await acquired.wait()
    assert locking.is_busy(cid)
    with pytest.raises(HTTPException) as exc:  # stale entry in THIS context must not bypass
        await busy_guard(cid).__aenter__()
    assert exc.value.status_code == 409 and exc.value.detail["error"] == "busy"
    release.set()
    await task
    assert nested_ok == [True] and not locking.is_busy(cid)
