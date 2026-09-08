"""Cost meter truth (PLAN.md §2 non-functional: cost / tokens / latency per feature invocation;
docs/semantics.md "Metering"): every persisted turn's `usage` is exactly the sum of the usage
chunks of the fixtures the mock served for it, call counts match, and the per-feature rows the
UI recomputes from the conversation (`meterFromConversation`, mirrored by `meter_rows`) equal
those sums."""

from __future__ import annotations

from typing import Any

from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.e2e.conftest import (
    Flow,
    calls,
    fixture_cost,
    fixture_generation_id,
    fixture_usage,
    meter_rows,
    served_name,
)

TOKEN_KEYS = ("prompt_tokens", "completion_tokens", "reasoning_tokens")


def _expected_usage(call: dict[str, Any]) -> dict[str, Any]:
    """What one served fixture's usage chunk says (tokens, cost, generation id)."""
    scenario, name = call["fixture"].split("/", 1)
    chunk = fixture_usage(scenario, name)
    assert chunk is not None, f"{call['fixture']} carries no usage chunk"
    return {
        "role": call["role"],
        "purpose": call["purpose"],
        "model": call["model"],
        "prompt_tokens": chunk["prompt_tokens"],
        "completion_tokens": chunk["completion_tokens"],
        "reasoning_tokens": chunk.get("completion_tokens_details", {}).get("reasoning_tokens", 0),
        "cost_usd": chunk["cost"],
        "generation_id": fixture_generation_id(scenario, name),
    }


def _sort_key(u: dict[str, Any]) -> tuple[str, str, float]:
    return (u["role"], u["purpose"], u["cost_usd"])


def assert_turn_usage_matches(turn: dict[str, Any], group: list[dict[str, Any]]) -> dict:
    """The turn's usage == the sum of the served fixtures' usage chunks; per-call entries match
    one served fixture each (slots run in parallel, so compare as multisets)."""
    expected = [_expected_usage(c) for c in group]
    totals = turn["usage"]["totals"]
    booked = turn["usage"]["calls"]
    assert totals["calls"] == len(booked) == len(group)
    assert totals["cost_usd"] == round(sum(e["cost_usd"] for e in expected), 8)
    for key in TOKEN_KEYS:
        assert totals[key] == sum(e[key] for e in expected), key
        assert totals[key] == sum(u[key] for u in booked), key
    assert totals["latency_ms"] >= 0 and all(u["latency_ms"] >= 0 for u in booked)
    keys = ("role", "purpose", "model", *TOKEN_KEYS, "cost_usd", "generation_id")
    got = sorted(({k: u[k] for k in keys} for u in booked), key=_sort_key)
    want = sorted(({k: e[k] for k in keys} for e in expected), key=_sort_key)
    assert got == want
    return {
        "cost_usd": totals["cost_usd"],
        **{k: totals[k] for k in TOKEN_KEYS},
        "calls": len(group),
    }


def _groups(f: Flow) -> dict[str, list[dict[str, Any]]]:
    return {
        "send": calls("chat"),
        "analyze": calls("extraction"),
        "fusion": calls("defense") + calls("convergence"),
    }


async def test_each_turn_books_exactly_its_fixtures_usage_chunks(run_flow):
    f = await run_flow("planted_factual")
    send, analyze, fusion = f.conv["turns"]
    groups = _groups(f)
    assert [len(g) for g in groups.values()] == [3, 1, 4]
    sums = {
        "send": assert_turn_usage_matches(send, groups["send"]),
        "analyze": assert_turn_usage_matches(analyze, groups["analyze"]),
        "fusion": assert_turn_usage_matches(fusion, groups["fusion"]),
    }
    # The numbers the README fixtures carry, spelled out.
    assert sums["send"]["cost_usd"] == round(
        sum(fixture_cost("planted_factual", f"{s}.chat.1.jsonl") for s in SLOT_IDS), 8
    )
    assert sums["analyze"]["cost_usd"] == fixture_cost(
        "planted_factual", "analyst.extraction.1.jsonl"
    )
    assert sums["fusion"]["cost_usd"] == round(
        sum(fixture_cost("planted_factual", f"{s}.defense.1.jsonl") for s in SLOT_IDS)
        + fixture_cost("planted_factual", "analyst.convergence.1.jsonl"),
        8,
    )
    # Fusion's multiplier is visible: one round already costs more than the Send it fused.
    assert sums["fusion"]["cost_usd"] > sums["send"]["cost_usd"] > sums["analyze"]["cost_usd"]
    # The stream events carry the same totals the document persists.
    assert f.send_events[-1]["usage"] == send["usage"]
    assert f.fusion_events[-1]["usage"] == fusion["usage"]
    for slot in SLOT_IDS:
        done = next(e for e in f.send_events if e["type"] == "slot_done" and e["slot"] == slot)
        booked = next(u for u in send["usage"]["calls"] if u["role"] == slot)
        assert done["usage"] == booked
    # The reasoning tokens of the chat fixtures are counted (they are not zero here).
    assert send["usage"]["totals"]["reasoning_tokens"] > 0
    # And the UI's recomputation from the persisted turns gives the very same rows.
    rows = meter_rows(f.conv)
    for feature, expected in sums.items():
        row = rows[feature]
        assert row["cost_usd"] == expected["cost_usd"] and row["calls"] == expected["calls"]
        for key in TOKEN_KEYS:
            assert row[key] == expected[key]
        assert row["truncated"] == 0
        assert (
            row["latency_ms"]
            == f.conv["turns"][list(sums).index(feature)]["usage"]["totals"]["latency_ms"]
        )


async def test_ui_rows_accumulate_continue_under_send_and_forced_reanalyze(run_flow, api):
    f = await run_flow("planted_factual")
    first = {k: dict(v) for k, v in meter_rows(f.conv).items()}
    n = len(mock.calls)
    await api.cont(f.cid, "grok", "One more thing about the accelerometer.")
    await api.analyze(f.cid, {"force": True})
    conv = await api.get(f.cid)
    assert [t["type"] for t in conv["turns"]] == [
        "send",
        "analyze",
        "fusion",
        "continue",
        "analyze",
    ]
    cont_call, extraction_call = mock.calls[n], mock.calls[n + 1]
    assert cont_call["purpose"] == "chat" and cont_call["role"] == "grok"
    assert extraction_call["purpose"] == "extraction"
    cont_turn, re_turn = conv["turns"][3], conv["turns"][4]
    cont_sum = assert_turn_usage_matches(cont_turn, [cont_call])
    re_sum = assert_turn_usage_matches(re_turn, [extraction_call])
    rows = meter_rows(conv)
    assert rows["send"]["cost_usd"] == round(first["send"]["cost_usd"] + cont_sum["cost_usd"], 8)
    assert rows["send"]["calls"] == first["send"]["calls"] + 1 == 4
    assert rows["analyze"]["cost_usd"] == round(
        first["analyze"]["cost_usd"] + re_sum["cost_usd"], 8
    )
    assert rows["analyze"]["calls"] == 2
    assert rows["fusion"] == first["fusion"]  # untouched
    for key in TOKEN_KEYS:
        assert rows["send"][key] == first["send"][key] + cont_sum[key]
        assert rows["analyze"][key] == first["analyze"][key] + re_sum[key]
    # A cached Analyze hit adds nothing: no turn, no call, same rows.
    r, events = await api.analyze(f.cid)
    assert events[-1]["cached"] is True and len(mock.calls) == n + 2
    assert meter_rows(await api.get(f.cid)) == rows


async def test_truncated_and_failed_slots_are_metered_honestly(run_flow):
    f = await run_flow("truncated", fusion=False)
    send = f.conv["turns"][0]
    assert_turn_usage_matches(send, calls("chat"))
    assert meter_rows(f.conv)["send"]["truncated"] == 1  # chatgpt hit max_tokens
    g = await run_flow("slot_failure", analyze=False, fusion=False)
    send = g.conv["turns"][0]
    # The errored grok call has no usage chunk: only two calls are booked, none for grok.
    ok_calls = [c for c in calls("chat") if fixture_usage(*c["fixture"].split("/", 1)) is not None]
    assert sorted(served_name(c) for c in ok_calls) == [
        "chatgpt.chat.1.jsonl",
        "claude.chat.1.jsonl",
    ]
    assert_turn_usage_matches(send, ok_calls)
    assert send["usage"]["totals"]["calls"] == 2
    assert {u["role"] for u in send["usage"]["calls"]} == {"claude", "chatgpt"}
    assert meter_rows(g.conv)["send"]["truncated"] == 0
