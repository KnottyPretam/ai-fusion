#!/usr/bin/env python3
"""Stage 4 live smoke test for the Triplex LLM layer: real backend modules, no server.

Runs, in order, and prints one block per step:

1. the model catalog (`catalog.get_catalog`) and where it came from (network / disk / fixture);
2. one short prompt per slot of `settings().default_slot_config` through
   `llm.client.stream_completion` with that slot's configured effort -- model, effort
   configured -> applied (and whether it was coerced), tokens, reasoning_tokens, cost, latency and
   the first 80 characters of the reply;
3. `complete_json` for the analyst with the `Extraction` schema over three canned answers --
   validity, agreement/divergence counts, attempts;
4. one grounded call (`plugins=[{"id": "web", ...}]`, `backend.prompts.send.web_plugins`) --
   the number of distinct citations.

Safety: refuses to run when `settings().openrouter_api_key` is None or `MOCK_OPENROUTER=1`,
unless `--allow-mock` is given (then the fixtures of `MOCK_SCENARIO` are replayed and nothing is
recorded -- the mock transport never tees). The session cost cap (`SESSION_COST_CAP_USD`) is
enforced by the client on every live call; `--budget-usd` (default 0.50) lowers that cap for this
process, and the run stops at the first `cost_cap_exceeded` refusal. `--record DIR` sets
`MOCK_RECORD_DIR` so every live call is teed into replayable fixtures (docs/fixtures.md).

    uv run python scripts/live_smoke.py                        # needs OPENROUTER_API_KEY in .env
    uv run python scripts/live_smoke.py --record data/recordings/smoke --budget-usd 0.25
    MOCK_OPENROUTER=1 MOCK_SCENARIO=grounded uv run python scripts/live_smoke.py --allow-mock

Exit codes: 0 every check passed; 1 a check failed (a slot errored, the analyst JSON was
invalid, the grounded call returned no citation); 2 refused to run; 3 the cost budget/cap was hit.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # `python scripts/live_smoke.py` puts scripts/ first
    sys.path.insert(0, str(REPO_ROOT))

from backend.config import ANALYST_EFFORT, MAX_TOKENS_STAGE, settings  # noqa: E402
from backend.llm import catalog, metering  # noqa: E402
from backend.llm import client as llm_client  # noqa: E402
from backend.llm import reasoning as reasoning_mod  # noqa: E402
from backend.llm.errors import COST_CAP_EXCEEDED  # noqa: E402
from backend.prompts import analyze as analyze_prompts  # noqa: E402
from backend.prompts.send import PURPOSE as CHAT_PURPOSE  # noqa: E402
from backend.prompts.send import web_plugins  # noqa: E402
from backend.schemas import Extraction, Label, SlotSpec, Usage  # noqa: E402

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_REFUSED = 2
EXIT_BUDGET = 3

DEFAULT_BUDGET_USD = 0.50
DEFAULT_MAX_TOKENS = 256
# OpenRouter floors an Anthropic reasoning budget at 1024 tokens and requires `max_tokens` to be
# strictly higher than that budget (docs/openrouter-notes.md, "Reasoning Max Tokens for
# Anthropic Models"). Whether adaptive-thinking Claude models ignore the floor is not verified,
# so an anthropic-vendor call with reasoning on never sends less than this. It is a cap, not a
# spend: a one-sentence answer stays a one-sentence answer.
ANTHROPIC_MIN_MAX_TOKENS = 1100
PREVIEW_CHARS = 80

DEFAULT_PROMPT = "In one sentence: what does an inertial measurement unit measure?"
DEFAULT_GROUNDED_PROMPT = (
    "What is the latest stable release version of the Linux kernel as of today? "
    "Answer in one sentence and cite the source."
)
# Three canned answers with one planted disagreement (R2's gyro range), vendor-free.
CANNED_QUESTION = "What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?"
CANNED_ANSWERS: dict[Label, str] = {
    "R1": "The BMI088 gyroscope full-scale range is selectable up to 2000 deg/s.",
    "R2": "Its gyroscope tops out at 1000 deg/s full scale.",
    "R3": "The gyro supports ranges from 125 up to 2000 deg/s.",
}


# --------------------------------------------------------------------------- results
@dataclass
class CallResult:
    role: str
    model: str
    effort: str | None
    applied: str
    coerced: bool
    text: str = ""
    reasoning_chars: int = 0
    citation_urls: list[str] = field(default_factory=list)
    usage: Usage | None = None
    truncated: bool = False
    error_code: Any = None
    error_type: str | None = None
    error_message: str | None = None

    @property
    def ok(self) -> bool:
        return self.error_code is None and self.usage is not None

    @property
    def cost_capped(self) -> bool:
        return self.error_code == COST_CAP_EXCEEDED


def preview(text: str, n: int = PREVIEW_CHARS) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= n else flat[:n] + "..."


def fmt_usage(u: Usage | None) -> str:
    if u is None:
        return "usage=none"
    return (
        f"tokens={u.prompt_tokens}/{u.completion_tokens} reasoning_tokens={u.reasoning_tokens} "
        f"cost=${u.cost_usd:.6f} latency={u.latency_ms}ms"
    )


def describe_effort(r: CallResult) -> str:
    configured = r.effort if r.effort is not None else "(none)"
    if r.coerced:
        return f"{configured}->{r.applied} (coerced)"
    return f"{configured}->{r.applied}"


# --------------------------------------------------------------------------- safety
def refusal(allow_mock: bool) -> str | None:
    """Why this run must not proceed, or None."""
    s = settings()
    if s.mock_openrouter:
        if allow_mock:
            return None
        return (
            "MOCK_OPENROUTER=1: refusing to run the live smoke test against replay fixtures "
            "(pass --allow-mock to replay MOCK_SCENARIO instead of calling OpenRouter)"
        )
    if s.openrouter_api_key is None:
        return "OPENROUTER_API_KEY is not set (put it in .env): refusing to run"
    return None


def apply_budget(budget_usd: float) -> float:
    """Lower SESSION_COST_CAP_USD for this process to `budget_usd` when it is smaller; returns
    the cap in force (the client refuses every live call once the session total reaches it)."""
    cap = settings().session_cost_cap_usd
    if budget_usd < cap:
        os.environ["SESSION_COST_CAP_USD"] = repr(float(budget_usd))
        cap = float(budget_usd)
    return cap


# --------------------------------------------------------------------------- calls
def reasoning_max_tokens(model: str, applied: str, max_tokens: int) -> int:
    """`max_tokens` for a chat call: at least ANTHROPIC_MIN_MAX_TOKENS when the model's vendor
    is `anthropic` and the applied effort is not `off` (see the constant), else unchanged."""
    meta = catalog.get_meta(model)
    vendor = meta.vendor if meta is not None else model.split("/", 1)[0]
    if vendor == "anthropic" and applied != "off":
        return max(max_tokens, ANTHROPIC_MIN_MAX_TOKENS)
    return max_tokens


async def call_chat(
    role: str,
    spec: SlotSpec,
    prompt: str,
    *,
    max_tokens: int,
    plugins: list[dict[str, Any]] | None = None,
) -> CallResult:
    meta = catalog.get_meta(spec.model)
    _param, applied, coerced = reasoning_mod.build(spec.effort, meta)
    r = CallResult(
        role=role, model=spec.model, effort=spec.effort, applied=applied, coerced=coerced
    )
    seen: set[str] = set()
    async for d in llm_client.stream_completion(
        role=role,
        purpose=CHAT_PURPOSE,
        model=spec.model,
        messages=[{"role": "user", "content": prompt}],
        effort=spec.effort,
        max_tokens=reasoning_max_tokens(spec.model, applied, max_tokens),
        plugins=plugins,
    ):
        if d.kind == "text":
            r.text += d.text
        elif d.kind == "reasoning":
            r.reasoning_chars += len(d.text)
        elif d.kind == "citations":
            for item in d.items:
                uc = item.get("url_citation") if isinstance(item, dict) else None
                url = uc.get("url") if isinstance(uc, dict) else None
                key = url if isinstance(url, str) and url else repr(item)
                if key not in seen:
                    seen.add(key)
                    r.citation_urls.append(key)
        elif d.kind == "done":
            r.usage = d.usage
            r.truncated = bool(d.truncated)
        elif d.kind == "error":
            r.error_code = d.code
            r.error_type = d.error_type
            r.error_message = d.message
    return r


def print_call(r: CallResult, *, label: str | None = None) -> None:
    tag = f"[{label or r.role}]"
    if r.error_code is not None:
        print(
            f"{tag} model={r.model} effort={describe_effort(r)} ERROR code={r.error_code} "
            f"error_type={r.error_type} message={r.error_message!r}"
        )
        if r.text:
            print(f"{' ' * len(tag)} partial: {preview(r.text)!r}")
        return
    print(
        f"{tag} model={r.model} effort={describe_effort(r)} {fmt_usage(r.usage)} "
        f"truncated={'yes' if r.truncated else 'no'} reasoning_chars={r.reasoning_chars}"
        + (f" citations={len(r.citation_urls)}" if r.citation_urls else "")
    )
    print(f"{' ' * len(tag)} text: {preview(r.text)!r}")


# --------------------------------------------------------------------------- the run
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="live_smoke.py",
        description="Triplex live smoke test: one call per slot, an analyst extraction, one "
        "grounded call (real backend modules, no server).",
    )
    p.add_argument(
        "--allow-mock",
        action="store_true",
        help="run in MOCK_OPENROUTER=1 mode (replays MOCK_SCENARIO; nothing is recorded)",
    )
    p.add_argument(
        "--record",
        metavar="DIR",
        default=None,
        help="tee every live call into DIR as replayable fixtures (sets MOCK_RECORD_DIR)",
    )
    p.add_argument(
        "--budget-usd",
        type=float,
        default=DEFAULT_BUDGET_USD,
        help=f"lower SESSION_COST_CAP_USD to this for the run (default {DEFAULT_BUDGET_USD})",
    )
    p.add_argument("--prompt", default=DEFAULT_PROMPT, help="the per-slot prompt")
    p.add_argument(
        "--grounded-prompt", default=DEFAULT_GROUNDED_PROMPT, help="the grounded-mode prompt"
    )
    p.add_argument(
        "--grounded-slot",
        default="claude",
        choices=["claude", "chatgpt", "grok"],
        help="which slot's model makes the grounded call (default claude)",
    )
    p.add_argument(
        "--max-tokens",
        type=int,
        default=DEFAULT_MAX_TOKENS,
        help=f"max_tokens for the chat calls (default {DEFAULT_MAX_TOKENS}; an anthropic-vendor "
        f"call with reasoning on sends at least {ANTHROPIC_MIN_MAX_TOKENS}, the provider's "
        "reasoning-budget floor)",
    )
    p.add_argument(
        "--skip-grounded", action="store_true", help="skip the grounded (web search) call"
    )
    return p


async def run(args: argparse.Namespace) -> int:
    why = refusal(args.allow_mock)
    if why:
        print(f"REFUSED: {why}")
        return EXIT_REFUSED
    if args.record:
        record_dir = Path(args.record).expanduser().resolve()
        os.environ["MOCK_RECORD_DIR"] = str(record_dir)
    cap = apply_budget(args.budget_usd)

    s = settings()
    cfg = s.default_slot_config
    mode = (
        f"MOCK (scenario={s.mock_scenario}, fixtures={s.mock_fixtures_dir})"
        if s.mock_openrouter
        else "LIVE"
    )
    print(f"triplex live smoke: mode={mode} base_url={s.openrouter_base_url}")
    print(
        f"  cost cap in force: ${cap:.2f} (SESSION_COST_CAP_USD); "
        f"record dir: {s.mock_record_dir or '-'}"
    )
    if s.mock_openrouter and s.mock_record_dir:
        print("  note: the mock transport never records; --record has no effect in mock mode")

    failures: list[str] = []
    usages: list[Usage] = []
    started = time.monotonic()

    # 1. catalog
    print("\n== catalog ==")
    models = await catalog.get_catalog()
    print(f"models={len(models)} source={catalog.cache_source() or '-'}")
    for slot, spec in cfg.slots.items():
        meta = catalog.get_meta(spec.model)
        known = "known" if meta is not None else "UNKNOWN to the catalog"
        extra = ""
        if meta is not None:
            extra = (
                f" efforts={meta.efforts} mandatory={meta.mandatory_reasoning} "
                f"structured_outputs={meta.structured_outputs}"
            )
        print(f"  {slot}: {spec.model} ({known}){extra}")
    analyst_meta = catalog.get_meta(cfg.analyst_model)
    print(
        f"  analyst: {cfg.analyst_model} "
        f"(structured_outputs={analyst_meta.structured_outputs if analyst_meta else 'unknown'})"
    )

    # 2. one prompt per slot, with the configured effort
    print(
        f"\n== send: one prompt per slot (max_tokens={args.max_tokens}; anthropic with "
        f"reasoning on: >= {ANTHROPIC_MIN_MAX_TOKENS}) =="
    )
    print(f"prompt: {args.prompt!r}")
    for slot, spec in cfg.slots.items():
        r = await call_chat(slot, spec, args.prompt, max_tokens=args.max_tokens)
        print_call(r)
        if r.cost_capped:
            return _budget_exit(r, usages, started)
        if r.usage is not None:
            usages.append(r.usage)
        if not r.ok:
            failures.append(f"{slot}: {r.error_code} {r.error_message}")
        elif not r.text.strip():
            failures.append(f"{slot}: empty reply")

    # 3. analyst extraction over canned answers
    print("\n== analyst: complete_json(Extraction) over three canned answers ==")
    messages = analyze_prompts.build_messages(CANNED_QUESTION, CANNED_ANSWERS)
    parsed, raw, usage, error = await llm_client.complete_json(
        role="analyst",
        purpose="extraction",
        model=cfg.analyst_model,
        messages=messages,
        schema_model=Extraction,
        effort=ANALYST_EFFORT,
        max_tokens=MAX_TOKENS_STAGE["extraction"],
        retries=1,
    )
    usages.extend(usage.calls)
    rf = (
        "response_format=json_schema"
        if analyst_meta and analyst_meta.structured_outputs
        else ("response_format=none (lenient parse only)")
    )
    if error == COST_CAP_EXCEEDED:
        print(f"[analyst] model={cfg.analyst_model} ERROR code={COST_CAP_EXCEEDED}")
        return _budget_exit(None, usages, started)
    if isinstance(parsed, Extraction):
        print(
            f"[analyst] model={cfg.analyst_model} effort={ANALYST_EFFORT} {rf} valid=yes "
            f"agreements={len(parsed.agreements)} divergences={len(parsed.divergences)} "
            f"attempts={usage.totals.calls} cost=${usage.totals.cost_usd:.6f} "
            f"latency={usage.totals.latency_ms}ms"
        )
        for d in parsed.divergences:
            print(f"          {d.id} [{d.materiality}] {preview(d.topic, 60)!r}")
    else:
        print(
            f"[analyst] model={cfg.analyst_model} effort={ANALYST_EFFORT} {rf} valid=NO "
            f"attempts={usage.totals.calls} error={preview(error or 'unknown', 160)!r}"
        )
        if raw:
            print(f"          raw: {preview(raw, 120)!r}")
        failures.append(f"analyst: {error}")

    # 4. grounded call
    if args.skip_grounded:
        print("\n== grounded: skipped (--skip-grounded) ==")
    else:
        spec = cfg.slots[args.grounded_slot]
        plugins = web_plugins(True, settings())
        print(f"\n== grounded: {args.grounded_slot} with plugins={plugins} ==")
        print(f"prompt: {args.grounded_prompt!r}")
        r = await call_chat(
            args.grounded_slot,
            spec,
            args.grounded_prompt,
            max_tokens=max(args.max_tokens, 512),
            plugins=plugins,
        )
        print_call(r, label=f"{args.grounded_slot}/grounded")
        if r.cost_capped:
            return _budget_exit(r, usages, started)
        if r.usage is not None:
            usages.append(r.usage)
        for url in r.citation_urls[:5]:
            print(f"          citation: {url}")
        if not r.ok:
            failures.append(f"grounded: {r.error_code} {r.error_message}")
        elif not r.citation_urls:
            failures.append("grounded: no citation returned")

    _summary(usages, started)
    if failures:
        print("\nFAILED checks:")
        for f in failures:
            print(f"  - {f}")
        return EXIT_FAILED
    print("\nall checks passed")
    return EXIT_OK


def _summary(usages: list[Usage], started: float) -> None:
    total = sum(u.cost_usd for u in usages)
    status = metering.session_cost_status()
    print(
        f"\n== summary == calls={len(usages)} cost_sum=${total:.6f} "
        f"session_total=${status['spent_usd']:.6f} cap=${status['cap_usd']:.2f} "
        f"enforced={'yes' if status['enforced'] else 'no (mock)'} "
        f"wall={int((time.monotonic() - started) * 1000)}ms"
    )


def _budget_exit(r: CallResult | None, usages: list[Usage], started: float) -> int:
    msg = r.error_message if r is not None else None
    print(f"\nCOST CAP HIT: {msg or 'the client refused the call (cost_cap_exceeded)'}")
    _summary(usages, started)
    return EXIT_BUDGET


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
