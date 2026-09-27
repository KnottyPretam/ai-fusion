# Scenario `council_two`

A council of TWO (chatgpt = R1, qwen = R2, both OpenRouter slugs). R2 recommends a 10 kOhm pull-up, which is too weak for 400 kHz on a real bus; R1 gives the usual 2.2 to 4.7 kOhm range. Both agree that the value is set by the bus capacitance and the rise-time limit. The extraction plants `d1` (materiality high, one Position for each of R1/R2) and one agreement.

**Prompt (the user prompt the test sends):** What pull-up resistor value should I use on a 400 kHz I2C bus running at 3.3 V?

**Expected outcome:** Send -> two slots, threads keyed chatgpt and qwen only. Analyze -> status ok, the analyst prompt says `two anonymous expert responses (R1, R2)` and the strict enum is R1/R2; `standing=[d1]`. Fusion round 1: R1 defends, R2 revises (justified) -> convergence resolved -> exit `converged`, `final=[{d1, resolved}]`. 6 files.

Anonymization is the fixed mock map R1=chatgpt, R2=qwen. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `chatgpt.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 19 chunks |
| `chatgpt.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 14 chunks |
| `qwen.chat.1.jsonl` | R2 chat reply; finish_reason stop; 1 reasoning chunk(s); 14 chunks |
| `qwen.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 19 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high; finish_reason stop; 22 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `chatgpt.chat.1.jsonl`, `qwen.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high -> standing=[d1]; the enum and prompt count two labels
3. Fusion round 1: `chatgpt.defense.1.jsonl`, `qwen.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R1 defend, R2 justified revise
4. Exit: (no LLM call) -- `converged` after round 1

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "council_two",
  "prompt": "What pull-up resistor value should I use on a 400 kHz I2C bus running at 3.3 V?",
  "anon_map": {
    "R1": "chatgpt",
    "R2": "qwen"
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
        "chatgpt.chat.1.jsonl",
        "qwen.chat.1.jsonl"
      ]
    },
    {
      "phase": "Analyze",
      "files": [
        "analyst.extraction.1.jsonl"
      ],
      "note": "d1 high -> standing=[d1]; the enum and prompt count two labels"
    },
    {
      "phase": "Fusion round 1",
      "files": [
        "chatgpt.defense.1.jsonl",
        "qwen.defense.1.jsonl",
        "analyst.convergence.1.jsonl"
      ],
      "note": "R1 defend, R2 justified revise"
    },
    {
      "phase": "Exit",
      "files": [],
      "note": "`converged` after round 1"
    }
  ],
  "files": {
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "Use something in the 2.2 kOhm to 4.7 kOhm range. At 400 kHz the bus has to rise within 300 ns, so the pull-up must be small enough for the RC formed with the bus capacitance: 4.7 kOhm works for a short bus of a few devices, and 2.2 kOhm is the safer choice once the capacitance approaches 200 pF. Check that the strongest pull-up still keeps the sink current under 3 mA at 3.3 V.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "qwen.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "A 10 kOhm pull-up on each line is the standard value and works at 3.3 V. The exact value depends on the bus capacitance: a longer bus with more devices needs a stronger (lower) pull-up to meet the rise-time requirement, but 10 kOhm is a fine default for a small board.",
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
    "chatgpt.defense.1.jsonl": {
      "kind": "defense",
      "label": "R1",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "defend"
    },
    "qwen.defense.1.jsonl": {
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
        "d1": "resolved"
      }
    }
  },
  "council": [
    "chatgpt",
    "qwen"
  ],
  "slot_config": {
    "slots": {
      "chatgpt": {
        "model": "openai/gpt-5.6-sol",
        "effort": "medium"
      },
      "qwen": {
        "model": "qwen/qwen3.7-max",
        "effort": "medium"
      }
    },
    "analyst_model": "openai/gpt-5.6-luna",
    "max_iterations": 2,
    "materiality_min": "medium",
    "grounded": false
  }
}
```
