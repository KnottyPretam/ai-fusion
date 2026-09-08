"""Mock/replay transport (owner: W1). Frozen surface used by the shared conftest and by every
feature test:

- `reset()`: clears the (scenario, role, purpose) counters AND `calls`. Called autouse before
  every test.
- `calls`: one dict per transport call, in call order, exactly what the live transport would
  have sent: {role, purpose, model, messages, reasoning, response_format, plugins, max_tokens,
  fixture} where `fixture` is "<scenario>/<role>.<purpose>.<n>.jsonl" or None on mock_miss.
  Feature tests assert on `mock.calls` (payload contents, leak scans, call sequence) instead of
  monkeypatching the client.
"""

from __future__ import annotations

from typing import Any

calls: list[dict[str, Any]] = []


def reset() -> None:
    """Clear counters and captured calls. Counters live here once W1 lands."""
    calls.clear()
