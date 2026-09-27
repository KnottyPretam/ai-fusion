"""Count-aware prompt fragments (2026-09-27, "a council anyone can assemble").

A conversation's council is 2..5 agents (`schemas.COUNCIL_MIN` / `COUNCIL_MAX`), shown to every
model as R1..Rn. Each prompt module builds its instructions from these helpers so the wording
follows the count ("three anonymous expert responses (R1, R2, R3)", "compared with two others"),
and each one defines its module constants FROM the builders at n=3, so the three-council text is
byte for byte what it always was -- the sha256 pins and both `test_golden.ambr` files are the proof.

Nothing here names a vendor, a slot id or a codename: every string reaches a model.
"""

from __future__ import annotations

from ..schemas import COUNCIL_MAX, COUNCIL_MIN, LABELS, Label

NUMBER_WORDS: dict[int, str] = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def check_council_size(n: int) -> int:
    """`n` when it is a council size (2..5); ValueError otherwise (never a silent clamp)."""
    if isinstance(n, bool) or not isinstance(n, int) or not COUNCIL_MIN <= n <= COUNCIL_MAX:
        raise ValueError(f"council size must be between {COUNCIL_MIN} and {COUNCIL_MAX}, got {n!r}")
    return n


def number_word(n: int) -> str:
    """`3 -> "three"`; sizes outside the council bounds are a ValueError."""
    return NUMBER_WORDS[check_council_size(n)]


def labels_for(n: int) -> tuple[Label, ...]:
    """R1..Rn."""
    return LABELS[: check_council_size(n)]


def label_list(n: int) -> str:
    """`"R1, R2, R3"`."""
    return ", ".join(labels_for(n))


def _joined(n: int, word: str) -> str:
    labels = labels_for(n)
    return ", ".join(labels[:-1]) + f" {word} " + labels[-1]


def label_or_list(n: int) -> str:
    """`"R1, R2 or R3"` (n=2: `"R1 or R2"`)."""
    return _joined(n, "or")


def label_and_list(n: int) -> str:
    """`"R1, R2 and R3"` (n=2: `"R1 and R2"`)."""
    return _joined(n, "and")


def schema_alternatives(n: int) -> str:
    """The schema fragment `"R1" | "R2" | "R3"`."""
    return " | ".join(f'"{label}"' for label in labels_for(n))


def others(n: int) -> str:
    """How many peers one response is compared with: `"two others"`; n=2 -> `"one other"`."""
    k = check_council_size(n) - 1
    return f"{NUMBER_WORDS[k]} other" + ("s" if k != 1 else "")


__all__ = [
    "NUMBER_WORDS",
    "check_council_size",
    "label_and_list",
    "label_list",
    "label_or_list",
    "labels_for",
    "number_word",
    "others",
    "schema_alternatives",
]
