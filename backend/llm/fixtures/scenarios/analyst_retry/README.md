# Scenario `analyst_retry`

R2 (chatgpt) gives the wrong default bandwidth (230 Hz, reset value 0x81) while R1 and R3 give 532 Hz (reset value 0x80). `analyst.extraction.1` is a code-fenced JSON object cut off mid-string (`finish_reason=length`) that fails lenient parsing; `analyst.extraction.2` is valid with d1 (high).

**Prompt (the user prompt the test sends):** What are the BMI088 gyroscope's default output data rate and filter bandwidth after power-on?

**Expected outcome:** Analyze emits `analyze_retry{error}` once and finishes with status ok; `mock.calls[-1]`'s last user message contains "failed validation" and both raw texts land in `raw_attempts`. An optional Fusion afterwards converges in round 1 (R2 justified revise, d1 resolved).

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 14 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 11 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 9 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 16 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 10 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 10 chunks |
| `analyst.extraction.1.jsonl` | INVALID extraction (code-fenced JSON truncated mid-string, finish_reason length); finish_reason length; 19 chunks |
| `analyst.extraction.2.jsonl` | Extraction, 2 agreement(s), divergences: d1 high; finish_reason stop; 31 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl`, `analyst.extraction.2.jsonl` -- `.1` fails lenient parsing -> `analyze_retry{error}` -> `.2` valid -> status ok
3. Fusion round 1 (optional): `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R2 justified revise -> converged

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "analyst_retry",
  "prompt": "What are the BMI088 gyroscope's default output data rate and filter bandwidth after power-on?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": "converged",
  "final": {
    "d1": "resolved"
  },
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
      "note": "`.1` fails lenient parsing -> `analyze_retry{error}` -> `.2` valid -> status ok"
    },
    {
      "phase": "Fusion round 1 (optional)",
      "files": [
        "claude.defense.1.jsonl",
        "chatgpt.defense.1.jsonl",
        "grok.defense.1.jsonl",
        "analyst.convergence.1.jsonl"
      ],
      "note": "R2 justified revise -> converged"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "After power-on the BMI088 gyroscope defaults to GYRO_BANDWIDTH = 0x80, which selects a 2000 Hz output data rate with a 532 Hz filter bandwidth. The range defaults to 2000 deg/s. You normally lower this to 1000 Hz / 116 Hz or 400 Hz / 47 Hz for a control loop unless you filter downstream.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "The gyro comes up at 2000 Hz ODR with a 230 Hz bandwidth by default (GYRO_BANDWIDTH register reset value 0x81). Most flight stacks reconfigure it to 1000 Hz / 116 Hz right after reset.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Power-on default for the gyroscope is ODR 2000 Hz, bandwidth 532 Hz (bandwidth register reset value 0x80); the alternative 2000 Hz setting with 230 Hz bandwidth is code 0x81. Default range is 2000 deg/s.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": false,
      "finish_reason": "length",
      "invalid_reason": "code-fenced JSON truncated mid-string, finish_reason length"
    },
    "analyst.extraction.2.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {
        "d1": "high"
      },
      "agreements": 2
    },
    "claude.defense.1.jsonl": {
      "kind": "defense",
      "label": "R1",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "defend"
    },
    "chatgpt.defense.1.jsonl": {
      "kind": "defense",
      "label": "R2",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "revise",
      "unjustified": false
    },
    "grok.defense.1.jsonl": {
      "kind": "defense",
      "label": "R3",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "defend"
    },
    "analyst.convergence.1.jsonl": {
      "kind": "convergence",
      "finish_reason": "stop",
      "statuses": {
        "d1": "resolved"
      }
    }
  }
}
```
