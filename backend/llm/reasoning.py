"""Effort -> OpenRouter `reasoning` object (owner: W1). Frozen signature: `build(effort, meta)`.

docs/semantics.md "Effort" (+ addendum), verbatim rules:

- `build(None, meta)` -> `(None, "off", False)` (reasoning omitted).
- `off` -> `{"enabled": false}`; unless the model is mandatory-reasoning (reasoning omitted so the
  provider default runs, `coerced=True`, applied = the lowest name in `meta.efforts`) or the
  catalog has no reasoning block for it (reasoning omitted, not coerced).
- `low/medium/high` -> `{"effort": name}`; when the name is not in `meta.efforts`, the nearest
  LOWER supported effort is applied, or the lowest supported one when nothing lower exists
  (`coerced=True`). An applied `off` follows the `off` rule above.
- Unknown model (`meta is None`) -> sent exactly as configured, `coerced=False`.
- Never raises.
"""

from __future__ import annotations

from typing import Any

from ..schemas import EFFORTS, Effort, ModelMeta

_RANK: dict[str, int] = {"off": 0, "low": 1, "medium": 2, "high": 3}


def _has_reasoning_meta(meta: ModelMeta) -> bool:
    """A model exposes reasoning when its catalog entry carried a `reasoning` block: visible as
    non-off efforts, a mandatory flag, or the raw block itself (a non-reasoning model maps to
    exactly `["off"]`)."""
    if meta.mandatory_reasoning:
        return True
    if any(e != "off" for e in meta.efforts):
        return True
    raw = meta.raw if isinstance(meta.raw, dict) else {}
    return bool(raw.get("reasoning"))


def _lowest(efforts: list[str]) -> Effort | None:
    known = [e for e in efforts if e in _RANK]
    if not known:
        return None
    return min(known, key=lambda e: _RANK[e])  # type: ignore[return-value]


def _param_for(applied: Effort, meta: ModelMeta | None) -> dict[str, Any] | None:
    if applied == "off":
        if meta is None:
            return {"enabled": False}
        if meta.mandatory_reasoning or not _has_reasoning_meta(meta):
            return None
        return {"enabled": False}
    return {"effort": applied}


def build(
    effort: Effort | None, meta: ModelMeta | None
) -> tuple[dict[str, Any] | None, Effort, bool]:
    """Returns (reasoning_param_or_None, effort_applied, coerced). Never raises."""
    if effort is None or effort not in EFFORTS:
        return None, "off", False

    if meta is None:
        return _param_for(effort, None), effort, False

    efforts = [e for e in (meta.efforts or []) if e in _RANK]

    if effort == "off":
        if meta.mandatory_reasoning:
            lowest = _lowest([e for e in efforts if e != "off"]) or _lowest(efforts)
            if lowest is None or lowest == "off":
                # Mandatory but no usable effort names: omit reasoning, report the coercion.
                return None, "off", True
            return None, lowest, True
        return _param_for("off", meta), "off", False

    if effort in efforts:
        return _param_for(effort, meta), effort, False

    # Not supported: nearest lower supported effort, else the lowest supported one.
    want = _RANK[effort]
    lower = [e for e in efforts if _RANK[e] < want]
    if lower:
        applied = max(lower, key=lambda e: _RANK[e])
    else:
        applied = _lowest(efforts)
    if applied is None:
        # No effort information at all (empty list): send as configured.
        return _param_for(effort, meta), effort, False
    if applied == "off" and meta.mandatory_reasoning:
        # Cannot switch a mandatory model off; fall back to its lowest real effort.
        real = _lowest([e for e in efforts if e != "off"])
        if real is not None:
            applied = real
    return _param_for(applied, meta), applied, True  # type: ignore[arg-type]


# --------------------------------------------------------------------------- token budgets
# Room for reasoning tokens on top of a stage's output budget. Reasoning tokens are BILLED AND
# COUNTED as completion tokens, so they come out of `max_tokens`: a budget sized for the answer alone
# is spent on the thinking and the answer is cut off mid-document. Measured 2026-09-20 against a
# reasoning analyst on a 4,000-token extraction budget: 4,615 / 4,650 / 4,555 reasoning tokens, every
# one a `finish_reason=length` reported to the user as `parse_error: no JSON object found in the
# response`. The allowance is comfortably over the largest of those, because the failure mode is a
# degraded turn and the cost of over-asking is nothing — `max_tokens` is a ceiling, not a purchase.
REASONING_TOKEN_ALLOWANCE = 8000


def _reasons(param: dict[str, Any] | None) -> bool:
    """True when this request will actually spend reasoning tokens. `build` says so by shape:
    `{"effort": name}` asks for reasoning, `{"enabled": False}` refuses it, None omits it (the
    provider default runs, which for a mandatory-reasoning model DOES reason)."""
    if param is None:
        return False
    return "effort" in param


def _completion_cap(meta: ModelMeta | None) -> int | None:
    """The provider's own completion ceiling from the catalog's raw entry, when it gave one."""
    if meta is None:
        return None
    try:
        value = (meta.raw or {}).get("top_provider", {}).get("max_completion_tokens")
    except AttributeError:
        return None
    return value if isinstance(value, int) and value > 0 else None


def token_budget(base: int, meta: ModelMeta | None, effort: Effort | None) -> int:
    """`base`, plus `REASONING_TOKEN_ALLOWANCE` when this model will reason at this effort.

    A non-reasoning model — or one asked for `off` — gets `base` unchanged, byte for byte, so the
    mock path and every golden are untouched. Clamped to the provider's completion ceiling when the
    catalog knows it, so a raised budget is never itself the thing the provider rejects, and never
    below `base`. The one case that gets `base` despite reasoning is a mandatory-reasoning model
    coerced all the way to `off`, where the parameter is omitted and nothing here can tell how much
    the provider default will spend.
    """
    param, _applied, _coerced = build(effort, meta)
    if not _reasons(param):
        return base
    cap = _completion_cap(meta)
    wanted = base + REASONING_TOKEN_ALLOWANCE
    return max(base, min(wanted, cap)) if cap else wanted
