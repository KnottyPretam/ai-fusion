"""Environment isolation of the offline e2e suite: the goldens and the contract-shaped
assertions (`plugins=[{"id":"web","max_results":5}]`, the as-run `slot_config`, `usage.calls`
order) must not depend on the developer's shell exports or `.env` (CLAUDE.md "settings() reads
the environment at CALL time"; tests/conftest.py "A developer .env must not leak defaults into
the offline suite").

- The `scenario` fixture pins `MOCK_DELAY_MS=0` and clears `GROUNDED_ENGINE` /
  `GROUNDED_MAX_RESULTS`: tests/conftest.py only `setdefault`s the first and never touches the
  other two, so a shell export used to win.
- `tests/e2e/conftest.py` loads the developer `.env` at import (collection) time. config.settings()
  loads it lazily on its first call, which otherwise happened inside the first test's
  `create_app()` -- AFTER that test's per-test `delenv` -- so the first isolated test (e.g. a
  golden regeneration of `test_golden.py` alone) ran with the overrides and everything after it
  did not. The subprocess test below reproduces that collection order in a fresh interpreter
  against a temporary `.env`; it never touches the repository's own `.env`.
"""

from __future__ import annotations

import os
import subprocess
import sys

from backend.config import DEFAULT_SLOT_CONFIG, settings
from tests.e2e.conftest import REPO_ROOT

# Slot-config overrides a developer .env may carry (tests/conftest.py deletes them per test).
OVERRIDES = ("FUSION_MAX_ITERATIONS", "MATERIALITY_MIN")


def test_scenario_fixture_pins_the_mock_pacing(scenario, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "3")  # what a shell export looks like to the test
    assert settings().mock_delay_ms == 3
    scenario("planted_factual")
    assert settings().mock_delay_ms == 0 and settings().mock_scenario == "planted_factual"


def test_scenario_fixture_clears_the_grounded_overrides(scenario, monkeypatch):
    monkeypatch.setenv("GROUNDED_ENGINE", "exa")
    monkeypatch.setenv("GROUNDED_MAX_RESULTS", "9")
    assert settings().grounded_engine == "exa" and settings().grounded_max_results == 9
    scenario("grounded")
    assert settings().grounded_engine is None and settings().grounded_max_results == 5


async def test_a_new_conversation_gets_the_module_default_slot_config(api):
    """The store copies `settings().default_slot_config`; with the .env loaded at collection
    time and the root conftest deleting every override key per test, that is the module
    constant in every test, the first one included."""
    for key in OVERRIDES:
        assert key not in os.environ, key
    conv = await api.create()
    assert conv["slot_config"] == DEFAULT_SLOT_CONFIG.model_dump()
    assert settings().default_slot_config == DEFAULT_SLOT_CONFIG


def test_dotenv_is_loaded_when_the_e2e_conftest_is_imported(tmp_path):
    """Regression for the once-only leak. A fresh interpreter points `config.REPO_ROOT` at a
    temporary directory holding a `.env`, imports the root conftest (which must NOT load it:
    nothing there calls settings()) and then `tests.e2e.conftest` -- exactly what collecting
    any tests/e2e module does -- and prints the override keys: they must already be in
    `os.environ`, where the per-test `delenv` in tests/conftest.py will find and remove them."""
    (tmp_path / ".env").write_text("FUSION_MAX_ITERATIONS=5\nMATERIALITY_MIN=low\n")
    script = "\n".join(
        [
            "import os",
            "from pathlib import Path",
            "import backend.config as cfg",
            f"cfg.REPO_ROOT = Path({str(tmp_path)!r})",
            "import tests.conftest",
            "before = [os.environ.get(k) for k in ('FUSION_MAX_ITERATIONS', 'MATERIALITY_MIN')]",
            "import tests.e2e.conftest",
            "after = [os.environ.get(k) for k in ('FUSION_MAX_ITERATIONS', 'MATERIALITY_MIN')]",
            "print(before, after)",
        ]
    )
    env = {k: v for k, v in os.environ.items() if k not in OVERRIDES}
    p = subprocess.run(
        [sys.executable, "-c", script],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert p.returncode == 0, p.stderr
    assert p.stdout.strip() == "[None, None] ['5', 'low']"
