"""Send / continue prompt helpers (owner: W4).

Send is deliberately prompt-free: NOTHING model-facing is authored by Triplex for a Send or a
solo continue. Each slot receives exactly its own persisted thread (`to_openai` projections) plus
the verbatim user prompt -- no system prompt, no labels, no delimiters -- so a leak test over the
captured payload reduces to "payload == thread history + prompt". The helpers below keep the
small request-shaping details (the user message, the web plugin, the auto-title) out of the
orchestration in `features/send.py`.
"""

from __future__ import annotations

from typing import Any

from ..config import Settings, settings

PURPOSE = "chat"
TITLE_MAX_CHARS = 60
WEB_PLUGIN_ID = "web"


def user_message(prompt: str) -> dict[str, str]:
    """The trailing user message of every Send/continue request: the prompt, verbatim."""
    return {"role": "user", "content": prompt}


def web_plugins(grounded: bool, s: Settings | None = None) -> list[dict[str, Any]] | None:
    """`plugins=[{"id": "web", ...}]` iff grounded mode is on (docs/semantics.md, Appendix B:
    the OpenRouter web plugin, never the `:online` suffix). `GROUNDED_ENGINE` is added only when
    configured; `GROUNDED_MAX_RESULTS` always has a value (default 5). None (no key) otherwise."""
    if not grounded:
        return None
    s = s or settings()
    plugin: dict[str, Any] = {"id": WEB_PLUGIN_ID}
    if s.grounded_engine:
        plugin["engine"] = s.grounded_engine
    if s.grounded_max_results > 0:
        plugin["max_results"] = int(s.grounded_max_results)
    return [plugin]


def title_from_prompt(prompt: str) -> str:
    """Conversation title = the first prompt truncated to 60 characters (no LLM titling)."""
    return prompt[:TITLE_MAX_CHARS]


__all__ = [
    "PURPOSE",
    "TITLE_MAX_CHARS",
    "WEB_PLUGIN_ID",
    "title_from_prompt",
    "user_message",
    "web_plugins",
]
