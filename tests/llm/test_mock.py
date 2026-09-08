"""mock transport: counters, sticky-last, mock_miss, calls capture, reset, recorded, pacing."""

from __future__ import annotations

import asyncio
import shutil

import pytest

from backend.llm import mock
from backend.llm.client import stream_completion
from backend.schemas import canonical_request_key
from tests.llm.conftest import LLM_FIXTURES_DIR, collect, kinds

MSGS = [{"role": "user", "content": "hello"}]


async def _chat(role="claude", purpose="chat", model="anthropic/claude-opus-5", **kw):
    args = dict(
        role=role, purpose=purpose, model=model, messages=MSGS, effort="medium", max_tokens=50
    )
    args.update(kw)
    return await collect(stream_completion(**args))


def _text(deltas):
    return "".join(d.text for d in deltas if d.kind == "text")


async def test_counters_advance_per_role_purpose_and_sticky_last(mini_fixtures):
    d1 = await _chat()
    d2 = await _chat()
    d3 = await _chat()
    assert "2000 deg/s" in _text(d1) and _text(d2).startswith("Second reply")
    assert _text(d3) == _text(d2)  # sticky-last: .2 keeps being served
    assert [c["fixture"] for c in mock.calls] == [
        "mini/claude.chat.1.jsonl",
        "mini/claude.chat.2.jsonl",
        "mini/claude.chat.2.jsonl",
    ]
    assert mock.counters()[("mini", "claude", "chat")] == 3
    # a different (role, purpose) has its own counter
    await _chat(role="claude", purpose="defense")
    assert mock.calls[-1]["fixture"] == "mini/claude.defense.1.jsonl"
    assert mock.counters()[("mini", "claude", "defense")] == 1
    assert mock.counters()[("mini", "claude", "chat")] == 3


async def test_mock_miss_when_no_file_at_all(mini_fixtures):
    deltas = await _chat(role="grok", purpose="convergence", model="x-ai/grok-4.6")
    assert kinds(deltas) == ["error"]
    e = deltas[0]
    assert e.code == "mock_miss" and e.error_type == "mock_miss"
    assert e.message == "no fixture mini/grok.convergence.1"
    assert mock.calls[-1]["fixture"] is None
    # the counter still advanced
    deltas = await _chat(role="grok", purpose="convergence", model="x-ai/grok-4.6")
    assert deltas[0].message == "no fixture mini/grok.convergence.2"


async def test_unknown_scenario_is_mock_miss(mini_fixtures, monkeypatch):
    monkeypatch.setenv("MOCK_SCENARIO", "does_not_exist")
    deltas = await _chat()
    assert (
        kinds(deltas) == ["error"]
        and deltas[0].message == "no fixture does_not_exist/claude.chat.1"
    )


async def test_calls_capture_shape(mini_fixtures):
    await _chat(
        role="claude",
        purpose="chat",
        effort="off",
        max_tokens=77,
        plugins=[{"id": "web"}],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "x", "strict": True, "schema": {}},
        },
    )
    c = mock.calls[-1]
    assert set(c) == {
        "role",
        "purpose",
        "model",
        "messages",
        "reasoning",
        "response_format",
        "plugins",
        "max_tokens",
        "fixture",
    }
    assert (
        c["role"] == "claude" and c["purpose"] == "chat" and c["model"] == "anthropic/claude-opus-5"
    )
    assert c["messages"] == MSGS and c["messages"] is not MSGS
    assert c["reasoning"] == {"enabled": False}
    assert c["response_format"]["json_schema"]["name"] == "x"
    assert c["plugins"] == [{"id": "web"}] and c["max_tokens"] == 77
    assert c["fixture"] == "mini/claude.chat.1.jsonl"


async def test_reset_clears_counters_and_calls(mini_fixtures):
    await _chat()
    await _chat()
    assert len(mock.calls) == 2 and mock.counters()
    mock.reset()
    assert mock.calls == [] and mock.counters() == {}
    await _chat()
    assert mock.calls[-1]["fixture"] == "mini/claude.chat.1.jsonl"


async def test_scenario_and_fixtures_dir_read_per_lookup(mini_fixtures, monkeypatch, tmp_path):
    await _chat()
    assert mock.calls[-1]["fixture"] == "mini/claude.chat.1.jsonl"
    monkeypatch.setenv("MOCK_SCENARIO", "mini_invalid")
    await _chat(role="analyst", purpose="extraction", model="openai/gpt-5.6-luna")
    assert mock.calls[-1]["fixture"] == "mini_invalid/analyst.extraction.1.jsonl"
    assert mock.counters()[("mini_invalid", "analyst", "extraction")] == 1
    # switching the fixtures dir mid-test is honoured too
    other = tmp_path / "fx"
    shutil.copytree(LLM_FIXTURES_DIR / "scenarios" / "mini", other / "scenarios" / "alt")
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(other))
    monkeypatch.setenv("MOCK_SCENARIO", "alt")
    await _chat()
    assert mock.calls[-1]["fixture"] == "alt/claude.chat.1.jsonl"


async def test_recorded_lookup_by_canonical_key_takes_precedence(
    mini_fixtures, monkeypatch, tmp_path
):
    fx = tmp_path / "fx"
    shutil.copytree(LLM_FIXTURES_DIR / "scenarios" / "mini", fx / "scenarios" / "mini")
    rf = {"type": "json_schema", "json_schema": {"name": "x", "strict": True, "schema": {}}}
    key = canonical_request_key("anthropic/claude-opus-5", MSGS, rf)
    (fx / "recorded").mkdir()
    (fx / "recorded" / f"{key}.jsonl").write_text(
        '{"id":"gen-rec","choices":[{"index":0,"delta":{"content":"recorded reply"},"finish_reason":"stop"}]}\n'
        '{"id":"gen-rec","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}],'
        '"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"cost":0.00001}}\n'
    )
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(fx))

    # same model/messages/response_format -> recorded, counters untouched
    deltas = await _chat(response_format=rf, effort="high", max_tokens=999)
    assert _text(deltas) == "recorded reply" and deltas[-1].generation_id == "gen-rec"
    assert mock.calls[-1]["fixture"] == f"recorded/{key}.jsonl"
    assert ("mini", "claude", "chat") not in mock.counters()
    # a different response_format misses the recorded file -> scenario counter path
    deltas = await _chat(response_format=None)
    assert mock.calls[-1]["fixture"] == "mini/claude.chat.1.jsonl"
    assert "2000 deg/s" in _text(deltas)


async def test_mock_delay_ms_paces_replay(mini_fixtures, monkeypatch):
    sleeps: list[float] = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(mock.asyncio, "sleep", fake_sleep)
    monkeypatch.setenv("MOCK_DELAY_MS", "7")
    deltas = await _chat()
    assert len(deltas) == 4  # text, reasoning, text, done
    assert sleeps == [0.007] * 3  # between consecutive deltas
    sleeps.clear()
    monkeypatch.setenv("MOCK_DELAY_MS", "0")
    await _chat()
    assert sleeps == []


async def test_mock_delay_real_sleep_is_honoured(mini_fixtures, monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "5")
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    await _chat()
    assert loop.time() - t0 >= 0.012  # 3 gaps x 5 ms, with slack


async def test_lines_feed_through_the_real_parser(mini_fixtures):
    deltas = await _chat(role="chatgpt", model="openai/gpt-5.6-sol")
    assert kinds(deltas) == ["text", "done"]
    assert deltas[-1].truncated is True and deltas[-1].usage.cost_usd == 0.0001


def test_resolve_scenario_file_rules(tmp_path):
    d = tmp_path / "scenarios" / "s"
    d.mkdir(parents=True)
    for n in (1, 2, 4):
        (d / f"r.p.{n}.jsonl").write_text("{}\n")
    r = mock.resolve_scenario_file
    assert r(tmp_path, "s", "r", "p", 1)[1] == 1
    assert r(tmp_path, "s", "r", "p", 2)[1] == 2
    assert r(tmp_path, "s", "r", "p", 3)[1] == 2  # gap -> sticky on the highest lower file
    assert r(tmp_path, "s", "r", "p", 4)[1] == 4
    assert r(tmp_path, "s", "r", "p", 9)[1] == 4  # never advances past the last file
    assert r(tmp_path, "s", "r", "other", 1) is None
    assert r(tmp_path, "nope", "r", "p", 1) is None


@pytest.mark.parametrize("bad", ["", "   \n"])
async def test_empty_fixture_file_still_terminates(mini_fixtures, monkeypatch, tmp_path, bad):
    fx = tmp_path / "fx"
    (fx / "scenarios" / "e").mkdir(parents=True)
    (fx / "scenarios" / "e" / "claude.chat.1.jsonl").write_text(bad)
    monkeypatch.setenv("MOCK_FIXTURES_DIR", str(fx))
    monkeypatch.setenv("MOCK_SCENARIO", "e")
    deltas = await _chat()
    assert kinds(deltas) == ["done"]  # synthesised done, never hangs or raises


def test_existing_numbers_is_sorted_and_safe_on_a_missing_dir(tmp_path):
    assert mock.existing_numbers(tmp_path / "nope", "claude", "chat") == []
    d = tmp_path / "s"
    d.mkdir()
    for n in (3, 1, 10):
        (d / f"claude.chat.{n}.jsonl").write_text("{}\n")
    (d / "claude.defense.1.jsonl").write_text("{}\n")
    (d / "claude.chat.x.jsonl").write_text("{}\n")
    assert mock.existing_numbers(d, "claude", "chat") == [1, 3, 10]
