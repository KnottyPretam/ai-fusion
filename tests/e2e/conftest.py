"""Per-area fixtures for tests/e2e (owned by the e2e-offline workstream). Shared fixtures live in
tests/conftest.py.

Offline end-to-end flows: every test drives the REAL HTTP API through the ASGI `client`
(create -> PUT slot_config -> send -> analyze -> fusion -> continue -> GET) against the committed
mock corpus (`backend/llm/fixtures/scenarios/<name>`, docs/fixtures.md), switching scenario with
`MOCK_SCENARIO` (+ `mock.reset()`) and reading what reached the models from
`backend.llm.mock.calls`. Nothing here monkeypatches feature code or the LLM client.

- `api`: a thin recorder around the shared `client`; every response is kept, asserted < 500 and
  asserted never to contain the string "anon_map" (docs/semantics.md: stripped from every API
  response).
- `run_flow`: `await run_flow("stalemate")` runs a scenario's whole flow and returns a `Flow`
  (events, responses, the final `GET` document and the README's machine-readable expectations).
- Golden helpers: `normalise_turn` / `leaves` make persisted turns snapshot-stable (turn ids ->
  placeholders, `ts` -> "<ts>", `latency_ms` -> 0, `generation_id` -> "<gen>").
- `meter_rows` mirrors the frontend meter's `meterFromConversation` so the cost-meter tests can
  assert the UI recomputes exactly the persisted totals.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.llm import mock
from backend.schemas import SLOT_IDS
from tests.helpers import find_identity_leaks, parse_sse_text

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = REPO_ROOT / "backend" / "llm" / "fixtures" / "scenarios"
LOCAL_FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

CONV_URL = "/api/conversations/{cid}"
SEND_URL = "/api/conversations/{cid}/send"
CONTINUE_URL = "/api/conversations/{cid}/slots/{slot}/continue"
ANALYZE_URL = "/api/conversations/{cid}/analyze"
FUSION_URL = "/api/conversations/{cid}/fusion"
SLOT_CONFIG_URL = "/api/conversations/{cid}/slot_config"

LABEL_OF = {"claude": "R1", "chatgpt": "R2", "grok": "R3"}  # the fixed mock anon map
SLOT_OF = {v: k for k, v in LABEL_OF.items()}

# Every committed scenario, in docs/fixtures.md table order.
ALL_SCENARIOS = [
    "baseline",
    "planted_factual",
    "stalemate",
    "standing_at_cap",
    "unjustified_revise",
    "analyst_retry",
    "analyst_degrade",
    "slot_failure",
    "fusion_slot_error",
    "truncated",
    "grounded",
    "injection",
    "vendor_in_prompt",
    "two_divergences",
]
# The `max_iterations` each README's call sequence was written for (default cap otherwise).
MAX_ITERATIONS_FOR = {"standing_at_cap": 5, "two_divergences": 2}
DEFAULT_MAX_ITERATIONS = 2
# Purposes whose payloads carry Triplex-authored text (analyst prompts, challenges, convergence).
TRIPLEX_PURPOSES = ("extraction", "defense", "convergence")
CHAT_FILES = [f"{slot}.chat.1.jsonl" for slot in SLOT_IDS]
EXTRACTION_1 = "analyst.extraction.1.jsonl"
CONVERGENCE_1 = "analyst.convergence.1.jsonl"

_DELIMITED_RE = re.compile(r"<<<([^>]+)>>>\n(.*?)\n<<<END \1>>>", re.S)


# --------------------------------------------------------------------------- fixture readers
def fixture_path(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> Path:
    return root / scenario / name


def fixture_chunks(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> list[dict[str, Any]]:
    text = fixture_path(scenario, name, root).read_text(encoding="utf-8")
    return [json.loads(ln) for ln in text.splitlines() if ln.strip()]


def fixture_text(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> str:
    """Concatenated `choices[0].delta.content` (exactly what the mock yields as text)."""
    parts: list[str] = []
    for chunk in fixture_chunks(scenario, name, root):
        choices = chunk.get("choices") or []
        if choices and isinstance(choices[0].get("delta"), dict):
            content = choices[0]["delta"].get("content")
            if isinstance(content, str):
                parts.append(content)
    return "".join(parts)


def fixture_is_error(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> bool:
    return "error" in fixture_chunks(scenario, name, root)[-1]


def fixture_usage(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> dict[str, Any] | None:
    """The `usage` object of the fixture's final chunk (None for an error fixture)."""
    last = fixture_chunks(scenario, name, root)[-1]
    usage = last.get("usage")
    return dict(usage) if isinstance(usage, dict) else None


def fixture_cost(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> float:
    usage = fixture_usage(scenario, name, root) or {}
    return float(usage.get("cost") or 0.0)


def fixture_generation_id(scenario: str, name: str, root: Path = SCENARIOS_DIR) -> str | None:
    """The first chunk's `id` (what the mock reports as generation_id)."""
    first = fixture_chunks(scenario, name, root)[0]
    gid = first.get("id")
    return gid if isinstance(gid, str) and gid else None


def scenario_expectations(scenario: str) -> dict[str, Any]:
    """The machine-readable block at the end of the scenario README (the last ```json fence)."""
    text = (SCENARIOS_DIR / scenario / "README.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```json\n(.*?)\n```", text, flags=re.S)
    assert blocks, f"{scenario}/README.md has no ```json expectations block"
    exp = json.loads(blocks[-1])
    assert exp["scenario"] == scenario
    return exp


def scenario_prompt(scenario: str) -> str:
    return scenario_expectations(scenario)["prompt"]


def scenario_send(scenario: str) -> tuple[str, dict[str, str | None]]:
    """(prompt, {slot: reply text | None}) of the scenario's send turn; an errored slot -> None."""
    responses: dict[str, str | None] = {}
    for slot in SLOT_IDS:
        name = f"{slot}.chat.1.jsonl"
        responses[slot] = None if fixture_is_error(scenario, name) else fixture_text(scenario, name)
    return scenario_prompt(scenario), responses


def readme_sequence(scenario: str) -> list[str]:
    """Every fixture file the README's call sequence expects, in phase order, ` (sticky)`
    markers stripped (the mock names the file actually served, which IS the sticky one)."""
    files: list[str] = []
    for phase in scenario_expectations(scenario)["sequence"]:
        files.extend(f.replace(" (sticky)", "") for f in phase["files"])
    return files


def readme_served_by_role(scenario: str) -> dict[str, list[str]]:
    """`{role: [file, ...]}` in call order per role (slots run in parallel, so only the per-role
    order and the total count are fully determined)."""
    out: dict[str, list[str]] = {}
    for f in readme_sequence(scenario):
        out.setdefault(f.split(".", 1)[0], []).append(f)
    return out


def extraction_obj(scenario: str, n: int = 1) -> dict[str, Any]:
    return json.loads(fixture_text(scenario, f"analyst.extraction.{n}.jsonl"))


def defense_obj(scenario: str, slot: str, n: int = 1) -> dict[str, Any]:
    return json.loads(fixture_text(scenario, f"{slot}.defense.{n}.jsonl"))


# --------------------------------------------------------------------------- prompt helpers
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


def one(events: list[dict[str, Any]], kind: str, slot: str | None = None) -> dict[str, Any]:
    hits = [e for e in by_type(events, kind) if slot is None or e.get("slot") == slot]
    assert len(hits) == 1, f"expected exactly one {kind} for {slot or 'the stream'}, got {hits}"
    return hits[0]


def for_slot(events: list[dict[str, Any]], slot: str) -> list[dict[str, Any]]:
    return [e for e in events if e.get("slot") == slot]


def slot_text(events: list[dict[str, Any]], slot: str, kind: str = "slot_delta") -> str:
    return "".join(e["text"] for e in for_slot(events, slot) if e["type"] == kind)


def exchanges_of(events: list[dict[str, Any]], round_no: int) -> dict[tuple[str, str], dict]:
    return {
        (e["divergence_id"], e["model"]): e
        for e in by_type(events, "exchange")
        if e["round"] == round_no
    }


def fusion_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The events after any auto-run `analyze_*` prefix."""
    return [e for e in events if not e["type"].startswith("analyze_")]


def assert_send_stream_invariants(
    events: list[dict[str, Any]], slots: tuple[str, ...] = SLOT_IDS
) -> None:
    """docs/api-contract.md: turn_start first, each slot's slot_start before its other events,
    exactly one slot_done | slot_error per slot, turn_done last, no `error`."""
    assert events and events[0]["type"] == "turn_start" and events[-1]["type"] == "turn_done"
    assert sorted(events[0]["slots"]) == sorted(slots)
    assert events[-1]["turn_id"] == events[0]["turn_id"]
    assert "error" not in types_of(events)
    for slot in slots:
        mine = for_slot(events, slot)
        assert mine and mine[0]["type"] == "slot_start", f"{slot}: slot_start not first"
        terminals = [e for e in mine if e["type"] in ("slot_done", "slot_error")]
        assert len(terminals) == 1 and mine[-1] is terminals[0], f"{slot}: {types_of(mine)}"


def assert_fusion_stream_invariants(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Ordering rules of a completed Fusion stream; returns the FusionTurn dict it carries."""
    body = fusion_events(events)
    assert body and body[0]["type"] == "fusion_start" and body[-1]["type"] == "fusion_done"
    assert "error" not in types_of(body)
    start, done = body[0], body[-1]
    turn = done["turn"]
    assert turn["type"] == "fusion" and turn["id"] == start["turn_id"]
    assert turn["of_analyze"] == start["of_analyze"]
    assert turn["max_iterations"] == start["max_iterations"]
    assert turn["standing"] == start["standing"]
    assert turn["exit_reason"] == done["exit_reason"] and turn["usage"] == done["usage"]
    rounds = by_type(body, "round_done")
    n = len(rounds)
    assert [r["round"] for r in by_type(body, "round_start")] == list(range(1, n + 1))
    assert [r["round"] for r in rounds] == list(range(1, n + 1)) and len(turn["rounds"]) == n
    current = 0
    for e in body[1:-1]:
        if e["type"] == "round_start":
            current = e["round"]
        elif e["type"] == "exchange":
            assert e["round"] == current, f"exchange outside its round: {e}"
        elif e["type"] == "round_done":
            assert e["round"] == current
            current = 0
        else:  # pragma: no cover - contract violation
            raise AssertionError(f"unexpected event inside the loop: {e['type']}")
    for rd, persisted in zip(rounds, turn["rounds"], strict=True):
        assert persisted["round"] == rd["round"] and persisted["changed"] == rd["changed"]
        assert persisted["post_round_status"] == rd["post_round_status"]
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


def served_name(call: dict[str, Any]) -> str | None:
    f = call["fixture"]
    return f.split("/", 1)[1] if isinstance(f, str) else None


def served_all() -> list[str | None]:
    """Every served fixture name in call order (None for a mock_miss)."""
    return [served_name(c) for c in mock.calls]


def served(role: str, purpose: str) -> list[str | None]:
    return [served_name(c) for c in calls(purpose, role)]


def served_by_role() -> dict[str, list[str | None]]:
    out: dict[str, list[str | None]] = {}
    for c in mock.calls:
        out.setdefault(c["role"], []).append(served_name(c))
    return out


def challenge_of(call: dict[str, Any]) -> str:
    """The Triplex-authored challenge: the last (user) message of a defense payload."""
    assert call["purpose"] == "defense"
    last = call["messages"][-1]
    assert last["role"] == "user"
    return last["content"]


@dataclass(frozen=True)
class AuthoredMessage:
    call_index: int
    message_index: int
    role: str  # the call's role (slot id or analyst)
    purpose: str
    message_role: str
    content: str


def triplex_messages() -> list[AuthoredMessage]:
    """Every message of every analyst / defense / convergence payload, in order."""
    out: list[AuthoredMessage] = []
    for i, c in enumerate(mock.calls):
        if c["purpose"] not in TRIPLEX_PURPOSES:
            continue
        for j, m in enumerate(c["messages"]):
            out.append(
                AuthoredMessage(i, j, c["role"], c["purpose"], m["role"], str(m.get("content", "")))
            )
    return out


def raw_replies_served(root: Path = SCENARIOS_DIR) -> list[str]:
    """The raw text of every served chat / defense fixture: the slot replies that are out of
    scope for leak checks (docs/semantics.md scope rule)."""
    out: list[str] = []
    for c in mock.calls:
        if c["purpose"] not in ("chat", "defense") or not isinstance(c["fixture"], str):
            continue
        scenario, name = c["fixture"].split("/", 1)
        if scenario == "recorded":
            continue
        out.append(fixture_text(scenario, name, root))
    return [t for t in out if t]


def leak_report(allow: list[str]) -> dict[tuple[int, int], list[str]]:
    """`{(call, message): leaks}` over every Triplex-authored message; empty means clean."""
    report: dict[tuple[int, int], list[str]] = {}
    for m in triplex_messages():
        leaks = find_identity_leaks(m.content, allow)
        if leaks:
            report[(m.call_index, m.message_index)] = leaks
    return report


# --------------------------------------------------------------------------- golden normaliser
TS_PLACEHOLDER = "<ts>"
GEN_PLACEHOLDER = "<gen>"
TURN_REF_KEYS = ("id", "of_turn", "of_analyze")


def turn_placeholders(conv: dict[str, Any]) -> dict[str, str]:
    """`{turn id: "<turn-N:type>"}` in the conversation's turn order (stable across runs)."""
    return {t["id"]: f"<turn-{i}:{t['type']}>" for i, t in enumerate(conv["turns"], start=1)}


def normalise_turn(turn: dict[str, Any], ids: dict[str, str]) -> dict[str, Any]:
    """A snapshot-stable copy of a persisted turn: turn references (`id`, `of_turn`,
    `of_analyze`) -> placeholders, `ts` -> "<ts>", `latency_ms` -> 0, `generation_id` ->
    "<gen>" (None stays None so an absent id is still visible). Everything else is untouched:
    `leaves()` lets tests prove that."""

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out: dict[str, Any] = {}
            for k, v in node.items():
                if k in TURN_REF_KEYS and isinstance(v, str) and v in ids:
                    out[k] = ids[v]
                elif k == "ts":
                    out[k] = TS_PLACEHOLDER
                elif k == "generation_id":
                    out[k] = None if v is None else GEN_PLACEHOLDER
                elif k == "latency_ms":
                    out[k] = 0
                else:
                    out[k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(turn)


def normalise_turns(conv: dict[str, Any]) -> list[dict[str, Any]]:
    ids = turn_placeholders(conv)
    return [normalise_turn(t, ids) for t in conv["turns"]]


def leaves(doc: Any, prefix: tuple[Any, ...] = ()) -> dict[tuple[Any, ...], Any]:
    """`{path: scalar}` for every leaf of a JSON document (lists indexed by position)."""
    if isinstance(doc, dict):
        out: dict[tuple[Any, ...], Any] = {}
        for k, v in doc.items():
            out.update(leaves(v, (*prefix, k)))
        return out
    if isinstance(doc, list):
        out = {}
        for i, v in enumerate(doc):
            out.update(leaves(v, (*prefix, i)))
        return out
    return {prefix: doc}


# --------------------------------------------------------------------------- meter mirror
ROW_KEYS = (
    "prompt_tokens",
    "completion_tokens",
    "reasoning_tokens",
    "cost_usd",
    "latency_ms",
    "calls",
    "truncated",
)


def empty_row() -> dict[str, float | int]:
    return {k: 0 for k in ROW_KEYS}


def add_row(row: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for k in ROW_KEYS:
        out[k] = out[k] + (delta.get(k) or 0)
    out["cost_usd"] = round(out["cost_usd"], 8)
    return out


def meter_rows(conv: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Python mirror of `meterFromConversation` (frontend/src/features/meter/slice.js): the
    cumulative per-feature rows the UI recomputes from the persisted turns (send AND continue
    both book under Send; `truncated` counts truncated slots)."""
    rows = {"send": empty_row(), "analyze": empty_row(), "fusion": empty_row()}
    for turn in conv.get("turns", []):
        totals = dict(turn.get("usage", {}).get("totals", {}))
        kind = turn["type"]
        if kind == "send":
            totals["truncated"] = sum(1 for v in (turn.get("truncated") or {}).values() if v)
            rows["send"] = add_row(rows["send"], totals)
        elif kind == "continue":
            totals["truncated"] = 1 if turn.get("truncated") else 0
            rows["send"] = add_row(rows["send"], totals)
        elif kind in ("analyze", "fusion"):
            totals["truncated"] = 0
            rows[kind] = add_row(rows[kind], totals)
    return rows


# --------------------------------------------------------------------------- HTTP recorder
class Api:
    """The shared ASGI client with bookkeeping: every response is recorded, must be < 500 and
    must never contain the string "anon_map"."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client
        self.responses: list[httpx.Response] = []

    async def request(self, method: str, url: str, **kw: Any) -> httpx.Response:
        r = await self.client.request(method, url, **kw)
        self.responses.append(r)
        assert r.status_code < 500, f"{method} {url} -> {r.status_code}: {r.text[:500]}"
        assert "anon_map" not in r.text, f"anon_map leaked by {method} {url}"
        return r

    async def create(self, **body: Any) -> dict[str, Any]:
        r = await self.request("POST", "/api/conversations", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    async def get(self, cid: str) -> dict[str, Any]:
        r = await self.request("GET", CONV_URL.format(cid=cid))
        assert r.status_code == 200, r.text
        return r.json()

    async def list(self) -> list[dict[str, Any]]:
        r = await self.request("GET", "/api/conversations")
        assert r.status_code == 200, r.text
        return r.json()

    async def get_slot_config(self, cid: str) -> dict[str, Any]:
        r = await self.request("GET", SLOT_CONFIG_URL.format(cid=cid))
        assert r.status_code == 200, r.text
        return r.json()

    async def put_slot_config(self, cid: str, cfg: dict[str, Any]) -> dict[str, Any]:
        r = await self.request("PUT", SLOT_CONFIG_URL.format(cid=cid), json=cfg)
        assert r.status_code == 200, r.text
        return r.json()

    async def _stream(
        self, url: str, body: dict[str, Any] | None
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r = await self.request("POST", url, json=body)
        if r.status_code == 200:
            assert r.headers["content-type"].startswith("text/event-stream"), r.headers
            return r, parse_sse_text(r.text)
        return r, []

    async def send(self, cid: str, prompt: str) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r, events = await self._stream(SEND_URL.format(cid=cid), {"prompt": prompt})
        assert r.status_code == 200, r.text
        return r, events

    async def cont(
        self, cid: str, slot: str, prompt: str
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        r, events = await self._stream(CONTINUE_URL.format(cid=cid, slot=slot), {"prompt": prompt})
        assert r.status_code == 200, r.text
        return r, events

    async def analyze(
        self, cid: str, body: dict[str, Any] | None = None
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        return await self._stream(ANALYZE_URL.format(cid=cid), body or {})

    async def fusion(
        self, cid: str, body: dict[str, Any]
    ) -> tuple[httpx.Response, list[dict[str, Any]]]:
        return await self._stream(FUSION_URL.format(cid=cid), body)


@pytest.fixture
def api(client: httpx.AsyncClient) -> Api:
    return Api(client)


@pytest.fixture
def scenario(monkeypatch) -> Callable[[str], str]:
    """Switch the mock scenario (and reset the mock counters) for the rest of the test."""

    def _set(name: str) -> str:
        monkeypatch.setenv("MOCK_SCENARIO", name)
        mock.reset()
        return name

    return _set


# --------------------------------------------------------------------------- the flow driver
@dataclass
class Flow:
    scenario: str
    cid: str
    prompt: str
    expectations: dict[str, Any]
    max_iterations: int
    send_events: list[dict[str, Any]]
    send_turn_id: str
    analyze: httpx.Response | None = None
    analyze_events: list[dict[str, Any]] = field(default_factory=list)
    fusion: httpx.Response | None = None
    fusion_events: list[dict[str, Any]] = field(default_factory=list)
    conv: dict[str, Any] = field(default_factory=dict)  # GET after every step

    def turns(self, kind: str) -> list[dict[str, Any]]:
        return [t for t in self.conv["turns"] if t["type"] == kind]

    @property
    def send_turn(self) -> dict[str, Any]:
        return next(t for t in self.conv["turns"] if t["id"] == self.send_turn_id)

    @property
    def analyze_turn(self) -> dict[str, Any] | None:
        """The turn carried by the explicit Analyze stream's final event (None on a 409)."""
        if self.analyze is None or self.analyze.status_code != 200:
            return None
        return self.analyze_events[-1]["turn"]

    @property
    def fusion_turn(self) -> dict[str, Any] | None:
        """The persisted FusionTurn (None when Fusion was refused or ended in `error`)."""
        if self.fusion is None or self.fusion.status_code != 200:
            return None
        last = self.fusion_events[-1]
        return last["turn"] if last["type"] == "fusion_done" else None

    def threads(self, slot: str) -> list[dict[str, Any]]:
        return self.conv["threads"][slot]


@pytest.fixture
def run_flow(api: Api, scenario) -> Callable[..., Awaitable[Flow]]:
    """`await run_flow("planted_factual")`: switch the scenario, create a conversation
    (optionally PUT `grounded`), drive Send, Analyze (unless `analyze=False`) and Fusion (unless
    `fusion=False`; `max_iterations` defaults to the README's) through the API, then GET the
    document. Every response is recorded on `api.responses`; `mock.calls` keeps the whole
    per-role call sequence for README assertions."""

    async def _run(
        name: str,
        *,
        max_iterations: int | None = None,
        grounded: bool = False,
        analyze: bool = True,
        fusion: bool = True,
        fusion_body: dict[str, Any] | None = None,
    ) -> Flow:
        scenario(name)
        conv = await api.create()
        cid = conv["id"]
        if grounded:
            cfg = conv["slot_config"]
            cfg["grounded"] = True
            stored = await api.put_slot_config(cid, cfg)
            assert stored["grounded"] is True
        prompt = scenario_prompt(name)
        _, send_events = await api.send(cid, prompt)
        cap = MAX_ITERATIONS_FOR.get(name, DEFAULT_MAX_ITERATIONS)
        if max_iterations is not None:
            cap = max_iterations
        flow = Flow(
            scenario=name,
            cid=cid,
            prompt=prompt,
            expectations=scenario_expectations(name),
            max_iterations=cap,
            send_events=send_events,
            send_turn_id=send_events[0]["turn_id"],
        )
        if analyze:
            flow.analyze, flow.analyze_events = await api.analyze(cid)
        if fusion:
            body = {"max_iterations": cap, **(fusion_body or {})}
            flow.fusion, flow.fusion_events = await api.fusion(cid, body)
        flow.conv = await api.get(cid)
        return flow

    return _run
