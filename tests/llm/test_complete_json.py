"""complete_json: lenient extraction (hypothesis fuzz), the retry rule, structured outputs."""

from __future__ import annotations

import json

import httpx
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from backend.llm import catalog, mock
from backend.llm.client import (
    RETRY_USER_MESSAGE,
    complete_json,
    extract_json,
    repair_json_string_quotes,
)
from backend.schemas import ConvergenceCheck, DefenseReply, Extraction, ModelMeta
from tests.llm.conftest import CHAT_URL, chunk, error_chunk, sse_body, usage_obj

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


def test_truncated_nested_output_is_a_parse_error_not_an_inner_object():
    """'Outermost braces': a complete inner object must never be returned for a truncated
    reply, or the retry would tell the model its output failed validation instead of being
    cut off."""
    text = '{"agreements": [{"label": "R1", "claim": "2000 deg/s"}], "divergences": [{"id": "d1"'
    for variant in (text, "```json\n" + text, "Here it is:\n" + text):
        value, err = extract_json(variant)
        assert value is None and err and "truncated" in err, variant
    # a stray non-JSON object before the real one is still skipped, nesting inside a COMPLETE
    # object is untouched, and a stray closing brace after it does not matter
    assert extract_json('{ not json } {"a": {"b": 1}}') == ({"a": {"b": 1}}, None)
    assert extract_json('{"a": {"b": 1}} }') == ({"a": {"b": 1}}, None)


# ------------------------------------------------- fenced blocks and the web quote repair (S7)
# The defect MEASURED live on 2026-09-17: a web analyst's reply is read back out of the chat page's
# RENDERED markdown, where CommonMark resolves a backslash escape before any ASCII punctuation, so
# a correct `\"PING-1\"` inside a JSON string arrived as a bare `"PING-1"` and Analyze degraded.
MEASURED = (
    '{"agreements":[{"topic":"Requested output","statement":"The reply is exactly "PING-1".",'
    '"models":["R1","R2","R3"]}],"divergences":[]}'
)


def test_a_fenced_block_wins_over_prose_around_it():
    """The fence is what survives a rendered round trip, so its CONTENT is the payload and anything
    outside it is chrome -- even when the prose happens to hold a parseable object of its own."""
    text = 'Draft was {"draft": true}.\n\n```json\n{"real": 1}\n```\n\nHope that helps!'
    assert extract_json(text) == ({"real": 1}, None)
    # ... and a fence whose trailing junk breaks the whole-candidate parse is still preferred
    assert extract_json('{"prose": 1}\n```json\n{"real": 2}\n// done\n```') == ({"real": 2}, None)


def test_a_fence_holding_invalid_json_falls_through_to_the_lenient_scan():
    assert extract_json('```json\n{"a": 1,}\n```\n{"b": 2}') == ({"b": 2}, None)
    value, err = extract_json("```json\nnot json at all\n```")
    assert value is None and err


@pytest.mark.parametrize(
    "text",
    [
        MEASURED,
        "```json\n" + MEASURED + "\n```",
        "Here you go:\n\n" + MEASURED + "\n\nLet me know!",
    ],
)
def test_repair_recovers_the_measured_unescaped_quotes(text):
    """Only with `repair=True` (the web transport): the analyst's own statement comes back."""
    assert extract_json(text) == (None, "no JSON object found in the response")
    value, err = extract_json(text, repair=True)
    assert err is None
    assert value["agreements"][0]["statement"] == 'The reply is exactly "PING-1".'
    assert value["divergences"] == []


@pytest.mark.parametrize(
    "text",
    [
        '{"a": "x" "b": "y"}',  # a missing comma: repairing the quotes cannot rescue it
        '{"a": [{"b": "c"',  # truncated: the truncation hint must survive
        "no json here",
        "```json\n```",
        '{"a": 1',
    ],
)
def test_repair_never_rescues_text_that_is_broken_some_other_way(text):
    """The repair is accepted only when the result parses, so every one of these keeps the error it
    had before -- the retry-then-degrade path is unchanged."""
    assert extract_json(text, repair=True) == extract_json(text)


def test_repair_does_not_fire_on_valid_json_examples():
    """The rule can only match text that is already invalid: inside an object or an array a JSON
    string is ALWAYS followed by `,` `}` `]` or `:` (modulo whitespace)."""
    for text in (
        '{"a": 1}',
        '{"s": "a, b: c} ] x"}',  # every closer character INSIDE a string value
        '{"s": "he said \\"hi\\""}',  # already escaped
        '{"s": "trailing backslash \\\\"}',
        '{"a": {"b": ["x", "y"]}, "c": null}',
        json.dumps({"k": 'a "quoted" phrase, then: more'}, indent=2),
        '"just a string"',
        "   ",
    ):
        assert repair_json_string_quotes(text) is None, text


@given(obj=json_objects, indent=st.sampled_from([None, 2]))
@FUZZ
def test_repair_never_touches_valid_json(obj, indent):
    """The non-destructiveness proof: for ANY object json.dumps can emit, the repair declines."""
    dumped = json.dumps(obj, indent=indent)
    for text in (dumped, json.dumps(obj, indent=indent, ensure_ascii=False)):
        assert repair_json_string_quotes(text) is None
        assert extract_json(text, repair=True) == extract_json(text) == (obj, None)


@given(text=st.one_of(st.text(max_size=120), st.just(MEASURED), json_objects.map(json.dumps)))
@FUZZ
def test_repair_only_ever_inserts_backslashes(text):
    """Whatever it does to ARBITRARY text, the output is the input with `\\` characters inserted:
    nothing is ever deleted, reordered or rewritten, so a repair can only fail to parse."""
    fixed = repair_json_string_quotes(text)
    if fixed is None:
        return
    i = 0
    for ch in fixed:
        if i < len(text) and ch == text[i]:
            i += 1  # a character of the original, in order
        else:
            assert ch == "\\", (text, fixed)  # the only thing this function may add
    assert i == len(text), (text, fixed)


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


# --------------------------------------------------------------------------- transport errors
DEFENSE = dict(
    role="claude",
    purpose="defense",
    model="anthropic/claude-opus-5",
    effort="low",
    max_tokens=2000,
)


PARTIAL = '{"stance": "def'


def _partial_then_429(respx_router):
    return respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200,
            content=sse_body(
                chunk(content=PARTIAL),
                error_chunk(429, "Rate limit exceeded", "rate_limit_exceeded"),
            ),
        )
    )


def _client_records(caplog, level: str):
    return [r for r in caplog.records if r.name == "triplex.llm.client" and r.levelname == level]


async def test_transport_error_after_partial_text_returns_immediately(
    live_transport, respx_router, caplog
):
    """Partial JSON then a mid-stream 429: `(None, "", usage, message)`, no retry. `raw` stays ""
    -- it feeds the web no-retry rule -- and the partial reaches `on_partial` exactly once; the
    WARNING line carries its length, never the text."""
    caplog.set_level("WARNING", logger="triplex.llm.client")
    route = _partial_then_429(respx_router)
    seen: list[str] = []
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=1, on_partial=seen.append, **DEFENSE
    )
    assert parsed is None and raw == "" and error == "Rate limit exceeded"
    assert usage.totals.calls == 0 and usage.calls == []
    assert route.call_count == 1
    assert seen == [PARTIAL]
    (line,) = [
        r.getMessage()
        for r in _client_records(caplog, "WARNING")
        if r.getMessage().startswith("complete_json transport error")
    ]
    assert f"partial_chars={len(PARTIAL)}" in line and "attempt=1/2" in line
    assert "role=claude purpose=defense model=anthropic/claude-opus-5" in line
    assert PARTIAL not in line


async def test_on_partial_is_not_called_when_the_error_arrived_with_no_text(
    live_transport, respx_router, caplog
):
    caplog.set_level("WARNING", logger="triplex.llm.client")
    respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200, content=sse_body(error_chunk(429, "Rate limit exceeded", "rate_limit_exceeded"))
        )
    )
    seen: list[str] = []
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=1, on_partial=seen.append, **DEFENSE
    )
    assert parsed is None and raw == "" and error == "Rate limit exceeded"
    assert seen == []
    (line,) = [
        r.getMessage()
        for r in _client_records(caplog, "WARNING")
        if r.getMessage().startswith("complete_json transport error")
    ]
    assert "partial_chars=0" in line


async def test_on_partial_is_not_called_on_success(live_transport, respx_router):
    good = json.dumps({"stance": "defend", "justification": "datasheet table 3", "confidence": 0.9})
    respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200, content=sse_body(chunk(content=good, finish="stop"), chunk(usage=usage_obj()))
        )
    )
    seen: list[str] = []
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=1, on_partial=seen.append, **DEFENSE
    )
    assert isinstance(parsed, DefenseReply) and raw == good and error is None
    assert seen == []


async def test_a_raising_on_partial_is_logged_and_never_changes_the_result(
    live_transport, respx_router, caplog
):
    """A broken recorder must not turn a degrade into a terminal `error` event: the error tuple
    comes back exactly as without the callback, and the exception is logged (with its traceback,
    without the partial)."""
    caplog.set_level("WARNING", logger="triplex.llm.client")
    route = _partial_then_429(respx_router)

    def boom(text: str) -> None:
        raise RuntimeError("recorder broke")

    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=1, on_partial=boom, **DEFENSE
    )
    assert parsed is None and raw == "" and error == "Rate limit exceeded"
    assert usage.totals.calls == 0 and route.call_count == 1
    (record,) = _client_records(caplog, "ERROR")
    assert record.exc_info is not None and record.exc_info[0] is RuntimeError
    assert "on_partial" in record.getMessage() and PARTIAL not in record.getMessage()


async def test_transport_failure_keeps_its_reason(live_transport, respx_router):
    respx_router.post(CHAT_URL).mock(side_effect=httpx.ConnectError("connection refused by host"))
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=1, **ANALYST
    )
    assert parsed is None and raw == "" and usage.totals.calls == 0
    assert "connection refused by host" in error and error != "transport_error"


async def test_missing_api_key_keeps_its_reason(live_transport, respx_router, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=Extraction, retries=1, **ANALYST
    )
    assert parsed is None and "OPENROUTER_API_KEY" in error
    assert respx_router.calls.call_count == 0


async def test_truncated_attempt_is_logged_and_named_in_the_error(
    live_transport, respx_router, caplog
):
    """`complete_json` cannot return the `truncated` flag (frozen 4-tuple): the cap hit is
    logged as a WARNING per attempt, and the parse error tells the model its output was cut."""
    caplog.set_level("WARNING", logger="triplex.llm.client")
    cut = '{"stance": "defend", "justification": "the datasheet table lists'
    route = respx_router.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200,
            content=sse_body(
                chunk(content=cut, finish="length"),
                chunk(content="", finish="length", usage=usage_obj()),
            ),
        )
    )
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=1, **DEFENSE
    )
    assert parsed is None and raw == cut and route.call_count == 2
    assert usage.totals.calls == 2
    assert error and error.startswith("parse_error") and "truncated" in error
    warnings = [
        r.getMessage()
        for r in caplog.records
        if r.name == "triplex.llm.client" and r.levelname == "WARNING"
    ]
    assert len(warnings) == 2  # one per truncated attempt
    assert "truncated at max_tokens=2000" in warnings[0]
    assert "role=claude purpose=defense model=anthropic/claude-opus-5 attempt=1/2" in warnings[0]
    assert "attempt=2/2" in warnings[1]
    sent = json.loads(route.calls[1].request.content)["messages"]
    assert sent[-1]["content"] == RETRY_USER_MESSAGE.format(error=error)


async def test_empty_first_attempt_retries_without_an_empty_assistant_message(
    live_transport, respx_router
):
    """Providers reject empty assistant content, so an empty reply is not echoed back."""
    good = json.dumps({"stance": "defend", "justification": "datasheet table 3", "confidence": 0.9})
    route = respx_router.post(CHAT_URL).mock(
        side_effect=[
            httpx.Response(
                200, content=sse_body(chunk(content="", finish="stop"), chunk(usage=usage_obj()))
            ),
            httpx.Response(
                200, content=sse_body(chunk(content=good, finish="stop"), chunk(usage=usage_obj()))
            ),
        ]
    )
    parsed, raw, usage, error = await complete_json(
        messages=MSGS, schema_model=DefenseReply, retries=1, **DEFENSE
    )
    assert isinstance(parsed, DefenseReply) and error is None and raw == good
    assert route.call_count == 2 and usage.totals.calls == 2
    sent = json.loads(route.calls[1].request.content)["messages"]
    assert sent[: len(MSGS)] == MSGS
    assert [m["role"] for m in sent[len(MSGS) :]] == ["user"]  # no empty assistant turn
    assert sent[-1]["content"] == RETRY_USER_MESSAGE.format(error="parse_error: empty response")
    assert all(m["content"].strip() for m in sent)
