"""`GET /app`, `/app/`, `/app/{path}` (routers/desktop_app.py): index fallback for extension-less
paths, assets, 404 for a missing asset / traversal / symlink escape / unset directory."""

from __future__ import annotations

import pytest

from backend.routers.desktop_app import app_dir, resolve_file

INDEX = "<!doctype html><title>Triplex</title><div id=root></div>"
NOT_FOUND = {"detail": {"error": "not_found", "what": "app"}}


@pytest.fixture
def dist(tmp_path, monkeypatch):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX, encoding="utf-8")
    (root / "assets" / "app.js").write_text("console.log('triplex')", encoding="utf-8")
    (root / "assets" / "app.css").write_text("body{margin:0}", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")
    (root / "assets" / "escape.txt").symlink_to(secret)
    monkeypatch.setenv("TRIPLEX_APP_DIR", str(root))
    return root


@pytest.mark.parametrize(
    "path", ["/app", "/app/", "/app/conversations/abc", "/app/deep/route/", "/app/x.y/"]
)
async def test_extension_less_paths_serve_index(client, dist, path):
    r = await client.get(path)
    assert r.status_code == 200, r.text
    assert r.text == INDEX and r.headers["content-type"].startswith("text/html")


async def test_assets_are_served_with_their_media_type(client, dist):
    r = await client.get("/app/assets/app.js")
    assert r.status_code == 200 and r.text == "console.log('triplex')"
    assert "javascript" in r.headers["content-type"]
    r = await client.get("/app/assets/app.css")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/css")


async def test_missing_asset_is_404(client, dist):
    r = await client.get("/app/assets/missing.js")
    assert r.status_code == 404 and r.json() == NOT_FOUND
    r = await client.get("/app/assets/")  # a directory, extension-less -> index, not a listing
    assert r.status_code == 200 and r.text == INDEX


@pytest.mark.parametrize(
    "path",
    [
        "/app/../secret.txt",
        "/app/assets/../../secret.txt",
        "/app/%2e%2e/secret.txt",
        "/app/assets/%2e%2e/%2e%2e/secret.txt",
        "/app/assets/escape.txt",
        "/app//etc/passwd",
        "/app/assets/app.js%00.txt",
    ],
)
async def test_traversal_and_escapes_are_blocked(client, dist, path):
    r = await client.get(path)
    assert "top secret" not in r.text and "root:" not in r.text
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert r.text == INDEX  # only the SPA fallback may answer an odd path


def test_resolve_file_containment(dist):
    root = dist.resolve()
    assert resolve_file(root, "") == root / "index.html"
    assert resolve_file(root, "conversations/abc") == root / "index.html"
    assert resolve_file(root, "assets/app.js") == root / "assets" / "app.js"
    assert resolve_file(root, "assets/missing.js") is None
    assert resolve_file(root, "../secret.txt") is None
    assert resolve_file(root, "assets/../../secret.txt") is None
    assert resolve_file(root, "/etc/passwd") == root / "index.html"  # extension-less: SPA route
    assert resolve_file(root, "/etc/hostname.txt") is None  # never a file outside the tree
    assert resolve_file(root, "assets/app.js/") == root / "index.html"  # trailing slash = route
    assert resolve_file(root, "assets/escape.txt") is None  # symlink out of the tree
    assert resolve_file(root, "assets/app.js\x00.txt") is None
    assert resolve_file(root, "index.html") == root / "index.html"


async def test_404_when_unset_or_not_a_directory(client, monkeypatch, tmp_path):
    monkeypatch.delenv("TRIPLEX_APP_DIR", raising=False)
    assert app_dir() is None
    for path in ("/app", "/app/", "/app/assets/app.js", "/app/conversations/abc"):
        r = await client.get(path)
        assert r.status_code == 404 and r.json() == NOT_FOUND, path
    monkeypatch.setenv("TRIPLEX_APP_DIR", str(tmp_path / "missing"))
    assert app_dir() is None
    r = await client.get("/app/")
    assert r.status_code == 404 and r.json() == NOT_FOUND
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("TRIPLEX_APP_DIR", str(empty))
    assert app_dir() == empty.resolve()
    r = await client.get("/app/")  # a directory without index.html
    assert r.status_code == 404 and r.json() == NOT_FOUND


async def test_api_routes_are_unaffected(client, dist):
    r = await client.get("/")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    r = await client.get("/api/conversations")
    assert r.status_code == 200
