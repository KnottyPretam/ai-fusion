"""Frozen config contract: env overrides (spec R2 "from config file"), fresh copies, forbidden lists."""

from backend.config import DEFAULT_SLOT_CONFIG, FORBIDDEN_IDENTITY_STRINGS, settings
from tests.helpers import find_identity_leaks


def test_default_slot_config_is_a_fresh_copy_each_call():
    a = settings().default_slot_config
    b = settings().default_slot_config
    assert a == DEFAULT_SLOT_CONFIG and a is not DEFAULT_SLOT_CONFIG and a is not b
    assert a.slots["claude"] is not DEFAULT_SLOT_CONFIG.slots["claude"]


def test_env_overrides_slot_defaults(monkeypatch):
    monkeypatch.setenv("SLOT_GROK_MODEL", "x-ai/grok-4.3")
    monkeypatch.setenv("SLOT_GROK_EFFORT", "off")
    monkeypatch.setenv("ANALYST_MODEL", "anthropic/claude-sonnet-5")
    monkeypatch.setenv("FUSION_MAX_ITERATIONS", "3")
    monkeypatch.setenv("MATERIALITY_MIN", "high")
    monkeypatch.setenv("GROUNDED_DEFAULT", "1")
    cfg = settings().default_slot_config
    assert cfg.slots["grok"].model == "x-ai/grok-4.3" and cfg.slots["grok"].effort == "off"
    assert cfg.slots["claude"].model == DEFAULT_SLOT_CONFIG.slots["claude"].model
    assert cfg.analyst_model == "anthropic/claude-sonnet-5"
    assert cfg.max_iterations == 3 and cfg.materiality_min == "high" and cfg.grounded is True


def test_settings_reads_env_at_call_time(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "x"))
    monkeypatch.setenv("MOCK_SCENARIO", "stalemate")
    s = settings()
    assert s.data_dir == tmp_path / "x" and s.mock_scenario == "stalemate" and s.mock_openrouter


def test_forbidden_strings_are_word_bounded_and_codenames_need_slug_context():
    assert "claude" in FORBIDDEN_IDENTITY_STRINGS
    assert find_identity_leaks("The Luna 9 lander and one sol on Mars; ad astra.") == []
    assert find_identity_leaks("use openai/gpt-5.6-luna") == ["-luna", "gpt", "openai"]
    assert find_identity_leaks("Claude said so") == ["claude"]
    assert find_identity_leaks("the encryption key") == []  # 'grok' not a substring match
    assert find_identity_leaks("R1 claims 2000 deg/s", allow=[]) == []
