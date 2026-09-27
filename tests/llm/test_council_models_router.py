"""`GET /api/models` in desktop mode with a session key (2026-09-27): the desktop catalog first,
then the OpenRouter models a council row can seat, tagged `raw.transport == "openrouter"` on
copies -- `catalog._mem` untouched, no network without a key."""

from __future__ import annotations

import httpx
import pytest

from backend.llm import catalog, session_key, webmodels
from backend.llm.catalog import load_offline
from backend.schemas import ModelMeta
from backend.vendors import openrouter_filter, vendor_of_model

MODELS_URL = "https://openrouter.ai/api/v1/models"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    session_key.clear_key()
    catalog._reset_cache()
    yield
    session_key.clear_key()
    catalog._reset_cache()


@pytest.fixture
def desktop(monkeypatch):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "1")


async def test_without_a_key_only_the_desktop_catalog_and_no_network(client, desktop, respx_router):
    route = respx_router.get(MODELS_URL).mock(return_value=httpx.Response(200, json={"data": []}))
    r = await client.get("/api/models")
    assert r.status_code == 200
    assert [m["id"] for m in r.json()] == [m.id for m in webmodels.desktop_catalog()]
    assert route.call_count == 0 and catalog.cache_source() is None


async def test_with_a_key_the_openrouter_council_models_follow_the_desktop_catalog(client, desktop):
    session_key.set_key("sk-or-v1-pushed")
    r = await client.get("/api/models")
    assert r.status_code == 200
    body = r.json()
    desktop_ids = [m.id for m in webmodels.desktop_catalog()]
    assert [m["id"] for m in body[: len(desktop_ids)]] == desktop_ids
    extra = body[len(desktop_ids) :]
    # mock mode: the offline fixture, filtered to the vendors a council can seat
    expected = [m.id for m in openrouter_filter(load_offline())]
    assert [m["id"] for m in extra] == expected and expected
    assert "mistralai/mistral-large-2512" in {m.id for m in load_offline()}
    assert "mistralai/mistral-large-2512" not in {m["id"] for m in extra}
    for m in extra:
        assert m["raw"]["transport"] == "openrouter"
        assert vendor_of_model(m["id"], m["name"]) is not None
        assert m["raw"]["id"] == m["id"]  # the entry's own raw fields are kept beside the tag
    # the catalog's own cache entries were never tagged
    for m in catalog._mem or []:
        assert "transport" not in m.raw
    assert catalog.get_meta("openai/gpt-5.6-luna").raw.get("transport") is None


async def test_outside_desktop_mode_the_key_changes_nothing(client, monkeypatch):
    monkeypatch.setenv("TRIPLEX_DESKTOP", "0")
    session_key.set_key("sk-or-v1-pushed")
    r = await client.get("/api/models")
    assert r.json() == [m.model_dump() for m in load_offline()]


def test_tag_openrouter_copies_and_never_mutates():
    src = [ModelMeta(id="qwen/qwen3.7-max", name="Qwen", raw={"id": "qwen/qwen3.7-max"})]
    out = webmodels.tag_openrouter(src)
    assert out[0] is not src[0] and out[0].raw is not src[0].raw
    assert out[0].raw == {"id": "qwen/qwen3.7-max", "transport": "openrouter"}
    assert src[0].raw == {"id": "qwen/qwen3.7-max"}
    assert webmodels.TRANSPORT_OPENROUTER == "openrouter"
