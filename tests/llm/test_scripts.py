"""The Stage 4 scripts (`scripts/live_smoke.py`, `scripts/record_fixtures.py`), offline.

Both are imported from their file path (scripts/ is not a package) and driven in-process:
- the safety refusals (no key in live mode, mock mode without --allow-mock, a recording
  directory that already holds fixtures) make no call at all;
- `--allow-mock` runs each flow against the shipped scenarios;
- the "live" path runs over the REAL httpx transport against a respx fake of OpenRouter, so
  `--record` really tees fixtures, the cost cap really refuses, and a recording made by
  `record_fixtures.py` replays byte-for-byte through the mock transport afterwards.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from types import ModuleType

import httpx
import pytest

from backend.config import REPO_ROOT
from backend.llm import metering, mock
from backend.store import conversations as store
from tests.llm.conftest import CHAT_URL, MODELS_URL, chunk, citation, sse_body, usage_obj

SCRIPTS = REPO_ROOT / "scripts"
_loaded: dict[str, ModuleType] = {}


def load_script(name: str) -> ModuleType:
    if name not in _loaded:
        path = SCRIPTS / f"{name}.py"
        spec = importlib.util.spec_from_file_location(f"triplex_script_{name}", path)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        _loaded[name] = mod
    return _loaded[name]


@pytest.fixture
def live_smoke():
    return load_script("live_smoke")


@pytest.fixture
def record_fixtures():
    return load_script("record_fixtures")


@pytest.fixture
def env_guard(monkeypatch):
    """The scripts write MOCK_RECORD_DIR / SESSION_COST_CAP_USD into os.environ: register both
    with monkeypatch first so the values are restored after the test."""
    monkeypatch.setenv("MOCK_RECORD_DIR", "")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "10")
    yield


# --------------------------------------------------------------------------- fake OpenRouter
CHAT_TEXT = {
    "anthropic/claude-opus-5": (
        "The BMI088 gyroscope full-scale range is selectable up to 2000 deg/s; the GYRO_RANGE "
        "register (0x0F) selects it."
    ),
    "openai/gpt-5.6-sol": (
        "Its gyroscope tops out at 1000 deg/s full scale; GYRO_RANGE selects the range."
    ),
    "x-ai/grok-4.6": (
        "The gyro supports ranges from 125 up to 2000 deg/s, set in register GYRO_RANGE."
    ),
}
EXTRACTION = {
    "agreements": [
        {
            "topic": "range register",
            "statement": "GYRO_RANGE selects the gyroscope full-scale range.",
            "models": ["R1", "R2", "R3"],
        }
    ],
    "divergences": [
        {
            "id": "d1",
            "topic": "maximum gyroscope full-scale range",
            "positions": [
                {"model": "R1", "claim": "selectable up to 2000 deg/s", "evidence_cited": None},
                {"model": "R2", "claim": "tops out at 1000 deg/s", "evidence_cited": None},
                {"model": "R3", "claim": "125 up to 2000 deg/s", "evidence_cited": None},
            ],
            "materiality": "high",
        }
    ],
}
DEFEND = {
    "stance": "defend",
    "justification": "The datasheet gyroscope table lists 2000 deg/s as the widest range.",
    "revised_claim": None,
    "confidence": 0.9,
    "persuaded_by": None,
}
REVISE = {
    "stance": "revise",
    "justification": (
        "The peers quote the datasheet gyroscope table where the selectable full-scale range "
        "reaches 2000 deg/s; my 1000 deg/s figure was the default after reset, not the maximum."
    ),
    "revised_claim": "selectable up to 2000 deg/s",
    "confidence": 0.8,
    "persuaded_by": "the datasheet table quoted by R1 listing the 2000 deg/s selectable range",
}
DEFENSE = {
    "anthropic/claude-opus-5": DEFEND,
    "openai/gpt-5.6-sol": REVISE,
    "x-ai/grok-4.6": DEFEND,
}
CONVERGENCE = {"statuses": [{"divergence_id": "d1", "status": "resolved"}]}
CITATION_URL = "https://example.com/bmi088-datasheet"


def fake_openrouter(*, cost: float = 0.001, grok_error: bool = False):
    """A respx side_effect that answers every Triplex request shape."""

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        model = payload["model"]
        rf = payload.get("response_format")
        if rf is not None:
            name = rf["json_schema"]["name"]
            doc = {"extraction": EXTRACTION, "convergence": CONVERGENCE}.get(name)
            if doc is None:
                doc = DEFENSE[model]
            text = json.dumps(doc)
        else:
            text = CHAT_TEXT.get(model, "hello")
        if grok_error and model == "x-ai/grok-4.6" and rf is None:
            body = sse_body(
                json.dumps(
                    {
                        "id": "gen-err",
                        "error": {"code": 502, "message": "Provider disconnected"},
                        "choices": [
                            {"index": 0, "delta": {"content": ""}, "finish_reason": "error"}
                        ],
                    }
                )
            )
            return httpx.Response(200, content=body)
        ann = [citation(CITATION_URL, "BMI088 datasheet")] if payload.get("plugins") else None
        payloads = [
            chunk(content=text[:20], model=model, annotations=ann, role=True),
            chunk(content=text[20:], finish="stop", model=model),
            chunk(content="", model=model, usage=usage_obj(cost=cost, reasoning=7)),
        ]
        return httpx.Response(200, content=sse_body(*payloads))

    return handler


@pytest.fixture
def fake_router(live_transport, respx_router):
    """Live transport settings + the fake OpenRouter on the autouse respx router."""
    respx_router.get(MODELS_URL).mock(return_value=httpx.Response(500))  # -> offline fixture
    route = respx_router.post(CHAT_URL).mock(side_effect=fake_openrouter())
    return route


# =========================================================================== live_smoke.py
def test_live_smoke_refuses_without_a_key_in_live_mode(live_smoke, monkeypatch, capsys):
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    assert live_smoke.main([]) == live_smoke.EXIT_REFUSED
    out = capsys.readouterr().out
    assert out.startswith("REFUSED:") and "OPENROUTER_API_KEY" in out
    assert mock.calls == []


def test_live_smoke_refuses_mock_mode_without_allow_mock(live_smoke, capsys):
    assert live_smoke.main([]) == live_smoke.EXIT_REFUSED
    out = capsys.readouterr().out
    assert "MOCK_OPENROUTER=1" in out and "--allow-mock" in out
    assert mock.calls == []


async def test_live_smoke_allow_mock_replays_the_scenario(live_smoke, monkeypatch, capsys):
    """Three slot calls with the configured effort, the analyst extraction with response_format,
    then one grounded call carrying the web plugin (never the slot calls)."""
    monkeypatch.setenv("MOCK_SCENARIO", "grounded")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "10")
    monkeypatch.setenv("MOCK_RECORD_DIR", "")
    args = live_smoke.build_parser().parse_args(["--allow-mock"])
    assert await live_smoke.run(args) == live_smoke.EXIT_OK
    out = capsys.readouterr().out
    assert "mode=MOCK (scenario=grounded" in out
    assert "[claude] model=anthropic/claude-opus-5 effort=medium->medium" in out
    assert "[chatgpt] model=openai/gpt-5.6-sol effort=medium->medium" in out
    assert "[grok] model=x-ai/grok-4.6 effort=medium->medium" in out
    assert "reasoning_tokens=86" in out and "cost=$0.004550" in out
    assert (
        "text: 'The BMI088 datasheet specifies the gyroscope zero-rate offset as +/-1 deg/s typi...'"
        in out
    )
    assert "response_format=json_schema valid=yes agreements=3 divergences=0" in out
    assert "[claude/grounded]" in out and "citations=2" in out
    assert (
        "citation: https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi088-ds001.pdf"
        in out
    )
    assert "enforced=no (mock)" in out and out.rstrip().endswith("all checks passed")

    assert [(c["role"], c["purpose"]) for c in mock.calls] == [
        ("claude", "chat"),
        ("chatgpt", "chat"),
        ("grok", "chat"),
        ("analyst", "extraction"),
        ("claude", "chat"),
    ]
    for c in mock.calls[:3]:
        assert c["plugins"] is None and c["reasoning"] == {"effort": "medium"}
        assert c["max_tokens"] == live_smoke.DEFAULT_MAX_TOKENS
    assert mock.calls[3]["response_format"]["json_schema"]["name"] == "extraction"
    assert mock.calls[3]["max_tokens"] == 4000
    assert mock.calls[4]["plugins"] == [{"id": "web", "max_results": 5}]


async def test_live_smoke_effort_coercion_is_reported(live_smoke, monkeypatch, capsys):
    monkeypatch.setenv("SLOT_GROK_EFFORT", "off")  # mandatory reasoning: coerced to low
    monkeypatch.setenv("SLOT_CLAUDE_EFFORT", "off")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "10")
    args = live_smoke.build_parser().parse_args(["--allow-mock", "--skip-grounded"])
    assert await live_smoke.run(args) == live_smoke.EXIT_OK
    out = capsys.readouterr().out
    assert "[grok] model=x-ai/grok-4.6 effort=off->low (coerced)" in out
    assert "[claude] model=anthropic/claude-opus-5 effort=off->off " in out
    assert "grounded: skipped" in out
    by_role = {c["role"]: c for c in mock.calls}
    assert by_role["grok"]["reasoning"] is None
    assert by_role["claude"]["reasoning"] == {"enabled": False}


async def test_live_smoke_live_path_records_fixtures(
    live_smoke, fake_router, env_guard, tmp_path, capsys
):
    rec = tmp_path / "smoke"
    args = live_smoke.build_parser().parse_args(["--record", str(rec)])
    assert await live_smoke.run(args) == live_smoke.EXIT_OK
    out = capsys.readouterr().out
    assert "mode=LIVE" in out and f"record dir: {rec}" in out
    assert "cost cap in force: $0.50" in out
    assert "[claude] model=anthropic/claude-opus-5 effort=medium->medium tokens=120/40 " in out
    assert "reasoning_tokens=7 cost=$0.001000" in out
    assert "valid=yes agreements=1 divergences=1" in out and "d1 [high]" in out
    assert "[claude/grounded]" in out and "citations=1" in out
    assert f"citation: {CITATION_URL}" in out
    assert "calls=5 cost_sum=$0.005000 session_total=$0.005000 cap=$0.50 enforced=yes" in out
    assert fake_router.call_count == 5
    assert metering.session_cost_usd() == pytest.approx(0.005)

    names = sorted(p.name for p in rec.iterdir())
    assert names == [
        "analyst.extraction.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "claude.chat.1.jsonl",
        "claude.chat.2.jsonl",  # the grounded call
        "grok.chat.1.jsonl",
        "recorded",
        "requests.jsonl",
    ]
    assert len(list((rec / "recorded").glob("*.jsonl"))) == 5
    reqs = [json.loads(ln) for ln in (rec / "requests.jsonl").read_text().splitlines()]
    assert [r["fixture"] for r in reqs] == [
        "claude.chat.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "grok.chat.1.jsonl",
        "analyst.extraction.1.jsonl",
        "claude.chat.2.jsonl",
    ]
    assert reqs[4]["payload"]["plugins"] == [{"id": "web", "max_results": 5}]
    assert all("plugins" not in r["payload"] for r in reqs[:4])
    assert "response_format" in reqs[3]["payload"]
    assert reqs[3]["payload"]["max_tokens"] == 4000


async def test_live_smoke_budget_lowers_the_cap_and_stops_at_the_refusal(
    live_smoke, live_transport, respx_router, env_guard, capsys
):
    respx_router.get(MODELS_URL).mock(return_value=httpx.Response(500))
    route = respx_router.post(CHAT_URL).mock(side_effect=fake_openrouter(cost=0.3))
    args = live_smoke.build_parser().parse_args(["--budget-usd", "0.5"])
    assert await live_smoke.run(args) == live_smoke.EXIT_BUDGET
    out = capsys.readouterr().out
    assert "cost cap in force: $0.50" in out
    assert "[grok] model=x-ai/grok-4.6 effort=medium->medium ERROR code=cost_cap_exceeded" in out
    assert "COST CAP HIT" in out and "SESSION_COST_CAP_USD=$0.50" in out
    assert route.call_count == 2  # claude + chatgpt ran, grok was refused before any request
    assert metering.session_cost_usd() == pytest.approx(0.6)
    assert metering.session_cost_status()["exceeded"] is True


async def test_live_smoke_reports_a_failed_slot(
    live_smoke, live_transport, respx_router, env_guard, capsys
):
    respx_router.get(MODELS_URL).mock(return_value=httpx.Response(500))
    respx_router.post(CHAT_URL).mock(side_effect=fake_openrouter(grok_error=True))
    args = live_smoke.build_parser().parse_args(["--skip-grounded"])
    assert await live_smoke.run(args) == live_smoke.EXIT_FAILED
    out = capsys.readouterr().out
    assert "[grok] model=x-ai/grok-4.6 effort=medium->medium ERROR code=502" in out
    assert "FAILED checks:" in out and "- grok: 502 Provider disconnected" in out


# =========================================================================== record_fixtures.py
def test_record_fixtures_refusals(record_fixtures, monkeypatch, tmp_path, capsys):
    fx = tmp_path / "fx"
    base = ["--scenario", "demo", "--fixtures-dir", str(fx)]
    # mock mode without --allow-mock
    assert record_fixtures.main(base) == record_fixtures.EXIT_REFUSED
    assert "MOCK_OPENROUTER=1" in capsys.readouterr().out
    # live mode without a key
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    assert record_fixtures.main(base) == record_fixtures.EXIT_REFUSED
    assert "OPENROUTER_API_KEY" in capsys.readouterr().out
    # a directory that already holds fixtures (numbering would continue)
    monkeypatch.setenv("MOCK_OPENROUTER", "1")
    target = fx / "scenarios" / "demo"
    target.mkdir(parents=True)
    (target / "claude.chat.1.jsonl").write_text("{}\n")
    assert record_fixtures.main([*base, "--allow-mock"]) == record_fixtures.EXIT_REFUSED
    assert "already holds fixtures" in capsys.readouterr().out
    # bad arguments
    assert (
        record_fixtures.main([*base, "--allow-mock", "--max-iterations", "9"])
        == record_fixtures.EXIT_REFUSED
    )
    assert (
        record_fixtures.main(["--scenario", "../x", "--allow-mock"]) == record_fixtures.EXIT_REFUSED
    )
    assert mock.calls == []
    assert not (fx / "scenarios" / "demo" / "README.md").exists()


async def test_record_fixtures_allow_mock_runs_the_flow_and_writes_only_the_readme(
    record_fixtures, monkeypatch, tmp_path, capsys
):
    monkeypatch.setenv("MOCK_RECORD_DIR", "")
    monkeypatch.setenv("SESSION_COST_CAP_USD", "10")
    fx = tmp_path / "fx"
    args = record_fixtures.build_parser().parse_args(
        ["--scenario", "demo", "--fixtures-dir", str(fx), "--allow-mock", "--max-iterations", "1"]
    )
    assert await record_fixtures.run(args) == record_fixtures.EXIT_OK
    out = capsys.readouterr().out
    assert "mode=MOCK (scenario=planted_factual" in out
    assert "the mock transport never records" in out
    assert "slot_done  claude" in out and "analyze_done status=ok" in out
    assert "R2 on d1: revise" in out and "fusion_done exit=converged" in out
    assert "README.md" in out and "== total cost == turns=$0.012525 over 8 call(s)" in out
    assert f"MOCK_FIXTURES_DIR={fx} MOCK_SCENARIO=demo" in out
    target = fx / "scenarios" / "demo"
    assert [p.name for p in target.iterdir()] == ["README.md"]
    readme = (target / "README.md").read_text()
    assert readme.startswith("# Scenario `demo`")
    assert "R1=claude, R2=chatgpt, R3=grok" in readme
    exp = json.loads(readme.split("```json\n")[-1].split("```")[0])
    assert exp["analyze_status"] == "ok" and exp["exit_reason"] == "converged"
    assert exp["final"] == {"d1": "resolved"} and exp["files"] == {}
    assert [p["phase"] for p in exp["sequence"]] == ["Send", "Analyze", "Fusion round 1", "Exit"]
    assert len(mock.calls) == 8
    # the conversation was created with the fixed anonymization map
    conv = await store.load(out.split("send (conversation ")[1].split(")")[0])
    assert conv is not None and conv.anon_map == store.MOCK_ANON_MAP


async def test_record_fixtures_live_path_records_a_scenario_that_replays(
    record_fixtures, fake_router, env_guard, monkeypatch, tmp_path, capsys
):
    """The whole Stage 4 recording pipeline, offline: live transport (respx) -> tee -> README;
    then the recording replays through the mock transport with identical results."""
    fx = tmp_path / "fx"
    args = record_fixtures.build_parser().parse_args(
        ["--scenario", "demo_live", "--fixtures-dir", str(fx), "--max-iterations", "1"]
    )
    assert await record_fixtures.run(args) == record_fixtures.EXIT_OK
    out = capsys.readouterr().out
    assert "mode=LIVE" in out and "cost cap in force: $2.00" in out
    assert fake_router.call_count == 8
    target = fx / "scenarios" / "demo_live"
    fixtures = [
        "analyst.convergence.1.jsonl",
        "analyst.extraction.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "chatgpt.defense.1.jsonl",
        "claude.chat.1.jsonl",
        "claude.defense.1.jsonl",
        "grok.chat.1.jsonl",
        "grok.defense.1.jsonl",
    ]
    assert sorted(p.name for p in target.iterdir()) == sorted(
        [*fixtures, "README.md", "recorded", "requests.jsonl"]
    )
    assert len(list((target / "recorded").glob("*.jsonl"))) == 8
    for name in fixtures:
        assert f"  {name}  (" in out
    assert "  README.md  (" in out and "  requests.jsonl  (" in out
    assert "== total cost == turns=$0.008000 over 8 call(s); session_total=$0.008000" in out
    assert "enforced=yes" in out

    readme = (target / "README.md").read_text()
    assert readme.startswith("# Scenario `demo_live`")
    assert "from a live OpenRouter session" in readme
    for name in fixtures:
        assert f"| `{name}` |" in readme
    assert (
        "| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 3 chunks |"
        in readme
    )
    assert "| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 3 chunks |" in readme
    assert (
        "| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high; finish_reason stop; 3 chunks |"
        in readme
    )
    assert (
        "| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 3 chunks |"
        in readme
    )
    exp = json.loads(readme.split("```json\n")[-1].split("```")[0])
    assert exp["scenario"] == "demo_live" and exp["prompt"] == record_fixtures.DEFAULT_PROMPT
    assert exp["anon_map"] == {"R1": "claude", "R2": "chatgpt", "R3": "grok"}
    assert exp["analyze_status"] == "ok" and exp["exit_reason"] == "converged"
    assert exp["final"] == {"d1": "resolved"}
    assert sorted(exp["files"]) == fixtures
    assert exp["files"]["claude.chat.1.jsonl"] == {
        "kind": "chat",
        "label": "R1",
        "text": CHAT_TEXT["anthropic/claude-opus-5"],
        "finish_reason": "stop",
    }
    assert exp["files"]["chatgpt.defense.1.jsonl"] == {
        "kind": "defense",
        "label": "R2",
        "divergence": "d1",
        "unjustified": False,
        "stance": "revise",
        "valid": True,
        "finish_reason": "stop",
    }
    assert exp["files"]["analyst.extraction.1.jsonl"]["divergences"] == {"d1": "high"}
    assert exp["files"]["analyst.convergence.1.jsonl"]["statuses"] == {"d1": "resolved"}
    phases = {p["phase"]: p for p in exp["sequence"]}
    assert set(phases["Send"]["files"]) == {
        "claude.chat.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "grok.chat.1.jsonl",
    }
    assert phases["Analyze"]["files"] == ["analyst.extraction.1.jsonl"]
    assert set(phases["Fusion round 1"]["files"]) == {
        "claude.defense.1.jsonl",
        "chatgpt.defense.1.jsonl",
        "grok.defense.1.jsonl",
        "analyst.convergence.1.jsonl",
    }
    assert phases["Fusion round 1"]["files"][-1] == "analyst.convergence.1.jsonl"
    assert phases["Fusion round 1"]["note"] == "R1 defend, R2 revise, R3 defend -> d1 resolved"
    assert phases["Exit"]["note"] == "exit_reason converged"
    listed = [f for p in exp["sequence"] for f in p["files"]]
    assert sorted(listed) == fixtures  # every fixture exactly once

    # ---- replay the recording through the mock transport: same flow, same answers
    monkeypatch.setenv("MOCK_OPENROUTER", "1")
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(fx))
    monkeypatch.setenv("MOCK_SCENARIO", "demo_live")
    monkeypatch.setenv("MOCK_RECORD_DIR", "")
    mock.reset()
    replay = await record_fixtures.run_flow(args)
    conv = replay.conversation
    assert conv is not None
    send = conv["turns"][0]
    assert send["responses"] == {
        "claude": CHAT_TEXT["anthropic/claude-opus-5"],
        "chatgpt": CHAT_TEXT["openai/gpt-5.6-sol"],
        "grok": CHAT_TEXT["x-ai/grok-4.6"],
    }
    assert send["usage"]["totals"]["cost_usd"] == pytest.approx(0.003)
    assert replay.analyze_status == "ok" and replay.exit_reason == "converged"
    assert replay.final == {"d1": "resolved"}
    assert [ex["stance"] for ex in replay.rounds()[0]["exchanges"]] == [
        "defend",
        "revise",
        "defend",
    ]
    # scenario layout (MOCK_FIXTURES_DIR=<fixtures-dir> MOCK_SCENARIO=<name>): the counters
    assert sorted(str(c["fixture"]) for c in mock.calls) == [f"demo_live/{f}" for f in fixtures]
    assert fake_router.call_count == 8  # nothing reached the (fake) network during replay

    # content-keyed layout (MOCK_FIXTURES_DIR=<record dir>): identical requests hit recorded/
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(target))
    monkeypatch.setenv("MOCK_SCENARIO", "does_not_matter")
    mock.reset()
    replay_b = await record_fixtures.run_flow(args)
    assert replay_b.exit_reason == "converged" and replay_b.final == {"d1": "resolved"}
    assert len(mock.calls) == 8
    missed = [
        (c["role"], c["purpose"], c["fixture"])
        for c in mock.calls
        if not str(c["fixture"]).startswith("recorded/")
    ]
    assert not missed, missed
    assert fake_router.call_count == 8
    # ... and under the scenario layout a DIFFERENT request still replays (sticky counters)
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(fx))
    monkeypatch.setenv("MOCK_SCENARIO", "demo_live")
    mock.reset()
    args2 = record_fixtures.build_parser().parse_args(
        [
            "--scenario",
            "x",
            "--fixtures-dir",
            str(fx),
            "--max-iterations",
            "1",
            "--prompt",
            "Other?",
        ]
    )
    replay2 = await record_fixtures.run_flow(args2)
    assert replay2.conversation is not None
    assert replay2.conversation["turns"][0]["responses"]["grok"] == CHAT_TEXT["x-ai/grok-4.6"]
    assert mock.calls[0]["fixture"].startswith("demo_live/")
