# Scenario `analyst_degrade`

Three compatible engineering answers. BOTH analyst attempts are invalid: `analyst.extraction.1` is prose with a Markdown list and no JSON object at all (lenient parse fails); `analyst.extraction.2` is well-formed JSON that violates the schema (`models` are not R-labels, `materiality` is not high/medium/low), so pydantic validation fails.

**Prompt (the user prompt the test sends):** How should I synchronise the BMI088 accelerometer and gyroscope data-ready interrupts for a 1 kHz attitude estimator?

**Expected outcome:** Analyze -> `analyze_retry{error}` then `analyze_degraded{turn}` as the last event (status degraded, both raw texts in `raw_attempts`). Explicit Fusion on that turn -> pre-stream `409 {detail:{error:"analyze_degraded"}}`; auto-run Fusion -> `analyze_degraded` then terminal `error{message:"analyze_degraded"}`. Re-running Analyze re-attempts: the counter is past the last file so sticky-last serves `extraction.2` twice -> degraded again.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 20 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 17 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 14 chunks |
| `analyst.extraction.1.jsonl` | INVALID extraction (prose only, no JSON object (lenient parse fails)); finish_reason stop; 20 chunks |
| `analyst.extraction.2.jsonl` | INVALID extraction (valid JSON, schema violation: models not R-labels, materiality 'negligible' (pydantic fails)); finish_reason stop; 14 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl`, `analyst.extraction.2.jsonl` -- `.1` parse failure -> `analyze_retry` -> `.2` validation failure -> `analyze_degraded`
3. Analyze again (optional): `analyst.extraction.2.jsonl (sticky)`, `analyst.extraction.2.jsonl (sticky)` -- degraded again
4. Fusion: (no LLM call) -- no call: 409 analyze_degraded explicit, `error{analyze_degraded}` auto-run

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "analyst_degrade",
  "prompt": "How should I synchronise the BMI088 accelerometer and gyroscope data-ready interrupts for a 1 kHz attitude estimator?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "degraded",
  "exit_reason": null,
  "final": null,
  "sequence": [
    {
      "phase": "Send",
      "files": [
        "claude.chat.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "grok.chat.1.jsonl"
      ]
    },
    {
      "phase": "Analyze",
      "files": [
        "analyst.extraction.1.jsonl",
        "analyst.extraction.2.jsonl"
      ],
      "note": "`.1` parse failure -> `analyze_retry` -> `.2` validation failure -> `analyze_degraded`"
    },
    {
      "phase": "Analyze again (optional)",
      "files": [
        "analyst.extraction.2.jsonl (sticky)",
        "analyst.extraction.2.jsonl (sticky)"
      ],
      "note": "degraded again"
    },
    {
      "phase": "Fusion",
      "files": [],
      "note": "no call: 409 analyze_degraded explicit, `error{analyze_degraded}` auto-run"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "Run the gyroscope at 1000 Hz ODR (GYRO_BANDWIDTH = 0x87 for 1000 Hz / 116 Hz) and drive the estimator from its INT3 data-ready line; the accelerometer cannot produce exactly 1000 Hz, so run it at 1600 Hz ODR, latch the most recent sample in the ISR, and timestamp both with a free-running microsecond counter. Propagate with the gyro and apply the accelerometer correction using the nearest-in-time sample; the sub-millisecond offset is negligible for a 1 kHz loop.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Use the gyro data-ready interrupt as the master clock at 1000 Hz and poll the accelerometer at 1600 Hz from its own interrupt into a ring buffer. In the gyro ISR, read the latest accel sample and its timestamp. Do not try to phase-lock the two ODRs; the BMI088 has independent clocks for the two dies, so a small drift between them is unavoidable and harmless when you timestamp.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Drive the loop from the gyroscope's INT3/INT4 data-ready at 1000 Hz. Configure the accelerometer for 1600 Hz and its own INT1 line, keep the newest sample and a timestamp, and consume it in the gyro-driven estimator step. The two sensors run on separate oscillators, so timestamp rather than assuming alignment; the worst-case misalignment is under 625 microseconds.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": false,
      "finish_reason": "stop",
      "invalid_reason": "prose only, no JSON object (lenient parse fails)"
    },
    "analyst.extraction.2.jsonl": {
      "kind": "extraction",
      "valid": false,
      "finish_reason": "stop",
      "invalid_reason": "valid JSON, schema violation: models not R-labels, materiality 'negligible' (pydantic fails)"
    }
  }
}
```
