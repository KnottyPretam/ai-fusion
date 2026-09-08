"""Malformed model-output corpus for the Analyze / Fusion JSON path (PLAN.md §9 "Robustness").

Two consumers share this module:

- the committed deterministic scenarios under `tests/e2e/fixtures/scenarios/` (regenerate with
  `uv run python -m tests.e2e.malformed`; `test_robustness.py` fails when they drift), and
- the hypothesis fuzz in `test_robustness.py`, which writes generated scenarios into a temp
  fixtures root through the same `write_scenario` and points `MOCK_FIXTURES_DIR` at it.

A `Reply` is what one model call streams back: a `kind` from `KINDS`, the exact `text` the
mock will yield (so tests can assert `raw_attempts` / thread contents verbatim) and, for the
valid kinds, the `payload` object the lenient parser must recover. The three valid shapes
(`plain`, `fenced`, `chatty`) exercise docs/semantics.md "Structured output" (strip fences,
outermost braces); the invalid shapes (`truncated`, `prose`, `schema`, `empty`, `error`) must end
in `degraded` (Analyze) or `unavailable` / `standing` (Fusion) -- never a 500, never a hang.

Every scenario reuses `planted_factual`'s chat fixtures (and its valid extraction for the
Fusion cases) so Send and Analyze behave exactly as in the committed corpus; the wire format is
docs/fixtures.md's canonical chunk lines.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hypothesis import strategies as st

HERE = Path(__file__).resolve().parent
LOCAL_FIXTURES_DIR = HERE / "fixtures"
REPO_ROOT = HERE.parents[1]
SCENARIOS_DIR = REPO_ROOT / "backend" / "llm" / "fixtures" / "scenarios"
BASE_SCENARIO = "planted_factual"
CHAT_FILES = ("claude.chat.1.jsonl", "chatgpt.chat.1.jsonl", "grok.chat.1.jsonl")
EXTRACTION_FILE = "analyst.extraction.1.jsonl"
SLOTS = ("claude", "chatgpt", "grok")

VALID_KINDS = ("plain", "fenced", "chatty")
INVALID_KINDS = ("truncated", "prose", "schema", "empty", "error")
KINDS = VALID_KINDS + INVALID_KINDS

RATE_LIMITED = {
    "code": 429,
    "message": "Rate limit exceeded",
    "metadata": {"error_type": "rate_limit_exceeded"},
}
CHUNK_CHARS = 24
DEFAULT_PROSE = "I compared the three responses and found them broadly compatible on the whole."


# --------------------------------------------------------------------------- replies
@dataclass(frozen=True)
class Reply:
    kind: str
    text: str  # exactly what the mock streams as content ("" for an error chunk)
    payload: dict[str, Any] | None  # the object a VALID reply carries

    @property
    def valid(self) -> bool:
        return self.kind in VALID_KINDS

    @property
    def transport_error(self) -> bool:
        return self.kind == "error"

    @property
    def metered(self) -> bool:
        """An error chunk carries no usage chunk, so the call is never booked."""
        return not self.transport_error


def render(
    kind: str,
    obj: dict[str, Any],
    *,
    violation: dict[str, Any] | None = None,
    lang: str = "json",
    prefix: str = "",
    suffix: str = "",
    cut: int = 0,
    fenced: bool = False,
    indent: int | None = None,
) -> Reply:
    """One reply of `kind` built around the valid object `obj` (or `violation` for `schema`)."""
    body = json.dumps(obj, ensure_ascii=False, indent=indent)
    if kind == "plain":
        return Reply(kind, body, obj)
    if kind == "fenced":
        return Reply(kind, f"```{lang}\n{body}\n```", obj)
    if kind == "chatty":
        return Reply(kind, prefix + body + suffix, obj)
    if kind == "truncated":
        # Strictly before the closing brace: the outermost object is never closed, so no
        # candidate the lenient parser tries can parse (nested objects are not candidates).
        head = "```json\n" if fenced else ""
        return Reply(kind, head + body[: cut % len(body)], None)
    if kind == "prose":
        text = (prefix + " " + suffix).strip() or DEFAULT_PROSE
        return Reply(kind, text, None)
    if kind == "schema":
        assert violation is not None, "schema kind needs a violation object"
        return Reply(kind, json.dumps(violation, ensure_ascii=False, indent=indent), None)
    if kind == "empty":
        return Reply(kind, "", None)
    if kind == "error":
        return Reply(kind, "", None)
    raise ValueError(kind)  # pragma: no cover - builder misuse


# --------------------------------------------------------------------------- payloads
def _fixture_text(scenario: str, name: str) -> str:
    parts: list[str] = []
    for ln in (SCENARIOS_DIR / scenario / name).read_text(encoding="utf-8").splitlines():
        if not ln.strip():
            continue
        choices = json.loads(ln).get("choices") or []
        if choices and isinstance(choices[0].get("delta"), dict):
            c = choices[0]["delta"].get("content")
            if isinstance(c, str):
                parts.append(c)
    return "".join(parts)


def extraction_payload() -> dict[str, Any]:
    """`planted_factual`'s extraction: d1 (high, one Position per label) and d2 (low)."""
    return json.loads(_fixture_text(BASE_SCENARIO, EXTRACTION_FILE))


DEFEND: dict[str, Any] = {
    "stance": "defend",
    "justification": (
        "The datasheet's GYRO_RANGE register (0x0F) lists code 0x00 as 2000 deg/s, the widest "
        "setting; nothing the peers cite contradicts that figure."
    ),
    "revised_claim": None,
    "confidence": 0.85,
    "persuaded_by": None,
}
REVISE_UNJUSTIFIED: dict[str, Any] = {
    "stance": "revise",
    "justification": "You are right, I revise.",
    "revised_claim": "The gyroscope full-scale range is selectable up to 2000 deg/s.",
    "confidence": 0.7,
    "persuaded_by": "the peers",
}


def revise_justified_payload() -> dict[str, Any]:
    """`planted_factual`'s R2 revise: passes `schemas.is_unjustified` against the peer claims."""
    return json.loads(_fixture_text(BASE_SCENARIO, "chatgpt.defense.1.jsonl"))


def defense_payloads() -> list[dict[str, Any]]:
    return [DEFEND, revise_justified_payload(), REVISE_UNJUSTIFIED]


CONVERGENCE_RESOLVED: dict[str, Any] = {"statuses": [{"divergence_id": "d1", "status": "resolved"}]}
CONVERGENCE_STANDING: dict[str, Any] = {"statuses": [{"divergence_id": "d1", "status": "standing"}]}
CONVERGENCE_PAYLOADS = [CONVERGENCE_RESOLVED, CONVERGENCE_STANDING]

# Well-formed JSON objects that FAIL pydantic validation for each schema.
EXTRACTION_VIOLATIONS: list[dict[str, Any]] = [
    {
        "agreements": [],
        "divergences": [
            {
                "id": "d1",
                "topic": "t",
                "positions": [{"model": "R9", "claim": "c", "evidence_cited": None}],
                "materiality": "high",
            }
        ],
    },
    {"agreements": [{"topic": "t", "statement": "s", "models": ["Reviewer 1"]}], "divergences": []},
    {"agreements": "none", "divergences": []},
    {"foo": 1},
    {
        "agreements": [],
        "divergences": [{"id": "d1", "topic": "t", "positions": [], "materiality": "negligible"}],
    },
]
DEFENSE_VIOLATIONS: list[dict[str, Any]] = [
    {"stance": "maybe", "justification": "x", "revised_claim": None, "confidence": 0.5},
    {"stance": "defend"},
    {
        "stance": "revise",
        "justification": "j",
        "revised_claim": "c",
        "confidence": 1.5,
        "persuaded_by": "p",
    },
    {"ok": True},
    {"stance": "defend", "justification": None, "confidence": 0.5},
]
CONVERGENCE_VIOLATIONS: list[dict[str, Any]] = [
    {"statuses": [{"divergence_id": "d1", "status": "maybe"}]},
    {"statuses": "resolved"},
    {"resolved": ["d1"]},
    {"statuses": [{"divergence_id": "d1"}]},
]


# --------------------------------------------------------------------------- wire format
def _gid(scenario: str, name: str) -> str:
    return "gen-" + hashlib.sha1(f"{scenario}/{name}".encode()).hexdigest()[:16]


def reply_lines(scenario: str, name: str, reply: Reply) -> list[str]:
    """The JSONL chunk lines of one fixture (docs/fixtures.md canonical chunk lines)."""
    gid = _gid(scenario, name)

    def chunk(delta: dict[str, Any], finish: str | None, **extra: Any) -> str:
        doc = {
            "id": gid,
            "object": "chat.completion.chunk",
            "model": "m",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            **extra,
        }
        return json.dumps(doc, ensure_ascii=False)

    if reply.transport_error:
        return [
            json.dumps(
                {
                    "id": gid,
                    "error": RATE_LIMITED,
                    "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "error"}],
                },
                ensure_ascii=False,
            )
        ]
    pieces = [reply.text[i : i + CHUNK_CHARS] for i in range(0, len(reply.text), CHUNK_CHARS)]
    if not pieces:
        pieces = [""]
    finish = "length" if reply.kind == "truncated" else "stop"
    lines: list[str] = []
    for i, piece in enumerate(pieces):
        delta: dict[str, Any] = {"content": piece}
        if i == 0:
            delta = {"role": "assistant", **delta}
        lines.append(chunk(delta, finish if i == len(pieces) - 1 else None))
    completion = max(1, (len(reply.text) + 3) // 4)
    prompt = 500 + int(gid[4:8], 16) % 37
    cost = round(prompt * 2e-7 + completion * 1e-6, 8)
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "cost": cost,
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    lines.append(chunk({"role": "assistant", "content": ""}, None, usage=usage))
    return lines


def write_scenario(
    root: Path, name: str, files: dict[str, Reply], *, with_extraction: bool
) -> Path:
    """Create `<root>/scenarios/<name>` with `planted_factual`'s chat fixtures (and its valid
    extraction when `with_extraction`) plus one fixture per `files` entry."""
    d = root / "scenarios" / name
    d.mkdir(parents=True, exist_ok=True)
    copied = [*CHAT_FILES, EXTRACTION_FILE] if with_extraction else list(CHAT_FILES)
    for f in copied:
        shutil.copyfile(SCENARIOS_DIR / BASE_SCENARIO / f, d / f)
    for fname, reply in files.items():
        (d / fname).write_text("\n".join(reply_lines(name, fname, reply)) + "\n", encoding="utf-8")
    return d


# --------------------------------------------------------------------------- committed corpus
def corpus() -> dict[str, tuple[bool, dict[str, Reply]]]:
    """`{scenario: (with_extraction, {file: Reply})}` -- the deterministic committed scenarios."""
    ext = extraction_payload()
    revise = revise_justified_payload()
    return {
        "analyst_truncated_twice": (
            False,
            {
                "analyst.extraction.1.jsonl": render("truncated", ext, cut=210),
                "analyst.extraction.2.jsonl": render("truncated", ext, cut=350, fenced=True),
            },
        ),
        "analyst_prose_then_fenced": (
            False,
            {
                "analyst.extraction.1.jsonl": render(
                    "prose",
                    ext,
                    prefix="Here is my comparison of the three reviewers.",
                    suffix="All three agree on the upper range; R2 disagrees on the maximum.",
                ),
                "analyst.extraction.2.jsonl": render("fenced", ext, lang="json", indent=2),
            },
        ),
        "analyst_chatty_first": (
            False,
            {
                "analyst.extraction.1.jsonl": render(
                    "chatty",
                    ext,
                    prefix="Sure! Here is the JSON you asked for:\n\n",
                    suffix="\n\nHope that helps! Let me know if you need anything else.",
                ),
            },
        ),
        "defense_malformed": (
            True,
            {
                "claude.defense.1.jsonl": render("truncated", DEFEND, cut=60),
                "claude.defense.2.jsonl": render(
                    "prose", DEFEND, prefix="I stand by my answer; no JSON is needed here."
                ),
                "chatgpt.defense.1.jsonl": render("fenced", revise, lang="JSON"),
                "grok.defense.1.jsonl": render(
                    "chatty", DEFEND, prefix="Here is my verdict:\n", suffix="\nThanks for asking."
                ),
                "analyst.convergence.1.jsonl": render("truncated", CONVERGENCE_STANDING, cut=25),
                "analyst.convergence.2.jsonl": render("fenced", CONVERGENCE_STANDING, lang=""),
            },
        ),
        "defense_all_malformed": (
            True,
            {
                "claude.defense.1.jsonl": render("truncated", DEFEND, cut=45),
                "claude.defense.2.jsonl": render("schema", DEFEND, violation=DEFENSE_VIOLATIONS[0]),
                "chatgpt.defense.1.jsonl": render("empty", revise),
                "chatgpt.defense.2.jsonl": render("prose", revise, prefix="Fine, you win."),
                "grok.defense.1.jsonl": render("error", DEFEND),
                "grok.defense.2.jsonl": render("truncated", DEFEND, cut=12, fenced=True),
            },
        ),
        "convergence_malformed_twice": (
            True,
            {
                "claude.defense.1.jsonl": render("plain", DEFEND),
                "chatgpt.defense.1.jsonl": render("plain", revise, indent=2),
                "grok.defense.1.jsonl": render("plain", DEFEND),
                "analyst.convergence.1.jsonl": render(
                    "prose", CONVERGENCE_RESOLVED, prefix="They now agree, mark it resolved."
                ),
                "analyst.convergence.2.jsonl": render(
                    "schema", CONVERGENCE_RESOLVED, violation=CONVERGENCE_VIOLATIONS[0]
                ),
            },
        ),
    }


def build(root: Path = LOCAL_FIXTURES_DIR) -> list[Path]:
    """(Re)write every committed scenario under `root/scenarios`; returns the directories."""
    out: list[Path] = []
    for name, (with_extraction, files) in corpus().items():
        target = root / "scenarios" / name
        if target.exists():
            shutil.rmtree(target)
        out.append(write_scenario(root, name, files, with_extraction=with_extraction))
    return out


# --------------------------------------------------------------------------- hypothesis
# Prose that can wrap or replace a JSON object without creating a candidate object of its own:
# no braces, no backticks (fences), no surrogates / control characters.
chatty_text = st.text(
    alphabet=st.characters(blacklist_characters="{}`", blacklist_categories=("Cs", "Cc")),
    max_size=40,
)


def replies(valid: list[dict[str, Any]], violations: list[dict[str, Any]]) -> st.SearchStrategy:
    """Replies of every kind built around one of `valid` (or one of `violations`)."""
    return st.builds(
        render,
        st.sampled_from(KINDS),
        st.sampled_from(valid),
        violation=st.sampled_from(violations),
        lang=st.sampled_from(["", "json", "JSON"]),
        prefix=chatty_text,
        suffix=chatty_text,
        cut=st.integers(min_value=0, max_value=10_000),
        fenced=st.booleans(),
        indent=st.sampled_from([None, 2]),
    )


if __name__ == "__main__":  # pragma: no cover - manual regeneration
    for d in build():
        print(d)
