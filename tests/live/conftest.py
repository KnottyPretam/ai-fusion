"""Per-area fixtures for tests/live: the manual live-API smoke tests (`uv run pytest -m live`).

- Every test collected from this directory is marked `live`, so the default run
  (`addopts = -m 'not live'`) deselects it and the shared conftest neither blocks outbound HTTP
  nor blanks the key for it.
- The whole directory is SKIPPED when `settings().openrouter_api_key` is None (no key in the
  shell or `.env`): the tests never fail for want of a key.
- `MOCK_OPENROUTER=0` is set for every test here (docs/semantics.md, "Live tests"); a
  `MOCK_RECORD_DIR` in the environment is honoured, so a live run can double as a recording.
- `live_budget` tracks the cost of the whole session (PLAN.md Stage 4: cumulative < $0.50).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from backend.config import settings

HERE = Path(__file__).resolve().parent
LIVE_BUDGET_USD = 0.50
NO_KEY_REASON = "OPENROUTER_API_KEY is not set (shell or .env): live tests skipped"


def _is_live_item(item: pytest.Item) -> bool:
    try:
        return Path(str(item.path)).resolve().is_relative_to(HERE)
    except (OSError, ValueError):  # pragma: no cover - defensive
        return False


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    missing_key = settings().openrouter_api_key is None
    for item in items:
        if not _is_live_item(item):
            continue
        item.add_marker(pytest.mark.live)
        if missing_key:
            item.add_marker(pytest.mark.skip(reason=NO_KEY_REASON))


@pytest.fixture(autouse=True)
def _live_mode(monkeypatch: pytest.MonkeyPatch):
    """Real transport for every test here; the key comes from the shell or .env."""
    monkeypatch.setenv("MOCK_OPENROUTER", "0")
    if settings().openrouter_api_key is None:  # belt and braces: never call without a key
        pytest.skip(NO_KEY_REASON)
    yield


@pytest.fixture(scope="session")
def live_budget() -> Callable[[], float]:
    """Returns a callable giving the live cost (USD) accrued since the session started."""
    from backend.llm import metering

    start = metering.session_cost_usd()
    return lambda: metering.session_cost_usd() - start
