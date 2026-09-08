"""complete_json: lenient extraction (hypothesis fuzz), the retry rule, structured outputs."""

from __future__ import annotations

import json

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from backend.llm import catalog, mock
from backend.llm.client import RETRY_USER_MESSAGE, complete_json, extract_json
from backend.schemas import ConvergenceCheck, DefenseReply, Extraction, ModelMeta

# --------------------------------------------------------------------------- extract_json (fuzz)
_json_scalars = (
    st.none()
    | st.booleans()
    | st.integers(min_value=-(10**12), max_value=10**12)
    | st.floats(allow_nan=False, allow_infinity=False, width=32)
    | st.text(max_size=20)
)
json_values = st.recursive(
    _json_scalars,
    lambda children: (
        st.lists(children, max_size=4) | st.dictionaries(st.text(max_size=8), children, max_size=4)
    ),
    max_leaves=12,
)
json_objects = st.dictionaries(st.text(min_size=1, max_size=8), json_values, max_size=5)
chatty = st.text(alphabet=st.characters(blacklist_characters="{}"), max_size=40)
phrases = st.sampled_from(
    [
        "",
        "Sure! Here is the JSON you asked for:\n",
        "Here you go.\n\n",
        "\n\nHope that helps! Let me know if you need anything else.",
        " \n```\n",
    ]
)

FUZZ = settings(
    max_examples=150, deadline=None, database=None, suppress_health_check=[HealthCheck.too_slow]
)


@given(
    obj=json_objects,
    prefix=chatty,
    suffix=chatty,
    pre=phrases,
    post=phrases,
    lang=st.sampled_from(["", "json", "JSON"]),
    fenced=st.booleans(),
)
@FUZZ
def test_valid_json_is_always_found(obj, prefix, suffix, pre, post, lang, fenced):
    body = json.dumps(obj)
    if fenced:
        body = f"```{lang}\n{body}\n```"
    value, err = extract_json(prefix + pre + body + post + suffix)
    assert err is None and value == obj


@given(text=st.text(max_size=300))
@FUZZ
def test_arbitrary_text_never_raises(text):
    value, err = extract_json(text)
    assert (value is None) != (err is None)
    if value is not None:
        assert isinstance(value, dict)


@given(obj=json_objects, cut=st.integers(min_value=0, max_value=400), fenced=st.booleans())
@FUZZ
def test_truncated_output_never_raises(obj, cut, fenced):
    body = json.dumps(obj)
    if fenced:
        body = "```json\n" + body
    value, err = extract_json(body[:cut])
    assert (value is None) != (err is None)


@pytest.mark.parametrize(
    "text,expected",
    [
        ('{"a": 1}', {"a": 1}),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('```\n{"a": 1}\n```', {"a": 1}),
        ('Sure: {"a": {"b": [1, 2]}} and then }', {"a": {"b": [1, 2]}}),
        ('prefix { not json } {"ok": true} suffix', {"ok": True}),
        ('{"s": "a } b"}', {"s": "a } b"}),
        ('```json\n{"a": 1}', {"a": 1}),  # unterminated fence
    ],
)
def test_extract_json_examples(text, expected):
    assert extract_json(text) == (expected, None)


@pytest.mark.parametrize(
    "text", ["", "   ", "no json here", '{"a": 1', "[1, 2, 3]", "42", "```json\n```"]
)
def test_extract_json_failures(text):
    value, err = extract_json(text)
    assert value is None and isinstance(err, str) and err


# --------------------------------------------------------------------------- complete_json
ANALYST = dict(
    role="analyst",
    purpose="extraction",
    model="openai/gpt-5.6-luna",
    effort="medium",
    max_tokens=4000,
)
MSGS = [
    {"role": "system", "content": "You are an analyst."},
    {"role": "user", "content": "Compare R1, R2, R3."},
]


async def test_retries_zero_single_attempt_returns_parse_error(mini_fixtures):
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=0, **ANALYST
    )
    assert parsed is None
    assert raw.startswith("```json") and "divergences" in raw
    assert usage.totals.calls == 1 and len(usage.calls) == 1
    assert usage.calls[0].purpose == "extraction" and usage.calls[0].role == "analyst"
    assert usage.calls[0].cost_usd == 0.00008
    assert error and error.startswith("parse_error")
    assert len(mock.calls) == 1


async def test_retries_one_appends_raw_and_retry_message_then_succeeds(mini_fixtures):
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=1, **ANALYST
    )
    assert isinstance(parsed, Extraction) and error is None
    assert (
        parsed.divergences[0].id == "d1"
        and parsed.divergences[0].positions[1].claim == "1000 deg/s"
    )
    assert raw.startswith("{") and raw.endswith("}")  # last attempt's raw text
    assert usage.totals.calls == 2 and [u.cost_usd for u in usage.calls] == [0.00008, 0.00016]
    assert usage.totals.cost_usd == pytest.approx(0.00024) and usage.totals.latency_ms >= 0
    assert [c["fixture"] for c in mock.calls] == [
        "mini/analyst.extraction.1.jsonl",
        "mini/analyst.extraction.2.jsonl",
    ]
    first_raw = "".join(
        # the first attempt's text, reconstructed from the fixture through the same parser
        d.text
        for d in _fixture_deltas(
            mini_fixtures / "scenarios" / "mini" / "analyst.extraction.1.jsonl"
        )
        if d.kind == "text"
    )
    retry_msgs = mock.calls[1]["messages"]
    assert retry_msgs[: len(MSGS)] == MSGS
    assert retry_msgs[-2] == {"role": "assistant", "content": first_raw}
    assert retry_msgs[-1]["role"] == "user"
    assert retry_msgs[-1]["content"].startswith("Your previous output failed validation: ")
    assert retry_msgs[-1]["content"].endswith(". Return only the corrected JSON.")
    assert retry_msgs[-1]["content"] == RETRY_USER_MESSAGE.format(
        error=retry_msgs[-1]["content"][40:-33]
    )
    assert len(mock.calls) == 2
    # the caller's message list is never mutated
    assert len(MSGS) == 2


async def test_validation_failure_retry_message_carries_the_pydantic_error(
    mini_fixtures, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "mini_invalid")
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=1, **ANALYST
    )
    assert isinstance(parsed, Extraction) and error is None and usage.totals.calls == 2
    retry = mock.calls[1]["messages"][-1]["content"]
    assert "R9" in retry and "validation error" in retry.lower()
    assert mock.calls[1]["messages"][-2]["content"].startswith('{"agreements"')


async def test_validation_failure_without_retry_returns_str_validation_error(
    mini_fixtures, monkeypatch
):
    monkeypatch.setenv("MOCK_SCENARIO", "mini_invalid")
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=0, **ANALYST
    )
    assert parsed is None and raw.startswith("{") and usage.totals.calls == 1
    assert error and "R9" in error


async def test_max_attempts_is_retries_plus_one_sticky_last(mini_fixtures, monkeypatch):
    """mini_invalid has only two files; retries=3 would need 4 attempts but the 2nd succeeds."""
    monkeypatch.setenv("MOCK_SCENARIO", "mini_invalid")
    parsed, _, usage, _ = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=3, **ANALYST
    )
    assert isinstance(parsed, Extraction) and usage.totals.calls == 2
    # With a schema no fixture satisfies, exactly retries + 1 attempts are made.
    mock.reset()
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=2, **ANALYST
    )
    assert parsed is None and usage.totals.calls == 3 and len(mock.calls) == 3 and error


async def test_no_retry_on_transport_error(mini_fixtures):
    parsed, raw, usage, error = await complete_json(
        role="grok",
        purpose="defense",
        model="x-ai/grok-4.6",
        messages=MSGS,
        schema_model=DefenseReply,
        effort="medium",
        max_tokens=2000,
        retries=1,
    )
    assert parsed is None and raw == "" and error == "Rate limit exceeded"
    assert usage.totals.calls == 0 and usage.calls == []
    assert len(mock.calls) == 1


async def test_mock_miss_is_a_transport_error(mini_fixtures):
    parsed, raw, usage, error = await complete_json(
        role="grok",
        purpose="convergence",
        model="x-ai/grok-4.6",
        messages=MSGS,
        schema_model=ConvergenceCheck,
        effort="medium",
        max_tokens=1000,
        retries=1,
    )
    assert parsed is None and raw == "" and "no fixture mini/grok.convergence.1" in error
    assert len(mock.calls) == 1 and mock.calls[0]["fixture"] is None


async def test_cost_cap_error_returns_the_code(live_transport, respx_router, monkeypatch):
    from backend.llm import metering

    monkeypatch.setenv("SESSION_COST_CAP_USD", "1")
    metering.add_session_cost(1.5)
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=1, **ANALYST
    )
    assert parsed is None and raw == "" and usage.totals.calls == 0
    assert error == "cost_cap_exceeded"


async def test_success_first_try_and_usage_per_attempt(mini_fixtures):
    parsed, raw, usage, error = await complete_json(
        role="claude",
        purpose="defense",
        model="anthropic/claude-opus-5",
        messages=MSGS,
        schema_model=DefenseReply,
        effort="low",
        max_tokens=2000,
        retries=1,
    )
    assert isinstance(parsed, DefenseReply) and parsed.stance == "defend" and error is None
    assert json.loads(raw)["confidence"] == 0.9
    assert usage.totals.calls == 1 and usage.calls[0].reasoning_tokens == 10
    assert usage.calls[0].role == "claude" and usage.calls[0].purpose == "defense"
    assert mock.calls[0]["reasoning"] == {"effort": "low"} and mock.calls[0]["max_tokens"] == 2000


# --------------------------------------------------------------------------- structured outputs
async def test_response_format_sent_only_when_structured_outputs(mini_fixtures, monkeypatch):
    await complete_json(
        messages=MSGS,
        schema_model=ConvergenceCheck,
        retries=0,
        **dict(ANALYST, purpose="convergence"),
    )
    rf = mock.calls[-1]["response_format"]
    assert rf["type"] == "json_schema"
    js = rf["json_schema"]
    assert js["name"] == "convergence" and js["strict"] is True
    assert js["schema"]["type"] == "object" and js["schema"]["additionalProperties"] is False
    assert set(js["schema"]["required"]) == {"statuses"}

    mock.reset()
    monkeypatch.setattr(catalog, "get_meta", lambda m: ModelMeta(id=m, structured_outputs=False))
    await complete_json(messages=MSGS, schema_model=Extraction, retries=0, **ANALYST)
    assert mock.calls[-1]["response_format"] is None

    mock.reset()
    monkeypatch.setattr(catalog, "get_meta", lambda m: None)
    await complete_json(messages=MSGS, schema_model=Extraction, retries=0, **ANALYST)
    assert mock.calls[-1]["response_format"] is None


# --------------------------------------------------------------------------- helpers
def _fixture_deltas(path):
    from backend.llm.stream import parse_sse_lines

    lines = [ln for ln in path.read_text().splitlines() if ln.strip()]
    return list(parse_sse_lines(f"data: {ln}" for ln in lines))
