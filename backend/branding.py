"""The product name and the logo, for anything the backend renders.

The name itself is `settings().app_title` (config, `APP_TITLE`); this module is about the mark.

The PNGs are generated from one master in `desktop/assets/` (see its README), so the logo is read
from there rather than copied: one file to replace when the artwork changes. `EXPORT_LOGO_PATH`
overrides the location for a deployment that does not ship the desktop directory, and a logo that
cannot be read is simply absent -- an export must never fail because of decoration.

Both sizes are base64 data URIs, because an exported document carries no external reference of any
kind: it has to render from a file path with no network, and the PDF is printed from that same HTML.
Markdown gets the smaller one, since its data URI is text the reader may scroll past.
"""

from __future__ import annotations

import base64
import logging
import os
from functools import lru_cache
from pathlib import Path

log = logging.getLogger("triplex.branding")

#: Repo root: backend/branding.py -> backend -> <repo>.
REPO_DIR = Path(__file__).resolve().parent.parent
#: Where the generated icons live when the desktop directory is present.
DEFAULT_LOGO_DIR = REPO_DIR / "desktop" / "assets"
#: Rendered px for each use. HTML/PDF can afford the detail; markdown pays for it in bytes.
HTML_LOGO_PX = 128
MARKDOWN_LOGO_PX = 64
#: A data URI larger than this is refused rather than bloating every document.
MAX_LOGO_BYTES = 256 * 1024


def logo_dir() -> Path:
    """`EXPORT_LOGO_PATH` when set (read at call time, as the rest of the LLM layer does)."""
    override = os.environ.get("EXPORT_LOGO_PATH", "").strip()
    return Path(override) if override else DEFAULT_LOGO_DIR


def logo_path(px: int) -> Path:
    """`icon-<px>.png`, or `icon.png` for the 512 the generator names that way."""
    directory = logo_dir()
    named = directory / f"icon-{px}.png"
    return named if named.exists() or px != 512 else directory / "icon.png"


@lru_cache(maxsize=8)
def _read(path_str: str) -> bytes | None:
    path = Path(path_str)
    try:
        raw = path.read_bytes()
    except OSError as exc:  # missing, unreadable, a directory
        log.debug("no logo at %s (%s)", path, type(exc).__name__)
        return None
    if not raw:
        log.warning("logo at %s is empty; exports will carry no logo", path)
        return None
    if len(raw) > MAX_LOGO_BYTES:
        log.warning("logo at %s is %d bytes (> %d); exports will carry no logo", path, len(raw), MAX_LOGO_BYTES)
        return None
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        log.warning("logo at %s is not a PNG; exports will carry no logo", path)
        return None
    return raw


def logo_data_uri(px: int = HTML_LOGO_PX) -> str | None:
    """`data:image/png;base64,...` for the icon at `px`, or None when there is none to embed."""
    raw = _read(str(logo_path(px)))
    if raw is None:
        return None
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def reset_cache() -> None:
    """Forget what was read (tests, and a logo replaced while the backend is up)."""
    _read.cache_clear()
