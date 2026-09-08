"""anon.labels / label_of / slot_of: read the persisted permutation, never re-derive it."""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest

from backend import anon
from backend.config import DEFAULT_SLOT_CONFIG
from backend.schemas import LABELS, SLOT_IDS, Conversation, empty_threads, new_anon_map


def _unchecked(anon_map: object) -> Conversation:
    """A Conversation carrying an arbitrary anon_map, bypassing pydantic validation."""
    return Conversation.model_construct(
        slot_config=DEFAULT_SLOT_CONFIG.model_copy(deep=True),
        threads=empty_threads(),
        anon_map=anon_map,
    )


def test_labels_returns_the_persisted_map_in_label_order(make_conversation, anon_map):
    conv = make_conversation()
    got = anon.labels(conv)
    assert got == anon_map
    assert list(got) == list(LABELS)


def test_labels_returns_a_fresh_dict(make_conversation):
    conv = make_conversation()
    got = anon.labels(conv)
    got["R1"] = "grok"
    assert conv.anon_map["R1"] == "claude"
    assert anon.labels(conv)["R1"] == "claude"


def test_label_of_and_slot_of_on_the_mock_map(make_conversation):
    conv = make_conversation()
    assert anon.label_of(conv, "claude") == "R1"
    assert anon.label_of(conv, "chatgpt") == "R2"
    assert anon.label_of(conv, "grok") == "R3"
    assert anon.slot_of(conv, "R1") == "claude"
    assert anon.slot_of(conv, "R2") == "chatgpt"
    assert anon.slot_of(conv, "R3") == "grok"


@pytest.mark.parametrize("seed", range(12))
def test_random_permutations_round_trip(make_conversation, seed):
    mapping = new_anon_map(random.Random(seed))
    conv = make_conversation(anon=mapping)
    assert anon.labels(conv) == mapping
    for label in LABELS:
        assert anon.label_of(conv, anon.slot_of(conv, label)) == label
    for slot in SLOT_IDS:
        assert anon.slot_of(conv, anon.label_of(conv, slot)) == slot


def test_mapping_is_read_from_the_document_not_from_position(make_conversation):
    """Two conversations with different maps give different answers for the same slot."""
    a = make_conversation(anon={"R1": "claude", "R2": "chatgpt", "R3": "grok"})
    b = make_conversation(anon={"R1": "grok", "R2": "claude", "R3": "chatgpt"})
    assert anon.label_of(a, "claude") == "R1" and anon.label_of(b, "claude") == "R2"
    assert anon.slot_of(a, "R1") == "claude" and anon.slot_of(b, "R1") == "grok"


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({"R1": "claude", "R2": "claude", "R3": "grok"}, id="duplicate-slot"),
        pytest.param({"R1": "claude", "R2": "chatgpt"}, id="missing-label"),
        pytest.param(
            {"R1": "claude", "R2": "chatgpt", "R3": "grok", "R4": "claude"}, id="extra-label"
        ),
        pytest.param({"R1": "claude", "R2": "chatgpt", "R3": "gemini"}, id="unknown-slot"),
        pytest.param({"R1": "claude", "R2": "chatgpt", "R9": "grok"}, id="unknown-label"),
        pytest.param({"claude": "R1", "chatgpt": "R2", "grok": "R3"}, id="inverted"),
        pytest.param({}, id="empty"),
        pytest.param(None, id="none"),
        pytest.param(["claude", "chatgpt", "grok"], id="not-a-dict"),
    ],
)
def test_labels_rejects_non_permutations(bad):
    conv = _unchecked(bad)
    with pytest.raises(ValueError):
        anon.labels(conv)
    with pytest.raises(ValueError):
        anon.label_of(conv, "claude")
    with pytest.raises(ValueError):
        anon.slot_of(conv, "R1")


def test_pydantic_valid_but_non_permutation_map_is_still_rejected():
    """Conversation only checks the literals; a duplicate slot passes pydantic but not anon."""
    conv = Conversation(
        slot_config=DEFAULT_SLOT_CONFIG.model_copy(deep=True),
        threads=empty_threads(),
        anon_map={"R1": "grok", "R2": "grok", "R3": "grok"},
    )
    with pytest.raises(ValueError):
        anon.labels(conv)


def test_labels_rejects_an_absent_map():
    without = Conversation.model_construct(
        slot_config=DEFAULT_SLOT_CONFIG.model_copy(deep=True), threads=empty_threads()
    )
    with pytest.raises(ValueError):
        anon.labels(without)
    with pytest.raises(ValueError):
        anon.labels(SimpleNamespace())
    with pytest.raises(ValueError):
        anon.labels(SimpleNamespace(anon_map=None))


def test_unknown_slot_or_label_lookups_raise(make_conversation):
    conv = make_conversation()
    with pytest.raises(ValueError):
        anon.label_of(conv, "gemini")
    with pytest.raises(ValueError):
        anon.slot_of(conv, "R4")
    with pytest.raises(ValueError):
        anon.slot_of(conv, "claude")  # a slot id is not a label
