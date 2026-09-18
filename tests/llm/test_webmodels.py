"""`webmodels.desktop_catalog()` and the `GET /api/models` gating (desktop-catalog-and-ollama S3,
docs/desktop-contract.md section 6): shape / vendors / efforts / raw, `TRIPLEX_DESKTOP` gating with
no network ever, the catalog module untouched, and `validate_slot_config` accepting `web:*` /
`ollama:*` with any effort."""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from backend.features.slot_config import validate_slot_config
from backend.llm import catalog, webmodels
from backend.schemas import SLOT_IDS, ModelMeta, SlotConfig, SlotSpec
from tests.llm.conftest import BASE_URL, MODELS_URL

EFFORTS = ["off", "low", "medium", "high"]
PANES = ["web:claude", "web:chatgpt", "web:grok"]
ANALYSTS = ["web:claude:analyst", "web:chatgpt:analyst", "web:grok:analyst"]


def _ids(models: list[ModelMeta]) -> list[str]:
    return [m.id for m in models]


# --------------------------------------------------------------------------- shape
def test_shape_order_and_common_fields(monkeypatch):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    models = webmodels.desktop_catalog()
    assert _ids(models) == [*PANES, *ANALYSTS, "ollama:hermes3"]
    for m in models:
        assert isinstance(m, ModelMeta)
        assert m.efforts == ["off"]
        assert m.mandatory_reasoning is False and m.structured_outputs is False
        assert m.context_length is None
        assert m.price_prompt is None and m.price_completion is None
        assert m.name
        ModelMeta.model_validate(m.model_dump())  # round-trips like the OpenRouter entries


def test_vendors_and_names():
    by_id = {m.id: m for m in webmodels.desktop_catalog()}
    assert by_id["web:claude"].vendor == "anthropic"
    assert by_id["web:chatgpt"].vendor == "openai"
    assert by_id["web:grok"].vendor == "x-ai"
    assert by_id["web:claude"].name == "Claude (web session)"
    assert by_id["web:chatgpt"].name == "ChatGPT (web session)"
    assert by_id["web:grok"].name == "Grok (web session)"
    for slot in SLOT_IDS:
        analyst = by_id[f"web:{slot}:analyst"]
        assert analyst.vendor == "triplex-analyst"
        assert analyst.name == f"{webmodels.SITE_NAMES[slot]} web session (hidden analyst page)"
    assert by_id["web:chatgpt:analyst"].name == "ChatGPT web session (hidden analyst page)"
    assert by_id["ollama:hermes3"].vendor == "ollama"
    assert by_id["ollama:hermes3"].name == "hermes3 (local Ollama)"


def test_raw_transport():
    for m in webmodels.desktop_catalog():
        expected = "ollama" if m.id.startswith("ollama:") else "web"
        assert m.raw == {"transport": expected}


@pytest.mark.parametrize(
    "value,names",
    [
        ("hermes3,llama3.1:8b", ["hermes3", "llama3.1:8b"]),
        (" hermes3 , , hermes3 ,qwen3 ", ["hermes3", "qwen3"]),
        ("ollama:qwen3", ["qwen3"]),
        ("", ["hermes3"]),
        (" , ", ["hermes3"]),
    ],
)
def test_ollama_models_env(monkeypatch, value, names):
    monkeypatch.setenv("OLLAMA_MODELS", value)
    assert webmodels.ollama_models() == names
    ollama_ids = [m.id for m in webmodels.desktop_catalog() if m.id.startswith("ollama:")]
    assert ollama_ids == [f"ollama:{n}" for n in names]
    assert len(webmodels.desktop_catalog()) == 6 + len(names)


def test_ollama_models_default(monkeypatch):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    assert webmodels.ollama_models() == ["hermes3"]
    assert webmodels.DEFAULT_OLLAMA_MODELS == "hermes3"


def test_fresh_objects_per_call():
    a, b = webmodels.desktop_catalog(), webmodels.desktop_catalog()
    assert a == b and a is not b
    assert all(x is not y for x, y in zip(a, b, strict=True))
    a[0].raw["mutated"] = True
    assert "mutated" not in webmodels.desktop_catalog()[0].raw


def test_catalog_module_stays_unaware_of_desktop_models():
    webmodels.desktop_catalog()
    for model_id in [*PANES, *ANALYSTS, "ollama:hermes3"]:
        assert catalog.get_meta(model_id) is None
    assert catalog.cache_source() is None


# --------------------------------------------------------------------------- GET /api/models
@pytest.fixture
async def desktop_client(monkeypatch):
    """An app built under `TRIPLEX_DESKTOP=1` (TrustedHost active: loopback Host only)."""
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")
    from backend.main import create_app

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="http://127.0.0.1"
    ) as c:
        yield c


@pytest.mark.parametrize("force_refresh", ["false", "true"])
async def test_desktop_returns_the_desktop_catalog_without_network(
    desktop_client, respx_router, monkeypatch, force_refresh
):
    monkeypatch.setenv("MOCK_OPENROUTER", "0")  # a live catalog fetch would otherwise happen
    monkeypatch.setenv("OPENROUTER_BASE_URL", BASE_URL)
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    models_route = respx_router.get(MODELS_URL).mock(
        return_value=httpx.Response(200, json={"data": [{"id": "openai/gpt-5"}]})
    )
    r = await desktop_client.get("/api/models", params={"force_refresh": force_refresh})
    assert r.status_code == 200, r.text
    assert r.json() == [m.model_dump() for m in webmodels.desktop_catalog()]
    assert [m["id"] for m in r.json()] == [*PANES, *ANALYSTS, "ollama:hermes3"]
    assert models_route.call_count == 0 and respx_router.calls.call_count == 0
    assert catalog.cache_source() is None  # the catalog module was never touched
    assert catalog.get_meta("web:chatgpt:analyst") is None


async def test_desktop_catalog_reflects_ollama_models_per_request(desktop_client, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODELS", "hermes3,qwen3")
    r = await desktop_client.get("/api/models")
    assert [m["id"] for m in r.json()][-2:] == ["ollama:hermes3", "ollama:qwen3"]
    monkeypatch.setenv("OLLAMA_MODELS", "phi4")
    r = await desktop_client.get("/api/models")
    assert [m["id"] for m in r.json()][-1] == "ollama:phi4"


async def test_unset_flag_is_the_existing_mock_path_without_network(
    client, respx_router, monkeypatch
):
    monkeypatch.delenv("TRIPLEX_DESKTOP", raising=False)
    r = await client.get("/api/models")
    assert r.status_code == 200
    assert r.json() == [m.model_dump() for m in catalog.load_offline()]
    assert not any(m["id"].startswith(("web:", "ollama:")) for m in r.json())
    assert catalog.cache_source() == "fixture"
    assert respx_router.calls.call_count == 0


@pytest.mark.parametrize("value", ["0", "", "true", "yes", " "])
async def test_only_the_literal_1_switches_to_the_desktop_catalog(client, monkeypatch, value):
    monkeypatch.setenv("TRIPLEX_DESKTOP", value)
    r = await client.get("/api/models")
    assert r.status_code == 200
    assert [m["id"] for m in r.json()] == [m.id for m in catalog.load_offline()]


async def test_unset_flag_keeps_the_live_catalog_fetch(client, respx_router, monkeypatch):
    """The non-desktop path is byte-identical: with the mock off it still fetches `/models`."""
    monkeypatch.delenv("TRIPLEX_DESKTOP", raising=False)
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    monkeypatch.setenv("OPENROUTER_BASE_URL", BASE_URL)
    entry = {
        "id": "openai/gpt-5",
        "name": "GPT-5",
        "pricing": {"prompt": "0.000001", "completion": "0.000002"},
        "supported_parameters": ["structured_outputs"],
    }
    models_route = respx_router.get(MODELS_URL).mock(
        return_value=httpx.Response(200, json={"data": [entry]})
    )
    r = await client.get("/api/models", params={"force_refresh": "true"})
    assert r.status_code == 200
    assert [m["id"] for m in r.json()] == ["openai/gpt-5"]
    assert models_route.call_count == 1 and catalog.cache_source() == "network"


# --------------------------------------------------------------------------- validate_slot_config
def _config(effort: str, **models: str) -> SlotConfig:
    return SlotConfig(
        slots={slot: SlotSpec(model=models[slot], effort=effort) for slot in SLOT_IDS},
        analyst_model="web:chatgpt:analyst",
    )


@pytest.mark.parametrize("effort", EFFORTS)
def test_validate_slot_config_accepts_web_and_ollama_with_any_effort(effort):
    validate_slot_config(_config(effort, claude="web:claude", chatgpt="web:chatgpt", grok="web:grok"))
    validate_slot_config(
        _config(effort, claude="ollama:hermes3", chatgpt="ollama:llama3.1:8b", grok="web:grok")
    )
    validate_slot_config(
        _config(effort, claude="web:claude:analyst", chatgpt="web:chatgpt", grok="ollama:qwen3")
    )


def test_validate_slot_config_still_rejects_a_known_model_at_an_unsupported_effort():
    # openai/gpt-chat-latest has no reasoning block in the offline fixture: efforts == ["off"]
    with pytest.raises(HTTPException) as ei:
        validate_slot_config(
            _config("high", claude="web:claude", chatgpt="openai/gpt-chat-latest", grok="web:grok")
        )
    assert ei.value.status_code == 422
    assert ei.value.detail["error"] == "unsupported_effort" and ei.value.detail["slot"] == "chatgpt"


@pytest.mark.parametrize("effort", EFFORTS)
async def test_put_slot_config_accepts_desktop_models_over_http(client, effort):
    r = await client.post("/api/conversations", json={})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    cfg = _config(effort, claude="web:claude", chatgpt="ollama:hermes3", grok="web:grok")
    r = await client.put(f"/api/conversations/{cid}/slot_config", json=cfg.model_dump())
    assert r.status_code == 200, r.text
    assert r.json() == cfg.model_dump()
    r = await client.get(f"/api/conversations/{cid}/slot_config")
    assert r.json()["slots"]["chatgpt"] == {"model": "ollama:hermes3", "effort": effort}
