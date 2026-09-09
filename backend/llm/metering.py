"""Usage / cost metering helpers (owner: W1).

- `usage_from_chunk` builds a `Usage` from OpenRouter's final usage chunk plus wall-clock latency.
- `estimate_usage` synthesises a `Usage` when the stream ended without a usage chunk
  (catalog price x a len(text)//4 token estimate); it returns the `EstimatedUsage` marker
  subclass so the client's INFO line can say `usage=estimated`.
- `price_fallback` is the catalog-price x tokens computation shared by both. A usage chunk
  WITHOUT `cost` gets it immediately; the live client then tries `GET /generation` and overrides
  `cost_usd` with the post-hoc `total_cost` when the lookup succeeds (docs/semantics.md).
- `float_or_none` is the tolerant number parser both the parser and the client use for `cost`.
- `aggregate` folds a list of `Usage` into a `FeatureUsage`.
- `format_log_line` renders the one INFO line every LLM call logs (feature-agnostic); the live
  client passes `cost_source=chunk|generation|catalog` so a log reader can tell a real
  `usage.cost` from a fallback.
- The process-level session cost total (`SESSION_COST_CAP_USD`) lives here; the client enforces it;
  `session_cost_status()` is the one-call snapshot a footer readout or a CLI prints.
"""

from __future__ import annotations

from typing import Any

from ..schemas import FeatureUsage, Usage

# --------------------------------------------------------------------------- session cost
_session_cost_usd: float = 0.0


def session_cost_usd() -> float:
    """Running total of `cost_usd` over every LIVE call in this process."""
    return _session_cost_usd


def add_session_cost(cost_usd: float) -> float:
    global _session_cost_usd
    _session_cost_usd = round(_session_cost_usd + max(float(cost_usd or 0.0), 0.0), 10)
    return _session_cost_usd


def reset_session_cost() -> None:
    global _session_cost_usd
    _session_cost_usd = 0.0


def session_cost_status() -> dict[str, Any]:
    """Snapshot of the session cost cap for a readout (footer, CLI): `spent_usd` (the running
    live total), `cap_usd` (`SESSION_COST_CAP_USD`, read now), `remaining_usd`, `exceeded`
    (exactly the client's refusal condition, `spent >= cap`) and `enforced` (False in mock mode,
    where no call is ever refused and no cost accrues)."""
    from ..config import settings  # lazy: keep this module import-light

    s = settings()
    spent = session_cost_usd()
    cap = float(s.session_cost_cap_usd)
    return {
        "spent_usd": spent,
        "cap_usd": cap,
        "remaining_usd": round(max(cap - spent, 0.0), 10),
        "exceeded": spent >= cap,
        "enforced": not s.mock_openrouter,
    }


# --------------------------------------------------------------------------- tokens / prices
def estimate_tokens(text: str) -> int:
    """Crude fallback estimate used only when OpenRouter sent no usage chunk."""
    return len(text or "") // 4


def catalog_prices(model: str) -> tuple[float | None, float | None]:
    """(price_prompt, price_completion) in USD per token from the catalog; (None, None) if unknown."""
    from . import catalog  # lazy: catalog imports config; keep this module import-light

    meta = catalog.get_meta(model)
    if meta is None:
        return None, None
    return meta.price_prompt, meta.price_completion


def price_fallback(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Catalog price x tokens (USD). 0.0 when the model is unknown to the catalog."""
    p_in, p_out = catalog_prices(model)
    cost = (p_in or 0.0) * max(prompt_tokens, 0) + (p_out or 0.0) * max(completion_tokens, 0)
    return round(cost, 10)


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def float_or_none(v: Any) -> float | None:
    """`float(v)`, or None when `v` is None or not a number (never raises)."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def usage_from_chunk(
    usage: dict[str, Any] | None,
    *,
    model: str,
    role: str = "",
    purpose: str = "",
    latency_ms: int = 0,
    generation_id: str | None = None,
) -> Usage:
    """Map OpenRouter's `usage` object to `Usage`. `cost` (credits taken as USD) is used
    verbatim when present. A missing cost is filled with catalog price x tokens here; in live
    mode the client performs the `GET /generation?id=` lookup first and replaces `cost_usd`
    with the reported `total_cost`, falling back to this catalog price only when that fails."""
    u = usage or {}
    prompt = _int(u.get("prompt_tokens"))
    completion = _int(u.get("completion_tokens"))
    details = u.get("completion_tokens_details") or {}
    reasoning = _int(details.get("reasoning_tokens")) if isinstance(details, dict) else 0
    cost = float_or_none(u.get("cost"))
    if cost is None:
        cost = price_fallback(model, prompt, completion)
    return Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        reasoning_tokens=reasoning,
        cost_usd=cost,
        latency_ms=int(latency_ms),
        model=model,
        role=role,
        purpose=purpose,
        generation_id=generation_id,
    )


class EstimatedUsage(Usage):
    """A `Usage` synthesised without a usage chunk. Identical fields (it serialises exactly like
    `Usage`); the subclass only lets the client mark its log line as an estimate."""


def estimate_usage(
    *,
    model: str,
    completion_text: str,
    prompt_text: str = "",
    role: str = "",
    purpose: str = "",
    latency_ms: int = 0,
    generation_id: str | None = None,
) -> Usage:
    """Synthesised usage for a stream that ended without a usage chunk."""
    prompt = estimate_tokens(prompt_text)
    completion = estimate_tokens(completion_text)
    return EstimatedUsage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        reasoning_tokens=0,
        cost_usd=price_fallback(model, prompt, completion),
        latency_ms=int(latency_ms),
        model=model,
        role=role,
        purpose=purpose,
        generation_id=generation_id,
    )


def aggregate(usages: list[Usage], *, wall_clock_ms: int | None = None) -> FeatureUsage:
    fu = FeatureUsage()
    for u in usages:
        fu.add(u)
    if wall_clock_ms is not None:
        fu.set_wall_clock(wall_clock_ms)
    return fu


def format_log_line(
    usage: Usage,
    *,
    estimated: bool = False,
    mock: bool = False,
    cost_source: str | None = None,
) -> str:
    """One INFO line per LLM call. Feature-agnostic: role + purpose identify the call.
    `cost_source` (live transport only) says where `cost_usd` came from: `chunk` (the usage
    chunk's own `cost`), `generation` (the `GET /generation` fallback) or `catalog` (price x
    tokens, also for a synthesised usage)."""
    parts = [
        "llm call",
        f"role={usage.role}",
        f"purpose={usage.purpose}",
        f"model={usage.model}",
        f"prompt_tokens={usage.prompt_tokens}",
        f"completion_tokens={usage.completion_tokens}",
        f"reasoning_tokens={usage.reasoning_tokens}",
        f"cost_usd={usage.cost_usd:.6f}",
    ]
    if cost_source:
        parts.append(f"cost_source={cost_source}")
    parts += [
        f"latency_ms={usage.latency_ms}",
        f"generation_id={usage.generation_id or '-'}",
    ]
    if estimated:
        parts.append("usage=estimated(no usage chunk; len(text)//4 x catalog price)")
    if mock:
        parts.append("transport=mock")
    return " ".join(parts)


def format_error_log_line(
    *,
    role: str,
    purpose: str,
    model: str,
    code: Any,
    error_type: Any,
    message: Any,
    latency_ms: int,
) -> str:
    return (
        f"llm call role={role} purpose={purpose} model={model} error code={code} "
        f"error_type={error_type} latency_ms={latency_ms} message={message!r}"
    )
