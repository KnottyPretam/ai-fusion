"""GET /api/models -> bare JSON array of ModelMeta (offline fixture in mock mode)."""

from __future__ import annotations

from backend.llm import catalog
from backend.schemas import ModelMeta
from tests.llm.test_catalog import DECISION_SLUGS


async def test_get_models_returns_fixture_list(client):
    r = await client.get("/api/models")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list) and body
    ids = [m["id"] for m in body]
    assert DECISION_SLUGS <= set(ids)
    expected = [m.model_dump() for m in catalog.load_offline()]
    assert ids == [m["id"] for m in expected]
    for item in body:
        meta = ModelMeta.model_validate(item)  # every entry round-trips
        assert set(ModelMeta.model_fields) <= set(item)
        assert meta.vendor == meta.id.split("/")[0]


async def test_get_models_never_hits_the_network_in_mock_mode(client, respx_router):
    r = await client.get("/api/models")
    assert r.status_code == 200
    assert not [c for c in respx_router.calls if "openrouter" in str(c.request.url)]
