#!/usr/bin/env python3
"""Stage 4 recorder: capture a live Send -> Analyze -> Fusion session as a replayable scenario.

Drives the REAL app in-process (`httpx.ASGITransport` over `backend.main.create_app()`, no
server) with `MOCK_RECORD_DIR=<fixtures-dir>/scenarios/<scenario>`, so the LLM client tees every
live call into the fixture format of docs/fixtures.md: `<role>.<purpose>.<n>.jsonl` (numbered
per role/purpose), `recorded/<sha256>.jsonl` (content-keyed, served first on replay) and
`requests.jsonl` (one line per call: payload + both names). It then writes a `README.md` skeleton
in the shipped-scenario layout (files table, exact per-role call sequence, machine-readable
expectations block) and prints the file list and the total cost.

The conversation is created with the FIXED anonymization map R1=claude, R2=chatgpt, R3=grok
(`store.MOCK_ANON_MAP`), the map every mock replay uses: the recorded analyst and challenge
fixtures therefore name the same labels on replay as they did live.

Safety: refuses to run when `settings().openrouter_api_key` is None or `MOCK_OPENROUTER=1`,
unless `--allow-mock` is given (then the flow replays `MOCK_SCENARIO` and, since the mock
transport never tees, only the README is written). It also refuses a target directory that
already holds `*.jsonl` fixtures (numbering would continue and the README would lie). The
session cost cap is enforced by the client; `--budget-usd` (default 2.00) lowers it for this
process.

    uv run python scripts/record_fixtures.py --scenario bmi088_live
    uv run python scripts/record_fixtures.py --scenario grounded_live --grounded --max-iterations 1
    # replay through the per-role counters (any prompt; sticky-last):
    MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR=data/recordings MOCK_SCENARIO=bmi088_live ./start.sh
    # replay content-keyed (only the exact recorded requests; `recorded/<sha256>.jsonl`):
    MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR=data/recordings/scenarios/bmi088_live ./start.sh

Exit codes: 0 recorded; 1 the flow failed (an HTTP error, a terminal `error` event);
2 refused; 3 the cost budget/cap was hit.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # `python scripts/record_fixtures.py` puts scripts/ first
    sys.path.insert(0, str(REPO_ROOT))

from backend.config import MAX_ITERATIONS_CAP, settings  # noqa: E402
from backend.llm import catalog, metering  # noqa: E402
from backend.llm.client import extract_json  # noqa: E402
from backend.llm.errors import COST_CAP_EXCEEDED  # noqa: E402
from backend.llm.stream import parse_sse_lines  # noqa: E402
from backend.main import create_app  # noqa: E402
from backend.schemas import (  # noqa: E402
    MATERIALITY_RANK,
    ConvergenceCheck,
    DefenseReply,
    Extraction,
)
from backend.store import conversations as store  # noqa: E402

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_REFUSED = 2
EXIT_BUDGET = 3

DEFAULT_BUDGET_USD = 2.0
DEFAULT_FIXTURES_DIR = REPO_ROOT / "data" / "recordings"
DEFAULT_PROMPT = (
    "What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU, and which "
    "register selects it?"
)
LABEL_OF = {"claude": "R1", "chatgpt": "R2", "grok": "R3"}
ROLE_ORDER = ["claude", "chatgpt", "grok", "analyst"]
PURPOSE_ORDER = ["chat", "extraction", "defense", "convergence"]
BASE_URL = "http://triplex.local"


# --------------------------------------------------------------------------- safety
def refusal(allow_mock: bool) -> str | None:
    s = settings()
    if s.mock_openrouter:
        if allow_mock:
            return None
        return (
            "MOCK_OPENROUTER=1: refusing to record from replay fixtures (pass --allow-mock to "
            "run the flow against MOCK_SCENARIO anyway; nothing is recorded in mock mode)"
        )
    if s.openrouter_api_key is None:
        return "OPENROUTER_API_KEY is not set (put it in .env): refusing to run"
    return None


def apply_budget(budget_usd: float) -> float:
    cap = settings().session_cost_cap_usd
    if budget_usd < cap:
        os.environ["SESSION_COST_CAP_USD"] = repr(float(budget_usd))
        cap = float(budget_usd)
    return cap


# --------------------------------------------------------------------------- SSE over ASGI
def parse_sse_text(text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for frame in text.split("\n\n"):
        for line in frame.splitlines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


class FlowError(Exception):
    def __init__(self, message: str, *, budget: bool = False) -> None:
        super().__init__(message)
        self.budget = budget


async def post_sse(client: httpx.AsyncClient, url: str, body: dict[str, Any]) -> list[dict]:
    """POST a feature endpoint; the ASGI transport buffers the whole stream, so the events are
    returned together once the feature finished (and persisted). Raises FlowError on a
    pre-stream JSON error or a terminal `error` event."""
    r = await client.post(url, json=body)
    if r.status_code != 200:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = r.text[:200]
        raise FlowError(f"{url} -> HTTP {r.status_code} {detail}")
    events = parse_sse_text(r.text)
    if events and events[-1].get("type") == "error":
        msg = str(events[-1].get("message"))
        raise FlowError(f"{url} -> error event: {msg}", budget=msg == COST_CAP_EXCEEDED)
    return events


def _cost_capped(events: list[dict[str, Any]]) -> bool:
    return any(
        e.get("code") == COST_CAP_EXCEEDED
        or e.get("error") == COST_CAP_EXCEEDED
        or (isinstance(e.get("turn"), dict) and e["turn"].get("error") == COST_CAP_EXCEEDED)
        for e in events
    )


# --------------------------------------------------------------------------- the flow
@dataclass
class Outcome:
    prompt: str
    conv_id: str
    send_events: list[dict[str, Any]] = field(default_factory=list)
    analyze_events: list[dict[str, Any]] = field(default_factory=list)
    fusion_events: list[dict[str, Any]] = field(default_factory=list)
    fusion_skipped: str | None = None
    conversation: dict[str, Any] | None = None

    @property
    def analyze_turn(self) -> dict[str, Any] | None:
        for e in self.analyze_events:
            if e.get("type") in ("analyze_done", "analyze_degraded"):
                return e.get("turn")
        return None

    @property
    def analyze_status(self) -> str | None:
        t = self.analyze_turn
        return t.get("status") if t else None

    @property
    def fusion_done(self) -> dict[str, Any] | None:
        for e in self.fusion_events:
            if e.get("type") == "fusion_done":
                return e
        return None

    @property
    def exit_reason(self) -> str | None:
        fd = self.fusion_done
        return fd.get("exit_reason") if fd else None

    @property
    def final(self) -> dict[str, str] | None:
        fd = self.fusion_done
        if not fd:
            return None
        return {s["divergence_id"]: s["status"] for s in fd["turn"].get("final", [])}

    def rounds(self) -> list[dict[str, Any]]:
        fd = self.fusion_done
        return list(fd["turn"].get("rounds", [])) if fd else []

    def standing(self, materiality_min: str) -> list[str]:
        t = self.analyze_turn
        if not t or not t.get("extraction"):
            return []
        floor = MATERIALITY_RANK[materiality_min]
        return [
            d["id"]
            for d in t["extraction"]["divergences"]
            if MATERIALITY_RANK[d["materiality"]] >= floor
        ]


def _print_send(events: list[dict[str, Any]]) -> None:
    for e in events:
        t = e["type"]
        if t == "slot_start":
            print(
                f"  slot_start {e['slot']} model={e['model']} effort={e['effort']}"
                + (" (coerced)" if e.get("effort_coerced") else "")
            )
        elif t == "slot_done":
            u = e["usage"]
            print(
                f"  slot_done  {e['slot']} tokens={u['prompt_tokens']}/{u['completion_tokens']} "
                f"reasoning_tokens={u['reasoning_tokens']} cost=${u['cost_usd']:.6f} "
                f"latency={u['latency_ms']}ms truncated={'yes' if e['truncated'] else 'no'}"
            )
        elif t == "slot_error":
            print(f"  slot_error {e['slot']} code={e['code']} message={e['message']!r}")
        elif t == "slot_citations":
            print(f"  slot_citations {e['slot']} items={len(e['items'])}")
        elif t == "turn_done":
            tot = e["usage"]["totals"]
            print(f"  turn_done calls={tot['calls']} cost=${tot['cost_usd']:.6f}")


def _print_analyze(events: list[dict[str, Any]]) -> None:
    for e in events:
        t = e["type"]
        if t == "analyze_start":
            print(f"  analyze_start turn={e['turn_id']}")
        elif t == "analyze_retry":
            print(f"  analyze_retry error={str(e['error'])[:120]!r}")
        elif t in ("analyze_done", "analyze_degraded"):
            turn = e["turn"]
            tot = turn["usage"]["totals"]
            if turn.get("extraction"):
                ex = turn["extraction"]
                divs = ", ".join(f"{d['id']}[{d['materiality']}]" for d in ex["divergences"])
                print(
                    f"  {t} status={turn['status']} agreements={len(ex['agreements'])} "
                    f"divergences={divs or 'none'} calls={tot['calls']} "
                    f"cost=${tot['cost_usd']:.6f}"
                )
            else:
                print(
                    f"  {t} status={turn['status']} error={str(turn.get('error'))[:120]!r} "
                    f"calls={tot['calls']} cost=${tot['cost_usd']:.6f}"
                )


def _print_fusion(events: list[dict[str, Any]]) -> None:
    for e in events:
        t = e["type"]
        if t == "fusion_start":
            print(f"  fusion_start standing={e['standing']} max_iterations={e['max_iterations']}")
        elif t == "round_start":
            print(f"  round {e['round']}")
        elif t == "exchange":
            flag = " FLAGGED" if e.get("flagged_unjustified") else ""
            err = f" error={e['error']!r}" if e.get("error") else ""
            print(f"    {e['model']} on {e['divergence_id']}: {e['stance']}{flag}{err}")
        elif t == "round_done":
            st = ", ".join(f"{s['divergence_id']}={s['status']}" for s in e["post_round_status"])
            print(f"  round_done changed={e['changed']} status: {st}")
        elif t == "fusion_done":
            tot = e["usage"]["totals"]
            print(
                f"  fusion_done exit={e['exit_reason']} calls={tot['calls']} "
                f"cost=${tot['cost_usd']:.6f}"
            )
        elif t.startswith("analyze_"):
            _print_analyze([e])


async def run_flow(args: argparse.Namespace) -> Outcome:
    s = settings()
    cfg = s.default_slot_config
    cfg.grounded = bool(args.grounded)
    cfg.max_iterations = args.max_iterations
    conv = await store.create(
        slot_config=cfg, title=args.title or args.prompt[:60], anon_map=store.MOCK_ANON_MAP
    )
    out = Outcome(prompt=args.prompt, conv_id=conv.id)
    app = create_app()
    logging.getLogger("httpx").setLevel(logging.WARNING)  # the per-call INFO lines suffice
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL) as c:
        base = f"/api/conversations/{conv.id}"
        print(f"\n== send (conversation {conv.id}) ==")
        out.send_events = await post_sse(c, f"{base}/send", {"prompt": args.prompt})
        _print_send(out.send_events)
        if _cost_capped(out.send_events):
            raise FlowError("cost cap hit during Send", budget=True)

        print("\n== analyze ==")
        out.analyze_events = await post_sse(c, f"{base}/analyze", {})
        _print_analyze(out.analyze_events)
        if _cost_capped(out.analyze_events):
            raise FlowError("cost cap hit during Analyze", budget=True)

        standing = out.standing(cfg.materiality_min)
        print(f"\n== fusion (max_iterations={args.max_iterations}) ==")
        if out.analyze_status != "ok":
            out.fusion_skipped = "analyze_degraded"
            print("  skipped: Analyze is degraded")
        elif not standing:
            out.fusion_skipped = "nothing_to_fuse"
            print("  skipped: nothing to fuse (no divergence at or above materiality_min)")
        else:
            out.fusion_events = await post_sse(
                c, f"{base}/fusion", {"max_iterations": args.max_iterations}
            )
            _print_fusion(out.fusion_events)
            if _cost_capped(out.fusion_events):
                raise FlowError("cost cap hit during Fusion", budget=True)

        r = await c.get(base)
        r.raise_for_status()
        out.conversation = r.json()
    return out


# --------------------------------------------------------------------------- fixture inventory
@dataclass
class Entry:
    """One line of requests.jsonl plus what the fixture file contains."""

    fixture: str | None
    recorded: str | None
    role: str
    purpose: str
    model: str | None
    payload: dict[str, Any]
    info: dict[str, Any] = field(default_factory=dict)  # from describe_fixture


def describe_fixture(path: Path) -> dict[str, Any]:
    """Parse one fixture through the real SSE parser: text, finish_reason, error, cost, …"""
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    deltas = list(parse_sse_lines(f"data: {ln}" for ln in lines))
    text = "".join(d.text for d in deltas if d.kind == "text")
    urls: list[str] = []
    for d in deltas:
        if d.kind == "citations":
            for item in d.items:
                uc = item.get("url_citation") if isinstance(item, dict) else None
                if isinstance(uc, dict) and isinstance(uc.get("url"), str):
                    urls.append(uc["url"])
    info: dict[str, Any] = {
        "text": text,
        "chunks": len(lines),
        "reasoning_chunks": sum(1 for d in deltas if d.kind == "reasoning"),
        "citation_urls": urls,
        "finish_reason": None,
        "error": None,
        "cost_usd": 0.0,
    }
    last = deltas[-1] if deltas else None
    if last is not None and last.kind == "error":
        info["error"] = {"code": last.code, "error_type": last.error_type}
    elif last is not None:
        info["finish_reason"] = last.finish_reason
        info["cost_usd"] = last.usage.cost_usd if last.usage else 0.0
    return info


def read_entries(record_dir: Path) -> list[Entry]:
    reqs = record_dir / "requests.jsonl"
    if not reqs.is_file():
        return []
    entries: list[Entry] = []
    for ln in reqs.read_text(encoding="utf-8").splitlines():
        if not ln.strip():
            continue
        doc = json.loads(ln)
        e = Entry(
            fixture=doc.get("fixture"),
            recorded=doc.get("recorded"),
            role=str(doc.get("role")),
            purpose=str(doc.get("purpose")),
            model=doc.get("model"),
            payload=doc.get("payload") or {},
        )
        if e.fixture and (record_dir / e.fixture).is_file():
            e.info = describe_fixture(record_dir / e.fixture)
        entries.append(e)
    return entries


def _parse_model(text: str, cls: type) -> Any | None:
    value, _err = extract_json(text)
    if value is None:
        return None
    try:
        return cls.model_validate(value)
    except Exception:
        return None


def _sort_key(fname: str) -> tuple[int, int, int]:
    role, purpose, n, _ = fname.split(".")
    return (ROLE_ORDER.index(role), PURPOSE_ORDER.index(purpose), int(n))


def _terminates(e: Entry) -> bool:
    """A defense fixture that ended an exchange: a valid DefenseReply or a transport error
    (an invalid attempt is followed by complete_json's silent retry)."""
    if e.info.get("error"):
        return True
    return _parse_model(e.info.get("text", ""), DefenseReply) is not None


def build_expectations(
    name: str, out: Outcome, entries: list[Entry], materiality_min: str
) -> dict[str, Any]:
    files: dict[str, dict[str, Any]] = {}
    sequence: list[dict[str, Any]] = []

    # exchanges per label in event order -> zipped with that slot's terminating defense files
    exchanges_by_label: dict[str, list[dict[str, Any]]] = {}
    for rnd in out.rounds():
        for ex in rnd["exchanges"]:
            exchanges_by_label.setdefault(ex["model"], []).append(ex)
    seen_terminating: dict[str, int] = {}

    for e in entries:
        if not e.fixture:
            continue
        info = e.info
        exp: dict[str, Any] = {"kind": e.purpose}
        if e.role in LABEL_OF:
            exp["label"] = LABEL_OF[e.role]
        if e.purpose == "chat":
            exp["text"] = info.get("text", "")
        elif e.purpose == "extraction":
            parsed = _parse_model(info.get("text", ""), Extraction)
            exp["valid"] = parsed is not None
            if parsed is not None:
                exp["divergences"] = {d.id: d.materiality for d in parsed.divergences}
                exp["agreements"] = len(parsed.agreements)
            else:
                exp["invalid_reason"] = "lenient parse or schema validation failed (recorded)"
        elif e.purpose == "defense":
            reply = _parse_model(info.get("text", ""), DefenseReply)
            if reply is not None or info.get("error"):
                k = seen_terminating.get(e.role, 0)
                seen_terminating[e.role] = k + 1
                exs = exchanges_by_label.get(LABEL_OF.get(e.role, ""), [])
                if k < len(exs):
                    exp["divergence"] = exs[k]["divergence_id"]
                    if reply is not None:
                        exp["unjustified"] = bool(exs[k].get("flagged_unjustified"))
            if reply is not None:
                exp["stance"] = reply.stance
                exp["valid"] = True
            elif not info.get("error"):
                exp["valid"] = False
                exp["invalid_reason"] = "lenient parse or schema validation failed (recorded)"
        elif e.purpose == "convergence":
            cc = _parse_model(info.get("text", ""), ConvergenceCheck)
            exp["valid"] = cc is not None
            if cc is not None:
                exp["statuses"] = {s.divergence_id: s.status for s in cc.statuses}
        if info.get("error"):
            exp["error"] = info["error"]
        else:
            exp["finish_reason"] = info.get("finish_reason") or "stop"
        if info.get("reasoning_chunks"):
            exp["reasoning_blocks"] = info["reasoning_chunks"]
        if info.get("citation_urls"):
            exp["citation_urls"] = list(dict.fromkeys(info["citation_urls"]))
        files[e.fixture] = exp

    # --- sequence
    not_recorded = "not recorded (the mock transport never tees)"
    chat = [e.fixture for e in entries if e.fixture and e.purpose == "chat"]
    if chat or out.send_events:
        grounded = any(e.payload.get("plugins") for e in entries if e.purpose == "chat")
        if not chat:
            note = not_recorded
        elif grounded:
            note = "three parallel chat calls, grounded (web plugin)"
        else:
            note = "three parallel chat calls"
        sequence.append({"phase": "Send", "files": chat, "note": note})
    extraction = [e.fixture for e in entries if e.fixture and e.purpose == "extraction"]
    if extraction or out.analyze_events:
        note = f"status {out.analyze_status}"
        if len(extraction) > 1:
            note += f"; {len(extraction) - 1} retry"
        if not extraction:
            note += f"; {not_recorded}"
        sequence.append({"phase": "Analyze", "files": extraction, "note": note})
    fusion_entries = [e for e in entries if e.fixture and e.purpose in ("defense", "convergence")]
    idx = 0
    for rnd in out.rounds():
        n = rnd["round"]
        wanted = len(rnd["exchanges"])
        got = 0
        names: list[str] = []
        while idx < len(fusion_entries) and got < wanted:
            e = fusion_entries[idx]
            if e.purpose != "defense":
                break
            names.append(e.fixture or "")
            idx += 1
            if _terminates(e):
                got += 1
        if idx < len(fusion_entries) and fusion_entries[idx].purpose == "convergence":
            names.append(fusion_entries[idx].fixture or "")
            idx += 1
        stances = ", ".join(
            f"{ex['model']} {ex['stance']}"
            + (" (flagged)" if ex.get("flagged_unjustified") else "")
            for ex in rnd["exchanges"]
        )
        status = ", ".join(f"{s['divergence_id']} {s['status']}" for s in rnd["post_round_status"])
        sequence.append(
            {"phase": f"Fusion round {n}", "files": names, "note": f"{stances} -> {status}"}
        )
    leftover = [e.fixture or "" for e in fusion_entries[idx:]]
    if leftover:
        sequence.append(
            {
                "phase": "Fusion (unassigned)",
                "files": leftover,
                "note": "calls the round heuristic could not place; assign by hand",
            }
        )
    if out.fusion_skipped:
        sequence.append({"phase": "Fusion", "files": [], "note": f"no call: {out.fusion_skipped}"})
    elif out.exit_reason:
        sequence.append({"phase": "Exit", "files": [], "note": f"exit_reason {out.exit_reason}"})

    return {
        "scenario": name,
        "prompt": out.prompt,
        "anon_map": dict(store.MOCK_ANON_MAP),
        "analyze_status": out.analyze_status,
        "exit_reason": out.exit_reason,
        "final": out.final,
        "sequence": sequence,
        "files": files,
    }


def _describe(fname: str, exp: dict[str, Any], chunks: int) -> str:
    bits: list[str] = []
    kind = exp["kind"]
    if kind == "chat":
        bits.append(f"{exp.get('label', '?')} chat reply")
    elif kind == "extraction":
        if exp.get("valid"):
            divs = ", ".join(f"{d} {m}" for d, m in exp["divergences"].items()) or "none"
            bits.append(f"Extraction, {exp['agreements']} agreement(s), divergences: {divs}")
        else:
            bits.append(f"INVALID extraction ({exp.get('invalid_reason', 'unknown')})")
    elif kind == "defense":
        what = exp.get("stance") or ("error" if "error" in exp else "INVALID reply")
        if what == "revise" and "unjustified" in exp:
            what += ", unjustified" if exp["unjustified"] else ", justified"
        bits.append(f"{exp.get('label', '?')} on {exp.get('divergence', '?')}: {what}")
    else:
        st = ", ".join(f"{d} {s}" for d, s in exp.get("statuses", {}).items()) or "INVALID"
        bits.append(f"ConvergenceCheck: {st}")
    if "error" in exp:
        bits.append(f"ends with error chunk {exp['error']['code']} {exp['error']['error_type']}")
    else:
        bits.append(f"finish_reason {exp.get('finish_reason', 'stop')}")
    if exp.get("reasoning_blocks"):
        bits.append(f"{exp['reasoning_blocks']} reasoning chunk(s)")
    if exp.get("citation_urls"):
        bits.append(f"{len(exp['citation_urls'])} citation url(s)")
    bits.append(f"{chunks} chunks")
    return "; ".join(bits)


def render_readme(
    name: str,
    out: Outcome,
    entries: list[Entry],
    expectations: dict[str, Any],
    *,
    fixtures_dir: Path,
    recorded_live: bool,
) -> str:
    cfg = (out.conversation or {}).get("slot_config") or {}
    slots = cfg.get("slots", {})
    models = ", ".join(f"{s}={slots[s]['model']}@{slots[s]['effort']}" for s in slots)
    analyst = cfg.get("analyst_model", "?")
    when = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    src = "a live OpenRouter session" if recorded_live else "a MOCK replay (nothing recorded)"
    chunks_of = {e.fixture: e.info.get("chunks", 0) for e in entries if e.fixture}

    outcome_bits = []
    ok_slots = [e["slot"] for e in out.send_events if e["type"] == "slot_done"]
    err_slots = [e["slot"] for e in out.send_events if e["type"] == "slot_error"]
    outcome_bits.append(
        f"Send -> slot_done for {', '.join(ok_slots) or 'no slot'}"
        + (f", slot_error for {', '.join(err_slots)}" if err_slots else "")
    )
    t = out.analyze_turn
    if t and t.get("extraction"):
        ex = t["extraction"]
        divs = ", ".join(f"{d['id']} ({d['materiality']})" for d in ex["divergences"]) or "none"
        outcome_bits.append(
            f"Analyze -> status {t['status']}, {len(ex['agreements'])} agreement(s), "
            f"divergences: {divs}"
        )
    elif t:
        outcome_bits.append(f"Analyze -> status {t['status']}")
    if out.fusion_skipped:
        outcome_bits.append(f"Fusion -> {out.fusion_skipped}")
    elif out.exit_reason:
        final = ", ".join(f"{d} {s}" for d, s in (out.final or {}).items())
        outcome_bits.append(
            f"Fusion -> exit `{out.exit_reason}` after {len(out.rounds())} "
            f"round(s), final: {final or '-'}"
        )

    lines = [f"# Scenario `{name}`", ""]
    lines += [
        f"Recorded on {when} by `scripts/record_fixtures.py` from {src} "
        f"(slots: {models or '?'}; analyst: {analyst}; grounded: "
        f"{'yes' if cfg.get('grounded') else 'no'}). "
        "TODO: describe the planted content and what this scenario is for.",
        "",
    ]
    lines += [f"**Prompt (the user prompt the test sends):** {out.prompt}", ""]
    lines += [
        f"**Expected outcome:** {'; '.join(outcome_bits)}. (Recorded outcome; edit if the "
        "fixtures are hand-tuned.)",
        "",
    ]
    lines += [
        "Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is",
        "JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the",
        "usage chunk (`usage.cost`), errors end with the error chunk.",
        "",
        "## Files",
        "",
        "| File | Content |",
        "|---|---|",
    ]
    for fname in sorted(expectations["files"], key=_sort_key):
        lines.append(
            f"| `{fname}` | {_describe(fname, expectations['files'][fname], chunks_of.get(fname, 0))} |"
        )
    if not expectations["files"]:
        lines.append("| (none) | no fixture was recorded (mock mode never tees) |")
    lines += ["", "## Exact per-role call sequence", ""]
    for i, entry in enumerate(expectations["sequence"], 1):
        files = ", ".join(f"`{f}`" for f in entry["files"]) or "(no LLM call)"
        note = f" -- {entry['note']}" if entry.get("note") else ""
        lines.append(f"{i}. {entry['phase']}: {files}{note}")
    lines += [
        "",
        "Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;",
        "within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2",
        "(standing order); sticky-last never advances beyond the last existing file. Round",
        "boundaries above were inferred from the recorded call order (parallel slots finish in",
        "any order; a silent `complete_json` retry adds an extra file): review before shipping.",
        "",
        "## Replay",
        "",
        "```bash",
        "# per-role counters (any prompt; sticky-last), the layout shipped scenarios use:",
        f"MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR={fixtures_dir} MOCK_SCENARIO={name} ./start.sh",
        "# content-keyed (exactly the recorded requests, served from recorded/<sha256>.jsonl):",
        f"MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR={fixtures_dir / 'scenarios' / name} ./start.sh",
        "```",
        "",
        "To ship this as a built-in scenario copy the directory to",
        f"`backend/llm/fixtures/scenarios/{name}/`, delete `requests.jsonl` and `recorded/`",
        "(the corpus validator allows only `<role>.<purpose>.<n>.jsonl` + `README.md`), finish the",
        "planted-content paragraph, and add the scenario row to `docs/fixtures.md` through the",
        "integrator (the validator checks the table against the directories).",
        "",
        "## Machine-readable expectations",
        "",
        "Same shape as the shipped scenarios (`tests/fixtures/test_scenarios.py`).",
        "",
        "```json",
        json.dumps(expectations, indent=2, ensure_ascii=False),
        "```",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- CLI
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="record_fixtures.py",
        description="Record a live Send -> Analyze -> Fusion session as a replayable mock "
        "scenario (docs/fixtures.md), through the ASGI app in-process.",
    )
    p.add_argument("--scenario", required=True, help="scenario name (directory under scenarios/)")
    p.add_argument(
        "--fixtures-dir",
        default=str(DEFAULT_FIXTURES_DIR),
        help="fixtures root; the recording goes to <fixtures-dir>/scenarios/<scenario> "
        f"(default {DEFAULT_FIXTURES_DIR})",
    )
    p.add_argument("--prompt", default=DEFAULT_PROMPT, help="the Send prompt")
    p.add_argument("--title", default=None, help="conversation title (default: the prompt)")
    p.add_argument(
        "--max-iterations",
        type=int,
        default=2,
        help=f"Fusion max_iterations, 1..{MAX_ITERATIONS_CAP} (default 2)",
    )
    p.add_argument("--grounded", action="store_true", help="record with grounded mode on")
    p.add_argument(
        "--allow-mock",
        action="store_true",
        help="run the flow in MOCK_OPENROUTER=1 mode (replays MOCK_SCENARIO; records nothing)",
    )
    p.add_argument(
        "--budget-usd",
        type=float,
        default=DEFAULT_BUDGET_USD,
        help=f"lower SESSION_COST_CAP_USD to this for the run (default {DEFAULT_BUDGET_USD})",
    )
    return p


async def run(args: argparse.Namespace) -> int:
    why = refusal(args.allow_mock)
    if why:
        print(f"REFUSED: {why}")
        return EXIT_REFUSED
    if not 1 <= args.max_iterations <= MAX_ITERATIONS_CAP:
        print(f"REFUSED: --max-iterations must be 1..{MAX_ITERATIONS_CAP}")
        return EXIT_REFUSED
    if not args.scenario or "/" in args.scenario or args.scenario.startswith("."):
        print("REFUSED: --scenario must be a plain directory name")
        return EXIT_REFUSED
    fixtures_dir = Path(args.fixtures_dir).expanduser().resolve()
    record_dir = fixtures_dir / "scenarios" / args.scenario
    if record_dir.exists() and any(record_dir.glob("*.jsonl")):
        print(
            f"REFUSED: {record_dir} already holds fixtures; numbering would continue from them "
            "and the README would be wrong. Pick a fresh --scenario or --fixtures-dir."
        )
        return EXIT_REFUSED
    os.environ["MOCK_RECORD_DIR"] = str(record_dir)
    cap = apply_budget(args.budget_usd)

    s = settings()
    live = not s.mock_openrouter
    mode = "LIVE" if live else f"MOCK (scenario={s.mock_scenario}, fixtures={s.mock_fixtures_dir})"
    print(f"triplex record_fixtures: mode={mode} scenario={args.scenario}")
    print(f"  record dir: {record_dir}")
    print(f"  cost cap in force: ${cap:.2f} (SESSION_COST_CAP_USD)")
    if not live:
        print("  note: the mock transport never records; only README.md will be written")
    started = time.monotonic()

    models = await catalog.get_catalog()
    print(f"  catalog: {len(models)} models (source={catalog.cache_source() or '-'})")

    try:
        out = await run_flow(args)
    except FlowError as e:
        print(f"\nFLOW FAILED: {e}")
        _print_inventory(record_dir, started)
        return EXIT_BUDGET if e.budget else EXIT_FAILED
    except httpx.HTTPStatusError as e:
        print(f"\nFLOW FAILED: {e}")
        return EXIT_FAILED

    record_dir.mkdir(parents=True, exist_ok=True)
    entries = read_entries(record_dir)
    cfg = (out.conversation or {}).get("slot_config") or {}
    expectations = build_expectations(
        args.scenario, out, entries, cfg.get("materiality_min", "medium")
    )
    readme = render_readme(
        args.scenario, out, entries, expectations, fixtures_dir=fixtures_dir, recorded_live=live
    )
    (record_dir / "README.md").write_text(readme, encoding="utf-8")

    _print_inventory(record_dir, started, conversation=out.conversation)
    print(
        f"\nreplay (counters):      MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR={fixtures_dir} "
        f"MOCK_SCENARIO={args.scenario} ./start.sh"
        f"\nreplay (content-keyed): MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR={record_dir} ./start.sh"
    )
    return EXIT_OK


def _print_inventory(
    record_dir: Path, started: float, conversation: dict[str, Any] | None = None
) -> None:
    print(f"\n== files under {record_dir} ==")
    if record_dir.is_dir():
        paths = sorted(p for p in record_dir.rglob("*") if p.is_file())
        for p in paths:
            print(f"  {p.relative_to(record_dir)}  ({p.stat().st_size} bytes)")
        if not paths:
            print("  (none)")
    else:
        print("  (directory not created: no call was recorded)")
    turn_cost = 0.0
    calls = 0
    if conversation:
        for t in conversation.get("turns", []):
            tot = (t.get("usage") or {}).get("totals") or {}
            turn_cost += float(tot.get("cost_usd", 0.0))
            calls += int(tot.get("calls", 0))
    status = metering.session_cost_status()
    print(
        f"\n== total cost == turns=${turn_cost:.6f} over {calls} call(s); "
        f"session_total=${status['spent_usd']:.6f} cap=${status['cap_usd']:.2f} "
        f"enforced={'yes' if status['enforced'] else 'no (mock)'} "
        f"wall={int((time.monotonic() - started) * 1000)}ms"
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
