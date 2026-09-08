"""metering helpers: Usage from a usage chunk, price fallback, aggregation, log line."""

from __future__ import annotations

import pytest

from backend.llm import metering
from backend.schemas import Usage


def test_usage_from_chunk_maps_every_field():
    u = metering.usage_from_chunk(
        {
            "prompt_tokens": 194,
            "completion_tokens": 2,
            "completion_tokens_details": {"reasoning_tokens": 1},
            "cost": 0.95,
        },
        model="m",
        role="claude",
        purpose="chat",
        latency_ms=12,
        generation_id="gen-1",
    )
    assert u == Usage(
        prompt_tokens=194,
        completion_tokens=2,
        reasoning_tokens=1,
        cost_usd=0.95,
        latency_ms=12,
        model="m",
        role="claude",
        purpose="chat",
        generation_id="gen-1",
    )


def test_usage_from_chunk_missing_cost_uses_catalog_price():
    u = metering.usage_from_chunk(
        {"prompt_tokens": 1000, "completion_tokens": 100}, model="anthropic/claude-opus-5"
    )
    assert u.cost_usd == pytest.approx(1000 * 5e-6 + 100 * 25e-6)
    unknown = metering.usage_from_chunk({"prompt_tokens": 10}, model="nobody/x")
    assert unknown.cost_usd == 0.0 and unknown.reasoning_tokens == 0


def test_usage_from_chunk_is_defensive():
    u = metering.usage_from_chunk(
        {"prompt_tokens": "x", "completion_tokens_details": "nope", "cost": "bad"}, model="nobody/x"
    )
    assert (u.prompt_tokens, u.completion_tokens, u.reasoning_tokens, u.cost_usd) == (0, 0, 0, 0.0)
    assert metering.usage_from_chunk(None, model="m").prompt_tokens == 0


def test_estimate_usage_and_price_fallback():
    u = metering.estimate_usage(
        model="openai/gpt-5.6-luna", completion_text="a" * 400, prompt_text="b" * 80
    )
    assert (u.prompt_tokens, u.completion_tokens) == (20, 100)
    assert u.cost_usd == pytest.approx(20 * 0.2e-6 + 100 * 1.2e-6)
    assert metering.estimate_tokens("") == 0
    assert metering.price_fallback("nobody/x", 5, 5) == 0.0


def test_aggregate_and_session_cost():
    a = Usage(prompt_tokens=1, completion_tokens=2, cost_usd=0.1, model="m", role="r", purpose="p")
    b = Usage(prompt_tokens=3, completion_tokens=4, cost_usd=0.2, model="m", role="r", purpose="p")
    fu = metering.aggregate([a, b], wall_clock_ms=99)
    assert fu.totals.calls == 2 and fu.totals.prompt_tokens == 4
    assert fu.totals.cost_usd == pytest.approx(0.3) and fu.totals.latency_ms == 99
    metering.reset_session_cost()
    assert metering.session_cost_usd() == 0.0
    metering.add_session_cost(0.25)
    metering.add_session_cost(-1)  # never decreases
    assert metering.session_cost_usd() == pytest.approx(0.25)


def test_format_log_line_is_feature_agnostic():
    u = Usage(
        prompt_tokens=10,
        completion_tokens=20,
        reasoning_tokens=5,
        cost_usd=0.001234,
        latency_ms=321,
        model="x-ai/grok-4.6",
        role="grok",
        purpose="defense",
        generation_id="gen-9",
    )
    line = metering.format_log_line(u)
    for needle in (
        "role=grok",
        "purpose=defense",
        "model=x-ai/grok-4.6",
        "prompt_tokens=10",
        "completion_tokens=20",
        "reasoning_tokens=5",
        "cost_usd=0.001234",
        "latency_ms=321",
        "generation_id=gen-9",
    ):
        assert needle in line
    assert "feature=" not in line
    assert "estimated" in metering.format_log_line(u, estimated=True)


def test_estimate_usage_is_marked_estimated_and_serialises_like_usage():
    u = metering.estimate_usage(model="anthropic/claude-opus-5", completion_text="a" * 40)
    assert isinstance(u, metering.EstimatedUsage) and isinstance(u, Usage)
    assert u.model_dump() == Usage(**u.model_dump()).model_dump()
    real = metering.usage_from_chunk({"cost": 0.1}, model="m")
    assert not isinstance(real, metering.EstimatedUsage)


def test_float_or_none():
    assert metering.float_or_none(None) is None
    assert metering.float_or_none("0.5") == 0.5 and metering.float_or_none(2) == 2.0
    assert metering.float_or_none("n/a") is None and metering.float_or_none([]) is None
