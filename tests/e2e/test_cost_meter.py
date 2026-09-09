"""Cost meter truth (PLAN.md §2 non-functional: cost / tokens / latency per feature invocation;
docs/semantics.md "Metering"): every persisted turn's `usage` is exactly the sum of the usage
chunks of the fixtures the mock served for it, call counts match, and the per-feature rows the
UI recomputes from the conversation (`meterFromConversation`, mirrored by `meter_rows`) equal
those sums. `meter_rows` is a hand transcription, so the last test runs the REAL slice
(`frontend/src/features/meter/slice.js`, a dependency-free ES module) under node on the same
conversation and the same SSE events and pins both sides to each other."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

import pytest

from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.e2e.conftest import (
    REPO_ROOT,
    Flow,
    calls,
    fixture_cost,
    fixture_generation_id,
    fixture_usage,
    meter_rows,
    served_name,
)

TOKEN_KEYS = ("prompt_tokens", "completion_tokens", "reasoning_tokens")
METER_SLICE = REPO_ROOT / "frontend" / "src" / "features" / "meter" / "slice.js"
# Runs the slice's reload path (`rowsFromConversation`) and its live path (`meterReducer` over
# `{type:'sse', feature, event}` actions, exactly what `runStream` dispatches) on stdin JSON.
NODE_SCRIPT = """
import fs from 'node:fs';
const slice = await import(process.env.METER_SLICE);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const loaded = slice.rowsFromConversation(input.conversation);
let s = slice.meterReducer(undefined, { type: '@@init' });
for (const { feature, events } of input.streams) {
  for (const event of events) s = slice.meterReducer(s, { type: 'sse', feature, event });
}
process.stdout.write(JSON.stringify({ loaded, live: { send: s.send, analyze: s.analyze, fusion: s.fusion } }));
"""


def frontend_meter_rows(
    conversation: dict[str, Any], streams: list[tuple[str, list[dict[str, Any]]]]
) -> dict[str, dict[str, dict[str, Any]]]:
    """`{"loaded": rows, "live": rows}` as the frontend meter slice computes them under node."""
    node = shutil.which("node")
    if node is None:  # pragma: no cover - the repo's frontend toolchain is node
        pytest.skip("node is required to run the frontend meter slice")
    assert METER_SLICE.is_file(), METER_SLICE
    payload = {
        "conversation": conversation,
        "streams": [{"feature": f, "events": e} for f, e in streams],
    }
    p = subprocess.run(
        [node, "--input-type=module", "-e", NODE_SCRIPT],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "METER_SLICE": METER_SLICE.as_uri()},
        cwd=REPO_ROOT,
    )
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


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


async def test_python_meter_mirror_matches_the_frontend_slice(run_flow, api):
    """`meter_rows` mirrors `meterFromConversation` by hand; nothing else ties the two. Run the
    real slice on the very conversation (reload path) and on the very SSE events the flow
    streamed (live path: `slot_done` per slot, `turn_done` wall clock, `analyze_done` cached or
    not, `analyze_degraded`, `fusion_done.usage`) and require all three to agree exactly, so a
    change to `turnDelta`, `round8` or the event booking on either side fails here."""
    f = await run_flow("planted_factual")
    streams = [("send", f.send_events), ("analyze", f.analyze_events), ("fusion", f.fusion_events)]
    _, events = await api.cont(f.cid, "grok", "One more thing about the accelerometer.")
    streams.append(("send", events))  # continue streams run under the feature key 'send'
    _, events = await api.analyze(f.cid, {"force": True})
    streams.append(("analyze", events))
    _, events = await api.analyze(f.cid)
    assert events[-1]["cached"] is True
    streams.append(("analyze", events))  # books nothing on either side
    conv = await api.get(f.cid)
    assert [t["type"] for t in conv["turns"]] == [
        "send",
        "analyze",
        "fusion",
        "continue",
        "analyze",
    ]

    expected = meter_rows(conv)
    js = frontend_meter_rows(conv, streams)
    assert js["loaded"] == expected
    assert js["live"] == expected
    assert [expected[k]["calls"] for k in ("send", "analyze", "fusion")] == [4, 2, 4]
    assert all(expected[k]["latency_ms"] > 0 for k in ("send", "analyze", "fusion"))

    # The truncated count and an errored slot go through the same two paths.
    g = await run_flow("truncated", fusion=False)
    rows = meter_rows(g.conv)
    assert rows["send"]["truncated"] == 1
    js = frontend_meter_rows(g.conv, [("send", g.send_events), ("analyze", g.analyze_events)])
    assert js["loaded"] == rows and js["live"] == rows
    h = await run_flow("slot_failure", analyze=False, fusion=False)
    rows = meter_rows(h.conv)
    assert rows["send"]["calls"] == 2
    js = frontend_meter_rows(h.conv, [("send", h.send_events)])
    assert js["loaded"] == rows and js["live"] == rows
