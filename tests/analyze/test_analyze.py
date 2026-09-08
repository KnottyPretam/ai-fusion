"""Analyze end-to-end through the router against the mock corpus (PLAN.md §8 Phase 3 AC,
docs/semantics.md "Analyze", docs/api-contract.md analyze_* events)."""

from __future__ import annotations

import json

from backend.config import DEFAULT_SLOT_CONFIG
from backend.llm import mock
from backend.schemas import AnalyzeTurn, Extraction, SendTurn
from backend.store import conversations as store
from tests.analyze.conftest import extraction_calls, extraction_text, persist
from tests.conftest import DEFAULT_PROMPT, DEFAULT_RESPONSES


def _types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


def _positions(div: dict) -> dict[str, str]:
    return {p["model"]: p["claim"] for p in div["positions"]}


# --------------------------------------------------------------------------- planted_factual
async def test_planted_factual_isolates_the_disagreement(persisted_conversation, analyze):
    conv = persisted_conversation
    send = conv.turns[-1]
    assert send.type == "send" and send.prompt == DEFAULT_PROMPT
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    assert _types(events) == ["analyze_start", "analyze_done"]

    start, done = events
    assert start["of_turn"] == send.id and done["cached"] is False
    turn = done["turn"]
    assert turn["type"] == "analyze" and turn["id"] == start["turn_id"]
    assert turn["of_turn"] == send.id and turn["status"] == "ok" and turn["error"] is None

    extraction = Extraction.model_validate(turn["extraction"])
    ids = [d.id for d in extraction.divergences]
    assert ids == ["d1", "d2"]
    d1, d2 = (d.model_dump() for d in extraction.divergences)
    assert d1["materiality"] == "high" and d2["materiality"] == "low"
    pos = _positions(d1)
    assert set(pos) == {"R1", "R2", "R3"}
    # R2 (= chatgpt under the fixed mock map) carries the wrong 1000 deg/s figure.
    assert "1000 deg/s" in pos["R2"] and "2000" not in pos["R2"]
    assert "2000 deg/s" in pos["R1"] and "2000 deg/s" in pos["R3"]
    assert extraction.agreements and set(extraction.agreements[0].models) == {"R1", "R3"}
    # The raw attempt is the fixture's text and parses to the same extraction.
    assert turn["raw_attempts"] == [extraction_text("planted_factual")]
    assert Extraction.model_validate(json.loads(turn["raw_attempts"][0])) == extraction


async def test_turn_is_persisted_before_analyze_done(
    persisted_conversation, analyze, get_conversation
):
    conv = persisted_conversation
    _, events = await analyze(conv.id)
    done = events[-1]
    public = await get_conversation(conv.id)
    assert "anon_map" not in public
    assert [t["type"] for t in public["turns"]] == ["send", "analyze"]
    persisted = public["turns"][-1]
    assert persisted == done["turn"]  # exactly the AnalyzeTurn.model_dump() that was emitted
    # As-run stamp: a deep copy of the conversation's slot_config.
    assert persisted["slot_config"] == conv.slot_config.model_dump()
    loaded = await store.load(conv.id)
    assert isinstance(loaded.turns[-1], AnalyzeTurn)
    assert loaded.turns[-1].slot_config is not loaded.slot_config
    assert loaded.threads == conv.threads  # Analyze never touches the threads


async def test_analyst_is_called_exactly_once_with_the_conversation_model(
    persisted_conversation, analyze
):
    conv = persisted_conversation
    await analyze(conv.id)
    calls = extraction_calls()
    assert len(calls) == 1 and len(mock.calls) == 1
    call = calls[0]
    assert call["model"] == conv.slot_config.analyst_model == DEFAULT_SLOT_CONFIG.analyst_model
    assert call["fixture"] == "planted_factual/analyst.extraction.1.jsonl"
    assert [m["role"] for m in call["messages"]] == ["system", "user"]


# --------------------------------------------------------------------------- idempotency / cache
async def test_second_analyze_is_served_from_cache_without_an_llm_call(
    persisted_conversation, analyze, get_conversation
):
    conv = persisted_conversation
    _, first = await analyze(conv.id)
    first_turn = first[-1]["turn"]
    mock.reset()

    _, second = await analyze(conv.id)
    assert _types(second) == ["analyze_start", "analyze_done"]
    assert (
        second[0]["turn_id"] == first_turn["id"] and second[0]["of_turn"] == first_turn["of_turn"]
    )
    assert second[1]["cached"] is True and second[1]["turn"] == first_turn
    assert mock.calls == []  # no LLM call at all
    public = await get_conversation(conv.id)
    assert [t["type"] for t in public["turns"]] == ["send", "analyze"]  # no new turn
    assert not store.is_busy(conv.id)


async def test_force_bypasses_the_cache_and_appends_a_new_turn(
    persisted_conversation, analyze, get_conversation
):
    conv = persisted_conversation
    _, first = await analyze(conv.id)
    mock.reset()

    _, forced = await analyze(conv.id, {"force": True})
    assert _types(forced) == ["analyze_start", "analyze_done"]
    assert forced[1]["cached"] is False
    assert forced[0]["turn_id"] != first[0]["turn_id"]
    assert forced[1]["turn"]["extraction"] == first[1]["turn"]["extraction"]
    assert len(extraction_calls()) == 1
    public = await get_conversation(conv.id)
    assert [t["type"] for t in public["turns"]] == ["send", "analyze", "analyze"]
    assert public["turns"][-1]["id"] == forced[0]["turn_id"]

    # The newest ok turn is now the cached one.
    mock.reset()
    _, third = await analyze(conv.id)
    assert third[1]["cached"] is True and third[0]["turn_id"] == forced[0]["turn_id"]
    assert mock.calls == []


async def test_cache_is_keyed_by_of_turn(make_conversation, analyze):
    src = make_conversation()
    first_send = src.turns[0]
    second_send = SendTurn(
        prompt="Follow-up: and the accelerometer range?",
        responses={s: f"{s} says up to 24 g" for s in DEFAULT_RESPONSES},
        slot_config=src.slot_config,
    )
    src.turns.append(second_send)
    conv = await persist(src)

    _, a = await analyze(conv.id, {"of_turn": first_send.id})
    assert a[0]["of_turn"] == first_send.id and a[1]["turn"]["of_turn"] == first_send.id
    assert a[1]["cached"] is False

    _, b = await analyze(conv.id)  # default = newest send turn: a different key -> fresh run
    assert b[0]["of_turn"] == second_send.id and b[1]["cached"] is False
    assert b[0]["turn_id"] != a[0]["turn_id"]
    assert len(extraction_calls()) == 2

    mock.reset()
    _, c = await analyze(conv.id, {"of_turn": first_send.id})
    assert c[1]["cached"] is True and c[0]["turn_id"] == a[0]["turn_id"]
    assert mock.calls == []


# --------------------------------------------------------------------------- retry
async def test_analyst_retry_recovers_with_one_retry(scenario_conversation, analyze):
    conv = await scenario_conversation("analyst_retry")
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_done"]
    retry, done = events[1], events[2]
    assert isinstance(retry["error"], str) and retry["error"]
    turn = done["turn"]
    assert turn["status"] == "ok" and turn["error"] is None and done["cached"] is False
    assert turn["raw_attempts"] == [
        extraction_text("analyst_retry", 1),
        extraction_text("analyst_retry", 2),
    ]
    assert turn["extraction"]["divergences"][0]["id"] == "d1"
    assert turn["extraction"]["divergences"][0]["materiality"] == "high"

    calls = extraction_calls()
    assert len(calls) == 2 and len(mock.calls) == 2
    assert [c["fixture"] for c in calls] == [
        "analyst_retry/analyst.extraction.1.jsonl",
        "analyst_retry/analyst.extraction.2.jsonl",
    ]
    first, second = calls
    assert [m["role"] for m in first["messages"]] == ["system", "user"]
    assert [m["role"] for m in second["messages"]] == ["system", "user", "assistant", "user"]
    assert second["messages"][:2] == first["messages"]
    assert second["messages"][2]["content"] == turn["raw_attempts"][0]
    last = second["messages"][-1]["content"]
    assert "failed validation" in last and retry["error"] in last
    assert last.endswith("Return only the corrected JSON.")


# --------------------------------------------------------------------------- degrade
async def test_analyst_degrade_ends_with_analyze_degraded_and_no_error_event(
    scenario_conversation, analyze, get_conversation
):
    conv = await scenario_conversation("analyst_degrade")
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_degraded"]
    degraded = events[-1]
    assert "error" not in [e["type"] for e in events]
    turn = degraded["turn"]
    assert turn["id"] == events[0]["turn_id"] and turn["status"] == "degraded"
    assert turn["extraction"] is None
    assert isinstance(turn["error"], str) and turn["error"]
    assert turn["raw_attempts"] == [
        extraction_text("analyst_degrade", 1),
        extraction_text("analyst_degrade", 2),
    ]
    assert len(extraction_calls()) == 2
    public = await get_conversation(conv.id)
    assert public["turns"][-1] == turn  # persisted before the final event


async def test_degraded_turn_is_never_served_from_cache(scenario_conversation, analyze):
    conv = await scenario_conversation("analyst_degrade")
    _, first = await analyze(conv.id)
    before = len(mock.calls)
    _, second = await analyze(conv.id)  # no force: still re-attempts
    assert _types(second) == ["analyze_start", "analyze_retry", "analyze_degraded"]
    assert second[0]["turn_id"] != first[0]["turn_id"]
    calls = extraction_calls()[before:]
    assert len(calls) == 2  # sticky-last (counters NOT reset): extraction.2 twice
    assert {c["fixture"] for c in calls} == {"analyst_degrade/analyst.extraction.2.jsonl"}
    loaded = await store.load(conv.id)
    assert [t.type for t in loaded.turns] == ["send", "analyze", "analyze"]
    assert all(t.status == "degraded" for t in loaded.turns[1:])


# --------------------------------------------------------------------------- transport errors
async def test_transport_error_counts_as_a_failed_attempt(
    persisted_conversation, analyze, local_fixtures
):
    local_fixtures("analyst_transport_error")
    conv = persisted_conversation
    r, events = await analyze(conv.id)
    assert r.status_code == 200, r.text
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_degraded"]
    assert events[1]["error"] == "Provider disconnected"
    turn = events[-1]["turn"]
    assert turn["status"] == "degraded" and turn["error"] == "Provider disconnected"
    assert turn["raw_attempts"] == ["", ""]
    calls = extraction_calls()
    assert len(calls) == 2
    # Nothing to correct: the retry re-sends the original request.
    assert calls[1]["messages"] == calls[0]["messages"]
    assert turn["usage"]["totals"]["calls"] == 0  # no usage chunk arrived
    assert not store.is_busy(conv.id)


async def test_transport_error_then_valid_output_is_ok(
    persisted_conversation, analyze, local_fixtures
):
    local_fixtures("analyst_transport_then_ok")
    conv = persisted_conversation
    _, events = await analyze(conv.id)
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_done"]
    turn = events[-1]["turn"]
    assert turn["status"] == "ok" and turn["extraction"]["divergences"][0]["id"] == "d1"
    assert turn["raw_attempts"] == ["", extraction_text("planted_factual")]
    assert turn["usage"]["totals"]["calls"] == 1 and len(extraction_calls()) == 2


async def test_mock_miss_degrades_instead_of_crashing(persisted_conversation, analyze, monkeypatch):
    monkeypatch.setenv("MOCK_SCENARIO", "no_such_scenario_w5")
    conv = persisted_conversation
    r, events = await analyze(conv.id)
    assert r.status_code == 200
    assert _types(events) == ["analyze_start", "analyze_retry", "analyze_degraded"]
    assert events[1]["error"] == "no fixture no_such_scenario_w5/analyst.extraction.1"
    assert events[-1]["turn"]["error"] == "no fixture no_such_scenario_w5/analyst.extraction.2"
    assert [c["fixture"] for c in extraction_calls()] == [None, None]


# --------------------------------------------------------------------------- meter
async def test_usage_meters_every_attempt_and_the_wall_clock(
    persisted_conversation, scenario_conversation, analyze
):
    _, ok_events = await analyze(persisted_conversation.id)
    usage = ok_events[-1]["turn"]["usage"]
    assert usage["totals"]["calls"] == 1 == len(usage["calls"])
    assert usage["totals"]["latency_ms"] > 0
    call = usage["calls"][0]
    assert call["role"] == "analyst" and call["purpose"] == "extraction"
    assert call["model"] == persisted_conversation.slot_config.analyst_model
    assert call["cost_usd"] > 0 and call["prompt_tokens"] > 0 and call["completion_tokens"] > 0
    assert usage["totals"]["cost_usd"] == call["cost_usd"]
    assert usage["totals"]["prompt_tokens"] == call["prompt_tokens"]

    conv = await scenario_conversation("analyst_retry")
    _, retry_events = await analyze(conv.id)
    usage = retry_events[-1]["turn"]["usage"]
    assert usage["totals"]["calls"] == 2 == len(usage["calls"])
    assert usage["totals"]["latency_ms"] > 0
    assert usage["totals"]["cost_usd"] == round(sum(c["cost_usd"] for c in usage["calls"]), 8)
    assert usage["totals"]["completion_tokens"] == sum(
        c["completion_tokens"] for c in usage["calls"]
    )
    assert all(c["purpose"] == "extraction" for c in usage["calls"])


async def test_cached_hit_returns_the_original_usage_unchanged(persisted_conversation, analyze):
    _, first = await analyze(persisted_conversation.id)
    _, second = await analyze(persisted_conversation.id)
    assert second[-1]["cached"] is True
    assert second[-1]["turn"]["usage"] == first[-1]["turn"]["usage"]


# --------------------------------------------------------------------------- other scenarios
async def test_baseline_has_agreements_only(scenario_conversation, analyze):
    conv = await scenario_conversation("baseline")
    _, events = await analyze(conv.id)
    assert _types(events) == ["analyze_start", "analyze_done"]
    extraction = events[-1]["turn"]["extraction"]
    assert extraction["divergences"] == [] and len(extraction["agreements"]) == 4
    assert all(set(a["models"]) == {"R1", "R2", "R3"} for a in extraction["agreements"])
