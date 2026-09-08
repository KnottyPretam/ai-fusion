# tests/analyze local fixtures (owner: W5)

Extra mock scenarios for Analyze's self-driven retry (transport errors and output-less first
attempts), served by pointing `MOCK_FIXTURES_DIR` at this directory
(`tests/analyze/conftest.py::local_fixtures`). Same JSONL format as
`backend/llm/fixtures/scenarios` (docs/fixtures.md): one raw OpenRouter chunk per line, an error
fixture ends with the error chunk and has no usage chunk, a successful one ends with the usage
chunk.

| Scenario | Files | Expected |
|---|---|---|
| `analyst_transport_error` | `analyst.extraction.1` = error chunk only (sticky-last serves it twice) | `analyze_retry` then `analyze_degraded`; `raw_attempts == ["", ""]`; no metered call; the retry re-sends the identical request |
| `analyst_transport_then_ok` | `.1` = error chunk, `.2` = the `planted_factual` extraction | `analyze_retry` then `analyze_done` (ok); `raw_attempts == ["", <json>]`; one metered call |
| `analyst_whitespace_then_ok` | `.1` = whitespace-only content (`"  \n\t"`, `finish_reason` stop, usage chunk), `.2` = the `planted_factual` extraction | `analyze_retry{error: "parse_error: empty response"}` then `analyze_done`; the retry carries the correction message but NO assistant echo (providers reject blank assistant content); `raw_attempts == ["  \n\t", <json>]`; two metered calls |
| `analyst_empty_then_ok` | `.1` = empty content (`""`, `finish_reason` stop, usage chunk), `.2` = the `planted_factual` extraction | `analyze_retry{error: "parse_error: empty response"}` then `analyze_done`; nothing to correct, so the retry re-sends the identical request (same rule as a transport error); `raw_attempts == ["", <json>]`; two metered calls |
