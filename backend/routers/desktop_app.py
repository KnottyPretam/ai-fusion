"""Built renderer for the desktop (owner: bridge-backend S2) -- docs/desktop-contract.md section 6.

    GET /app, /app/, /app/{path:path}   -> files under TRIPLEX_APP_DIR (frontend/dist built with
                                           VITE_BASE=/app/)

Rules: `TRIPLEX_APP_DIR` unset (or not a directory) -> 404 for every path; an extension-less path
(`/app`, `/app/`, `/app/conversations/abc`) serves `index.html` (the SPA fallback); any other
path is resolved against the directory and served only when the resolved file is still inside it
(`..`, absolute paths, symlinks out of the tree and NUL bytes are all 404, never a file outside
`TRIPLEX_APP_DIR`); a missing asset is 404. Same origin as `/api`, so `main.py` CORS and
`api/http.js` stay frozen. Errors use the `{detail:{error:"not_found", what:"app"}}` envelope.

Every file goes out with `Cache-Control: no-cache` (2026-10-15): the bundled renderer's files carry
the AppImage's 1980 timestamp as `last-modified`, and with nothing else Chromium's heuristic counted
the page fresh for years -- every launch reused the FIRST build's renderer, and an upgrade never
reached the screen. `no-cache` makes each load revalidate through the ETag (a 304 on loopback).
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from .. import api_errors

router = APIRouter(tags=["desktop"])

INDEX = "index.html"


def app_dir() -> Path | None:
    """`TRIPLEX_APP_DIR` resolved, or None when unset / not a directory (private env read)."""
    raw = os.environ.get("TRIPLEX_APP_DIR", "").strip()
    if not raw:
        return None
    try:
        root = Path(raw).expanduser().resolve()
    except (OSError, ValueError):
        return None
    return root if root.is_dir() else None


def resolve_file(root: Path, path: str) -> Path | None:
    """The file to serve for `path`, or None (404). Extension-less (no suffix on the last
    segment, or a trailing slash = a directory-shaped route) -> `index.html`; everything else
    must resolve to a regular file inside `root`."""
    try:
        rel = path.strip("/")
        if not rel or path.endswith("/") or not Path(rel).suffix:
            target = (root / INDEX).resolve()
        else:
            target = (root / rel).resolve()
    except (OSError, ValueError):  # NUL bytes, absurd lengths
        return None
    if target != root and not target.is_relative_to(root):
        return None
    return target if target.is_file() else None


@router.get("/app")
@router.get("/app/")
@router.get("/app/{path:path}")
async def serve_app(path: str = "") -> FileResponse:
    root = app_dir()
    if root is None:
        raise api_errors.not_found("app")
    target = resolve_file(root, path)
    if target is None:
        raise api_errors.not_found("app")
    return FileResponse(target, headers={"Cache-Control": "no-cache"})
