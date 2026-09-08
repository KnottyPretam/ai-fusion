"""Frozen test helpers importable from every test area (`from tests.helpers import ...`)."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable

from backend.config import FORBIDDEN_IDENTITY_STRINGS

_FORBIDDEN_RE = re.compile(
    r"(?<![A-Za-z0-9])("
    + "|".join(re.escape(s) for s in FORBIDDEN_IDENTITY_STRINGS)
    + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)


def parse_sse_text(text: str) -> list[dict]:
    """Turn a raw text/event-stream body into the list of JSON events (comments skipped)."""
    events: list[dict] = []
    for frame in text.split("\n\n"):
        for line in frame.splitlines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def find_identity_leaks(text: str, allow: Iterable[str] = ()) -> list[str]:
    """Forbidden identity strings present in `text` after excising the allowed verbatim
    substrings (user prompts, raw model responses) that are out of scope for leak checks."""
    for a in allow:
        if a:
            text = text.replace(a, " ")
    return sorted({m.group(1).lower() for m in _FORBIDDEN_RE.finditer(text)})


def assert_no_identity_leak(
    text: str, allow: Iterable[str] = (), extra_forbidden: Iterable[str] = ()
) -> None:
    leaks = find_identity_leaks(text, allow)
    low = text.lower()
    for s in extra_forbidden:
        if s and s.lower() in low:
            leaks.append(s)
    assert not leaks, f"identity leak in Triplex-authored text: {leaks}"


def messages_text(messages: list[dict]) -> str:
    """Concatenate an OpenAI-style messages list for leak scanning."""
    return "\n".join(str(m.get("content", "")) for m in messages)
