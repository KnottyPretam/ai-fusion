"""`anon.labels` over a council of 2..5 and Fusion's label filtering (2026-09-27)."""

from __future__ import annotations

import random

import pytest

from backend import anon
from backend.features.fusion import labels_with_position
from backend.schemas import (
    LABELS,
    Conversation,
    Divergence,
    Position,
    SlotConfig,
    SlotSpec,
    council_of,
    empty_threads,
    new_anon_map,
)


def _cfg(*slots: str) -> SlotConfig:
    return SlotConfig(
        slots={s: SlotSpec(model=f"vendor/{s}", effort="medium") for s in slots},
        analyst_model="openai/gpt-5.6-luna",
    )


def _conv(cfg: SlotConfig, anon_map: dict) -> Conversation:
    return Conversation(slot_config=cfg, threads=empty_threads(council_of(cfg)), anon_map=anon_map)


PAIR = _cfg("qwen", "chatgpt")  # dict order is not council order
FIVE = _cfg("claude", "chatgpt", "grok", "gemini", "deepseek")


def test_labels_over_a_pair_in_label_order():
    conv = _conv(PAIR, {"R2": "chatgpt", "R1": "qwen"})
    assert anon.labels(conv) == {"R1": "qwen", "R2": "chatgpt"}
    assert list(anon.labels(conv)) == ["R1", "R2"]
    assert anon.label_of(conv, "chatgpt") == "R2" and anon.slot_of(conv, "R1") == "qwen"
    with pytest.raises(ValueError, match="unknown label"):
        anon.slot_of(conv, "R3")
    with pytest.raises(ValueError, match="unknown slot"):
        anon.label_of(conv, "grok")  # a catalog vendor this council did not seat


@pytest.mark.parametrize("seed", range(20))
def test_labels_over_a_five_is_the_persisted_permutation(seed):
    amap = new_anon_map(random.Random(seed), council_of(FIVE))
    conv = _conv(FIVE, amap)
    assert anon.labels(conv) == amap and tuple(anon.labels(conv)) == LABELS
    for label, slot in amap.items():
        assert anon.label_of(conv, slot) == label and anon.slot_of(conv, label) == slot


@pytest.mark.parametrize(
    "bad",
    [
        {"R1": "claude", "R2": "chatgpt", "R3": "grok"},  # the three, on a pair
        {"R1": "qwen"},
        {"R1": "qwen", "R2": "qwen"},
        {"R1": "qwen", "R3": "chatgpt"},
        {"R1": "qwen", "R2": "bing"},  # not a vendor at all
        {"R1": "qwen", "R2": "chatgpt", "R3": "grok"},  # one more than the council
        {},
    ],
)
def test_a_map_that_is_not_a_permutation_of_the_council_is_refused(bad):
    conv = _conv(PAIR, {"R1": "qwen", "R2": "chatgpt"})
    conv.anon_map = bad
    with pytest.raises(ValueError):
        anon.labels(conv)


def test_the_three_still_reads_as_before(make_conversation):
    conv = make_conversation()
    assert anon.labels(conv) == {"R1": "claude", "R2": "chatgpt", "R3": "grok"}


# --------------------------------------------------------------------------- fusion filtering
def _div(*labels: str) -> Divergence:
    return Divergence(
        id="d1",
        topic="t",
        materiality="high",
        positions=[Position(model=label, claim=f"claim {label}") for label in labels],
    )


def test_labels_with_position_filters_to_the_council():
    div = _div("R2", "R1", "R4", "R2", "R5")
    assert labels_with_position(div) == ["R2", "R1", "R4", "R5"]  # unfiltered: as before
    assert labels_with_position(div, ("R1", "R2")) == ["R2", "R1"]
    assert labels_with_position(div, ("R1", "R2", "R3")) == ["R2", "R1"]
    assert labels_with_position(div, LABELS) == ["R2", "R1", "R4", "R5"]
    assert labels_with_position(_div("R3"), ("R1", "R2")) == []
