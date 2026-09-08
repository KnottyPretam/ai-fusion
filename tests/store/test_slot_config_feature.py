"""backend/features/slot_config.validate_slot_config: the 422 unsupported_effort rule
(docs/api-contract.md PUT slot_config; docs/semantics.md "Effort")."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend.config import DEFAULT_SLOT_CONFIG
from backend.features.slot_config import validate_slot_config
from backend.schemas import ModelMeta

GROK = DEFAULT_SLOT_CONFIG.slots["grok"].model
CLAUDE = DEFAULT_SLOT_CONFIG.slots["claude"].model


def _catalog(**metas: ModelMeta):
    def get_meta(model: str) -> ModelMeta | None:
        return metas.get(model)

    return get_meta


def _cfg(**efforts: str):
    cfg = DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    for slot, effort in efforts.items():
        cfg.slots[slot].effort = effort  # type: ignore[assignment]
    return cfg


def test_stub_catalog_counts_as_unknown_models(monkeypatch):
    """A catalog that is still a stub (NotImplementedError) must read as 'unknown model'."""

    def _stub(model: str):
        raise NotImplementedError("stub")

    monkeypatch.setattr("backend.llm.catalog.get_meta", _stub)
    validate_slot_config(_cfg(grok="off"))  # no exception


def test_real_catalog_rejects_off_for_mandatory_reasoning_model():
    """With the real offline catalog, grok-4.6 (mandatory reasoning) cannot be set to 'off'."""
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        validate_slot_config(_cfg(grok="off"))
    assert exc.value.status_code == 422
    assert exc.value.detail["error"] == "unsupported_effort"


def test_unknown_model_passes(monkeypatch):
    monkeypatch.setattr("backend.llm.catalog.get_meta", _catalog())
    validate_slot_config(_cfg(claude="off", chatgpt="high", grok="off"))


def test_supported_effort_passes(monkeypatch):
    monkeypatch.setattr(
        "backend.llm.catalog.get_meta",
        _catalog(
            **{
                GROK: ModelMeta(
                    id=GROK, efforts=["low", "medium", "high"], mandatory_reasoning=True
                )
            }
        ),
    )
    validate_slot_config(_cfg(grok="medium"))
    validate_slot_config(_cfg(grok="low"))


def test_unsupported_effort_raises_422_with_the_documented_body(monkeypatch):
    monkeypatch.setattr(
        "backend.llm.catalog.get_meta",
        _catalog(
            **{
                GROK: ModelMeta(
                    id=GROK, efforts=["low", "medium", "high"], mandatory_reasoning=True
                )
            }
        ),
    )
    with pytest.raises(HTTPException) as ei:
        validate_slot_config(_cfg(grok="off"))
    assert ei.value.status_code == 422
    assert ei.value.detail == {
        "error": "unsupported_effort",
        "slot": "grok",
        "model": GROK,
        "effort": "off",
        "supported": ["low", "medium", "high"],
    }


def test_non_reasoning_model_only_supports_off(monkeypatch):
    monkeypatch.setattr("backend.llm.catalog.get_meta", _catalog(**{CLAUDE: ModelMeta(id=CLAUDE)}))
    with pytest.raises(HTTPException) as ei:
        validate_slot_config(_cfg(claude="medium"))
    assert ei.value.detail["slot"] == "claude" and ei.value.detail["supported"] == ["off"]
    validate_slot_config(_cfg(claude="off"))


def test_first_offending_slot_in_slot_order_is_reported(monkeypatch):
    monkeypatch.setattr(
        "backend.llm.catalog.get_meta",
        _catalog(
            **{
                CLAUDE: ModelMeta(id=CLAUDE, efforts=["off", "low"]),
                GROK: ModelMeta(id=GROK, efforts=["high"], mandatory_reasoning=True),
            }
        ),
    )
    with pytest.raises(HTTPException) as ei:
        validate_slot_config(_cfg(claude="high", grok="off"))
    assert ei.value.detail["slot"] == "claude"
    with pytest.raises(HTTPException) as ei:
        validate_slot_config(_cfg(claude="low", grok="off"))
    assert ei.value.detail["slot"] == "grok" and ei.value.detail["supported"] == ["high"]


def test_analyst_model_is_not_checked(monkeypatch):
    analyst = DEFAULT_SLOT_CONFIG.analyst_model
    monkeypatch.setattr(
        "backend.llm.catalog.get_meta",
        _catalog(**{analyst: ModelMeta(id=analyst, efforts=["high"])}),
    )
    validate_slot_config(DEFAULT_SLOT_CONFIG.model_copy(deep=True))  # ANALYST_EFFORT is a constant
