"""`backend.prompts.council`: the count-aware fragments every prompt module builds from, and the
pins that keep the three-council text byte-identical."""

from __future__ import annotations

import pytest

from backend.prompts import analyze, council, fusion, preparse, refactor
from backend.schemas import COUNCIL_MAX, COUNCIL_MIN, LABELS
from tests.helpers import find_identity_leaks


@pytest.mark.parametrize("n", [COUNCIL_MIN - 1, 0, COUNCIL_MAX + 1, 99, -1])
def test_sizes_outside_the_council_bounds_are_a_value_error(n):
    with pytest.raises(ValueError, match="between 2 and 5"):
        council.check_council_size(n)
    with pytest.raises(ValueError):
        council.number_word(n)
    with pytest.raises(ValueError):
        council.labels_for(n)


def test_bools_are_not_council_sizes():
    with pytest.raises(ValueError):
        council.check_council_size(True)  # type: ignore[arg-type]


def test_number_words_and_labels():
    assert [council.number_word(n) for n in range(2, 6)] == ["two", "three", "four", "five"]
    assert council.labels_for(2) == ("R1", "R2")
    assert council.labels_for(5) == LABELS
    assert council.label_list(3) == "R1, R2, R3"
    assert council.label_or_list(2) == "R1 or R2"
    assert council.label_or_list(3) == "R1, R2 or R3"
    assert council.label_or_list(5) == "R1, R2, R3, R4 or R5"
    assert council.label_and_list(2) == "R1 and R2"
    assert council.label_and_list(3) == "R1, R2 and R3"
    assert council.schema_alternatives(2) == '"R1" | "R2"'
    assert council.schema_alternatives(3) == '"R1" | "R2" | "R3"'
    assert council.others(2) == "one other"
    assert council.others(3) == "two others"
    assert council.others(5) == "four others"


def test_module_constants_are_the_builders_at_three():
    """The pins: every module constant is byte for byte its builder at n=3, so the sha256 pins in
    the prompt tests and both `test_golden.ambr` files hold without a single byte moving."""
    assert analyze.SYSTEM == analyze.system_for(3)
    assert analyze.SYSTEM_FENCED == analyze.system_for(3, fenced=True)
    assert analyze.CONDENSE_SYSTEM == analyze.condense_system_for(3)
    assert analyze.system_message() == analyze.SYSTEM
    assert fusion.CONVERGENCE_SYSTEM == fusion.convergence_system_for(3)
    assert fusion.CONVERGENCE_SYSTEM_FENCED == fusion.convergence_system_for(3, fenced=True)
    assert refactor.REPLY_SYSTEM == refactor.reply_system() == refactor.reply_system(n=3)
    assert refactor.REPLY_SYSTEM_FENCED == refactor.reply_system(fenced=True, n=3)
    assert preparse.RESTATE_SYSTEM == preparse.restate_system_for(3)
    assert preparse.RESTATE_SYSTEM_FENCED == preparse.restate_system_for(3, fenced=True)


@pytest.mark.parametrize("n", [2, 4, 5])
def test_other_sizes_change_only_the_counted_clauses(n):
    word = council.number_word(n)
    system = analyze.system_for(n)
    assert f"comparing {word} anonymous expert responses ({council.label_list(n)})" in system
    assert f"EVERY label ({council.label_or_list(n)})" in system
    assert f"only as {council.label_and_list(n)}." in system
    assert f'"models": [{council.schema_alternatives(n)}, ...]' in system
    assert "R3" not in system if n == 2 else "R4" in system
    assert f"compared with {council.others(n)}." in analyze.condense_system_for(n)
    assert f"compared with {council.others(n)}." in refactor.reply_system(n=n)
    assert f"whether {word} anonymous expert reviewers ({council.label_list(n)})" in (
        fusion.convergence_system_for(n)
    )
    assert f"put to {word} experts" in preparse.restate_system_for(n)
    # The fenced twin differs from the API text in the packaging clause only, at every size.
    assert analyze.system_for(n, fenced=True) == system.replace(
        analyze.JSON_INSTRUCTION, analyze.JSON_INSTRUCTION_FENCED
    )


@pytest.mark.parametrize("n", [2, 3, 4, 5])
def test_every_built_text_is_identity_free(n):
    texts = [
        analyze.system_for(n),
        analyze.system_for(n, fenced=True),
        analyze.condense_system_for(n, fenced=True),
        fusion.convergence_system_for(n, fenced=True),
        refactor.reply_system(n=n),
        preparse.restate_system_for(n),
    ]
    for text in texts:
        assert find_identity_leaks(text) == [], text[:80]


def test_messages_carry_the_size_through():
    two = analyze.build_messages("Q?", {"R1": "a", "R2": "b"})
    assert two[0]["content"] == analyze.system_for(2)
    assert analyze.condense_messages("Q", "R1", "x", n=2)[0]["content"] == analyze.condense_system_for(2)
    assert fusion.convergence_messages([], n=5)[0]["content"] == fusion.convergence_system_for(5)
    assert refactor.reply_messages("Q", "R2", "x", n=2)[0]["content"] == refactor.reply_system(n=2)
    with pytest.raises(ValueError, match="R3"):
        refactor.reply_messages("Q", "R3", "x", n=2)
    assert preparse.restate_messages("Q", n=4)[0]["content"] == preparse.restate_system_for(4)
