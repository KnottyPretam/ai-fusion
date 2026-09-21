"""reasoning.build: the full table from docs/semantics.md "Effort" + the contract addendum."""

from __future__ import annotations

import pytest

from backend.llm import catalog
from backend.llm.reasoning import REASONING_TOKEN_ALLOWANCE, build, token_budget
from backend.schemas import ModelMeta

OPTIONAL = ModelMeta(id="v/optional", efforts=["off", "low", "medium", "high"])
MANDATORY = ModelMeta(id="v/mandatory", efforts=["low", "medium", "high"], mandatory_reasoning=True)
HIGH_ONLY = ModelMeta(id="v/high-only", efforts=["high"], mandatory_reasoning=True)
MED_HIGH = ModelMeta(id="v/med-high", efforts=["medium", "high"], mandatory_reasoning=True)
OFF_HIGH = ModelMeta(id="v/off-high", efforts=["off", "high"])
NO_REASONING = ModelMeta(id="v/plain", efforts=["off"])  # no reasoning block at all


@pytest.mark.parametrize(
    "effort,meta,expected",
    [
        # build(None, meta) -> (None, "off", False)
        (None, None, (None, "off", False)),
        (None, OPTIONAL, (None, "off", False)),
        (None, MANDATORY, (None, "off", False)),
        # unknown model: as configured, never coerced
        ("off", None, ({"enabled": False}, "off", False)),
        ("low", None, ({"effort": "low"}, "low", False)),
        ("medium", None, ({"effort": "medium"}, "medium", False)),
        ("high", None, ({"effort": "high"}, "high", False)),
        # optional reasoning: everything supported
        ("off", OPTIONAL, ({"enabled": False}, "off", False)),
        ("low", OPTIONAL, ({"effort": "low"}, "low", False)),
        ("medium", OPTIONAL, ({"effort": "medium"}, "medium", False)),
        ("high", OPTIONAL, ({"effort": "high"}, "high", False)),
        # mandatory: off -> omitted, applied = lowest, coerced
        ("off", MANDATORY, (None, "low", True)),
        ("low", MANDATORY, ({"effort": "low"}, "low", False)),
        ("high", MANDATORY, ({"effort": "high"}, "high", False)),
        # nothing lower supported -> lowest supported, coerced
        ("off", HIGH_ONLY, (None, "high", True)),
        ("low", HIGH_ONLY, ({"effort": "high"}, "high", True)),
        ("medium", HIGH_ONLY, ({"effort": "high"}, "high", True)),
        ("high", HIGH_ONLY, ({"effort": "high"}, "high", False)),
        ("low", MED_HIGH, ({"effort": "medium"}, "medium", True)),
        ("off", MED_HIGH, (None, "medium", True)),
        # nearest LOWER supported effort
        ("medium", OFF_HIGH, ({"enabled": False}, "off", True)),
        ("low", OFF_HIGH, ({"enabled": False}, "off", True)),
        ("high", OFF_HIGH, ({"effort": "high"}, "high", False)),
        # no reasoning block: off is omitted (not {"enabled": false}); efforts coerce to off
        ("off", NO_REASONING, (None, "off", False)),
        ("medium", NO_REASONING, (None, "off", True)),
        ("high", NO_REASONING, (None, "off", True)),
    ],
)
def test_build_table(effort, meta, expected):
    assert build(effort, meta) == expected


def test_never_raises_on_garbage():
    assert build("bogus", OPTIONAL) == (None, "off", False)  # type: ignore[arg-type]
    assert build("off", ModelMeta(id="v/empty", efforts=[])) == (None, "off", False)
    assert build("high", ModelMeta(id="v/empty", efforts=[])) == ({"effort": "high"}, "high", False)
    weird = ModelMeta(id="v/weird", efforts=[], mandatory_reasoning=True)
    assert build("off", weird) == (None, "off", True)


def test_raw_reasoning_block_counts_as_reasoning_meta():
    """A ModelMeta whose efforts collapsed to ["off"] but whose raw entry carries a reasoning
    block still gets {"enabled": false} for off."""
    meta = ModelMeta(id="v/raw", efforts=["off"], raw={"reasoning": {"mandatory": False}})
    assert build("off", meta) == ({"enabled": False}, "off", False)


def test_fixture_models_end_to_end():
    """The decisions.md slugs through the real catalog fixture."""
    opus = catalog.get_meta("anthropic/claude-opus-5")
    grok = catalog.get_meta("x-ai/grok-4.6")
    fable = catalog.get_meta("anthropic/claude-fable-5.1")
    astra = catalog.get_meta("openai/gpt-6-astra")
    grok43 = catalog.get_meta("x-ai/grok-4.3")
    plain = catalog.get_meta("openai/gpt-chat-latest")
    assert build("off", opus) == ({"enabled": False}, "off", False)
    assert build("high", opus) == ({"effort": "high"}, "high", False)
    assert build("off", grok) == (None, "low", True)
    assert build("medium", grok) == ({"effort": "medium"}, "medium", False)
    assert build("off", fable) == (None, "low", True)
    assert build("off", astra) == (None, "low", True)
    assert build("off", grok43) == ({"enabled": False}, "off", False)
    assert build("off", plain) == (None, "off", False)
    assert build("high", plain) == (None, "off", True)


# --------------------------------------------------------------------------- token budgets
# Reasoning tokens are billed AND counted as completion tokens, so they come out of `max_tokens`.
# Measured 2026-09-20: a reasoning analyst spent 4,615 of a 4,000-token extraction budget on thinking
# and the JSON was cut off, reported to the user as `parse_error: no JSON object found in the
# response` -- the same message a mid-reply capture gives, from an unrelated cause.
def _reasoning_meta(**over) -> ModelMeta:
    base = {
        "id": "vendor/reasoner",
        "efforts": ["off", "low", "medium", "high"],
        "structured_outputs": True,
    }
    return ModelMeta(**{**base, **over})


def test_a_non_reasoning_model_gets_the_base_budget_unchanged():
    plain = ModelMeta(id="vendor/plain", efforts=["off"])
    assert token_budget(4000, plain, "medium") == 4000
    assert token_budget(4000, plain, "off") == 4000
    assert token_budget(4000, plain, None) == 4000


def test_asking_a_reasoning_model_for_off_still_gets_the_base_budget():
    assert token_budget(4000, _reasoning_meta(), "off") == 4000


def test_a_reasoning_model_gets_room_for_its_thinking():
    assert token_budget(4000, _reasoning_meta(), "medium") == 4000 + REASONING_TOKEN_ALLOWANCE
    assert REASONING_TOKEN_ALLOWANCE > 4650, "over the largest reasoning spend measured live"


def test_an_unknown_model_is_trusted_as_configured():
    # build() sends an unknown model exactly as configured, so a non-off effort reasons.
    assert token_budget(4000, None, "medium") == 4000 + REASONING_TOKEN_ALLOWANCE
    assert token_budget(4000, None, "off") == 4000


def test_the_budget_is_clamped_to_the_provider_ceiling_but_never_below_the_base():
    capped = _reasoning_meta(raw={"top_provider": {"max_completion_tokens": 5000}})
    assert token_budget(4000, capped, "medium") == 5000  # not 12000: the provider would refuse it
    tiny = _reasoning_meta(raw={"top_provider": {"max_completion_tokens": 100}})
    assert token_budget(4000, tiny, "medium") == 4000  # a raised budget never shrinks the base
    unknown = _reasoning_meta(raw={"top_provider": {}})
    assert token_budget(4000, unknown, "medium") == 4000 + REASONING_TOKEN_ALLOWANCE


def test_token_budget_never_raises_on_garbage():
    for bad in (None, "nonsense", 0, {}):
        assert token_budget(4000, _reasoning_meta(raw={"top_provider": bad}), "medium") > 0
