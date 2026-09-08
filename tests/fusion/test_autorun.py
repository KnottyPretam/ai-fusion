"""Fusion's auto-run of Analyze (docs/semantics.md "Fusion", docs/api-contract.md): when no ok
Analyze turn exists for the newest send turn the stream first forwards the REAL `run_analyze`'s
events (re-entrant under Fusion's guard), then fuses the fresh extraction -- or ends with the
terminal `error{message}` and no fusion turn after `analyze_degraded` / an empty standing set."""

from __future__ import annotations

from backend.features.fusion import run_fusion
from backend.llm import mock
from backend.schemas import SLOT_IDS, FusionTurn
from backend.store import conversations as store
from tests.fusion.conftest import (
    assert_fusion_stream_invariants,
    calls,
    served,
    served_all,
    types_of,
)

CHAT_FILES = [f"{slot}.chat.1.jsonl" for slot in SLOT_IDS]
DEFENSE_FILES = [f"{slot}.defense.1.jsonl" for slot in SLOT_IDS]


async def test_planted_factual_auto_runs_analyze_then_fuses(prepare, fusion):
    p = await prepare("planted_factual", run_analyze=False)
    assert [t.type for t in p.conv.turns] == ["send"]
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200, r.text
    assert types_of(events) == [
        "analyze_start",
        "analyze_done",
        "fusion_start",
        "round_start",
        "exchange",
        "exchange",
        "exchange",
        "round_done",
        "fusion_done",
    ]
    a_start, a_done = events[0], events[1]
    assert a_start["of_turn"] == p.send_turn_id
    assert a_done["cached"] is False and a_done["turn"]["id"] == a_start["turn_id"]
    assert a_done["turn"]["status"] == "ok" and a_done["turn"]["of_turn"] == p.send_turn_id
    turn_doc = assert_fusion_stream_invariants(events)
    assert events[2]["of_analyze"] == a_start["turn_id"]
    assert events[2]["standing"] == ["d1"]
    assert events[-1]["exit_reason"] == "converged"

    turn = FusionTurn.model_validate(turn_doc)
    assert turn.usage.totals.calls == 4
    assert {u.purpose for u in turn.usage.calls} == {"defense", "convergence"}
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze", "fusion"]
    analyze_turn = after.turns[1]
    assert analyze_turn.id == a_start["turn_id"] and analyze_turn.status == "ok"
    assert analyze_turn.model_dump(mode="json") == a_done["turn"]  # forwarded verbatim
    assert analyze_turn.usage.totals.calls == 1
    assert analyze_turn.usage.calls[0].purpose == "extraction"
    assert after.turns[2].of_analyze == analyze_turn.id and after.turns[2].id == turn.id
    assert not store.is_busy(p.cid)

    # README's 8-file sequence in one stream: chats, extraction, three defenses, convergence.
    files = served_all()
    assert sorted(files[:3]) == sorted(CHAT_FILES)
    assert files[3] == "analyst.extraction.1.jsonl"
    assert sorted(files[4:7]) == sorted(DEFENSE_FILES)
    assert files[7] == "analyst.convergence.1.jsonl"
    assert len(mock.calls) == 8

    # A second Fusion is served the now-cached ok Analyze turn: no analyze_* prefix, no call.
    mock.reset()
    _, events2 = await fusion(p.cid, {"max_iterations": 1})
    assert types_of(events2)[0] == "fusion_start"
    assert events2[0]["of_analyze"] == analyze_turn.id
    assert calls("extraction") == []


async def test_baseline_auto_run_ends_with_nothing_to_fuse_and_no_fusion_turn(prepare, fusion):
    p = await prepare("baseline", run_analyze=False)
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    assert types_of(events) == ["analyze_start", "analyze_done", "error"]
    assert events[-1] == {"type": "error", "message": "nothing_to_fuse"}
    assert events[1]["cached"] is False and events[1]["turn"]["status"] == "ok"
    assert events[1]["turn"]["extraction"]["divergences"] == []
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze"]
    assert after.turns[-1].id == events[0]["turn_id"] and after.turns[-1].status == "ok"
    assert not store.is_busy(p.cid)
    files = served_all()
    assert sorted(files[:3]) == sorted(CHAT_FILES)
    assert files[3:] == ["analyst.extraction.1.jsonl"]
    assert calls("defense") == [] and calls("convergence") == []
    for slot in SLOT_IDS:
        assert len(after.threads[slot]) == 2  # nothing appended

    # Now that an ok Analyze exists, the same request is refused before the stream.
    r, _ = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 409 and r.json() == {"detail": {"error": "nothing_to_fuse"}}
    assert len(mock.calls) == 4


async def test_analyst_degrade_auto_run_ends_with_analyze_degraded(prepare, fusion):
    p = await prepare("analyst_degrade", run_analyze=False)
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200, r.text
    assert types_of(events) == ["analyze_start", "analyze_retry", "analyze_degraded", "error"]
    assert events[-1] == {"type": "error", "message": "analyze_degraded"}
    assert events[2]["turn"]["status"] == "degraded"
    assert events[2]["turn"]["id"] == events[0]["turn_id"]
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze"]
    assert after.turns[-1].status == "degraded" and len(after.turns[-1].raw_attempts) == 2
    assert not store.is_busy(p.cid)
    assert served("analyst", "extraction") == [
        "analyst.extraction.1.jsonl",
        "analyst.extraction.2.jsonl",
    ]
    assert len(mock.calls) == 5 and calls("defense") == []

    # Explicitly asking for that degraded turn is a pre-stream 409.
    degraded_id = events[0]["turn_id"]
    r, _ = await fusion(p.cid, {"of_analyze": degraded_id, "max_iterations": 2})
    assert r.status_code == 409 and r.json() == {"detail": {"error": "analyze_degraded"}}

    # A degraded turn is never served from cache: the default path re-attempts Analyze
    # (the counter is past the last file, so sticky-last serves extraction.2 twice) and
    # degrades again.
    r, events = await fusion(p.cid, {"max_iterations": 2})
    assert r.status_code == 200
    assert types_of(events) == ["analyze_start", "analyze_retry", "analyze_degraded", "error"]
    assert events[0]["turn_id"] != degraded_id
    assert served("analyst", "extraction")[2:] == ["analyst.extraction.2.jsonl"] * 2
    assert len(mock.calls) == 7
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze", "analyze"]
    assert not store.is_busy(p.cid)


async def test_ok_analyze_for_an_older_send_turn_does_not_count(prepare, send, fusion):
    p = await prepare("planted_factual")  # send + ok analyze
    second = await send(p.cid, "And once more?")  # sticky <slot>.chat.1 replies
    second_id = second[0]["turn_id"]
    assert second_id != p.send_turn_id
    _, events = await fusion(p.cid, {"max_iterations": 2})
    assert types_of(events)[:3] == ["analyze_start", "analyze_done", "fusion_start"]
    assert events[0]["of_turn"] == second_id
    assert events[0]["turn_id"] != p.analyze_turn_id
    assert events[2]["of_analyze"] == events[0]["turn_id"]
    assert events[-1]["exit_reason"] == "converged"
    after = await store.load(p.cid)
    assert after is not None
    assert [t.type for t in after.turns] == ["send", "analyze", "send", "analyze", "fusion"]
    # The older ok Analyze turn is still usable when named explicitly.
    _, events2 = await fusion(p.cid, {"of_analyze": p.analyze_turn_id, "max_iterations": 1})
    assert events2[0]["type"] == "fusion_start"
    assert events2[0]["of_analyze"] == p.analyze_turn_id


async def test_auto_run_holds_one_guard_across_analyze_and_fusion(prepare, monkeypatch):
    """The nested run_analyze is re-entrant under Fusion's guard: the conversation is busy from
    analyze_start through the last round and released exactly once, before fusion_done."""
    p = await prepare("planted_factual", run_analyze=False)
    monkeypatch.setenv("MOCK_DELAY_MS", "2")
    seen: list[str] = []
    async for ev in run_fusion(p.cid, of_analyze=None, max_iterations=2):
        seen.append(ev["type"])
        if ev["type"] == "fusion_done":
            assert not store.is_busy(p.cid)  # released before the final event is handed over
        elif ev["type"] != "round_done":  # after the final round_done only persistence remains
            assert store.is_busy(p.cid), ev["type"]
    assert seen[:3] == ["analyze_start", "analyze_done", "fusion_start"]
    assert seen[-1] == "fusion_done"
    assert not store.is_busy(p.cid)
