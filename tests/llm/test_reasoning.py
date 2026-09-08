"""reasoning.build: the full table from docs/semantics.md "Effort" + the contract addendum."""

from __future__ import annotations

import pytest

from backend.llm import catalog
from backend.llm.reasoning import build
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
