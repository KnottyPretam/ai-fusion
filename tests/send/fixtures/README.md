# tests/send private fixtures

`MOCK_FIXTURES_DIR` is pointed here by `tests/send/test_grounded_citations.py` and
`tests/send/test_slot_failures.py`. Same JSONL format as `backend/llm/fixtures`
(docs/fixtures.md): one raw OpenRouter `data:` object per line, no comments, no `[DONE]`; a
success ends with the usage chunk.

## scenario `grounded_dupes`

| file | content |
|---|---|
| `claude.chat.1` | the datasheet URL is cited on TWO delta chunks and again in `message.annotations` on the usage chunk; the product URL appears only on the usage chunk (de-duplication by URL across the stream) |
| `chatgpt.chat.1`, `grok.chat.1` | plain one-chunk replies, no annotations |

## scenario `empty_reply`

A `done` with no text is a slot failure (`slot_error{code:"empty_reply", error_type:"triplex"}`,
nothing appended, `responses[slot]=None`, `truncated` still from `finish_reason`, usage still
billed), never an empty assistant message in the thread.

| file | content |
|---|---|
| `claude.chat.1` | one `reasoning.text` chunk, then the usage chunk carrying `finish_reason:"length"` and 64 reasoning tokens: reasoning consumed the whole budget, no content at all |
| `chatgpt.chat.1` | a plain one-chunk reply (`stop`) |
| `grok.chat.1` | a single usage-only chunk with `finish_reason:"stop"`: the provider returned nothing |

Expected: `slot_error{empty_reply}` for claude (`finish_reason=length`, `truncated:true`) and
grok (`finish_reason=stop`), `slot_done` for chatgpt, `turn_done.usage.totals.calls == 3`,
`threads.claude == threads.grok == []`, and Analyze answers `409 incomplete_send_turn
{missing:["claude","grok"]}`.
