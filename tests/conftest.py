"""Shared pytest fixtures (frozen after Stage 0; per-area fixtures go in tests/<area>/conftest.py).

Environment is set BEFORE any backend import so config.settings() sees mock mode everywhere.
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault("MOCK_OPENROUTER", "1")
os.environ.setdefault("MOCK_SCENARIO", "planted_factual")
os.environ.setdefault("MOCK_DELAY_MS", "0")
os.environ.setdefault("SESSION_COST_CAP_USD", "10")
os.environ.setdefault("LOG_LEVEL", "WARNING")
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="triplex-tests-"))

import httpx  # noqa: E402
import pytest  # noqa: E402
import respx  # noqa: E402

from backend.config import DEFAULT_SLOT_CONFIG  # noqa: E402
from backend.schemas import (  # noqa: E402
    Conversation,
    Label,
    SendTurn,
    SlotId,
    ThreadMessage,
    empty_threads,
)
from tests.helpers import assert_no_identity_leak as _assert_no_identity_leak  # noqa: E402
from tests.helpers import find_identity_leaks, messages_text, parse_sse_text  # noqa: E402

__all__ = ["find_identity_leaks", "messages_text", "parse_sse_text"]

DEFAULT_ANON: dict[Label, SlotId] = {"R1": "claude", "R2": "chatgpt", "R3": "grok"}
DEFAULT_PROMPT = "What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?"
DEFAULT_RESPONSES: dict[SlotId, str] = {
    "claude": "The BMI088 gyroscope full-scale range is selectable up to 2000 deg/s.",
    "chatgpt": "Its gyroscope tops out at 1000 deg/s full scale.",
    "grok": "The gyro supports ranges from 125 up to 2000 deg/s.",
}


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    yield


@pytest.fixture(autouse=True)
def _mock_reset():
    from backend.llm import mock

    mock.reset()
    yield


@pytest.fixture(autouse=True)
def _block_outbound_http(request):
    """Every non-live test runs with outbound HTTP blocked: any unmocked request fails."""
    if "live" in request.keywords:
        yield None
        return
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        yield router


@pytest.fixture(autouse=True)
def _no_real_key(request, monkeypatch):
    """Non-live tests never see a real key and always run in mock mode, even if the shell exports
    one. Live tests (-m live) take OPENROUTER_API_KEY from the shell or .env (config loads .env
    lazily with override=False); tests/live/conftest.py sets MOCK_OPENROUTER=0 and skips when the
    key is absent."""
    if "live" not in request.keywords:
        monkeypatch.setenv("OPENROUTER_API_KEY", "")
        monkeypatch.setenv("MOCK_OPENROUTER", "1")
    yield


@pytest.fixture
def anon_map() -> dict[Label, SlotId]:
    return dict(DEFAULT_ANON)


@pytest.fixture
def make_conversation():
    """In-memory Conversation factory built from schemas only (no store)."""

    def _mk(
        *,
        with_send: bool = True,
        prompt: str = DEFAULT_PROMPT,
        responses: dict[SlotId, str | None] | None = None,
        anon: dict[Label, SlotId] | None = None,
        title: str = "Test conversation",
    ) -> Conversation:
        conv = Conversation(
            title=title,
            slot_config=DEFAULT_SLOT_CONFIG.model_copy(deep=True),
            threads=empty_threads(),
            anon_map=dict(anon or DEFAULT_ANON),
        )
        if with_send:
            resp = dict(responses or DEFAULT_RESPONSES)
            turn = SendTurn(prompt=prompt, responses=resp, slot_config=conv.slot_config)
            for slot, text in resp.items():
                if text is None:
                    continue
                conv.threads[slot].extend(
                    [
                        ThreadMessage(role="user", content=prompt, turn_id=turn.id),
                        ThreadMessage(role="assistant", content=text, turn_id=turn.id),
                    ]
                )
            conv.turns.append(turn)
        return conv

    return _mk


@pytest.fixture
async def persisted_conversation(make_conversation):
    """A conversation written through the real store (lazy import: needs W2)."""
    from backend.store import conversations as store

    src = make_conversation()
    conv = await store.create(slot_config=src.slot_config, title=src.title, anon_map=src.anon_map)
    for slot, msgs in src.threads.items():
        if msgs:
            await store.append_to_thread(conv.id, slot, msgs)
    for turn in src.turns:
        await store.append_turn(conv.id, turn)
    return await store.load(conv.id)


@pytest.fixture
def app():
    from backend.main import create_app

    return create_app()


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.fixture
def assert_no_identity_leak():
    return _assert_no_identity_leak
