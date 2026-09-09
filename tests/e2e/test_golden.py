"""Golden (syrupy) snapshots of the persisted AnalyzeTurn / FusionTurn JSON for fixed inputs
(PLAN.md §9 "snapshot tests on the Analyze report and fusion timeline").

Volatile fields are normalised BEFORE snapshotting (`tests/e2e/conftest.py::normalise_turn`):
turn ids / `of_turn` / `of_analyze` -> "<turn-N:type>" placeholders in turn order, `ts` ->
"<ts>", every `latency_ms` -> 0, `generation_id` -> "<gen>", and every `usage.calls` list in
`(role, purpose)` order (the persisted order is the completion order of the parallel slot
tasks; `FeatureUsage.calls` specifies none). The normaliser tests prove that nothing else is
touched, so a snapshot diff is always a real behaviour change.

Regenerate deliberately with `uv run pytest tests/e2e/test_golden.py --snapshot-update`. A
developer `.env` cannot leak into a regeneration: `tests/e2e/conftest.py` loads it at
collection time so the root conftest's per-test `delenv` sees its keys, and the Analyze golden
additionally asserts the as-run `slot_config` is the module default on a plain assert.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from backend.config import DEFAULT_SLOT_CONFIG
from backend.llm import mock
from backend.schemas import AnalyzeTurn, FusionTurn
from tests.e2e.conftest import (
    GEN_PLACEHOLDER,
    TS_PLACEHOLDER,
    TURN_REF_KEYS,
    leaves,
    normalise_turn,
    normalise_turns,
    sort_usage_calls,
    turn_placeholders,
    usage_call_key,
)

FUSED = [
    "planted_factual",
    "stalemate",
    "standing_at_cap",
    "unjustified_revise",
    "two_divergences",
    "fusion_slot_error",
]
VOLATILE_KEYS = (*TURN_REF_KEYS, "ts", "latency_ms", "generation_id")


@pytest.mark.parametrize("name", FUSED)
async def test_analyze_turn_snapshot(run_flow, name, snapshot):
    f = await run_flow(name)
    turns = normalise_turns(f.conv)
    assert [t["type"] for t in turns] == ["send", "analyze", "fusion"]
    assert turns[1]["status"] == "ok"
    # A leaked developer .env override (FUSION_MAX_ITERATIONS, MATERIALITY_MIN, SLOT_*_MODEL,
    # ...) must fail on a plain assert, never be snapshotted: compare against the module
    # constant, not settings().default_slot_config (tautological under a leak).
    assert turns[1]["slot_config"] == DEFAULT_SLOT_CONFIG.model_dump()
    assert turns[1] == snapshot


@pytest.mark.parametrize("name", FUSED)
async def test_fusion_turn_snapshot(run_flow, name, snapshot):
    f = await run_flow(name)
    turns = normalise_turns(f.conv)
    assert turns[2]["type"] == "fusion"
    assert turns[2]["exit_reason"] == f.expectations["exit_reason"]
    assert turns[2] == snapshot


async def test_injection_extraction_snapshot(run_flow, snapshot):
    f = await run_flow("injection", fusion=False)
    turn = f.analyze_turn
    assert turn is not None and turn["status"] == "ok"
    assert normalise_turn(turn, turn_placeholders(f.conv))["extraction"] == snapshot


# --------------------------------------------------------------------------- the normaliser
def _with_sorted_usage_calls(doc: Any) -> Any:
    """A deep copy of `doc` with every `usage.calls` list in `usage_call_key` order, so the
    leaf-by-leaf comparison below compares those lists as multisets rather than by index."""
    if isinstance(doc, dict):
        out = {}
        for k, v in doc.items():
            if k == "usage" and isinstance(v, dict) and isinstance(v.get("calls"), list):
                v = {**v, "calls": sort_usage_calls(v["calls"])}
            out[k] = _with_sorted_usage_calls(v)
        return out
    if isinstance(doc, list):
        return [_with_sorted_usage_calls(v) for v in doc]
    return doc


def _assert_only_volatile_leaves_changed(original: dict, normalised: dict, ids: dict) -> None:
    before, after = leaves(_with_sorted_usage_calls(original)), leaves(normalised)
    assert set(before) == set(after), "the normaliser changed the document's structure"
    for path, value in before.items():
        key = path[-1]
        new = after[path]
        if key in TURN_REF_KEYS and isinstance(value, str) and value in ids:
            assert new == ids[value], path
        elif key == "ts":
            assert new == TS_PLACEHOLDER, path
        elif key == "generation_id":
            assert new == (None if value is None else GEN_PLACEHOLDER), path
        elif key == "latency_ms":
            assert new == 0, path
        else:
            assert new == value, f"non-volatile leaf changed: {path}"


async def test_normaliser_changes_only_the_volatile_fields(run_flow):
    f = await run_flow("two_divergences")
    conv = copy.deepcopy(f.conv)
    ids = turn_placeholders(conv)
    assert list(ids.values()) == ["<turn-1:send>", "<turn-2:analyze>", "<turn-3:fusion>"]
    for original in conv["turns"]:
        normalised = normalise_turn(original, ids)
        _assert_only_volatile_leaves_changed(original, normalised, ids)
        assert normalise_turn(normalised, ids) == normalised  # idempotent
        assert original == f.conv["turns"][conv["turns"].index(original)]  # never mutates
    # Real volatility was actually present and actually removed.
    send, analyze, fusion = (normalise_turn(t, ids) for t in conv["turns"])
    assert analyze["of_turn"] == "<turn-1:send>" and fusion["of_analyze"] == "<turn-2:analyze>"
    assert {t["ts"] for t in (send, analyze, fusion)} == {TS_PLACEHOLDER}
    assert all(u["latency_ms"] == 0 for t in (send, analyze, fusion) for u in t["usage"]["calls"])
    assert all(t["usage"]["totals"]["latency_ms"] == 0 for t in (send, analyze, fusion))
    assert {u["generation_id"] for t in (send, analyze, fusion) for u in t["usage"]["calls"]} == {
        GEN_PLACEHOLDER
    }
    # Divergence ids (`id: "d1"`) are NOT turn references and survive untouched.
    assert [d["id"] for d in analyze["extraction"]["divergences"]] == ["d1", "d2"]
    assert [s["divergence_id"] for s in fusion["final"]] == ["d1", "d2"]
    # The normalised documents still validate against the frozen schemas.
    AnalyzeTurn.model_validate(analyze)
    FusionTurn.model_validate(fusion)
    # The fusion turn's calls (three slots in parallel + the analyst) come out keyed, not in the
    # completion order the document happened to persist.
    assert [usage_call_key(u) for u in fusion["usage"]["calls"]] == sorted(
        usage_call_key(u) for u in conv["turns"][2]["usage"]["calls"]
    )


async def test_normaliser_ignores_the_completion_order_of_usage_calls(run_flow):
    """`usage.calls` is merged per slot task inside `asyncio.gather`, so its persisted order is
    whichever slot finished first: any permutation of it must normalise to the same golden."""
    f = await run_flow("planted_factual")
    ids = turn_placeholders(f.conv)
    fusion = f.conv["turns"][2]
    assert len(fusion["usage"]["calls"]) == 4
    reference = normalise_turn(fusion, ids)
    for permutation in (
        list(reversed(fusion["usage"]["calls"])),
        [*fusion["usage"]["calls"][1:], fusion["usage"]["calls"][0]],
    ):
        shuffled = copy.deepcopy(fusion)
        shuffled["usage"]["calls"] = permutation
        assert normalise_turn(shuffled, ids) == reference
        _assert_only_volatile_leaves_changed(shuffled, normalise_turn(shuffled, ids), ids)
    # `totals` is order-independent by construction and stays untouched (latency aside).
    assert reference["usage"]["totals"] == {**fusion["usage"]["totals"], "latency_ms": 0}


async def test_goldens_do_not_depend_on_the_mock_pacing(run_flow, api, monkeypatch):
    """Under `MOCK_DELAY_MS>0` the mock suspends between deltas, the three slot tasks
    interleave and the fusion turn books `usage.calls` in completion order (the exact case that
    once broke the goldens under a shell export). The pacing is set AFTER the scenario fixture's
    pin, so this exercises the normaliser, not the pin."""
    f = await run_flow("planted_factual")
    unpaced = normalise_turns(f.conv)
    monkeypatch.setenv("MOCK_DELAY_MS", "3")
    mock.reset()
    cid = (await api.create())["id"]
    await api.send(cid, f.prompt)
    r, _ = await api.analyze(cid)
    assert r.status_code == 200
    r, events = await api.fusion(cid, {"max_iterations": f.max_iterations})
    assert r.status_code == 200 and events[-1]["type"] == "fusion_done"
    paced_conv = await api.get(cid)
    assert normalise_turns(paced_conv) == unpaced
    for paced_turn, turn in zip(paced_conv["turns"], f.conv["turns"], strict=True):
        assert sorted(map(usage_call_key, paced_turn["usage"]["calls"])) == sorted(
            map(usage_call_key, turn["usage"]["calls"])
        )


def test_normaliser_on_a_hand_built_document():
    ids = {"aaa": "<turn-1:send>", "bbb": "<turn-2:analyze>"}
    doc = {
        "id": "bbb",
        "of_turn": "aaa",
        "ts": "2026-09-08T00:00:00.000Z",
        "usage": {
            "calls": [
                {"role": "grok", "purpose": "defense", "latency_ms": 42, "generation_id": "gen-1"},
                {"role": "analyst", "purpose": "convergence", "latency_ms": 7, "cost_usd": 0.5},
                {"role": "claude", "purpose": "defense", "latency_ms": 3, "generation_id": None},
            ],
            "totals": {"latency_ms": 99, "calls": 3},
        },
        "extraction": {"divergences": [{"id": "d1", "positions": [{"model": "R1"}]}]},
        "nested": {"generation_id": None, "id": "not-a-turn", "of_analyze": "zzz"},
    }
    out = normalise_turn(doc, ids)
    assert out == {
        "id": "<turn-2:analyze>",
        "of_turn": "<turn-1:send>",
        "ts": "<ts>",
        "usage": {
            "calls": [
                {"role": "analyst", "purpose": "convergence", "latency_ms": 0, "cost_usd": 0.5},
                {"role": "claude", "purpose": "defense", "latency_ms": 0, "generation_id": None},
                {"role": "grok", "purpose": "defense", "latency_ms": 0, "generation_id": "<gen>"},
            ],
            "totals": {"latency_ms": 0, "calls": 3},
        },
        "extraction": {"divergences": [{"id": "d1", "positions": [{"model": "R1"}]}]},
        "nested": {"generation_id": None, "id": "not-a-turn", "of_analyze": "zzz"},
    }
    assert doc["id"] == "bbb" and doc["usage"]["calls"][0]["role"] == "grok"  # untouched
    assert doc["usage"]["calls"][0]["latency_ms"] == 42
    assert normalise_turn(out, ids) == out  # idempotent: a stable sort of a sorted list
    _assert_only_volatile_leaves_changed(doc, out, ids)
