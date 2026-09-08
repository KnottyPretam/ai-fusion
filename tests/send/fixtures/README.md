# tests/send private fixtures

`MOCK_FIXTURES_DIR` is pointed here by `tests/send/test_grounded_citations.py`. Same JSONL
format as `backend/llm/fixtures` (docs/fixtures.md): one raw OpenRouter `data:` object per line,
no comments, no `[DONE]`; a success ends with the usage chunk.

## scenario `grounded_dupes`

| file | content |
|---|---|
| `claude.chat.1` | the datasheet URL is cited on TWO delta chunks and again in `message.annotations` on the usage chunk; the product URL appears only on the usage chunk (de-duplication by URL across the stream) |
| `chatgpt.chat.1`, `grok.chat.1` | plain one-chunk replies, no annotations |
