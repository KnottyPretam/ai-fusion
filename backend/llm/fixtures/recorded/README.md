# Recorded live transcripts (content-keyed replay)

Captured 2026-09-08 by `scripts/live_smoke.py --record` against the real OpenRouter API (the
Stage 4 live smoke: one prompt per slot at the configured effort, an analyst Extraction, one
grounded call). Each file is the raw `data:` chunk stream keyed by `schemas.canonical_request_key`
of the request, so the mock replays it whenever the identical request is made
(`docs/fixtures.md`, lookup step 1). No secrets: request payloads live only in the
gitignored `data/recordings/` directory.

| role | purpose | model | file |
|---|---|---|---|
| claude | chat | `anthropic/claude-opus-5` | `7c1f99ad63ea54a741a45db34e0be2dc64a16fb9293dd99e3da739145544f877.jsonl` |
| chatgpt | chat | `openai/gpt-5.6-sol` | `bd1bafab26611e8758c52a2e36aa77fd666d9172b03513dc40d0023b5e4766db.jsonl` |
| grok | chat | `x-ai/grok-4.6` | `86f8901367005029a99d1a3334c9ec5d36d6bea7efda6b6e372bede5d584c914.jsonl` |
| analyst | extraction | `openai/gpt-5.6-luna` | `91d842203677e5704c01da59252ec7e3521ea1a59f3a2d91017e8ed89514d4c3.jsonl` |
| claude | chat | `anthropic/claude-opus-5` | `67d5fc18d7d54b933dee89649a696ac29fc422bd46831aeb998ba6459271f64f.jsonl` |

Observed stream shapes (see docs/openrouter-notes.md → 'Observed live'):
- claude (grounded): `delta.annotations` with one `url_citation` on a mid-stream content chunk;
  nothing on the usage chunk.
- grok-4.6 at medium: 18 chunks of `reasoning_details[type=reasoning.summary]` mirrored by a bare
  `delta.reasoning` string, then one `reasoning.encrypted` block, then text; `reasoning_tokens=241`.
- claude-opus-5 and gpt-5.6-sol at medium on a one-line prompt: no reasoning deltas,
  `reasoning_tokens=0`.
- every stream ends with a usage chunk carrying `cost` and repeating `finish_reason`.
