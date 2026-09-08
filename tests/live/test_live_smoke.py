"""Live smoke checks against OpenRouter (PLAN.md Stage 4). Manual: `uv run pytest -m live`.

Every check is cheap (short prompts, small max_tokens) and the whole module is budgeted:
the last test asserts the cumulative live cost stayed under `LIVE_BUDGET_USD` (0.50). Nothing
here runs in the default suite (deselected by `-m 'not live'`) and the directory is skipped
without `OPENROUTER_API_KEY`.

Checks: catalog fetch works; each slot answers with its configured model/effort with
`usage.cost` present; reasoning_tokens > 0 at effort high; `off` is honoured where the catalog
allows it; a mandatory-reasoning model (grok) is coerced; the analyst returns schema-valid JSON
via response_format; a grounded question returns >= 1 citation; the cost cap refuses at
`SESSION_COST_CAP_USD=0`.
"""

from __future__ import annotations

import pytest

from backend.config import ANALYST_EFFORT, MAX_TOKENS_STAGE, settings
from backend.llm import catalog, metering
from backend.llm import client as llm_client
from backend.llm import reasoning as reasoning_mod
from backend.prompts import analyze as analyze_prompts
from backend.prompts.send import web_plugins
from backend.schemas import Delta, Extraction, Label, SlotSpec
from tests.live.conftest import LIVE_BUDGET_USD

pytestmark = pytest.mark.live

SHORT_PROMPT = "In one short sentence: what does an inertial measurement unit measure?"
THINK_PROMPT = (
    "How many times does the digit 7 appear when writing every integer from 1 to 100 "
    "inclusive? Reply with the number only."
)
GROUNDED_PROMPT = (
    "What is the latest stable Linux kernel release as of today? One sentence, cite the source."
)
CANNED_QUESTION = "What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?"
CANNED_ANSWERS: dict[Label, str] = {
    "R1": "The BMI088 gyroscope full-scale range is selectable up to 2000 deg/s.",
    "R2": "Its gyroscope tops out at 1000 deg/s full scale.",
    "R3": "The gyro supports ranges from 125 up to 2000 deg/s.",
}


async def _chat(
    role: str, spec: SlotSpec, prompt: str, *, max_tokens: int, plugins=None
) -> tuple[str, list[Delta], Delta]:
    text = ""
    deltas: list[Delta] = []
    terminal: Delta | None = None
    async for d in llm_client.stream_completion(
        role=role,
        purpose="chat",
        model=spec.model,
        messages=[{"role": "user", "content": prompt}],
        effort=spec.effort,
        max_tokens=max_tokens,
        plugins=plugins,
    ):
        deltas.append(d)
        if d.kind == "text":
            text += d.text
        elif d.kind in ("done", "error"):
            terminal = d
    assert terminal is not None, "stream_completion ended without a terminal delta"
    return text, deltas, terminal


def _slots() -> dict[str, SlotSpec]:
    return dict(settings().default_slot_config.slots)


def _within_budget(live_budget) -> None:
    spent = live_budget()
    assert spent < LIVE_BUDGET_USD, f"live budget exceeded: ${spent:.4f} >= ${LIVE_BUDGET_USD}"


# --------------------------------------------------------------------------- catalog
async def test_catalog_fetch_works(live_budget):
    models = await catalog.get_catalog(force_refresh=True)
    assert len(models) > 50 and catalog.cache_source() == "network"
    ids = {m.id for m in models}
    cfg = settings().default_slot_config
    for slot, spec in cfg.slots.items():
        assert spec.model in ids, f"{slot}: configured model {spec.model} is not on OpenRouter"
        meta = catalog.get_meta(spec.model)
        assert meta is not None and meta.price_completion is not None
    assert cfg.analyst_model in ids
    _within_budget(live_budget)


# --------------------------------------------------------------------------- slots
async def test_each_slot_answers_with_its_configured_model_and_effort(live_budget):
    for slot, spec in _slots().items():
        _param, applied, coerced = reasoning_mod.build(spec.effort, catalog.get_meta(spec.model))
        text, _deltas, done = await _chat(slot, spec, SHORT_PROMPT, max_tokens=200)
        assert done.kind == "done", f"{slot}: {done.code} {done.message}"
        assert text.strip(), f"{slot}: empty reply"
        u = done.usage
        assert u is not None and u.model == spec.model and u.role == slot
        assert u.cost_usd > 0, f"{slot}: usage.cost missing"  # usage.cost present
        assert u.prompt_tokens > 0 and u.completion_tokens > 0 and u.latency_ms > 0
        assert u.generation_id, f"{slot}: no generation id"
        assert not isinstance(u, metering.EstimatedUsage), f"{slot}: no usage chunk arrived"
        print(
            f"{slot}: {spec.model} effort={spec.effort}->{applied}{' (coerced)' if coerced else ''} "
            f"cost=${u.cost_usd:.6f} reasoning_tokens={u.reasoning_tokens}"
        )
    _within_budget(live_budget)


async def test_reasoning_tokens_are_reported_at_effort_high(live_budget):
    for slot, spec in _slots().items():
        high = SlotSpec(model=spec.model, effort="high")
        meta = catalog.get_meta(spec.model)
        assert meta is not None and "high" in meta.efforts, f"{slot}: {spec.model} lacks high"
        _text, _deltas, done = await _chat(slot, high, THINK_PROMPT, max_tokens=1500)
        assert done.kind == "done", f"{slot}: {done.code} {done.message}"
        assert done.usage is not None
        assert done.usage.reasoning_tokens > 0, f"{slot}: no reasoning tokens at effort high"
    _within_budget(live_budget)


async def test_effort_off_is_honoured_where_the_catalog_allows_it(live_budget):
    candidates = {
        s: spec
        for s, spec in _slots().items()
        if (m := catalog.get_meta(spec.model)) is not None and "off" in m.efforts
    }
    if not candidates:
        pytest.skip("no configured slot model allows reasoning off")
    slot, spec = next(iter(candidates.items()))
    off = SlotSpec(model=spec.model, effort="off")
    param, applied, coerced = reasoning_mod.build("off", catalog.get_meta(spec.model))
    assert param == {"enabled": False} and applied == "off" and coerced is False
    _text, deltas, done = await _chat(slot, off, SHORT_PROMPT, max_tokens=200)
    assert done.kind == "done", f"{slot}: {done.code} {done.message}"
    assert done.usage is not None and done.usage.reasoning_tokens == 0
    assert not [d for d in deltas if d.kind == "reasoning"]
    _within_budget(live_budget)


async def test_mandatory_reasoning_model_is_coerced_not_rejected(live_budget):
    spec = _slots()["grok"]
    meta = catalog.get_meta(spec.model)
    if meta is None or not meta.mandatory_reasoning:
        pytest.skip(f"{spec.model} does not declare mandatory reasoning")
    param, applied, coerced = reasoning_mod.build("off", meta)
    assert param is None and coerced is True and applied in ("low", "medium", "high")
    _text, _deltas, done = await _chat(
        "grok", SlotSpec(model=spec.model, effort="off"), SHORT_PROMPT, max_tokens=200
    )
    assert done.kind == "done", f"grok: {done.code} {done.message}"  # provider default ran
    assert done.usage is not None and done.usage.model == spec.model
    _within_budget(live_budget)


# --------------------------------------------------------------------------- analyst
async def test_analyst_returns_schema_valid_json_via_response_format(live_budget):
    cfg = settings().default_slot_config
    meta = catalog.get_meta(cfg.analyst_model)
    assert meta is not None and meta.structured_outputs, (
        "analyst model must list structured_outputs"
    )
    parsed, raw, usage, error = await llm_client.complete_json(
        role="analyst",
        purpose="extraction",
        model=cfg.analyst_model,
        messages=analyze_prompts.build_messages(CANNED_QUESTION, CANNED_ANSWERS),
        schema_model=Extraction,
        effort=ANALYST_EFFORT,
        max_tokens=MAX_TOKENS_STAGE["extraction"],
        retries=0,  # the FIRST attempt must already be schema-valid
    )
    assert error is None, f"analyst: {error}\nraw: {raw[:300]}"
    assert isinstance(parsed, Extraction) and usage.totals.calls == 1
    assert parsed.divergences, "the planted 1000 vs 2000 deg/s disagreement was not extracted"
    assert usage.totals.cost_usd > 0
    _within_budget(live_budget)


# --------------------------------------------------------------------------- grounded
async def test_grounded_question_returns_at_least_one_citation(live_budget):
    slots = _slots()
    plugins = web_plugins(True, settings())
    assert plugins and plugins[0]["id"] == "web"
    urls: list[str] = []
    for slot in ("claude", "chatgpt"):  # the first slot that cites wins; the second is a fallback
        _text, deltas, done = await _chat(
            slot, slots[slot], GROUNDED_PROMPT, max_tokens=600, plugins=plugins
        )
        assert done.kind == "done", f"{slot}: {done.code} {done.message}"
        for d in deltas:
            if d.kind == "citations":
                urls += [i["url_citation"]["url"] for i in d.items if "url_citation" in i]
        if urls:
            break
    assert urls, "grounded call returned no url_citation annotation"
    assert len(urls) == len(set(urls))  # de-duplicated by URL
    _within_budget(live_budget)


# --------------------------------------------------------------------------- cost cap
async def test_cost_cap_refuses_at_zero(monkeypatch, live_budget):
    monkeypatch.setenv("SESSION_COST_CAP_USD", "0")
    spec = _slots()["claude"]
    before = metering.session_cost_usd()
    _text, deltas, done = await _chat("claude", spec, SHORT_PROMPT, max_tokens=50)
    assert [d.kind for d in deltas] == ["error"]
    assert done.code == "cost_cap_exceeded" and done.error_type == "triplex"
    assert done.usage is None and metering.session_cost_usd() == before
    assert metering.session_cost_status()["exceeded"] is True
    _within_budget(live_budget)


# --------------------------------------------------------------------------- budget (keep last)
async def test_total_live_cost_is_within_budget(live_budget):
    spent = live_budget()
    print(f"live smoke total: ${spent:.4f} (budget ${LIVE_BUDGET_USD})")
    assert spent < LIVE_BUDGET_USD
