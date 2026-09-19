"""GET /api/conversations/{conv_id}/export/{turn_id}?format=md|html over the real ASGI app."""

from __future__ import annotations

import re

import pytest

from backend import export
from backend.routers import export as router_mod

URL = "/api/conversations/{cid}/export/{tid}"
MISSING_ID = "00000000-0000-4000-8000-000000000000"


@pytest.fixture
async def stored(rich_send, add_analyze, add_fusion, persist):
    """A persisted conversation plus the ids of its send / analyze / fusion turns."""
    conv = rich_send()
    analyze = add_analyze(conv)
    fusion = add_fusion(conv, analyze)
    saved = await persist(conv)
    return saved, {
        "send": conv.turns[0].id,
        "analyze": analyze.id,
        "fusion": fusion.id,
    }


def test_route_is_mounted_by_convention():
    routes = {(r.path, tuple(sorted(r.methods))) for r in router_mod.router.routes}
    assert ("/api/conversations/{conv_id}/export/{turn_id}", ("GET",)) in routes


@pytest.mark.parametrize("kind", ["send", "analyze", "fusion"])
async def test_markdown_response(client, stored, kind):
    conv, ids = stored
    r = await client.get(URL.format(cid=conv.id, tid=ids[kind]), params={"format": "md"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/markdown; charset=utf-8"
    assert r.text == export.render_markdown(conv, ids[kind])
    assert r.text.startswith(f"<!-- triplex-export=triplex triplex-export-type={kind} ")
    filename = r.headers["x-triplex-export-filename"]
    assert re.fullmatch(rf"triplex-{kind}-test-conversation-\d{{8}}-\d{{6}}\.md", filename)
    assert r.headers["content-disposition"] == f'attachment; filename="{filename}"'
    assert r.headers["x-triplex-export-type"] == kind
    assert r.headers["x-triplex-export-turn"] == ids[kind]


@pytest.mark.parametrize("kind", ["send", "analyze", "fusion"])
async def test_html_response(client, stored, kind):
    conv, ids = stored
    r = await client.get(URL.format(cid=conv.id, tid=ids[kind]), params={"format": "html"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/html; charset=utf-8"
    assert r.text == export.render_html(conv, ids[kind])
    assert r.text.startswith("<!doctype html>")
    assert f'<meta name="triplex-export-type" content="{kind}">' in r.text
    assert f'<meta name="triplex-export-turn" content="{ids[kind]}">' in r.text
    assert r.headers["x-triplex-export-filename"].endswith(".html")


async def test_the_two_formats_share_one_base_name(client, stored):
    """"All three" asks once for a base path: .md, .html and the shell's .pdf sit beside each other."""
    conv, ids = stored
    names = []
    for fmt in ("md", "html"):
        r = await client.get(URL.format(cid=conv.id, tid=ids["send"]), params={"format": fmt})
        names.append(r.headers["x-triplex-export-filename"])
    assert names[0].removesuffix(".md") == names[1].removesuffix(".html")


async def test_format_defaults_to_markdown(client, stored):
    conv, ids = stored
    r = await client.get(URL.format(cid=conv.id, tid=ids["send"]))
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/markdown; charset=utf-8"


@pytest.mark.parametrize(
    ("value", "content_type"),
    [
        ("MD", "text/markdown; charset=utf-8"),
        ("markdown", "text/markdown; charset=utf-8"),
        ("HTML", "text/html; charset=utf-8"),
        ("htm", "text/html; charset=utf-8"),
    ],
)
async def test_format_aliases(client, stored, value, content_type):
    conv, ids = stored
    r = await client.get(URL.format(cid=conv.id, tid=ids["send"]), params={"format": value})
    assert r.status_code == 200
    assert r.headers["content-type"] == content_type


@pytest.mark.parametrize("value", ["pdf", "docx", "", "md html"])
async def test_unknown_format_is_422(client, stored, value):
    conv, ids = stored
    r = await client.get(URL.format(cid=conv.id, tid=ids["send"]), params={"format": value})
    assert r.status_code == 422
    assert r.json()["detail"] == {
        "error": "unknown_format",
        "format": value,
        "supported": ["md", "html"],
    }


async def test_unknown_format_is_checked_before_the_conversation(client):
    """The 422 needs no disk read: a bogus conversation id with a bad format is still 422."""
    r = await client.get(URL.format(cid=MISSING_ID, tid=MISSING_ID), params={"format": "pdf"})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "unknown_format"


@pytest.mark.parametrize("conv_id", [MISSING_ID, "not-a-uuid"])
async def test_unknown_conversation_is_404(client, conv_id):
    r = await client.get(URL.format(cid=conv_id, tid=MISSING_ID))
    assert r.status_code == 404
    assert r.json()["detail"] == {"error": "not_found", "what": "conversation"}


async def test_unknown_turn_is_404(client, stored):
    conv, _ = stored
    r = await client.get(URL.format(cid=conv.id, tid=MISSING_ID))
    assert r.status_code == 404
    assert r.json()["detail"] == {"error": "not_found", "what": "turn"}


@pytest.mark.parametrize("kind", ["send", "analyze", "fusion"])
@pytest.mark.parametrize("fmt", ["md", "html"])
async def test_no_response_ever_carries_the_anon_map(client, stored, kind, fmt):
    conv, ids = stored
    r = await client.get(URL.format(cid=conv.id, tid=ids[kind]), params={"format": fmt})
    assert "anon_map" not in r.text
    assert conv.anon_map  # the document on disk does hold one; the export never shows it
