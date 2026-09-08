"""Golden (syrupy) snapshots of the persisted AnalyzeTurn / FusionTurn JSON for fixed inputs
(PLAN.md §9 "snapshot tests on the Analyze report and fusion timeline").

Volatile fields are normalised BEFORE snapshotting (`tests/e2e/conftest.py::normalise_turn`):
turn ids / `of_turn` / `of_analyze` -> "<turn-N:type>" placeholders in turn order, `ts` ->
"<ts>", every `latency_ms` -> 0, `generation_id` -> "<gen>". The normaliser tests prove that
nothing else is touched, so a snapshot diff is always a real behaviour change.

Regenerate deliberately with `uv run pytest tests/e2e/test_golden.py --snapshot-update`.
"""

from __future__ import annotations

import copy

import pytest

from backend.schemas import AnalyzeTurn, FusionTurn
from tests.e2e.conftest import (
    GEN_PLACEHOLDER,
    TS_PLACEHOLDER,
    TURN_REF_KEYS,
    leaves,
    normalise_turn,
    normalise_turns,
    turn_placeholders,
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
def _assert_only_volatile_leaves_changed(original: dict, normalised: dict, ids: dict) -> None:
    before, after = leaves(original), leaves(normalised)
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


def test_normaliser_on_a_hand_built_document():
    ids = {"aaa": "<turn-1:send>", "bbb": "<turn-2:analyze>"}
    doc = {
        "id": "bbb",
        "of_turn": "aaa",
        "ts": "2026-09-08T00:00:00.000Z",
        "usage": {
            "calls": [{"latency_ms": 42, "generation_id": "gen-1", "cost_usd": 0.5}],
            "totals": {"latency_ms": 99, "calls": 1},
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
            "calls": [{"latency_ms": 0, "generation_id": "<gen>", "cost_usd": 0.5}],
            "totals": {"latency_ms": 0, "calls": 1},
        },
        "extraction": {"divergences": [{"id": "d1", "positions": [{"model": "R1"}]}]},
        "nested": {"generation_id": None, "id": "not-a-turn", "of_analyze": "zzz"},
    }
    assert doc["id"] == "bbb" and doc["usage"]["calls"][0]["latency_ms"] == 42  # untouched
    _assert_only_volatile_leaves_changed(doc, out, ids)
