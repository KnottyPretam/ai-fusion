"""Local Ollama transport helpers (owner: desktop-catalog-and-ollama S3). Pure: no network I/O,
never raises (`warn_if_remote` logs, and that is the module's only side effect).

docs/desktop-contract.md section 6: an `ollama:<name>` model is served by Ollama's OpenAI-compatible
endpoint through the same httpx transport as OpenRouter -- `client._live_stream(base_url=,
headers=, cost_lookup=False)` -- with these helpers shaping the call:

- `model_name("ollama:hermes3") == "hermes3"`: the bare name Ollama knows (a name without the
  prefix is returned as is).
- `headers()`: JSON in, SSE out, nothing else -- no `Authorization` (Ollama has no key) and none of
  the OpenRouter attribution headers.
- `sanitize_payload(payload, model)`: an allow-list, never a copy-and-drop -- `messages`,
  `stream: true`, `max_tokens` (when the payload set one), `model` = the bare name, plus
  `stream_options: {"include_usage": true}` so the final chunk carries token counts. `reasoning`,
  `provider`, `plugins`, `response_format` (and any other OpenRouter-only key) are dropped: the
  local server rejects unknown parameters, and the analyst's JSON is parsed leniently anyway
  (`catalog.get_meta` does not know `ollama:*`, so `complete_json` never asks for a strict
  `response_format`). The input payload is left untouched.
- `base_url()`: the private `OLLAMA_BASE_URL` read (`config.py` is frozen); unset or blank -> the
  default `http://127.0.0.1:11434/v1`.
- `is_loopback(url)` / `warn_if_remote(url)`: the S7 review's "the local Ollama analyst has no
  loopback guard or warning" (lens anon-tos). A base URL whose host is not loopback (127.0.0.1 /
  localhost / ::1, the same test as `routers/bridge.origin_is_loopback` and the desktop's
  `backend.isLoopbackHost`) is still served -- the user may run Ollama on another box deliberately,
  so this is a warning and never a refusal -- but `client.stream_completion` calls
  `warn_if_remote(base_url())` on the `ollama:` branch and ONE WARNING per process per host says
  where the call went: the analyst payload is the whole Analyze prompt (the user's question plus
  all three accounts' replies), so a remote host sees exactly the data the local analyst exists to
  keep on this machine. A URL with no parsable host is reported verbatim (it is not loopback).

Cost: Ollama's usage chunk carries no `cost`, so the parser's catalog fallback prices the bare
name -- unknown to the catalog, hence 0.0 -- and `cost_lookup=False` keeps the client from asking
`GET /generation` (no such endpoint). Without a usage chunk the stream gets the usual
`EstimatedUsage`. The session cost cap and the OpenRouter key check are never consulted for a
local model (`client.stream_completion` routes `ollama:` before both, and before the mock).
"""

from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger("triplex.llm.ollama")

PREFIX = "ollama:"
DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
ENV_BASE_URL = "OLLAMA_BASE_URL"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_warned_hosts: set[str] = set()


def model_name(model: str) -> str:
    """`ollama:hermes3` -> `hermes3`; a name without the prefix is returned unchanged."""
    if isinstance(model, str) and model.startswith(PREFIX):
        return model[len(PREFIX) :]
    return model


def base_url() -> str:
    """`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434/v1` (blank counts as unset)."""
    value = os.environ.get(ENV_BASE_URL, "").strip()
    return value or DEFAULT_BASE_URL


def host_of(url: str) -> str | None:
    """The host of `url`, or None when it has none (an unparsable or scheme-less value)."""
    if not isinstance(url, str):
        return None
    try:
        return urlsplit(url.strip()).hostname
    except ValueError:
        return None


def is_loopback(url: str) -> bool:
    """True only for a URL whose host is 127.0.0.1 / localhost / ::1 (a trailing dot ignored)."""
    host = host_of(url)
    return host is not None and host.lower().rstrip(".") in LOOPBACK_HOSTS


def warn_if_remote(url: str) -> str | None:
    """One WARNING per process per non-loopback host (module docstring); returns the host it
    warned about, else None. Never raises and never refuses: a remote Ollama is allowed."""
    if is_loopback(url):
        return None
    host = host_of(url) or (url.strip() if isinstance(url, str) else "") or ENV_BASE_URL
    if host in _warned_hosts:
        return None
    _warned_hosts.add(host)
    log.warning(
        "%s names the non-loopback host %s: this is NOT a local analyst -- the whole Analyze "
        "prompt (your question and all three replies) is sent to that host over the network",
        ENV_BASE_URL,
        host,
    )
    return host


def headers() -> dict[str, str]:
    """A fresh dict each call: JSON request, SSE response, no Authorization."""
    return {"Content-Type": "application/json", "Accept": "text/event-stream"}


def sanitize_payload(payload: dict[str, Any], model: str) -> dict[str, Any]:
    """The OpenAI-compatible subset Ollama accepts (see the module docstring)."""
    out: dict[str, Any] = {
        "model": model_name(model),
        "messages": list(payload.get("messages") or []),
        "stream": True,
    }
    if payload.get("max_tokens") is not None:
        out["max_tokens"] = int(payload["max_tokens"])
    out["stream_options"] = {"include_usage": True}
    return out


__all__ = [
    "DEFAULT_BASE_URL",
    "LOOPBACK_HOSTS",
    "PREFIX",
    "base_url",
    "headers",
    "host_of",
    "is_loopback",
    "model_name",
    "sanitize_payload",
    "warn_if_remote",
]
