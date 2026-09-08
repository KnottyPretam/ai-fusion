# Scenario `grounded`

Grounded-mode answers. Two of the claude content chunks carry `annotations` (`url_citation` to the Bosch BMI088 datasheet PDF and to the product page); the claude stream also carries a `reasoning.text` and a `reasoning.encrypted` block (encrypted blocks are ignored). chatgpt and grok answer without annotations. All three agree, so the extraction has agreements only.

**Prompt (the user prompt the test sends):** What is the zero-rate offset specification of the BMI088 gyroscope, and where is it documented?

**Expected outcome:** Send -> `slot_citations{slot:"claude", items:[...]}` once per annotated chunk with the raw annotation objects (two distinct URLs), `citations.claude` persisted on the turn, `slot_reasoning` text from the `reasoning.text` block only. Analyze -> ok, no divergences; Fusion -> nothing_to_fuse.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 2 reasoning chunk(s); 2 annotation chunk(s); 14 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 12 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 7 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 3 agreement(s), divergences: none; finish_reason stop; 17 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl` -- claude carries two annotation chunks -> slot_citations
2. Analyze: `analyst.extraction.1.jsonl` -- agreements only
3. Fusion: (no LLM call) -- no call: nothing_to_fuse

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "grounded",
  "prompt": "What is the zero-rate offset specification of the BMI088 gyroscope, and where is it documented?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": null,
  "final": null,
  "sequence": [
    {
      "phase": "Send",
      "files": [
        "claude.chat.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "grok.chat.1.jsonl"
      ],
      "note": "claude carries two annotation chunks -> slot_citations"
    },
    {
      "phase": "Analyze",
      "files": [
        "analyst.extraction.1.jsonl"
      ],
      "note": "agreements only"
    },
    {
      "phase": "Fusion",
      "files": [],
      "note": "no call: nothing_to_fuse"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "The BMI088 datasheet specifies the gyroscope zero-rate offset as +/-1 deg/s typical at 25 C, with a zero-rate offset temperature drift of +/-0.015 deg/s per kelvin typical. Both figures are in the gyroscope electrical characteristics table of the datasheet (BST-BMI088-DS001), and the product page links the current revision.",
      "finish_reason": "stop",
      "reasoning_blocks": 2,
      "citation_urls": [
        "https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi088-ds001.pdf",
        "https://www.bosch-sensortec.com/products/motion-sensors/imus/bmi088/"
      ]
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Zero-rate offset for the BMI088 gyro is +/-1 deg/s typical at room temperature, with a temperature coefficient of about 0.015 deg/s per kelvin. It is listed in the gyroscope section of the datasheet's electrical characteristics; look for the row labelled zero-rate offset in the current datasheet revision.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "+/-1 deg/s typical zero-rate offset at 25 C and +/-0.015 deg/s/K drift over temperature. Source: the gyroscope electrical characteristics table in the datasheet document BST-BMI088-DS001.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {},
      "agreements": 3
    }
  }
}
```
