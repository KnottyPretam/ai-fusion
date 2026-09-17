"""`conversation_scope` through the real routers: the producer task of every feature (and the
Analyze producer Fusion spawns for its auto-run) sees `current_conversation()` == the path's
conversation id at the moment it calls `stream_completion` -- while the test's own context (and
the request handler's, once `sse_response` returned) holds None."""

from __future__ import annotations

import asyncio

from backend.llm import bridge, mock
from backend.llm import client as client_mod
from tests.conftest import DEFAULT_PROMPT
from tests.helpers import parse_sse_text


async def test_current_conversation_is_seen_inside_every_producer_task(client, monkeypatch):
    seen: list[tuple[str, str, str | None, str]] = []
    real = client_mod.stream_completion

    async def recording(**kw):
        seen.append(
            (
                kw["role"],
                kw["purpose"],
                bridge.current_conversation(),
                asyncio.current_task().get_name(),
            )
        )
        async for d in real(**kw):
            yield d

    monkeypatch.setattr(client_mod, "stream_completion", recording)

    r = await client.post("/api/conversations", json={})
    cid = r.json()["id"]
    r = await client.post(f"/api/conversations/{cid}/send", json={"prompt": DEFAULT_PROMPT})
    assert r.status_code == 200 and parse_sse_text(r.text)[-1]["type"] == "turn_done"
    assert bridge.current_conversation() is None  # the scope never leaks past the router
    r = await client.post(f"/api/conversations/{cid}/analyze", json={})
    assert r.status_code == 200 and parse_sse_text(r.text)[-1]["type"] == "analyze_done"
    r = await client.post(f"/api/conversations/{cid}/fusion", json={"max_iterations": 2})
    assert r.status_code == 200 and parse_sse_text(r.text)[-1]["type"] == "fusion_done"
    r = await client.post(f"/api/conversations/{cid}/slots/grok/continue", json={"prompt": "more"})
    assert r.status_code == 200 and parse_sse_text(r.text)[-1]["type"] == "turn_done"
    assert bridge.current_conversation() is None

    purposes = [(role, purpose) for role, purpose, _, _ in seen]
    assert purposes.count(("analyst", "extraction")) == 1
    assert purposes.count(("analyst", "convergence")) == 1
    assert sum(1 for _, p in purposes if p == "chat") == 4  # three slots + the continue
    assert sum(1 for _, p in purposes if p == "defense") == 3
    assert {conv for _, _, conv, _ in seen} == {cid}
    # Calls made directly by a producer task carry its name; slot calls run in the tasks
    # `asyncio.gather` spawns from it (a copy of the same context).
    by_purpose = {(role, purpose): task for role, purpose, _, task in seen}
    assert by_purpose[("analyst", "extraction")].startswith("analyze:")
    assert by_purpose[("analyst", "convergence")].startswith("triplex-fusion-")
    assert len(mock.calls) == len(seen)


async def test_fusion_auto_run_analyze_inherits_the_scope(client, monkeypatch):
    seen: list[tuple[str, str | None, str]] = []
    real = client_mod.stream_completion

    async def recording(**kw):
        seen.append(
            (kw["purpose"], bridge.current_conversation(), asyncio.current_task().get_name())
        )
        async for d in real(**kw):
            yield d

    monkeypatch.setattr(client_mod, "stream_completion", recording)
    cid = (await client.post("/api/conversations", json={})).json()["id"]
    await client.post(f"/api/conversations/{cid}/send", json={"prompt": DEFAULT_PROMPT})
    r = await client.post(f"/api/conversations/{cid}/fusion", json={"max_iterations": 1})
    events = parse_sse_text(r.text)
    assert events[0]["type"] == "analyze_start" and events[-1]["type"] == "fusion_done"
    assert {conv for _, conv, _ in seen} == {cid}
    nested = [task for purpose, _, task in seen if purpose == "extraction"]
    assert len(nested) == 1 and nested[0].startswith("analyze:")


async def test_scope_is_per_request_not_global(client, monkeypatch):
    """Two conversations back to back: each producer sees its own id, never the other's."""
    seen: list[str | None] = []
    real = client_mod.stream_completion

    async def recording(**kw):
        seen.append(bridge.current_conversation())
        async for d in real(**kw):
            yield d

    monkeypatch.setattr(client_mod, "stream_completion", recording)
    a = (await client.post("/api/conversations", json={})).json()["id"]
    b = (await client.post("/api/conversations", json={})).json()["id"]
    await client.post(f"/api/conversations/{a}/send", json={"prompt": DEFAULT_PROMPT})
    await client.post(f"/api/conversations/{b}/send", json={"prompt": DEFAULT_PROMPT})
    assert seen == [a, a, a, b, b, b]
