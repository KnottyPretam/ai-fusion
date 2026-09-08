# Scenario `fusion_slot_error`

R2 (chatgpt) is wrong with 800 Hz; R1 and R3 give 1600 Hz. In Fusion, `grok.defense.1` is a single mid-stream error chunk (429 rate_limit_exceeded, the only event in the stream), R1 defends and R2 produces a justified but only partial revise; the analyst keeps d1 standing. Round 2 repeats everything sticky-last.

**Prompt (the user prompt the test sends):** What is the maximum output data rate of the BMI088 accelerometer?

**Expected outcome:** Every round: the R3 exchange is `stance="unavailable"` with `error` set, nothing appended to the grok thread, the loop continues (not every exchange failed); R2's revise makes `changed=true`; convergence -> standing. Exit `max_iterations` at the default cap of 2, `final=[{d1, standing}]`.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 11 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 12 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 8 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 19 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 9 chunks |
| `grok.defense.1.jsonl` | R3 on d1: error; ends with error chunk 429 rate_limit_exceeded; 1 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high; finish_reason stop; 21 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 standing; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high -> standing=[d1]
3. Fusion round 1: `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R1 defend, R2 justified partial revise, R3 error -> unavailable; standing
4. Fusion round 2: `claude.defense.1.jsonl (sticky)`, `chatgpt.defense.1.jsonl (sticky)`, `grok.defense.1.jsonl (sticky)`, `analyst.convergence.1.jsonl (sticky)` -- same again; R3 unavailable in every round
5. Exit: (no LLM call) -- `max_iterations` at the default cap of 2

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "fusion_slot_error",
  "prompt": "What is the maximum output data rate of the BMI088 accelerometer?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": "max_iterations",
  "final": {
    "d1": "standing"
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
        "analyst.extraction.1.jsonl"
      ],
      "note": "d1 high -> standing=[d1]"
    },
    {
      "phase": "Fusion round 1",
      "files": [
        "claude.defense.1.jsonl",
        "chatgpt.defense.1.jsonl",
        "grok.defense.1.jsonl",
        "analyst.convergence.1.jsonl"
      ],
      "note": "R1 defend, R2 justified partial revise, R3 error -> unavailable; standing"
    },
    {
      "phase": "Fusion round 2",
      "files": [
        "claude.defense.1.jsonl (sticky)",
        "chatgpt.defense.1.jsonl (sticky)",
        "grok.defense.1.jsonl (sticky)",
        "analyst.convergence.1.jsonl (sticky)"
      ],
      "note": "same again; R3 unavailable in every round"
    },
    {
      "phase": "Exit",
      "files": [],
      "note": "`max_iterations` at the default cap of 2"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "The BMI088 accelerometer's maximum output data rate is 1600 Hz (ACC_CONF odr field = 0x0C). The ODR options run from 12.5 Hz to 1600 Hz in powers of two; the gyroscope is the part that goes to 2000 Hz.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "The accelerometer tops out at 800 Hz ODR. If you need faster updates the gyroscope side runs to 2000 Hz, but the accelerometer die is limited to 800 Hz.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "1600 Hz is the accelerometer's highest ODR on the BMI088; 2000 Hz belongs to the gyroscope. Below that the table is 800, 400, 200, 100, 50, 25 and 12.5 Hz.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {
        "d1": "high"
      },
      "agreements": 1
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
      "error": {
        "code": 429,
        "error_type": "rate_limit_exceeded"
      }
    },
    "analyst.convergence.1.jsonl": {
      "kind": "convergence",
      "finish_reason": "stop",
      "statuses": {
        "d1": "standing"
      }
    }
  }
}
```
