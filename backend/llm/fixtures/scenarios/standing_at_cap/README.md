# Scenario `standing_at_cap`

Same send and extraction as `planted_factual` (d1 high with R2 wrong, d2 low). In every round R1 and R3 defend while R2 produces a re-worded, justified REVISE that is still incompatible with 2000 deg/s, and the analyst keeps d1 `standing`. Five distinct `chatgpt.defense.n` files exist; R1, R3 and the analyst have one file each and are served sticky-last from round 2 on.

**Prompt (the user prompt the test sends):** What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?

**Expected outcome:** Tests pass `max_iterations=5`. Every round has a revise (`changed=true`), the convergence check answers standing, so the loop runs to the cap -> exit `max_iterations`, `final=[{d1, standing}]` with both sides' latest justifications. With the default `max_iterations=2` the exit is the same after round 2.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 2 reasoning chunk(s); 6 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 13 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 1 reasoning chunk(s); 4 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 20 chunks |
| `chatgpt.defense.2.jsonl` | R2 on d1: revise, justified; finish_reason stop; 20 chunks |
| `chatgpt.defense.3.jsonl` | R2 on d1: revise, justified; finish_reason stop; 19 chunks |
| `chatgpt.defense.4.jsonl` | R2 on d1: revise, justified; finish_reason stop; 19 chunks |
| `chatgpt.defense.5.jsonl` | R2 on d1: revise, justified; finish_reason stop; 18 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 4 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 12 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high, d2 low; finish_reason stop; 34 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 standing; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high, d2 low -> standing=[d1]
3. Fusion round 1: `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R1 defend, R2 justified revise, R3 defend
4. Fusion round 2: `claude.defense.1.jsonl (sticky)`, `chatgpt.defense.2.jsonl`, `grok.defense.1.jsonl (sticky)`, `analyst.convergence.1.jsonl (sticky)` -- R2 re-words its revise; analyst still says standing
5. Fusion round 3: `claude.defense.1.jsonl (sticky)`, `chatgpt.defense.3.jsonl`, `grok.defense.1.jsonl (sticky)`, `analyst.convergence.1.jsonl (sticky)` -- R2 re-words its revise; analyst still says standing
6. Fusion round 4: `claude.defense.1.jsonl (sticky)`, `chatgpt.defense.4.jsonl`, `grok.defense.1.jsonl (sticky)`, `analyst.convergence.1.jsonl (sticky)` -- R2 re-words its revise; analyst still says standing
7. Fusion round 5: `claude.defense.1.jsonl (sticky)`, `chatgpt.defense.5.jsonl`, `grok.defense.1.jsonl (sticky)`, `analyst.convergence.1.jsonl (sticky)` -- R2 re-words its revise; analyst still says standing
8. Exit: (no LLM call) -- `max_iterations` at round == cap

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "standing_at_cap",
  "prompt": "What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?",
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
      "note": "d1 high, d2 low -> standing=[d1]"
    },
    {
      "phase": "Fusion round 1",
      "files": [
        "claude.defense.1.jsonl",
        "chatgpt.defense.1.jsonl",
        "grok.defense.1.jsonl",
        "analyst.convergence.1.jsonl"
      ],
      "note": "R1 defend, R2 justified revise, R3 defend"
    },
    {
      "phase": "Fusion round 2",
      "files": [
        "claude.defense.1.jsonl (sticky)",
        "chatgpt.defense.2.jsonl",
        "grok.defense.1.jsonl (sticky)",
        "analyst.convergence.1.jsonl (sticky)"
      ],
      "note": "R2 re-words its revise; analyst still says standing"
    },
    {
      "phase": "Fusion round 3",
      "files": [
        "claude.defense.1.jsonl (sticky)",
        "chatgpt.defense.3.jsonl",
        "grok.defense.1.jsonl (sticky)",
        "analyst.convergence.1.jsonl (sticky)"
      ],
      "note": "R2 re-words its revise; analyst still says standing"
    },
    {
      "phase": "Fusion round 4",
      "files": [
        "claude.defense.1.jsonl (sticky)",
        "chatgpt.defense.4.jsonl",
        "grok.defense.1.jsonl (sticky)",
        "analyst.convergence.1.jsonl (sticky)"
      ],
      "note": "R2 re-words its revise; analyst still says standing"
    },
    {
      "phase": "Fusion round 5",
      "files": [
        "claude.defense.1.jsonl (sticky)",
        "chatgpt.defense.5.jsonl",
        "grok.defense.1.jsonl (sticky)",
        "analyst.convergence.1.jsonl (sticky)"
      ],
      "note": "R2 re-words its revise; analyst still says standing"
    },
    {
      "phase": "Exit",
      "files": [],
      "note": "`max_iterations` at round == cap"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "The BMI088 gyroscope full-scale range is selectable up to 2000 deg/s.",
      "finish_reason": "stop",
      "reasoning_blocks": 2
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Its gyroscope tops out at 1000 deg/s full scale.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "The gyro supports ranges from 125 up to 2000 deg/s.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {
        "d1": "high",
        "d2": "low"
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
    "grok.defense.1.jsonl": {
      "kind": "defense",
      "label": "R3",
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
    "chatgpt.defense.2.jsonl": {
      "kind": "defense",
      "label": "R2",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "revise",
      "unjustified": false
    },
    "chatgpt.defense.3.jsonl": {
      "kind": "defense",
      "label": "R2",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "revise",
      "unjustified": false
    },
    "chatgpt.defense.4.jsonl": {
      "kind": "defense",
      "label": "R2",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "revise",
      "unjustified": false
    },
    "chatgpt.defense.5.jsonl": {
      "kind": "defense",
      "label": "R2",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "revise",
      "unjustified": false
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
