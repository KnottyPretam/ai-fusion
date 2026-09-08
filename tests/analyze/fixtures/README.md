# tests/analyze local fixtures (owner: W5)

Extra mock scenarios for Analyze's transport-error path, served by pointing `MOCK_FIXTURES_DIR`
at this directory (`tests/analyze/conftest.py::local_fixtures`). Same JSONL format as
`backend/llm/fixtures/scenarios` (docs/fixtures.md): one raw OpenRouter chunk per line, an error
fixture ends with the error chunk and has no usage chunk.

| Scenario | Files | Expected |
|---|---|---|
| `analyst_transport_error` | `analyst.extraction.1` = error chunk only (sticky-last serves it twice) | `analyze_retry` then `analyze_degraded`; `raw_attempts == ["", ""]`; no metered call |
| `analyst_transport_then_ok` | `.1` = error chunk, `.2` = the `planted_factual` extraction | `analyze_retry` then `analyze_done` (ok); `raw_attempts == ["", <json>]`; one metered call |
