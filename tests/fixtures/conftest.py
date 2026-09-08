"""Per-area fixtures for tests/fixtures (owned by W-fix). Shared fixtures live in tests/conftest.py.

Everything here is a local structural reader of the scenario corpus: only json + backend.schemas
are used (never backend.llm, which W1 writes in parallel).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = REPO_ROOT / "backend" / "llm" / "fixtures" / "scenarios"
FIXTURES_DOC = REPO_ROOT / "docs" / "fixtures.md"

FIXTURE_NAME_RE = re.compile(
    r"^(?P<role>claude|chatgpt|grok|analyst)\.(?P<purpose>chat|extraction|defense|convergence)"
    r"\.(?P<n>[1-9]\d*)\.jsonl$"
)
ROLE_PURPOSES = {
    "claude": {"chat", "defense"},
    "chatgpt": {"chat", "defense"},
    "grok": {"chat", "defense"},
    "analyst": {"extraction", "convergence"},
}


def scenario_dirs() -> list[Path]:
    return sorted(p for p in SCENARIOS_DIR.iterdir() if p.is_dir())


def fixture_files() -> list[Path]:
    return sorted(f for d in scenario_dirs() for f in d.glob("*.jsonl"))


def documented_scenarios() -> list[str]:
    """Scenario names from the table in docs/fixtures.md (rows starting with "| `name` |")."""
    names = []
    for line in FIXTURES_DOC.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\|\s*`([a-z_]+)`\s*\|", line)
        if m and m.group(1) not in names:
            names.append(m.group(1))
    return names


def load_chunks(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines, f"{path} is empty"
    out = []
    for i, line in enumerate(lines, 1):
        assert line.strip(), f"{path}:{i} blank line"
        assert not line.startswith(":"), f"{path}:{i} SSE comment line in a fixture"
        assert line.strip() != "[DONE]", f"{path}:{i} [DONE] sentinel in a fixture"
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:  # pragma: no cover - only on a corrupt fixture
            raise AssertionError(f"{path}:{i} does not parse: {e}") from e
        assert isinstance(obj, dict), f"{path}:{i} is not a JSON object"
        out.append(obj)
    return out


def content_text(chunks: list[dict]) -> str:
    """Concatenated `choices[0].delta.content` (what the mock transport yields as text)."""
    parts = []
    for c in chunks:
        choices = c.get("choices") or []
        if choices and isinstance(choices[0].get("delta"), dict):
            text = choices[0]["delta"].get("content")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def reasoning_text(chunks: list[dict]) -> str:
    parts = []
    for c in chunks:
        choices = c.get("choices") or []
        if not choices:
            continue
        for block in (choices[0].get("delta") or {}).get("reasoning_details") or []:
            parts.append(block.get("text") or block.get("summary") or "")
    return "".join(parts)


def annotations(chunks: list[dict]) -> list[dict]:
    out = []
    for c in chunks:
        choices = c.get("choices") or []
        if choices:
            out.extend((choices[0].get("delta") or {}).get("annotations") or [])
    return out


def is_error_fixture(chunks: list[dict]) -> bool:
    return "error" in chunks[-1]


def readme_expectations(scenario_dir: Path) -> dict:
    """The machine-readable block at the end of a scenario README (the last ```json fence)."""
    text = (scenario_dir / "README.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```json\n(.*?)\n```", text, flags=re.S)
    assert blocks, f"{scenario_dir.name}/README.md has no ```json expectations block"
    exp = json.loads(blocks[-1])
    assert exp["scenario"] == scenario_dir.name
    return exp


@pytest.fixture
def scenarios_dir() -> Path:
    return SCENARIOS_DIR
