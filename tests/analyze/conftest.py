"""Per-area fixtures for tests/analyze (owned by W5). Shared fixtures live in tests/conftest.py.

Scenario helpers read the committed mock corpus (`backend/llm/fixtures/scenarios/<name>`): the
user prompt from the README's machine-readable block and each slot's reply from the text deltas of
`<slot>.chat.1.jsonl` (None when that fixture ends with an error chunk), so a persisted
conversation reproduces exactly the send turn the scenario's analyst fixture was written for.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.llm import mock
from backend.schemas import SLOT_IDS, Conversation, SlotId
from backend.store import conversations as store
from tests.helpers import parse_sse_text

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = REPO_ROOT / "backend" / "llm" / "fixtures" / "scenarios"
LOCAL_FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

_JSON_BLOCK_RE = re.compile(r"```json\n(.*?)\n```", re.DOTALL)
BLOCK_RE = re.compile(r"<<<(R[123])>>>\n(.*?)\n<<<END \1>>>", re.DOTALL)


# --------------------------------------------------------------------------- scenario corpus
def fixture_text(path: Path) -> tuple[str, bool]:
    """(concatenated content deltas, ended_with_error) of one JSONL fixture."""
    parts: list[str] = []
    errored = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        doc = json.loads(line)
        if "error" in doc:
            errored = True
        for choice in doc.get("choices") or []:
            content = (choice.get("delta") or {}).get("content")
            if content:
                parts.append(content)
    return "".join(parts), errored


def scenario_expectations(scenario: str) -> dict[str, Any]:
    """The README's machine-readable expectations block."""
    readme = (SCENARIOS_DIR / scenario / "README.md").read_text(encoding="utf-8")
    m = _JSON_BLOCK_RE.search(readme)
    assert m, f"no machine-readable block in {scenario}/README.md"
    return json.loads(m.group(1))


def scenario_send(scenario: str) -> tuple[str, dict[SlotId, str | None]]:
    """(prompt, responses) of the scenario's send turn; an errored slot maps to None."""
    prompt = scenario_expectations(scenario)["prompt"]
    responses: dict[SlotId, str | None] = {}
    for slot in SLOT_IDS:
        text, errored = fixture_text(SCENARIOS_DIR / scenario / f"{slot}.chat.1.jsonl")
        responses[slot] = None if errored else text
    return prompt, responses


def extraction_text(scenario: str, n: int = 1) -> str:
    return fixture_text(SCENARIOS_DIR / scenario / f"analyst.extraction.{n}.jsonl")[0]


def blocks_of(user_content: str) -> dict[str, str]:
    """The delimited R-label blocks of an analyst user message."""
    return {m.group(1): m.group(2) for m in BLOCK_RE.finditer(user_content)}


def outside_blocks(user_content: str) -> str:
    return BLOCK_RE.sub(" ", user_content)


async def persist(src: Conversation) -> Conversation:
    """Write an in-memory conversation through the real store (same shape as the shared
    `persisted_conversation` fixture) and return the stored document."""
    conv = await store.create(slot_config=src.slot_config, title=src.title, anon_map=src.anon_map)
    for slot, msgs in src.threads.items():
        if msgs:
            await store.append_to_thread(conv.id, slot, msgs)
    for turn in src.turns:
        await store.append_turn(conv.id, turn)
    loaded = await store.load(conv.id)
    assert loaded is not None
    return loaded


@pytest.fixture
def scenario_conversation(make_conversation, monkeypatch):
    """`await scenario_conversation("analyst_retry")`: switch MOCK_SCENARIO, reset the mock, and
    persist a conversation whose send turn reproduces that scenario's chat fixtures."""

    async def _mk(scenario: str, **kw: Any) -> Conversation:
        monkeypatch.setenv("MOCK_SCENARIO", scenario)
        mock.reset()
        prompt, responses = scenario_send(scenario)
        return await persist(make_conversation(prompt=prompt, responses=responses, **kw))

    return _mk


@pytest.fixture
def local_fixtures(monkeypatch) -> Callable[[str], None]:
    """Serve the scenarios under tests/analyze/fixtures instead of the packaged corpus."""

    def _use(scenario: str) -> None:
        monkeypatch.setenv("MOCK_FIXTURES_DIR", str(LOCAL_FIXTURES_DIR))
        monkeypatch.setenv("MOCK_SCENARIO", scenario)
        mock.reset()

    return _use


# --------------------------------------------------------------------------- HTTP helpers
@pytest.fixture
def analyze(client: httpx.AsyncClient):
    """POST /api/conversations/{id}/analyze -> (response, events)."""

    async def _post(
        conv_id: str, body: dict[str, Any] | None = None
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r = await client.post(f"/api/conversations/{conv_id}/analyze", json=body or {})
        events = parse_sse_text(r.text) if r.status_code == 200 else []
        return r, events

    return _post


@pytest.fixture
def refactor(client: httpx.AsyncClient):
    """POST /api/conversations/{id}/refactor -> (response, events). Shares this conftest because
    Refactor is the pass that feeds Analyze and every fixture here (the analyst scenarios, the
    conversation factory, `extraction_calls`) is exactly what its tests need."""

    async def _post(
        conv_id: str, body: dict[str, Any] | None = None
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r = await client.post(f"/api/conversations/{conv_id}/refactor", json=body or {})
        events = parse_sse_text(r.text) if r.status_code == 200 else []
        return r, events

    return _post


@pytest.fixture
def get_conversation(client: httpx.AsyncClient):
    async def _get(conv_id: str) -> dict[str, Any]:
        r = await client.get(f"/api/conversations/{conv_id}")
        assert r.status_code == 200, r.text
        return r.json()

    return _get


def extraction_calls() -> list[dict[str, Any]]:
    return [c for c in mock.calls if c["role"] == "analyst" and c["purpose"] == "extraction"]


# --------------------------------------------------------------------------- busy guard
@pytest.fixture
def hold_busy():
    """`async with hold_busy(conv_id):` holds the busy guard from a FOREIGN task/context (the way
    another HTTP request would), so the test's own request is not re-entrant."""

    @asynccontextmanager
    async def _hold(conv_id: str) -> AsyncIterator[None]:
        acquired, release = asyncio.Event(), asyncio.Event()

        async def holder() -> None:
            guard = store.busy_guard(conv_id)
            await guard.__aenter__()
            acquired.set()
            try:
                await release.wait()
            finally:
                await guard.__aexit__(None, None, None)

        task = asyncio.create_task(holder(), context=contextvars.Context())
        await acquired.wait()
        try:
            yield
        finally:
            release.set()
            await task

    return _hold


@pytest.fixture
def run_foreign() -> Callable[[Awaitable[Any]], Awaitable[Any]]:
    """Run a coroutine in a task with a fresh contextvars.Context (a second HTTP request)."""

    async def _run(coro: Awaitable[Any]) -> Any:
        return await asyncio.create_task(coro, context=contextvars.Context())

    return _run


async def wait_until_free(conv_id: str, timeout_s: float = 5.0) -> None:
    """Wait for a detached producer task to release the busy guard."""
    deadline = asyncio.get_running_loop().time() + timeout_s
    while store.is_busy(conv_id):
        assert asyncio.get_running_loop().time() < deadline, "producer never released the guard"
        await asyncio.sleep(0.005)
