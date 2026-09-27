"""`backend.vendors`: the seven-vendor catalog behind the council (2026-09-27), pure."""

from __future__ import annotations

import pytest

from backend import vendors
from backend.config import FORBIDDEN_IDENTITY_STRINGS
from backend.llm import catalog
from backend.llm.bridge_protocol import BRIDGE_SLOTS
from backend.schemas import DEFAULT_COUNCIL, SLOT_IDS, SLOT_VENDORS, ModelMeta


def test_catalog_is_slot_ids_in_order_with_the_classic_three_first():
    assert tuple(v.id for v in vendors.CATALOG) == SLOT_IDS
    assert tuple(vendors.BY_ID) == SLOT_IDS
    assert SLOT_IDS[:3] == DEFAULT_COUNCIL == ("claude", "chatgpt", "grok")


def test_web_sites_are_exactly_the_bridge_slots_and_stage2_sites_have_no_adapter():
    assert vendors.WEB_SITES == BRIDGE_SLOTS == ("claude", "chatgpt", "grok")
    assert vendors.STAGE2_SITES == ("gemini", "deepseek", "qwen")
    assert not vendors.BY_ID["mimo"].web_site and not vendors.BY_ID["mimo"].stage2_site
    for slot in vendors.WEB_SITES:
        assert not vendors.BY_ID[slot].stage2_site


def test_prefixes_agree_with_the_frozen_slot_vendors():
    for slot, org in SLOT_VENDORS.items():
        assert vendors.BY_ID[slot].prefixes[0] == org


def test_display_names_and_identities_are_forbidden_identity_strings():
    """Every name here is exactly what the leak scan forbids in a prompt -- the catalog is data for
    the desktop and the export, never prompt text."""
    forbidden = set(FORBIDDEN_IDENTITY_STRINGS)
    for v in vendors.CATALOG:
        assert vendors.display_name(v.id) == v.name
        assert v.name.lower() in forbidden, v.name
    assert vendors.display_name("qwen") == "Qwen" and vendors.BY_ID["qwen"].identity == "Alibaba"
    assert vendors.BY_ID["mimo"].identity == "Xiaomi"


def test_default_slot_spec_is_a_fresh_supported_spec():
    a, b = vendors.default_slot_spec("deepseek"), vendors.default_slot_spec("deepseek")
    assert a == b and a is not b
    assert a.model == vendors.BY_ID["deepseek"].default_model
    for v in vendors.CATALOG:
        spec = vendors.default_slot_spec(v.id)
        assert vendors.vendor_of_model(spec.model) is v
        meta = catalog.get_meta(spec.model)
        if meta is not None:  # the offline fixture knows it: the default effort must be allowed
            assert spec.effort in meta.efforts, (v.id, spec.model, meta.efforts)


@pytest.mark.parametrize(
    "model,expected",
    [
        ("web:claude", "claude"),
        ("web:chatgpt:analyst", "chatgpt"),
        ("web:gemini", "gemini"),  # a vendor without an adapter is still a vendor
        ("web:bing", None),
        ("ollama:qwen3:8b", "qwen"),
        ("ollama:deepseek-r1:14b", "deepseek"),
        ("ollama:hermes3", None),
        ("anthropic/claude-opus-5", "claude"),
        ("openai/gpt-5.6-sol", "chatgpt"),
        ("x-ai/grok-4.6", "grok"),
        ("google/gemini-3.8-flash", "gemini"),
        ("deepseek/deepseek-v4-pro", "deepseek"),
        ("qwen/qwen3.7-max", "qwen"),
        ("xiaomi/mimo-v2.6-pro", "mimo"),
        ("huihui-ai/qwen3-abliterated", "qwen"),  # a community "uncensored" variant, by family word
        ("cognitivecomputations/dolphin-deepseek-r1", "deepseek"),
        ("someorg/mimo-uncensored", "mimo"),
        ("mistralai/mistral-large-2512", None),  # the negative control
        ("nousresearch/hermes-4-405b", None),
        ("chatgpt-clone/model", None),  # "gpt" inside "chatgpt" is not a word start
        ("", None),
    ],
)
def test_vendor_of_model(model, expected):
    v = vendors.vendor_of_model(model)
    assert (v.id if v is not None else None) == expected


def test_vendor_of_model_falls_back_to_the_display_name():
    assert vendors.vendor_of_model("someorg/uncensored-24b", "Someorg: Qwen3 Uncensored").id == "qwen"
    assert vendors.vendor_of_model("someorg/uncensored-24b", "Venice: Uncensored") is None
    assert vendors.vendor_of_model(None) is None  # type: ignore[arg-type]


def _meta(model_id: str, name: str = "") -> ModelMeta:
    return ModelMeta(id=model_id, name=name)


def test_openrouter_filter_keeps_input_order_and_objects():
    ms = [
        _meta("mistralai/mistral-large-2512"),
        _meta("qwen/qwen3.7-max"),
        _meta("google/gemini-3.8-flash"),
        _meta("nousresearch/hermes-4-405b", "Nous: Hermes 4"),
    ]
    kept = vendors.openrouter_filter(ms)
    assert [m.id for m in kept] == ["qwen/qwen3.7-max", "google/gemini-3.8-flash"]
    assert kept[0] is ms[1] and kept[1] is ms[2]


def test_offline_fixture_carries_every_council_vendor_and_the_negative_control():
    ids = {m.id for m in catalog.load_offline()}
    for v in vendors.CATALOG:
        assert v.default_model in ids, v.default_model
    assert "mistralai/mistral-large-2512" in ids
    by_vendor = vendors.vendors_of(catalog.load_offline())
    assert tuple(by_vendor) == SLOT_IDS  # every vendor represented, catalog order
    assert "mistralai/mistral-large-2512" not in {m.id for ms in by_vendor.values() for m in ms}
