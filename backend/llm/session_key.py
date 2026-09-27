"""The session OpenRouter key (2026-09-27): what the desktop pushes, never what the environment holds.

In desktop mode (`TRIPLEX_DESKTOP=1`) the live OpenRouter path takes its key from HERE and only
here -- `client.stream_completion` never reads `settings().openrouter_api_key` in that mode.
Electron keeps the key encrypted in its own settings and PUTs it to `/api/session/openrouter_key`
(Bearer `BRIDGE_TOKEN`) on every bridge connect; without that push the desktop backend has no key,
whatever a developer `.env` next to the checkout says -- otherwise the e2e backend would place
live, paid calls the moment the transport guard is relaxed.

Module state only, one process, one key. The key is never logged: `status()` is the only
rendering that leaves the module, and it carries a short prefix and the length, never the value.
"""

from __future__ import annotations

KEY_PREFIX = "sk-or-v1-"  # the public marker of an OpenRouter key; anything else is never echoed, even in part
_key: str | None = None

# What `status()` shows of a configured key: "sk-or-v1-" and nothing after it.
PREFIX_CHARS = 9


def set_key(key: str) -> None:
    """Store `key` (stripped). A blank key is a ValueError, never a silent clear: clearing is
    `clear_key()`, and a caller that meant to clear should say so."""
    global _key
    if not isinstance(key, str) or not key.strip():
        raise ValueError("the session key must be a non-empty string")
    _key = key.strip()


def clear_key() -> None:
    global _key
    _key = None


def get_key() -> str | None:
    return _key


def status() -> dict[str, object]:
    """`{configured, prefix, length}` -- never the key itself."""
    if _key is None:
        return {"configured": False, "prefix": None, "length": 0}
    # Only the public marker of an OpenRouter key is ever revealed; any other shape stays entirely secret.
    return {"configured": True, "prefix": KEY_PREFIX if _key.startswith(KEY_PREFIX) else None, "length": len(_key)}


__all__ = ["PREFIX_CHARS", "clear_key", "get_key", "set_key", "status"]
