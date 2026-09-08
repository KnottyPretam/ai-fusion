"""Every shipped scenario fixture parses through the real parser with exactly one terminal delta.

The scenario fixtures are authored in parallel by the fixture workstream; the glob may be empty in
this worktree, in which case the parametrized test is skipped.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.config import REPO_ROOT
from backend.llm.stream import parse_sse_lines

SCENARIOS_DIR = REPO_ROOT / "backend" / "llm" / "fixtures" / "scenarios"
FILES = sorted(SCENARIOS_DIR.glob("**/*.jsonl"))
MINI_FILES = sorted((Path(__file__).resolve().parent / "fixtures" / "scenarios").glob("**/*.jsonl"))


def _check(path: Path) -> None:
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert lines, f"{path} is empty"
    chunks = [json.loads(ln) for ln in lines]  # every line parses
    for c in chunks:
        assert "error" in c or (c.get("choices") and "delta" in c["choices"][0]), path
    deltas = list(parse_sse_lines(f"data: {ln}" for ln in lines))
    terminal = [d for d in deltas if d.kind in ("done", "error")]
    assert len(terminal) == 1, (
        f"{path}: expected one terminal delta, got {[d.kind for d in deltas]}"
    )
    assert deltas[-1].kind in ("done", "error"), path
    last = chunks[-1]
    if "error" in last:
        assert deltas[-1].kind == "error"
    else:
        assert deltas[-1].kind == "done"
        assert "usage" in last and last["usage"].get("cost") is not None, f"{path}: no usage.cost"
        assert deltas[-1].usage.cost_usd == pytest.approx(float(last["usage"]["cost"]))
        assert deltas[-1].generation_id == chunks[0].get("id")
        # last non-null finish_reason equals the last content chunk's finish_reason
        content_frs = [
            c["choices"][0].get("finish_reason")
            for c in chunks
            if c.get("choices") and c["choices"][0].get("delta", {}).get("content")
        ]
        if content_frs and content_frs[-1] is not None:
            assert deltas[-1].finish_reason == content_frs[-1], path


@pytest.mark.skipif(
    not FILES, reason="no backend/llm/fixtures/scenarios/**/*.jsonl in this worktree"
)
@pytest.mark.parametrize("path", FILES, ids=[str(p.relative_to(SCENARIOS_DIR)) for p in FILES])
def test_shipped_scenario_fixture_has_single_terminal_delta(path: Path):
    _check(path)


@pytest.mark.parametrize("path", MINI_FILES, ids=[p.parent.name + "/" + p.name for p in MINI_FILES])
def test_mini_fixture_has_single_terminal_delta(path: Path):
    _check(path)
