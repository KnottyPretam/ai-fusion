"""Slot-config validation against the model catalog (owner: W2).

`PUT /api/conversations/{id}/slot_config` rejects a config with 422 `unsupported_effort` ONLY when
the catalog knows the model (`catalog.get_meta(model)` is not None) and the requested effort is not
in `meta.efforts` (docs/api-contract.md, docs/semantics.md "Effort"). Unknown models pass: the
LLM layer sends the effort as configured and `reasoning.build` coerces at request time.

`backend.llm.catalog` (W1) is imported INSIDE the function so tests can
`monkeypatch.setattr("backend.llm.catalog.get_meta", ...)` and so this module imports cleanly
while the catalog is still a stub (its NotImplementedError is treated as "unknown model").
"""

from __future__ import annotations

from .. import api_errors
from ..schemas import SLOT_IDS, ModelMeta, SlotConfig


def _meta(model: str) -> ModelMeta | None:
    from ..llm import catalog  # lazy: W1 module, monkeypatched in tests

    try:
        return catalog.get_meta(model)
    except NotImplementedError:
        return None


def validate_slot_config(cfg: SlotConfig) -> None:
    """Raise `api_errors.unprocessable("unsupported_effort", slot, model, effort, supported)` for
    the first slot (in SLOT_IDS order) whose effort the catalog says its model does not support."""
    for slot in SLOT_IDS:
        spec = cfg.slots[slot]
        meta = _meta(spec.model)
        if meta is None:
            continue
        if spec.effort not in meta.efforts:
            raise api_errors.unprocessable(
                "unsupported_effort",
                slot=slot,
                model=spec.model,
                effort=spec.effort,
                supported=list(meta.efforts),
            )
