"""catalog: offline fixture mapping, get_meta, and the live fetch / disk cache / TTL path."""

from __future__ import annotations

import json
import time

import httpx
import pytest

from backend.config import DEFAULT_SLOT_CONFIG, settings
from backend.llm import catalog
from backend.schemas import SLOT_VENDORS, ModelMeta
from tests.llm.conftest import MODELS_URL

DECISION_SLUGS = {
    "anthropic/claude-opus-5",
    "openai/gpt-5.6-sol",
    "x-ai/grok-4.6",
    "openai/gpt-5.6-luna",
    "anthropic/claude-fable-5.1",
    "openai/gpt-6-astra",
    "anthropic/claude-sonnet-5",
    "x-ai/grok-4.3",
}


async def test_mock_mode_serves_the_offline_fixture_without_network():
    models = await catalog.get_catalog()
    ids = {m.id for m in models}
    assert DECISION_SLUGS <= ids
    assert len(ids) == len(models)  # distinct slugs
    assert catalog.cache_source() == "fixture"
    assert all(isinstance(m, ModelMeta) for m in models)


def test_fixture_mapping_vendors_efforts_structured_outputs_prices():
    opus = catalog.get_meta("anthropic/claude-opus-5")
    assert opus is not None
    assert opus.vendor == "anthropic" and opus.name == "Anthropic: Claude Opus 5"
    assert opus.efforts == ["off", "low", "medium", "high"] and opus.mandatory_reasoning is False
    assert opus.structured_outputs is True
    assert opus.price_prompt == pytest.approx(5e-6) and opus.price_completion == pytest.approx(
        25e-6
    )
    assert opus.context_length == 1_000_000
    assert opus.raw["id"] == "anthropic/claude-opus-5" and "reasoning" in opus.raw

    grok = catalog.get_meta("x-ai/grok-4.6")
    assert grok.vendor == "x-ai"  # slug prefix, never the display name ("SpaceXAI")
    assert grok.efforts == ["low", "medium", "high"] and grok.mandatory_reasoning is True
    assert grok.price_prompt == pytest.approx(2e-6) and grok.price_completion == pytest.approx(6e-6)
    assert grok.raw["reasoning"]["supported_efforts"] == ["xhigh", "high", "medium", "low"]

    grok43 = catalog.get_meta("x-ai/grok-4.3")
    assert grok43.efforts == ["off", "low", "medium", "high"] and not grok43.mandatory_reasoning

    fable = catalog.get_meta("anthropic/claude-fable-5.1")
    assert fable.mandatory_reasoning is True and "off" not in fable.efforts
    assert fable.price_prompt == pytest.approx(10e-6)

    astra = catalog.get_meta("openai/gpt-6-astra")
    assert astra.vendor == "openai" and astra.mandatory_reasoning is True

    luna = catalog.get_meta("openai/gpt-5.6-luna")
    assert luna.structured_outputs and "seed" in luna.raw["supported_parameters"]
    assert luna.price_prompt == pytest.approx(0.2e-6) and luna.price_completion == pytest.approx(
        1.2e-6
    )
    assert luna.raw["reasoning"]["supported_efforts"] == [
        "max",
        "xhigh",
        "high",
        "medium",
        "low",
        "none",
    ]

    plain = catalog.get_meta("openai/gpt-chat-latest")
    assert plain.efforts == ["off"] and plain.mandatory_reasoning is False
    assert "reasoning" not in plain.raw


def test_get_meta_unknown_is_none():
    assert catalog.get_meta("nobody/unknown-model") is None
    assert catalog.get_meta("") is None


def test_defaults_are_in_the_fixture_with_matching_vendors():
    for slot, spec in DEFAULT_SLOT_CONFIG.slots.items():
        meta = catalog.get_meta(spec.model)
        assert meta is not None, spec.model
        assert meta.vendor == SLOT_VENDORS[slot]
        assert spec.effort in meta.efforts
    analyst = catalog.get_meta(DEFAULT_SLOT_CONFIG.analyst_model)
    assert analyst is not None and analyst.structured_outputs


def test_to_meta_is_defensive():
    assert catalog.to_meta({}) is None
    assert catalog.to_meta({"id": ""}) is None
    m = catalog.to_meta({"id": "weird", "pricing": {"prompt": "abc"}, "supported_parameters": "x"})
    assert m is not None and m.vendor == "" and m.price_prompt is None
    assert m.structured_outputs is False and m.efforts == ["off"]
    assert catalog.map_entries("not a list") == []


def _fake_models_doc(prompt_price: str = "0.000001") -> dict:
    return {
        "data": [
            {
                "id": "acme/fake-1",
                "name": "Acme: Fake 1",
                "context_length": 4096,
                "pricing": {"prompt": prompt_price, "completion": "0.000002"},
                "supported_parameters": ["reasoning", "structured_outputs"],
                "reasoning": {"mandatory": False, "supported_efforts": ["high", "low"]},
            },
            {"id": "acme/fake-2", "name": "Acme: Fake 2", "pricing": {"prompt": "0"}},
        ]
    }


async def test_live_fetch_maps_and_caches_on_disk_within_ttl(
    live_transport, respx_router, monkeypatch
):
    monkeypatch.setenv("CATALOG_TTL_S", "3600")
    route = respx_router.get(MODELS_URL).mock(
        return_value=httpx.Response(200, json=_fake_models_doc())
    )

    models = await catalog.get_catalog()
    assert [m.id for m in models] == ["acme/fake-1", "acme/fake-2"]
    assert models[0].efforts == ["off", "low", "high"] and models[0].structured_outputs
    assert models[1].efforts == ["off"] and models[1].price_completion is None
    assert route.call_count == 1 and catalog.cache_source() == "network"
    # no Authorization header needed for /models
    assert "authorization" not in {k.lower() for k in route.calls.last.request.headers}

    cache_file = settings().data_dir / "models.json"
    assert cache_file.is_file()
    doc = json.loads(cache_file.read_text())
    assert doc["data"][0]["id"] == "acme/fake-1" and doc["fetched_at"] <= time.time()

    # in-memory hit
    await catalog.get_catalog()
    assert route.call_count == 1
    assert catalog.get_meta("acme/fake-1") is not None
    assert catalog.get_meta("anthropic/claude-opus-5") is not None  # offline fallback still there

    # disk hit after the memory cache is dropped
    catalog._reset_cache()
    again = await catalog.get_catalog()
    assert route.call_count == 1 and catalog.cache_source() == "disk"
    assert [m.id for m in again] == ["acme/fake-1", "acme/fake-2"]

    # force_refresh always fetches
    respx_router.get(MODELS_URL).mock(
        return_value=httpx.Response(200, json=_fake_models_doc("0.000009"))
    )
    fresh = await catalog.get_catalog(force_refresh=True)
    assert fresh[0].price_prompt == pytest.approx(9e-6)


async def test_live_fetch_respects_ttl_expiry(live_transport, respx_router, monkeypatch):
    monkeypatch.setenv("CATALOG_TTL_S", "0")
    route = respx_router.get(MODELS_URL).mock(
        return_value=httpx.Response(200, json=_fake_models_doc())
    )
    await catalog.get_catalog()
    await catalog.get_catalog()
    assert route.call_count == 2


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, json={"error": {"code": 500, "message": "boom"}}),
        httpx.Response(200, json={"data": []}),
        httpx.Response(200, content=b"not json"),
    ],
)
async def test_live_fetch_failure_falls_back_to_offline_fixture(
    live_transport, respx_router, response
):
    respx_router.get(MODELS_URL).mock(return_value=response)
    models = await catalog.get_catalog()
    assert {m.id for m in models} >= DECISION_SLUGS
    assert catalog.cache_source() == "fixture"
    assert not (settings().data_dir / "models.json").exists()


async def test_live_fetch_transport_error_falls_back(live_transport, respx_router):
    respx_router.get(MODELS_URL).mock(side_effect=httpx.ConnectError("down"))
    models = await catalog.get_catalog()
    assert {m.id for m in models} >= DECISION_SLUGS


def test_get_meta_in_mock_mode_never_touches_the_network(respx_router):
    # The autouse blocker fails any unmocked request; a plain get_meta must not trigger one.
    assert catalog.get_meta("x-ai/grok-4.6") is not None
    assert respx_router.calls.call_count == 0
