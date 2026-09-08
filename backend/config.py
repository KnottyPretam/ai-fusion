"""Frozen runtime configuration.

Everything is read at CALL time via settings() (never at import) so tests and worktrees can set
environment variables before the app is created. Feature-private constants live in the feature
module, not here. Cross-feature additions go through the integrator (frozen_change_requests).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from .schemas import Effort, SlotConfig, SlotSpec

REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_LOADED = False

DEFAULT_SLOT_CONFIG = SlotConfig(
    slots={
        "claude": SlotSpec(model="anthropic/claude-opus-5", effort="medium"),
        "chatgpt": SlotSpec(model="openai/gpt-5.6-sol", effort="medium"),
        "grok": SlotSpec(model="x-ai/grok-4.6", effort="medium"),
    },
    analyst_model="openai/gpt-5.6-luna",
    max_iterations=2,
    materiality_min="medium",
    grounded=False,
)
ANALYST_EFFORT: Effort = "medium"
MAX_ITERATIONS_CAP = 5
MAX_TOKENS_STAGE: dict[str, int] = {
    "send": 8000,
    "continue": 8000,
    "extraction": 4000,
    "defense": 2000,
    "convergence": 1000,
}
# Matched case-insensitively on word boundaries in Triplex-authored prompts (see semantics.md).
FORBIDDEN_IDENTITY_STRINGS: tuple[str, ...] = (
    "claude",
    "chatgpt",
    "grok",
    "openai",
    "anthropic",
    "xai",
    "x-ai",
    "spacexai",
    "gpt",
    "opus",
    "sonnet",
    "fable",
    "astra",
    "luna",
    "sol",
)


def _load_env_once() -> None:
    global _ENV_LOADED
    if not _ENV_LOADED:
        load_dotenv(REPO_ROOT / ".env", override=False)
        _ENV_LOADED = True


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


@dataclass(frozen=True)
class Settings:
    openrouter_api_key: str | None
    openrouter_base_url: str
    http_referer: str
    app_title: str
    data_dir: Path
    host: str
    port: int
    mock_openrouter: bool
    mock_scenario: str
    mock_fixtures_dir: Path
    mock_record_dir: Path | None
    mock_delay_ms: int
    session_cost_cap_usd: float
    request_timeout_s: float
    catalog_ttl_s: int
    grounded_engine: str | None
    grounded_max_results: int
    log_level: str
    default_slot_config: SlotConfig = field(
        default_factory=lambda: DEFAULT_SLOT_CONFIG.model_copy(deep=True)
    )


def settings() -> Settings:
    """Read the environment now. Cheap; call it inside handlers, never cache at import."""
    _load_env_once()
    e = os.environ
    data_dir = Path(e.get("DATA_DIR", str(REPO_ROOT / "data"))).expanduser()
    if not data_dir.is_absolute():
        data_dir = (REPO_ROOT / data_dir).resolve()
    fixtures = Path(e.get("MOCK_FIXTURES_DIR", str(REPO_ROOT / "backend" / "llm" / "fixtures")))
    if not fixtures.is_absolute():
        fixtures = (REPO_ROOT / fixtures).resolve()
    rec = e.get("MOCK_RECORD_DIR") or None
    return Settings(
        openrouter_api_key=e.get("OPENROUTER_API_KEY") or None,
        openrouter_base_url=e.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip(
            "/"
        ),
        http_referer=e.get("HTTP_REFERER", "http://localhost:5173"),
        app_title=e.get("APP_TITLE", "Triplex"),
        data_dir=data_dir,
        host=e.get("HOST", "127.0.0.1"),
        port=int(e.get("PORT", e.get("BACKEND_PORT", "8001"))),
        mock_openrouter=_bool("MOCK_OPENROUTER", False),
        mock_scenario=e.get("MOCK_SCENARIO", "planted_factual"),
        mock_fixtures_dir=fixtures,
        mock_record_dir=Path(rec).resolve() if rec else None,
        mock_delay_ms=int(e.get("MOCK_DELAY_MS", "0")),
        session_cost_cap_usd=float(e.get("SESSION_COST_CAP_USD", "10")),
        request_timeout_s=float(e.get("REQUEST_TIMEOUT_S", "300")),
        catalog_ttl_s=int(e.get("CATALOG_TTL_S", "86400")),
        grounded_engine=e.get("GROUNDED_ENGINE") or None,
        grounded_max_results=int(e.get("GROUNDED_MAX_RESULTS", "5")),
        log_level=e.get("LOG_LEVEL", "INFO").upper(),
    )
