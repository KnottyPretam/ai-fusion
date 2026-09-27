"""Slot-config validation against the model catalog (owner: W2).

`PUT /api/conversations/{id}/slot_config` rejects a config with 422 `unsupported_effort` ONLY when
the catalog knows the model (`catalog.get_meta(model)` is not None) and the requested effort is not
in `meta.efforts` (docs/api-contract.md, docs/semantics.md "Effort"). Unknown models pass: the
LLM layer sends the effort as configured and `reasoning.build` coerces at request time.

Since 2026-09-27 the checks run over the config's COUNCIL (`schemas.council_of`, 2..5 slots in
catalog order), and a `web:` model is checked FIRST: a subscription session belongs to exactly one
site, so `web:<site>` on any other slot, a site without a Stage-1 adapter (`web:gemini` -- a vendor
the council can seat on OpenRouter or Ollama only, until a Stage-2 adapter exists), or a string the
bridge could not parse (`web:claude:foo`, `web:`) is 422 `web_slot_mismatch{slot, model}`.
`web:<slot>` and `web:<slot>:analyst` on the slot's own site both pass -- the bridge decides the
view. The bridge would refuse such a model at Send time anyway (`bridge.parse_web_model`, whose
grammar this mirrors); refusing it at PUT time keeps the mistake out of the document.

`backend.llm.catalog` (W1) is imported INSIDE the function so tests can
`monkeypatch.setattr("backend.llm.catalog.get_meta", ...)` and so this module imports cleanly
while the catalog is still a stub (its NotImplementedError is treated as "unknown model").
"""

from __future__ import annotations

from .. import api_errors
from ..llm.bridge_protocol import BRIDGE_SLOTS
from ..schemas import ModelMeta, SlotConfig, SlotId, council_of


def _meta(model: str) -> ModelMeta | None:
    from ..llm import catalog  # lazy: W1 module, monkeypatched in tests

    try:
        return catalog.get_meta(model)
    except NotImplementedError:
        return None


def web_slot_mismatch(slot: SlotId, model: str) -> bool:
    """True when `model` is a `web:` string whose site is not this slot, is a site without a
    Stage-1 adapter, or is not of the form the bridge parses (`web:<slot>` / `web:<slot>:analyst`;
    both pass on the slot's own site -- the bridge decides the view)."""
    if not isinstance(model, str) or not model.startswith("web:"):
        return False
    parts = model.split(":")
    if not (len(parts) == 2 or (len(parts) == 3 and parts[2] == "analyst")):
        return True  # `bridge.parse_web_model` would raise "malformed web model"
    site = parts[1]
    return site != slot or site not in BRIDGE_SLOTS


def validate_slot_config(cfg: SlotConfig) -> None:
    """Raise `api_errors.unprocessable("web_slot_mismatch", slot, model)` for the first slot (in
    council order) whose `web:` model is not its own site's session, else
    `api_errors.unprocessable("unsupported_effort", slot, model, effort, supported)` for the first
    whose effort the catalog says its model does not support."""
    for slot in council_of(cfg):
        spec = cfg.slots[slot]
        if web_slot_mismatch(slot, spec.model):
            raise api_errors.unprocessable("web_slot_mismatch", slot=slot, model=spec.model)
    for slot in council_of(cfg):
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
