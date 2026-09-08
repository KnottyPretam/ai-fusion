# Scenario `unjustified_revise`

R2 (chatgpt) confuses the gyroscope address (0x68/0x69) with the accelerometer's (0x18/0x19); R1 and R3 are correct. In round 1 R2 caves with the literal reply "You are right, I revise." and a short `persuaded_by`, which `schemas.is_unjustified` flags; R1 and R3 defend.

**Prompt (the user prompt the test sends):** What are the I2C slave addresses of the BMI088 accelerometer?

**Expected outcome:** Round 1: the R2 exchange carries `flagged_unjustified=true`; the convergence check marks d1 resolved, and because every revise that produced it was flagged the status is `resolved_unjustified` -> exit `converged`, `final=[{d1, resolved_unjustified}]`.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 13 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 14 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 9 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, unjustified; finish_reason stop; 8 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 9 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 11 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high; finish_reason stop; 24 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high -> standing=[d1]
3. Fusion round 1: `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R2's revise is flagged unjustified; analyst says resolved -> resolved_unjustified
4. Exit: (no LLM call) -- `converged` after round 1

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "unjustified_revise",
  "prompt": "What are the I2C slave addresses of the BMI088 accelerometer?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": "converged",
  "final": {
    "d1": "resolved_unjustified"
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
      "note": "R2's revise is flagged unjustified; analyst says resolved -> resolved_unjustified"
    },
    {
      "phase": "Exit",
      "files": [],
      "note": "`converged` after round 1"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "The BMI088 accelerometer responds at 0x18 when the SDO1 pin is tied low and at 0x19 when it is tied high. The gyroscope is a separate I2C device on the same bus at 0x68 or 0x69, selected by SDO2. Both parts support fast mode up to 400 kHz.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "The accelerometer sits at 0x68 by default, or 0x69 if you pull SDO high. Note that the gyro and accel have independent address pins, so make sure the two do not collide on the bus.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Accelerometer: 0x18 (SDO1 low) or 0x19 (SDO1 high). Gyroscope: 0x68 (SDO2 low) or 0x69 (SDO2 high). They are two independent I2C targets even though they share a package.",
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
      "unjustified": true
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
