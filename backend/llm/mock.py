"""Mock/replay transport (owner: W1). `MOCK_OPENROUTER=1` swaps this in inside `client.py`.

Frozen surface used by the shared conftest and by every feature test:

- `reset()`: clears the (scenario, role, purpose) counters AND `calls`. Called autouse before
  every test.
- `calls`: one dict per transport call, in call order, exactly what the live transport would
  have sent: {role, purpose, model, messages, reasoning, response_format, plugins, max_tokens,
  fixture} where `fixture` is "<scenario>/<role>.<purpose>.<n>.jsonl" (the file actually
  served, so a sticky-last hit names the last existing file), "recorded/<sha256>.jsonl", or None
  on mock_miss.

Lookup (docs/fixtures.md): `settings()` is read on EVERY call (`MOCK_SCENARIO`,
`MOCK_FIXTURES_DIR`, `MOCK_DELAY_MS`). Precedence: `recorded/<sha256>.jsonl` (key =
`schemas.canonical_request_key(model, messages, response_format)`), else
`scenarios/<MOCK_SCENARIO>/<role>.<purpose>.<n>.jsonl` with `n = 1 + earlier scenario lookups
for the same (scenario, role, purpose)` -- sticky-last when the counter runs past the last
existing file -- else a mid-stream `mock_miss` error chunk. Every fixture line is fed as
`data: <line>` through the real `parse_sse_lines`; `MOCK_DELAY_MS` paces the replayed deltas.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from ..config import settings
from ..schemas import Delta, canonical_request_key
from .errors import ERROR_TYPE_MOCK_MISS, MOCK_MISS
from .stream import parse_sse_lines

log = logging.getLogger("triplex.llm.mock")

calls: list[dict[str, Any]] = []
_counters: dict[tuple[str, str, str], int] = {}


def reset() -> None:
    """Clear counters and captured calls."""
    calls.clear()
    _counters.clear()


def counters() -> dict[tuple[str, str, str], int]:
    """Read-only view of the (scenario, role, purpose) counters (tests)."""
    return dict(_counters)


def existing_numbers(scenario_dir: Path, role: str, purpose: str) -> list[int]:
    """Sorted `n` of every `<role>.<purpose>.<n>.jsonl` under `scenario_dir` ([] when the
    directory does not exist yet). Shared with the live tee so recordings continue numbering."""
    pattern = re.compile(rf"^{re.escape(role)}\.{re.escape(purpose)}\.(\d+)\.jsonl$")
    nums: list[int] = []
    if not scenario_dir.is_dir():
        return nums
    for p in scenario_dir.iterdir():
        m = pattern.match(p.name)
        if m and p.is_file():
            nums.append(int(m.group(1)))
    return sorted(nums)


def resolve_scenario_file(
    fixtures_dir: Path, scenario: str, role: str, purpose: str, n: int
) -> tuple[Path, int] | None:
    """The file to serve for call number `n`: exact match, else sticky-last (the highest
    existing number below `n`), else None (mock_miss)."""
    scenario_dir = fixtures_dir / "scenarios" / scenario
    nums = existing_numbers(scenario_dir, role, purpose)
    if not nums:
        return None
    if n in nums:
        k = n
    else:
        lower = [k for k in nums if k < n]
        if not lower:
            return None
        k = max(lower)
    return scenario_dir / f"{role}.{purpose}.{k}.jsonl", k


def mock_miss_line(scenario: str, role: str, purpose: str, n: int) -> str:
    return json.dumps(
        {
            "error": {
                "code": MOCK_MISS,
                "message": f"no fixture {scenario}/{role}.{purpose}.{n}",
                "metadata": {"error_type": ERROR_TYPE_MOCK_MISS},
            }
        },
        ensure_ascii=False,
    )


def _read_lines(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8") as fh:
        return [ln.rstrip("\r\n") for ln in fh if ln.strip()]


async def stream(
    *,
    role: str,
    purpose: str,
    model: str,
    messages: list[dict[str, Any]],
    reasoning: dict[str, Any] | None,
    response_format: dict[str, Any] | None,
    plugins: list[dict[str, Any]] | None,
    max_tokens: int | None,
) -> AsyncIterator[Delta]:
    """Replay the fixture for this call as Deltas (same stream shape as the live transport)."""
    s = settings()
    fixtures_dir = s.mock_fixtures_dir
    scenario = s.mock_scenario
    delay_s = max(s.mock_delay_ms, 0) / 1000.0

    fixture: str | None = None
    lines: list[str]

    key = canonical_request_key(model, messages, response_format)
    recorded = fixtures_dir / "recorded" / f"{key}.jsonl"
    if recorded.is_file():
        fixture = f"recorded/{key}.jsonl"
        lines = _read_lines(recorded)
    else:
        ck = (scenario, role, purpose)
        n = _counters.get(ck, 0) + 1
        _counters[ck] = n
        found = resolve_scenario_file(fixtures_dir, scenario, role, purpose, n)
        if found is None:
            fixture = None
            lines = [mock_miss_line(scenario, role, purpose, n)]
            log.warning(
                "mock_miss: no fixture %s/%s.%s.%s under %s",
                scenario,
                role,
                purpose,
                n,
                fixtures_dir,
            )
        else:
            path, k = found
            fixture = f"{scenario}/{role}.{purpose}.{k}.jsonl"
            lines = _read_lines(path)

    calls.append(
        {
            "role": role,
            "purpose": purpose,
            "model": model,
            "messages": [dict(m) for m in messages],
            "reasoning": reasoning,
            "response_format": response_format,
            "plugins": plugins,
            "max_tokens": max_tokens,
            "fixture": fixture,
        }
    )

    deltas = list(parse_sse_lines(f"data: {ln}" for ln in lines))
    for i, d in enumerate(deltas):
        if i and delay_s:
            await asyncio.sleep(delay_s)
        yield d
