"""Per-area fixtures for tests/fusion (owned by W6). Shared fixtures live in tests/conftest.py.

Everything goes through the ASGI `client` fixture and the mock transport. A scenario is prepared
by driving Send and Analyze FOR REAL through the HTTP API (its `<slot>.chat.1` and
`analyst.extraction.1` fixtures), so the full per-role call sequence captured in
`backend.llm.mock.calls` matches the scenario README end to end; Fusion is then driven the same
way. Nothing here monkeypatches the LLM client: every assertion on payloads reads `mock.calls`.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.llm import mock
from backend.schemas import SLOT_IDS, Conversation, DefenseReply, Extraction
from backend.store import conversations as store
from tests.helpers import parse_sse_text

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = REPO_ROOT / "backend" / "llm" / "fixtures" / "scenarios"

CONV_URL = "/api/conversations/{cid}"
SEND_URL = "/api/conversations/{cid}/send"
ANALYZE_URL = "/api/conversations/{cid}/analyze"
FUSION_URL = "/api/conversations/{cid}/fusion"

LABEL_OF = {"claude": "R1", "chatgpt": "R2", "grok": "R3"}  # the fixed mock anon map
SLOT_OF = {v: k for k, v in LABEL_OF.items()}

_DELIMITED_RE = re.compile(r"<<<([^>]+)>>>\n(.*?)\n<<<END \1>>>", re.S)


# --------------------------------------------------------------------------- fixture readers
def fixture_chunks(scenario: str, name: str) -> list[dict[str, Any]]:
    path = SCENARIOS_DIR / scenario / name
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def fixture_text(scenario: str, name: str) -> str:
    """Concatenated `choices[0].delta.content` (exactly what the mock yields as text)."""
    parts: list[str] = []
    for chunk in fixture_chunks(scenario, name):
        choices = chunk.get("choices") or []
        if choices and isinstance(choices[0].get("delta"), dict):
            text = choices[0]["delta"].get("content")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def fixture_cost(scenario: str, name: str) -> float:
    last = fixture_chunks(scenario, name)[-1]
    usage = last.get("usage") or {}
    return float(usage.get("cost") or 0.0)


def scenario_expectations(scenario: str) -> dict[str, Any]:
    """The machine-readable block at the end of the scenario README (last ```json fence)."""
    text = (SCENARIOS_DIR / scenario / "README.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```json\n(.*?)\n```", text, flags=re.S)
    assert blocks, f"{scenario}/README.md has no ```json expectations block"
    return json.loads(blocks[-1])


def scenario_prompt(scenario: str) -> str:
    return scenario_expectations(scenario)["prompt"]


def scenario_responses(scenario: str) -> dict[str, str]:
    files = scenario_expectations(scenario)["files"]
    return {slot: files[f"{slot}.chat.1.jsonl"]["text"] for slot in SLOT_IDS}


def extraction_of(scenario: str, n: int = 1) -> Extraction:
    return Extraction.model_validate_json(fixture_text(scenario, f"analyst.extraction.{n}.jsonl"))


def defense_of(scenario: str, slot: str, n: int = 1) -> DefenseReply:
    return DefenseReply.model_validate_json(fixture_text(scenario, f"{slot}.defense.{n}.jsonl"))


def delimited_blocks(text: str) -> dict[str, str]:
    """`{label: body}` of every `<<<LABEL>>>...<<<END LABEL>>>` block in `text`."""
    return {m.group(1): m.group(2) for m in _DELIMITED_RE.finditer(text)}


def strip_delimited(text: str) -> str:
    """Everything OUTSIDE `<<<X>>>...<<<END X>>>` blocks (the Triplex-authored part)."""
    return _DELIMITED_RE.sub(" ", text)


# --------------------------------------------------------------------------- event helpers
def types_of(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


def by_type(events: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [e for e in events if e["type"] == kind]


def one(events: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    hits = by_type(events, kind)
    assert len(hits) == 1, f"expected exactly one {kind}, got {hits}"
    return hits[0]


def exchanges_of(events: list[dict[str, Any]], round_no: int) -> dict[tuple[str, str], dict]:
    """Round `round_no`'s exchange events keyed by (divergence_id, label)."""
    return {
        (e["divergence_id"], e["model"]): e
        for e in by_type(events, "exchange")
        if e["round"] == round_no
    }


def fusion_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The events after any auto-run `analyze_*` prefix."""
    return [e for e in events if not e["type"].startswith("analyze_")]


def assert_fusion_stream_invariants(events: list[dict[str, Any]]) -> dict[str, Any]:
    """The contract's ordering rules for a completed Fusion stream: fusion_start first (after
    the optional analyze_* prefix), every round bracketed by round_start / round_done with its
    exchanges in between, fusion_done last and consistent with the persisted turn it carries.
    Returns the FusionTurn dict."""
    assert events, "empty stream"
    body = fusion_events(events)
    assert body, f"no fusion events in {types_of(events)}"
    assert body[0]["type"] == "fusion_start", types_of(events)
    assert body[-1]["type"] == "fusion_done", types_of(events)
    kinds = types_of(body)
    assert kinds.count("fusion_start") == 1 and kinds.count("fusion_done") == 1
    assert "error" not in kinds
    start, done = body[0], body[-1]
    turn = done["turn"]
    assert turn["type"] == "fusion" and turn["id"] == start["turn_id"]
    assert turn["of_analyze"] == start["of_analyze"]
    assert turn["max_iterations"] == start["max_iterations"]
    assert turn["standing"] == start["standing"]
    assert turn["exit_reason"] == done["exit_reason"]
    assert turn["usage"] == done["usage"]

    rounds = by_type(body, "round_done")
    starts = by_type(body, "round_start")
    n = len(rounds)
    assert [r["round"] for r in starts] == list(range(1, n + 1))
    assert [r["round"] for r in rounds] == list(range(1, n + 1))
    assert len(turn["rounds"]) == n
    inner = body[1:-1]
    current = 0
    for e in inner:
        if e["type"] == "round_start":
            current = e["round"]
        elif e["type"] == "exchange":
            assert e["round"] == current, f"exchange outside its round: {e}"
        elif e["type"] == "round_done":
            assert e["round"] == current
            current = 0
        else:  # pragma: no cover
            raise AssertionError(f"unexpected event inside the loop: {e['type']}")
    for i, rd in enumerate(rounds):
        persisted = turn["rounds"][i]
        assert persisted["round"] == rd["round"]
        assert persisted["post_round_status"] == rd["post_round_status"]
        assert persisted["changed"] == rd["changed"]
        assert [s["divergence_id"] for s in rd["post_round_status"]] == turn["standing"]
        emitted = exchanges_of(body, rd["round"])
        assert {(x["divergence_id"], x["model"]) for x in persisted["exchanges"]} == set(emitted)
    assert turn["final"] == rounds[-1]["post_round_status"]
    return turn


# --------------------------------------------------------------------------- mock.calls helpers
def calls(purpose: str | None = None, role: str | None = None) -> list[dict[str, Any]]:
    out = list(mock.calls)
    if purpose is not None:
        out = [c for c in out if c["purpose"] == purpose]
    if role is not None:
        out = [c for c in out if c["role"] == role]
    return out


def served(role: str, purpose: str) -> list[str | None]:
    """Served fixture file names (without the scenario prefix) for one (role, purpose)."""
    out: list[str | None] = []
    for c in calls(purpose, role):
        f = c["fixture"]
        out.append(f.split("/", 1)[1] if isinstance(f, str) else None)
    return out


def served_all() -> list[str | None]:
    """Every served fixture name in call order (None for a mock_miss)."""
    return [
        c["fixture"].split("/", 1)[1] if isinstance(c["fixture"], str) else None for c in mock.calls
    ]


def challenge_of(call: dict[str, Any]) -> str:
    """The Triplex-authored challenge: the last (user) message of a defense payload."""
    assert call["purpose"] == "defense"
    last = call["messages"][-1]
    assert last["role"] == "user"
    return last["content"]


# --------------------------------------------------------------------------- HTTP fixtures
@pytest.fixture
def scenario(monkeypatch) -> Callable[[str], str]:
    """Switch the mock scenario (and reset the mock counters) for the rest of the test."""

    def _set(name: str) -> str:
        monkeypatch.setenv("MOCK_SCENARIO", name)
        mock.reset()
        return name

    return _set


@pytest.fixture
def new_conv(client: httpx.AsyncClient) -> Callable[..., Awaitable[dict]]:
    """POST /api/conversations (body kwargs) -> the ConversationPublic dict."""

    async def _mk(**body: Any) -> dict:
        r = await client.post("/api/conversations", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    return _mk


@pytest.fixture
def get_conv(client: httpx.AsyncClient) -> Callable[[str], Awaitable[dict]]:
    async def _get(conv_id: str) -> dict:
        r = await client.get(CONV_URL.format(cid=conv_id))
        assert r.status_code == 200, r.text
        return r.json()

    return _get


@pytest.fixture
def send(client: httpx.AsyncClient) -> Callable[..., Awaitable[list[dict]]]:
    """POST .../send and return the parsed SSE events (asserts a 200 event-stream)."""

    async def _send(conv_id: str, prompt: str) -> list[dict]:
        r = await client.post(SEND_URL.format(cid=conv_id), json={"prompt": prompt})
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/event-stream")
        return parse_sse_text(r.text)

    return _send


@pytest.fixture
def analyze(client: httpx.AsyncClient):
    """POST .../analyze -> (response, events)."""

    async def _post(
        conv_id: str, body: dict[str, Any] | None = None
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r = await client.post(ANALYZE_URL.format(cid=conv_id), json=body or {})
        events = parse_sse_text(r.text) if r.status_code == 200 else []
        return r, events

    return _post


@pytest.fixture
def fusion(client: httpx.AsyncClient):
    """POST .../fusion -> (response, events)."""

    async def _post(
        conv_id: str, body: dict[str, Any] | None = None
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r = await client.post(FUSION_URL.format(cid=conv_id), json=body)
        events = parse_sse_text(r.text) if r.status_code == 200 else []
        return r, events

    return _post


@dataclass
class Prepared:
    scenario: str
    cid: str
    prompt: str
    send_turn_id: str
    analyze_turn_id: str | None
    conv: Conversation  # the stored document right before Fusion (threads + turns)


@pytest.fixture
def prepare(scenario, new_conv, send, analyze):
    """`await prepare("planted_factual")`: switch the scenario, create a conversation, drive Send
    (the scenario's chat fixtures) and, by default, Analyze (its extraction fixture) for real
    through the API. `mock.calls` keeps the whole sequence so tests can assert the README's
    per-role file order end to end."""

    async def _prepare(
        name: str,
        *,
        run_analyze: bool = True,
        slot_config: dict[str, Any] | None = None,
    ) -> Prepared:
        scenario(name)
        body: dict[str, Any] = {}
        if slot_config is not None:
            body["slot_config"] = slot_config
        cid = (await new_conv(**body))["id"]
        prompt = scenario_prompt(name)
        send_events = await send(cid, prompt)
        send_turn_id = send_events[0]["turn_id"]
        analyze_turn_id: str | None = None
        if run_analyze:
            r, events = await analyze(cid)
            assert r.status_code == 200, r.text
            assert events[-1]["type"] in ("analyze_done", "analyze_degraded"), types_of(events)
            analyze_turn_id = events[0]["turn_id"]
        conv = await store.load(cid)
        assert conv is not None
        return Prepared(
            scenario=name,
            cid=cid,
            prompt=prompt,
            send_turn_id=send_turn_id,
            analyze_turn_id=analyze_turn_id,
            conv=conv,
        )

    return _prepare


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


async def wait_until_free(conv_id: str, timeout_s: float = 5.0) -> None:
    """Wait for a detached producer task to release the busy guard."""
    deadline = asyncio.get_running_loop().time() + timeout_s
    while store.is_busy(conv_id):
        assert asyncio.get_running_loop().time() < deadline, "producer never released the guard"
        await asyncio.sleep(0.005)
