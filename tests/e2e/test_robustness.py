"""Robustness of the Analyze / Fusion JSON path end to end (PLAN.md §9 "Robustness": fuzz the
parsers with truncated and fenced output; docs/semantics.md "Structured output").

Malformed model outputs -- truncated, fenced, chatty, prose-only, schema-violating,
whitespace-only, empty and mid-stream error chunks -- are planted as mock fixtures
(`tests/e2e/malformed.py`) and the REAL HTTP flow runs against them: the committed deterministic
scenarios under `tests/e2e/fixtures` first, then hypothesis-generated combinations written into a
temporary fixtures root (`MOCK_FIXTURES_DIR` monkeypatched). The oracle is the frozen contract: a
valid attempt (plain, fenced or chatty) is recovered; Analyze retries once on ANY failure and
otherwise degrades, echoing the bad output back only when it is not blank; `complete_json`
retries once on a parse / validation failure (same echo rule) but never on a transport error, so
a slot whose attempts all fail is `unavailable`, a failed convergence check leaves ids
`standing`. Never a 500, never an `error` event, never a hung stream (every request is bounded
by `TIMEOUT_S`)."""

from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from backend import anon
from backend.llm import mock
from backend.main import create_app
from backend.prompts import analyze as analyze_prompts
from backend.schemas import (
    SLOT_IDS,
    AnalyzeTurn,
    DefenseReply,
    Extraction,
    FusionTurn,
    is_unjustified,
)
from backend.store import conversations as store
from tests.conftest import DEFAULT_PROMPT
from tests.e2e.conftest import (
    ANALYZE_URL,
    CONV_URL,
    FUSION_URL,
    LABEL_OF,
    SEND_URL,
    calls,
    challenge_of,
    types_of,
)
from tests.e2e.malformed import (
    CONVERGENCE_PAYLOADS,
    CONVERGENCE_VIOLATIONS,
    DEFENSE_VIOLATIONS,
    EXTRACTION_VIOLATIONS,
    LOCAL_FIXTURES_DIR,
    Reply,
    build,
    corpus,
    defense_payloads,
    extraction_payload,
    replies,
    write_scenario,
)
from tests.helpers import parse_sse_text

TIMEOUT_S = 30.0
RETRY_PREFIX = "Your previous output failed validation:"
FUZZ = settings(
    max_examples=40,
    deadline=None,
    database=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)


# --------------------------------------------------------------------------- driving the API
async def drive(
    client: httpx.AsyncClient, *, fusion: bool, max_iterations: int = 1
) -> dict[str, Any]:
    """create -> send -> analyze [-> fusion] -> GET, every streamed request bounded in time;
    nothing may be a 5xx, leak `anon_map` or leave the busy guard held."""
    r = await client.post("/api/conversations", json={})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    responses = [r]
    r = await asyncio.wait_for(
        client.post(SEND_URL.format(cid=cid), json={"prompt": DEFAULT_PROMPT}), TIMEOUT_S
    )
    responses.append(r)
    assert r.status_code == 200, r.text
    send_events = parse_sse_text(r.text)
    assert send_events[-1]["type"] == "turn_done"
    r = await asyncio.wait_for(client.post(ANALYZE_URL.format(cid=cid), json={}), TIMEOUT_S)
    responses.append(r)
    out: dict[str, Any] = {
        "cid": cid,
        "analyze": r,
        "analyze_events": parse_sse_text(r.text) if r.status_code == 200 else [],
    }
    if fusion:
        r = await asyncio.wait_for(
            client.post(FUSION_URL.format(cid=cid), json={"max_iterations": max_iterations}),
            TIMEOUT_S,
        )
        responses.append(r)
        out["fusion"] = r
        out["fusion_events"] = parse_sse_text(r.text) if r.status_code == 200 else []
    r = await client.get(CONV_URL.format(cid=cid))
    responses.append(r)
    assert r.status_code == 200
    out["conv"] = r.json()
    for resp in responses:
        assert resp.status_code < 500, f"{resp.request.url}: {resp.status_code} {resp.text[:300]}"
        assert "anon_map" not in resp.text
    assert not store.is_busy(cid)
    return out


def run_offline(coro_factory) -> dict[str, Any]:
    """Run `coro_factory(client)` on a fresh loop with a fresh app (hypothesis examples are
    synchronous; the shared async `client` fixture cannot be reused across loops)."""

    async def _main() -> dict[str, Any]:
        app = create_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await coro_factory(client)

    return asyncio.run(_main())


# --------------------------------------------------------------------------- the oracles
def attempts_of(first: Reply, second: Reply) -> list[Reply]:
    """`complete_json(retries=1)`: one attempt when the first parses or is a transport error
    (never retried), else the retry follows."""
    return [first] if first.valid or first.transport_error else [first, second]


def assert_analyze_outcome(out: dict[str, Any], first: Reply, second: Reply) -> AnalyzeTurn:
    r, events = out["analyze"], out["analyze_events"]
    assert r.status_code == 200, r.text
    kinds = types_of(events)
    assert kinds[0] == "analyze_start" and kinds[-1] in ("analyze_done", "analyze_degraded")
    assert "error" not in kinds
    turn = AnalyzeTurn.model_validate(events[-1]["turn"])
    assert [t["type"] for t in out["conv"]["turns"]] == ["send", "analyze"]
    assert out["conv"]["turns"][1] == events[-1]["turn"]  # persisted before the final event
    extraction_calls = calls("extraction")
    if first.valid:
        assert kinds == ["analyze_start", "analyze_done"]
        assert turn.status == "ok" and turn.raw_attempts == [first.text]
        assert turn.extraction == Extraction.model_validate(first.payload)
        assert len(extraction_calls) == 1
    else:
        # Analyze drives ONE retry itself, after any failure (parse, validation or transport).
        assert kinds[:2] == ["analyze_start", "analyze_retry"] and len(kinds) == 3
        retry_error = events[1]["error"]
        assert retry_error
        if first.transport_error:
            assert retry_error == "Rate limit exceeded"
        else:
            assert retry_error.startswith("parse_error") or "validation error" in retry_error
        assert len(extraction_calls) == 2
        c1, c2 = extraction_calls
        # docs/semantics.md retry rule, all three cases: output that failed parsing is echoed
        # back and corrected; whitespace-only output gets the correction WITHOUT the echo
        # (providers reject empty assistant content); no output at all is simply re-sent.
        correction = {"role": "user", "content": analyze_prompts.retry_message(retry_error)}
        if first.echoed_on_retry:
            assert c2["messages"] == [
                *c1["messages"],
                {"role": "assistant", "content": first.text},
                correction,
            ]
            assert "failed validation" in c2["messages"][-1]["content"]
        elif first.text:
            assert first.kind == "blank"
            assert c2["messages"] == [*c1["messages"], correction]
            assert all(m["content"].strip() for m in c2["messages"] if m["role"] == "assistant")
        else:  # nothing to correct: the same request is simply retried
            assert c2["messages"] == c1["messages"]
        assert turn.raw_attempts == [first.text, second.text]
        if second.valid:
            assert kinds[-1] == "analyze_done" and turn.status == "ok"
            assert turn.extraction == Extraction.model_validate(second.payload)
            assert turn.error is None
        else:
            assert kinds[-1] == "analyze_degraded" and turn.status == "degraded"
            assert turn.extraction is None and turn.error
    assert turn.usage.totals.calls == sum(
        1 for a in ([first] if first.valid else [first, second]) if a.metered
    )
    return turn


def assert_fusion_outcome(
    out: dict[str, Any],
    defenses: dict[str, tuple[Reply, Reply]],
    convergence: tuple[Reply, Reply],
) -> FusionTurn:
    r, events = out["fusion"], out["fusion_events"]
    assert r.status_code == 200, r.text
    kinds = types_of(events)
    assert kinds[0] == "fusion_start" and kinds[-1] == "fusion_done" and "error" not in kinds
    turn = FusionTurn.model_validate(events[-1]["turn"])
    assert [t["type"] for t in out["conv"]["turns"]] == ["send", "analyze", "fusion"]
    assert out["conv"]["turns"][2] == events[-1]["turn"]
    assert turn.standing == ["d1"] and turn.max_iterations == 1 and len(turn.rounds) == 1
    rnd = turn.rounds[0]
    exchanges = {e.model: e for e in rnd.exchanges}
    assert set(exchanges) == {"R1", "R2", "R3"}

    positions = {
        p["model"]: p["claim"] for p in extraction_payload()["divergences"][0]["positions"]
    }
    available: dict[str, Reply] = {}
    flags: list[bool] = []
    metered = 0
    for slot in SLOT_IDS:
        label = LABEL_OF[slot]
        first, second = defenses[slot]
        attempts = attempts_of(first, second)
        served = calls("defense", slot)
        assert len(served) == len(attempts), f"{slot}: {len(served)} calls for {attempts}"
        metered += sum(1 for a in attempts if a.metered)
        if len(served) == 2:
            # The internal retry carries the bad output (only when it is not blank) and the
            # error: same three-case rule as Analyze, applied by `complete_json` itself.
            c1, c2 = served
            assert challenge_of(c1) == c2["messages"][len(c1["messages"]) - 1]["content"]
            assert c2["messages"][-1]["content"].startswith(RETRY_PREFIX)
            assert len(c2["messages"]) == len(c1["messages"]) + (2 if first.echoed_on_retry else 1)
            if first.echoed_on_retry:
                assert c2["messages"][-2] == {"role": "assistant", "content": first.text}
        reply = attempts[-1] if attempts[-1].valid else None
        ex = exchanges[label]
        thread = out["conv"]["threads"][slot]
        if reply is None:
            assert ex.stance == "unavailable" and ex.error and ex.confidence is None
            assert ex.justification == "" and ex.revised_claim is None
            if attempts[-1].transport_error:
                assert ex.error == "Rate limit exceeded"
            assert [m["kind"] for m in thread] == ["chat", "chat"], f"{slot}: appended on error"
            continue
        available[label] = reply
        payload = reply.payload
        assert payload is not None
        assert ex.stance == payload["stance"] and ex.error is None
        assert ex.justification == payload["justification"]
        assert ex.revised_claim == payload.get("revised_claim")
        assert ex.confidence == payload["confidence"]
        peers = [anon.scrub(positions[peer]) for peer in ("R1", "R2", "R3") if peer != label]
        expected_flag = is_unjustified(DefenseReply.model_validate(payload), peers)
        assert ex.flagged_unjustified is expected_flag
        if ex.stance == "revise":
            flags.append(expected_flag)
        assert [m["kind"] for m in thread] == ["chat", "chat", "fusion_challenge", "fusion_reply"]
        assert thread[2]["content"] == challenge_of(served[0])
        assert thread[3]["content"] == reply.text  # the successful attempt, verbatim
        assert thread[2]["meta"] == thread[3]["meta"] == {"divergence_id": "d1", "round": 1}

    revised = any(r.payload["stance"] == "revise" for r in available.values() if r.payload)
    assert rnd.changed is revised
    conv_calls = calls("convergence")
    if not available:
        assert turn.exit_reason == "error" and conv_calls == []
        status = "standing"
    elif not revised:
        assert turn.exit_reason == "stalemate" and conv_calls == []
        status = "standing"
    else:
        c1, c2 = convergence
        attempts = attempts_of(c1, c2)
        assert len(conv_calls) == len(attempts)
        metered += sum(1 for a in attempts if a.metered)
        verdict = attempts[-1].payload if attempts[-1].valid else None
        if verdict is not None and verdict["statuses"][0]["status"] == "resolved":
            status = "resolved_unjustified" if flags and all(flags) else "resolved"
            assert turn.exit_reason == "converged"
        else:
            status = "standing"
            assert turn.exit_reason == "max_iterations"
    assert [s.model_dump() for s in turn.final] == [{"divergence_id": "d1", "status": status}]
    assert [s.model_dump() for s in rnd.post_round_status] == [
        {"divergence_id": "d1", "status": status}
    ]
    assert turn.usage.totals.calls == metered
    return turn


# --------------------------------------------------------------------------- committed corpus
@pytest.fixture
def local_fixtures(monkeypatch):
    def _use(scenario: str) -> None:
        monkeypatch.setenv("MOCK_FIXTURES_DIR", str(LOCAL_FIXTURES_DIR))
        monkeypatch.setenv("MOCK_SCENARIO", scenario)
        mock.reset()

    return _use


def test_committed_malformed_corpus_matches_builder(tmp_path):
    """The files under tests/e2e/fixtures are exactly what `malformed.build` produces."""
    expected = {d.name for d in build(tmp_path)}
    committed = LOCAL_FIXTURES_DIR / "scenarios"
    assert {d.name for d in committed.iterdir() if d.is_dir()} == expected
    for name in expected:
        fresh, on_disk = tmp_path / "scenarios" / name, committed / name
        assert {p.name for p in fresh.iterdir()} == {p.name for p in on_disk.iterdir()}, name
        for p in fresh.iterdir():
            assert (on_disk / p.name).read_bytes() == p.read_bytes(), f"{name}/{p.name} drifted"


ANALYST_CASES = {
    "analyst_truncated_twice": ("degraded", ["analyze_start", "analyze_retry", "analyze_degraded"]),
    "analyst_prose_then_fenced": ("ok", ["analyze_start", "analyze_retry", "analyze_done"]),
    "analyst_chatty_first": ("ok", ["analyze_start", "analyze_done"]),
    "analyst_blank_then_valid": ("ok", ["analyze_start", "analyze_retry", "analyze_done"]),
}


@pytest.mark.parametrize("name", sorted(ANALYST_CASES))
async def test_committed_analyst_scenarios(local_fixtures, client, name):
    local_fixtures(name)
    _, files = corpus()[name]
    first = files["analyst.extraction.1.jsonl"]
    second = files.get("analyst.extraction.2.jsonl", first)
    out = await drive(client, fusion=False)
    turn = assert_analyze_outcome(out, first, second)
    status, kinds = ANALYST_CASES[name]
    assert turn.status == status and types_of(out["analyze_events"]) == kinds
    if status == "degraded":
        r = await client.post(
            FUSION_URL.format(cid=out["cid"]),
            json={"of_analyze": turn.id, "max_iterations": 1},
        )
        assert r.status_code == 409 and r.json() == {"detail": {"error": "analyze_degraded"}}
    else:
        assert turn.extraction == Extraction.model_validate(extraction_payload())


FUSION_CASES = {
    "defense_malformed": (
        "max_iterations",
        {"R1": "unavailable", "R2": "revise", "R3": "defend"},
        {"claude": 2, "chatgpt": 1, "grok": 1, "convergence": 2},
    ),
    "defense_all_malformed": (
        "error",
        {"R1": "unavailable", "R2": "unavailable", "R3": "unavailable"},
        {"claude": 2, "chatgpt": 2, "grok": 1, "convergence": 0},  # grok: error chunk, no retry
    ),
    "convergence_malformed_twice": (
        "max_iterations",
        {"R1": "defend", "R2": "revise", "R3": "defend"},
        {"claude": 1, "chatgpt": 1, "grok": 1, "convergence": 2},
    ),
}


@pytest.mark.parametrize("name", sorted(FUSION_CASES))
async def test_committed_fusion_scenarios(local_fixtures, client, name):
    local_fixtures(name)
    _, files = corpus()[name]

    def pair(role: str, purpose: str) -> tuple[Reply, Reply]:
        first = files.get(f"{role}.{purpose}.1.jsonl")
        assert first is not None, f"{name} has no {role}.{purpose}.1"
        return first, files.get(f"{role}.{purpose}.2.jsonl", first)

    out = await drive(client, fusion=True, max_iterations=1)
    turn = assert_fusion_outcome(
        out,
        {slot: pair(slot, "defense") for slot in SLOT_IDS},
        pair("analyst", "convergence")
        if "analyst.convergence.1.jsonl" in files
        else (
            files["claude.defense.1.jsonl"],
            files["claude.defense.1.jsonl"],
        ),
    )
    exit_reason, stances, counts = FUSION_CASES[name]
    assert turn.exit_reason == exit_reason
    assert {e.model: e.stance for e in turn.rounds[0].exchanges} == stances
    assert [s.status for s in turn.final] == ["standing"]
    for slot in SLOT_IDS:
        assert len(calls("defense", slot)) == counts[slot], slot
    assert len(calls("convergence")) == counts["convergence"]
    assert len(calls("extraction")) == 1


# --------------------------------------------------------------------------- hypothesis fuzz
extraction_replies = replies([extraction_payload()], EXTRACTION_VIOLATIONS)
defense_replies = replies(defense_payloads(), DEFENSE_VIOLATIONS)
convergence_replies = replies(CONVERGENCE_PAYLOADS, CONVERGENCE_VIOLATIONS)


def _fresh_scenario(root: Path, files: dict[str, Reply], *, with_extraction: bool) -> str:
    name = f"fuzz_{uuid.uuid4().hex[:10]}"
    write_scenario(root, name, files, with_extraction=with_extraction)
    return name


@given(first=extraction_replies, second=extraction_replies)
@FUZZ
def test_fuzz_analyze_json_path_never_500s_or_hangs(first, second, tmp_path, monkeypatch):
    root = tmp_path / "fixtures"
    name = _fresh_scenario(
        root,
        {"analyst.extraction.1.jsonl": first, "analyst.extraction.2.jsonl": second},
        with_extraction=False,
    )
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(root))
    monkeypatch.setenv("MOCK_SCENARIO", name)
    mock.reset()
    try:
        out = run_offline(lambda client: drive(client, fusion=False))
        turn = assert_analyze_outcome(out, first, second)
        assert turn.status in ("ok", "degraded")
    finally:
        shutil.rmtree(root / "scenarios" / name, ignore_errors=True)


@given(
    defenses=st.fixed_dictionaries(
        {slot: st.tuples(defense_replies, defense_replies) for slot in SLOT_IDS}
    ),
    convergence=st.tuples(convergence_replies, convergence_replies),
)
@FUZZ
def test_fuzz_defense_and_convergence_json_path_ends_in_a_contract_state(
    defenses, convergence, tmp_path, monkeypatch
):
    root = tmp_path / "fixtures"
    files: dict[str, Reply] = {}
    for slot, (first, second) in defenses.items():
        files[f"{slot}.defense.1.jsonl"] = first
        files[f"{slot}.defense.2.jsonl"] = second
    files["analyst.convergence.1.jsonl"] = convergence[0]
    files["analyst.convergence.2.jsonl"] = convergence[1]
    name = _fresh_scenario(root, files, with_extraction=True)
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(root))
    monkeypatch.setenv("MOCK_SCENARIO", name)
    mock.reset()
    try:
        out = run_offline(lambda client: drive(client, fusion=True, max_iterations=1))
        assert out["analyze"].status_code == 200
        assert out["analyze_events"][-1]["type"] == "analyze_done"
        turn = assert_fusion_outcome(out, defenses, convergence)
        assert turn.exit_reason in ("converged", "stalemate", "max_iterations", "error")
        assert all(
            e.stance in ("defend", "revise", "unavailable") for e in turn.rounds[0].exchanges
        )
    finally:
        shutil.rmtree(root / "scenarios" / name, ignore_errors=True)
