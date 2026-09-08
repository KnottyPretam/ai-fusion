"""Per-area fixtures for tests/store (owned by W2). Shared fixtures live in tests/conftest.py."""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest

from backend.config import settings


@pytest.fixture
def conv_dir() -> Callable[[], Path]:
    """The conversations directory of the CURRENT DATA_DIR (resolved at call time, like the store)."""
    return lambda: settings().data_dir / "conversations"


@pytest.fixture
def run_foreign() -> Callable[[Awaitable], Awaitable]:
    """Run a coroutine in a task with a FRESH contextvars.Context, i.e. one that is not a
    descendant of the calling task -- the way a second HTTP request reaches the store."""

    async def _run(coro):
        return await asyncio.create_task(coro, context=contextvars.Context())

    return _run
