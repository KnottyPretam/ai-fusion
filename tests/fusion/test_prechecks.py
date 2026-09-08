"""Pre-stream checks of POST /api/conversations/{id}/fusion: plain JSON errors in FastAPI's
`{detail:{error}}` envelope raised before the first SSE byte, in the order of docs/semantics.md
"Fusion" (404 -> max_iterations -> of_analyze -> nothing_to_fuse / Analyze's own checks ->
busy LAST), plus the busy guard against a Send in flight."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from backend.features.fusion import run_fusion
from backend.llm import mock
from backend.store import conversations as store
from tests.fusion.conftest import FUSION_URL, SEND_URL, scenario_prompt, types_of
from tests.helpers import parse_sse_text

NOT_FOUND_CONV = {"detail": {"error": "not_found", "what": "conversation"}}
NOT_FOUND_TURN = {"detail": {"error": "not_found", "what": "turn"}}
BUSY = {"detail": {"error": "busy"}}


def _is_json(r) -> bool:
    return r.headers["content-type"].startswith("application/json")


def _error(r) -> str:
    assert _is_json(r), r.headers
    return r.json()["detail"]["error"]


# --------------------------------------------------------------------------- 404
@pytest.mark.parametrize("conv_id", [str(uuid.uuid4()), "not-a-uuid", "0" * 36])
async def test_unknown_conversation_is_404_json(fusion, conv_id):
    r, _ = await fusion(conv_id, {"max_iterations": 2})
    assert r.status_code == 404 and r.json() == NOT_FOUND_CONV and _is_json(r)
    assert mock.calls == []


async def test_unknown_of_analyze_is_404_turn(prepare, fusion):
    p = await prepare("planted_factual")
    before = len(mock.calls)
    r, _ = await fusion(p.cid, {"of_analyze": str(uuid.uuid4()), "max_iterations": 2})
    assert r.status_code == 404 and r.json() == NOT_FOUND_TURN and _is_json(r)
    assert len(mock.calls) == before and not store.is_busy(p.cid)


async def test_404_conversation_wins_over_every_other_check(fusion):
    r, _ = await fusion(str(uuid.uuid4()), {"of_analyze": "x", "max_iterations": 3})
    assert r.status_code == 404 and r.json() == NOT_FOUND_CONV
    # Even an out-of-range max_iterations handed straight to the feature: 404 first.
    gen = run_fusion(str(uuid.uuid4()), of_analyze=None, max_iterations=0)
    with pytest.raises(HTTPException) as info:
        await gen.__anext__()
    assert info.value.status_code == 404
    assert mock.calls == []


# --------------------------------------------------------------------------- request body
async def test_max_iterations_is_required_and_bounded_by_fastapi_validation(prepare, client):
    p = await prepare("planted_factual")
    url = FUSION_URL.format(cid=p.cid)
    before = len(mock.calls)
    for body in (None, {}, {"of_analyze": None}):
        r = await client.post(url, json=body)
        assert r.status_code == 422 and isinstance(r.json()["detail"], list), body
    for bad in (0, 6, -1, "two", 2.5, None):
        r = await client.post(url, json={"max_iterations": bad})
        assert r.status_code == 422 and isinstance(r.json()["detail"], list), bad
    r = await client.post(url, json={"max_iterations": 2, "of_analyze": 123})
    assert r.status_code == 422 and isinstance(r.json()["detail"], list)
    r = await client.post(url, content=b"not json")
    assert r.status_code == 422
    assert len(mock.calls) == before and not store.is_busy(p.cid)


async def test_feature_guards_max_iterations_itself(prepare):
    p = await prepare("planted_factual")
    for bad in (0, 6, True, "2"):
        gen = run_fusion(p.cid, of_analyze=None, max_iterations=bad)  # type: ignore[arg-type]
        with pytest.raises(HTTPException) as info:
            await gen.__anext__()
        assert info.value.status_code == 422
        assert info.value.detail["error"] == "invalid_max_iterations"
        assert info.value.detail["cap"] == 5
    assert not store.is_busy(p.cid)


# --------------------------------------------------------------------------- of_analyze
async def test_explicit_non_analyze_turn_is_422(prepare, fusion):
    p = await prepare("planted_factual")
    r, _ = await fusion(p.cid, {"of_analyze": p.send_turn_id, "max_iterations": 2})
    assert r.status_code == 422
    assert r.json() == {"detail": {"error": "not_an_analyze_turn", "of_analyze": p.send_turn_id}}
    assert not store.is_busy(p.cid)


async def test_explicit_degraded_of_analyze_is_409(prepare, fusion):
    p = await prepare("analyst_degrade")
    assert p.analyze_turn_id is not None
    assert p.conv.turns[-1].type == "analyze" and p.conv.turns[-1].status == "degraded"
    before = len(mock.calls)
    r, _ = await fusion(p.cid, {"of_analyze": p.analyze_turn_id, "max_iterations": 2})
    assert r.status_code == 409 and r.json() == {"detail": {"error": "analyze_degraded"}}
    assert _is_json(r)
    assert len(mock.calls) == before and not store.is_busy(p.cid)
    after = await store.load(p.cid)
    assert after is not None and [t.type for t in after.turns] == ["send", "analyze"]


async def test_nothing_to_fuse_is_409_when_analyze_already_ran(prepare, fusion):
    p = await prepare("baseline")
    assert p.conv.turns[-1].type == "analyze" and p.conv.turns[-1].status == "ok"
    assert p.conv.turns[-1].extraction.divergences == []
    before = len(mock.calls)
    r, _ = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 409 and r.json() == {"detail": {"error": "nothing_to_fuse"}}
    assert _is_json(r)
    r, _ = await fusion(p.cid, {"of_analyze": p.analyze_turn_id, "max_iterations": 1})
    assert r.status_code == 409 and _error(r) == "nothing_to_fuse"
    assert len(mock.calls) == before and not store.is_busy(p.cid)
    after = await store.load(p.cid)
    assert after is not None and [t.type for t in after.turns] == ["send", "analyze"]


async def test_nothing_to_fuse_honours_the_conversations_materiality_min(prepare, fusion):
    """planted_factual has d1 high + d2 low: with materiality_min=high d1 alone stands; a
    later PUT raising the floor above every divergence makes Fusion refuse."""
    p = await prepare("planted_factual")
    cfg = p.conv.slot_config.model_dump()
    await store.update_slot_config(p.cid, {**cfg, "materiality_min": "high"})
    r, events = await fusion(p.cid, {"max_iterations": 1})
    assert r.status_code == 200 and events[0]["standing"] == ["d1"]
    assert events[-1]["turn"]["slot_config"]["materiality_min"] == "high"


# --------------------------------------------------------------------------- Analyze's checks
async def test_no_send_turn_is_409_on_the_auto_run_path(new_conv, fusion):
    cid = (await new_conv())["id"]
    r, _ = await fusion(cid, {"max_iterations": 2})
    assert r.status_code == 409 and r.json() == {"detail": {"error": "no_send_turn"}}
    assert mock.calls == [] and not store.is_busy(cid)


async def test_incomplete_send_turn_is_409_on_the_auto_run_path(prepare, fusion):
    p = await prepare("slot_failure", run_analyze=False)
    send = p.conv.turns[-1]
    assert send.type == "send" and send.responses["grok"] is None
    before = len(mock.calls)
    r, _ = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 409
    assert r.json() == {"detail": {"error": "incomplete_send_turn", "missing": ["grok"]}}
    assert len(mock.calls) == before and not store.is_busy(p.cid)


# --------------------------------------------------------------------------- busy
async def test_fusion_while_another_feature_holds_the_conversation_is_409_busy(
    prepare, fusion, hold_busy
):
    p = await prepare("planted_factual")
    before = len(mock.calls)
    async with hold_busy(p.cid):
        r, _ = await fusion(p.cid, {"max_iterations": 2})
        assert r.status_code == 409 and r.json() == BUSY and _is_json(r)
        r, _ = await fusion(p.cid, {"of_analyze": p.analyze_turn_id, "max_iterations": 1})
        assert r.status_code == 409 and _error(r) == "busy"
        assert len(mock.calls) == before
    # Released: the same request now streams.
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200 and events[-1]["type"] == "fusion_done"
    assert not store.is_busy(p.cid)


async def test_busy_is_checked_last(prepare, new_conv, fusion, hold_busy):
    baseline = await prepare("baseline")
    async with hold_busy(baseline.cid):
        r, _ = await fusion(baseline.cid, {"max_iterations": 2})
        assert r.status_code == 409 and _error(r) == "nothing_to_fuse"
        r, _ = await fusion(baseline.cid, {"of_analyze": str(uuid.uuid4()), "max_iterations": 2})
        assert r.status_code == 404 and _error(r) == "not_found"
        r, _ = await fusion(
            baseline.cid, {"of_analyze": baseline.send_turn_id, "max_iterations": 2}
        )
        assert r.status_code == 422 and _error(r) == "not_an_analyze_turn"
    empty = (await new_conv())["id"]
    async with hold_busy(empty):
        r, _ = await fusion(empty, {"max_iterations": 2})
        assert r.status_code == 409 and _error(r) == "no_send_turn"
    degraded = await prepare("analyst_degrade")
    async with hold_busy(degraded.cid):
        r, _ = await fusion(
            degraded.cid, {"of_analyze": degraded.analyze_turn_id, "max_iterations": 2}
        )
        assert r.status_code == 409 and _error(r) == "analyze_degraded"
        # The default path would auto-run Analyze: only then is the guard the blocker.
        r, _ = await fusion(degraded.cid, {"max_iterations": 2})
        assert r.status_code == 409 and _error(r) == "busy"


async def test_fusion_while_a_send_is_in_flight_is_409_busy_and_released_after(
    prepare, client, fusion, monkeypatch
):
    """A conversation with a fused-able Analyze turn, then a second Send in flight: every
    other pre-check passes, so the guard is what refuses Fusion; released once the send ends."""
    p = await prepare("planted_factual")
    monkeypatch.setenv("MOCK_DELAY_MS", "100")  # paced replay keeps the send in flight
    running = asyncio.create_task(
        client.post(SEND_URL.format(cid=p.cid), json={"prompt": "And the accelerometer?"})
    )
    await asyncio.sleep(0.15)
    assert store.is_busy(p.cid)
    r, _ = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 409 and r.json() == BUSY and _is_json(r)
    r, _ = await fusion(p.cid, {"of_analyze": p.analyze_turn_id, "max_iterations": 1})
    assert r.status_code == 409 and r.json() == BUSY
    r1 = await running
    assert r1.status_code == 200 and parse_sse_text(r1.text)[-1]["type"] == "turn_done"
    assert not store.is_busy(p.cid)
    assert len(mock.calls) == 4 + 3  # the rejected Fusions never reached the transport

    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    # The newest send turn has no Analyze turn yet: auto-run, then fuse.
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200
    assert types_of(events)[:2] == ["analyze_start", "analyze_done"]
    assert events[0]["of_turn"] == parse_sse_text(r1.text)[0]["turn_id"]
    assert events[-1]["type"] == "fusion_done" and events[-1]["exit_reason"] == "converged"
    assert not store.is_busy(p.cid)


async def test_no_send_turn_wins_over_busy_while_the_first_send_is_in_flight(
    scenario, new_conv, client, fusion, monkeypatch
):
    scenario("planted_factual")
    cid = (await new_conv())["id"]
    monkeypatch.setenv("MOCK_DELAY_MS", "100")
    running = asyncio.create_task(
        client.post(SEND_URL.format(cid=cid), json={"prompt": scenario_prompt("planted_factual")})
    )
    await asyncio.sleep(0.15)
    assert store.is_busy(cid)
    r, _ = await fusion(cid, {"max_iterations": 2})
    assert r.status_code == 409 and _error(r) == "no_send_turn"  # busy is checked LAST
    assert (await running).status_code == 200
    assert not store.is_busy(cid)


async def test_send_and_analyze_while_a_fusion_is_in_flight_are_409_busy(
    prepare, client, fusion, monkeypatch
):
    p = await prepare("standing_at_cap")
    monkeypatch.setenv("MOCK_DELAY_MS", "20")
    running = asyncio.create_task(
        client.post(FUSION_URL.format(cid=p.cid), json={"max_iterations": 2})
    )
    await asyncio.sleep(0.1)
    assert store.is_busy(p.cid)
    r = await client.post(SEND_URL.format(cid=p.cid), json={"prompt": "Concurrent"})
    assert r.status_code == 409 and r.json() == BUSY
    r = await client.post(f"/api/conversations/{p.cid}/analyze", json={"force": True})
    assert r.status_code == 409 and r.json() == BUSY
    r, _ = await fusion(p.cid, {"max_iterations": 1})
    assert r.status_code == 409 and r.json() == BUSY
    done = await running
    assert done.status_code == 200
    events = parse_sse_text(done.text)
    assert events[-1]["type"] == "fusion_done" and events[-1]["exit_reason"] == "max_iterations"
    assert not store.is_busy(p.cid)
    after = await store.load(p.cid)
    assert after is not None and [t.type for t in after.turns] == ["send", "analyze", "fusion"]
