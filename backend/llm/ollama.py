"""Local Ollama transport helpers (owner: desktop-catalog-and-ollama S3). Pure: no I/O, never raises.

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

Cost: Ollama's usage chunk carries no `cost`, so the parser's catalog fallback prices the bare
name -- unknown to the catalog, hence 0.0 -- and `cost_lookup=False` keeps the client from asking
`GET /generation` (no such endpoint). Without a usage chunk the stream gets the usual
`EstimatedUsage`. The session cost cap and the OpenRouter key check are never consulted for a
local model (`client.stream_completion` routes `ollama:` before both, and before the mock).
"""

from __future__ import annotations

import os
from typing import Any

PREFIX = "ollama:"
DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
ENV_BASE_URL = "OLLAMA_BASE_URL"


def model_name(model: str) -> str:
    """`ollama:hermes3` -> `hermes3`; a name without the prefix is returned unchanged."""
    if isinstance(model, str) and model.startswith(PREFIX):
        return model[len(PREFIX) :]
    return model


def base_url() -> str:
    """`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434/v1` (blank counts as unset)."""
    value = os.environ.get(ENV_BASE_URL, "").strip()
    return value or DEFAULT_BASE_URL


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


__all__ = ["DEFAULT_BASE_URL", "PREFIX", "base_url", "headers", "model_name", "sanitize_payload"]
