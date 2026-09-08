# tests/llm mini fixtures

Private replay fixtures for the W1 unit tests (`MOCK_FIXTURES_DIR` is monkeypatched to this
directory by the `mini_fixtures` fixture in `tests/llm/conftest.py`). Same JSONL format as
`backend/llm/fixtures` (docs/fixtures.md): one raw OpenRouter `data:` object per line, no
comments, no `[DONE]`; a success ends with the usage chunk, an error fixture ends with the error
chunk.

## scenario `mini`

| file | content |
|---|---|
| `claude.chat.1` | two content chunks + a `reasoning.text` block; usage cost 0.0004, reasoning_tokens 3 |
| `claude.chat.2` | a different reply (counter / sticky-last tests) |
| `chatgpt.chat.1` | `finish_reason: "length"` on the last text chunk and the usage chunk (truncated) |
| `grok.chat.1` | mid-stream error chunk only (502 provider_unavailable) |
| `analyst.extraction.1` | fenced AND truncated JSON (lenient parse fails) |
| `analyst.extraction.2` | valid `Extraction` |
| `analyst.convergence.1` | valid `ConvergenceCheck` (d1 resolved) |
| `claude.defense.1` | valid `DefenseReply` (defend) |
| `grok.defense.1` | mid-stream error chunk only (429 rate_limit_exceeded) |

Anything else (e.g. `grok.convergence.1`) is a deliberate `mock_miss`.

## scenario `mini_invalid`

| file | content |
|---|---|
| `analyst.extraction.1` | valid JSON that FAILS pydantic (`model: "R9"`) |
| `analyst.extraction.2` | valid `Extraction` |
