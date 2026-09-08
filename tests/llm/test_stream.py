"""parse_sse_lines: the OpenRouter SSE rules from docs/api-contract.md + docs/fixtures.md."""

from __future__ import annotations

import json
import logging

from backend.llm import metering
from backend.llm.stream import SSEParser, parse_sse_lines
from tests.llm.conftest import chunk, citation, error_chunk, kinds, sse_lines, usage_obj


def _parse(*payloads: str, done: bool = True):
    return list(parse_sse_lines(sse_lines(*payloads, done=done)))


def test_comments_blank_lines_and_done_sentinel():
    deltas = list(
        parse_sse_lines(
            [
                ": OPENROUTER PROCESSING",
                "",
                "data: " + chunk(content="Hel", role=True),
                "",
                ": OPENROUTER PROCESSING",
                "data: " + chunk(content="lo", finish="stop"),
                "data: " + chunk(content="", usage=usage_obj()),
                "data: [DONE]",
                "data: " + chunk(content="AFTER DONE MUST BE IGNORED"),
            ]
        )
    )
    assert kinds(deltas) == ["text", "text", "done"]
    assert "".join(d.text for d in deltas if d.kind == "text") == "Hello"
    done = deltas[-1]
    assert done.finish_reason == "stop" and done.truncated is False
    assert done.generation_id == "gen-test"
    assert done.usage is not None and done.usage.prompt_tokens == 120
    assert done.usage.completion_tokens == 40 and done.usage.cost_usd == 0.00123


def test_usage_chunk_maps_reasoning_tokens_and_cost():
    deltas = _parse(
        chunk(content="x", finish="stop"),
        chunk(content="", usage=usage_obj(prompt=7, completion=9, cost=0.5, reasoning=4)),
    )
    u = deltas[-1].usage
    assert (u.prompt_tokens, u.completion_tokens, u.reasoning_tokens, u.cost_usd) == (7, 9, 4, 0.5)


def test_mid_stream_error_is_the_only_event_and_terminal():
    deltas = _parse(error_chunk(502, "Provider disconnected", "provider_unavailable"))
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == 502 and e.message == "Provider disconnected"
    assert e.error_type == "provider_unavailable" and e.usage is None


def test_error_after_text_stops_the_stream_and_ignores_the_rest():
    deltas = _parse(
        chunk(content="partial"),
        error_chunk("server_error", "boom", None),
        chunk(content="never"),
        chunk(content="", usage=usage_obj()),
    )
    assert kinds(deltas) == ["text", "error"]
    assert deltas[1].code == "server_error" and deltas[1].error_type is None


def test_reasoning_details_text_and_summary_encrypted_ignored():
    deltas = _parse(
        chunk(
            reasoning_details=[
                {"type": "reasoning.text", "text": "step one ", "signature": None},
                {"type": "reasoning.encrypted", "data": "[REDACTED]"},
                {"type": "reasoning.summary", "summary": "summary"},
            ]
        ),
        chunk(content="answer", finish="stop"),
        chunk(content="", usage=usage_obj()),
    )
    assert kinds(deltas) == ["reasoning", "text", "done"]
    assert deltas[0].text == "step one summary"


def test_bare_delta_reasoning_string():
    deltas = _parse(
        chunk(reasoning="thinking..."),
        chunk(content="a", finish="stop"),
        chunk(content="", usage=usage_obj()),
    )
    assert kinds(deltas) == ["reasoning", "text", "done"]
    assert deltas[0].text == "thinking..."


def test_bare_reasoning_identical_to_details_is_not_doubled():
    deltas = _parse(
        chunk(reasoning="same", reasoning_details=[{"type": "reasoning.text", "text": "same"}]),
        chunk(reasoning="other", reasoning_details=[{"type": "reasoning.text", "text": "one"}]),
        chunk(content="", usage=usage_obj()),
    )
    assert [d.text for d in deltas if d.kind == "reasoning"] == ["same", "oneother"]


def test_annotations_on_delta_and_on_usage_chunk_deduplicated_by_url():
    a, b = citation("https://a.example/1", "A"), citation("https://b.example/2", "B")
    deltas = _parse(
        chunk(content="see", annotations=[a]),
        chunk(content=" more", annotations=[a, b], finish="stop"),
        chunk(
            content="", message_annotations=[b, citation("https://c.example/3")], usage=usage_obj()
        ),
    )
    assert kinds(deltas) == ["text", "citations", "text", "citations", "citations", "done"]
    assert deltas[1].items == [a]
    assert deltas[3].items == [b]  # `a` already seen
    assert deltas[4].items == [citation("https://c.example/3")]
    # verbatim pass-through: the exact annotation object, untouched
    assert deltas[1].items[0] is not None and deltas[1].items[0]["url_citation"]["title"] == "A"


def test_annotations_all_duplicates_emit_nothing():
    a = citation("https://a.example/1")
    deltas = _parse(
        chunk(content="x", annotations=[a]),
        chunk(content="y", annotations=[a], finish="stop"),
        chunk(content="", usage=usage_obj()),
    )
    assert kinds(deltas) == ["text", "citations", "text", "done"]


def test_finish_reason_length_marks_truncated_and_last_non_null_wins():
    deltas = _parse(
        chunk(content="a", finish=None),
        chunk(content="b", finish="length"),
        chunk(content="", finish="length", usage=usage_obj()),
    )
    done = deltas[-1]
    assert done.finish_reason == "length" and done.truncated is True


def test_usage_chunk_with_null_finish_reason_keeps_the_last_seen():
    deltas = _parse(chunk(content="a", finish="stop"), chunk(content="", usage=usage_obj()))
    assert deltas[-1].finish_reason == "stop"


def test_generation_id_is_the_first_chunk_id():
    deltas = _parse(
        chunk(content="a", cid="gen-first"),
        chunk(content="b", cid="gen-second", finish="stop"),
        chunk(content="", cid="gen-third", usage=usage_obj()),
    )
    assert deltas[-1].generation_id == "gen-first"
    assert deltas[-1].usage.generation_id == "gen-first"


def test_stream_without_usage_chunk_synthesises_done_with_estimate(caplog):
    caplog.set_level("DEBUG", logger="triplex.llm.stream")
    text = "x" * 40
    deltas = _parse(chunk(content=text, finish="stop", model="anthropic/claude-opus-5"))
    assert kinds(deltas) == ["text", "done"]
    done = deltas[-1]
    assert done.finish_reason == "stop" and done.usage is not None
    assert done.usage.completion_tokens == len(text) // 4 == 10
    # catalog price of claude-opus-5: $25 / M output tokens
    assert abs(done.usage.cost_usd - 10 * 25e-6) < 1e-12
    assert isinstance(done.usage, metering.EstimatedUsage)
    # The estimate is logged at DEBUG only: the client's single INFO line carries the marker
    # (semantics.md: one INFO log line per LLM call).
    records = [r for r in caplog.records if r.name == "triplex.llm.stream"]
    assert records and all(r.levelno == logging.DEBUG for r in records)
    assert any("estimated" in r.getMessage() for r in records)


def test_usage_cost_missing_flag_tracks_the_usage_chunk():
    p = SSEParser()
    p.feed("data: " + chunk(content="x"))
    assert p.usage_cost_missing is False
    p.feed("data: " + chunk(usage=usage_obj(cost=None)))
    assert p.usage_cost_missing is True
    with_cost = SSEParser()
    with_cost.feed("data: " + chunk(usage=usage_obj(cost=0.1)))
    assert with_cost.usage_cost_missing is False
    bad = SSEParser()
    bad.feed("data: " + chunk(usage=usage_obj(cost="n/a")))
    assert bad.usage_cost_missing is True


def test_stream_that_just_ends_without_done_sentinel_still_terminates():
    deltas = _parse(chunk(content="hi", finish="stop"), done=False)
    assert kinds(deltas) == ["text", "done"]


def test_empty_stream_yields_exactly_one_terminal_delta():
    assert kinds(list(parse_sse_lines([]))) == ["done"]
    assert kinds(list(parse_sse_lines(["data: [DONE]"]))) == ["done"]


def test_malformed_lines_are_skipped_never_raise():
    deltas = list(
        parse_sse_lines(
            [
                "data: {not json",
                "event: ping",
                "data: 42",
                "data: " + json.dumps({"choices": []}),
                "data: " + json.dumps({"choices": [{"delta": None}]}),
                "data: " + chunk(content="ok", finish="stop"),
                "data: " + chunk(content="", usage=usage_obj()),
            ]
        )
    )
    assert kinds(deltas) == ["text", "done"]


def test_empty_content_and_role_only_chunks_emit_nothing():
    deltas = _parse(chunk(role=True), chunk(content=""), chunk(content="", usage=usage_obj()))
    assert kinds(deltas) == ["done"]


def test_data_prefix_without_space_and_crlf_lines():
    lines = ["data:" + chunk(content="a", finish="stop") + "\r", "data: [DONE]\r"]
    deltas = list(parse_sse_lines(lines))
    assert kinds(deltas) == ["text", "done"] and deltas[0].text == "a"


def test_nothing_after_terminal_even_when_fed_more():
    p = SSEParser()
    assert kinds(p.feed("data: " + error_chunk())) == ["error"]
    assert p.feed("data: " + chunk(content="x")) == []
    assert p.finish() == []


def test_error_code_string_and_mock_miss_shape():
    line = json.dumps(
        {
            "error": {
                "code": "mock_miss",
                "message": "no fixture s/r.p.1",
                "metadata": {"error_type": "mock_miss"},
            }
        }
    )
    deltas = _parse(line)
    assert kinds(deltas) == ["error"]
    assert deltas[0].code == "mock_miss" and deltas[0].error_type == "mock_miss"
