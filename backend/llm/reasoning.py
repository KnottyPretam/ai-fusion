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
