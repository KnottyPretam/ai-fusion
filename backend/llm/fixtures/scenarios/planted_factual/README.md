# Scenario `planted_factual`

The chat fixtures reproduce `tests/conftest.py` `DEFAULT_PROMPT` / `DEFAULT_RESPONSES` verbatim: R2 (chatgpt) is wrong with 1000 deg/s; R1 and R3 give the correct 2000 deg/s maximum. The extraction plants `d1` (materiality high, one Position for each of R1/R2/R3, R2 wrong) and `d2` (low, not fused at `materiality_min=medium`).

**Prompt (the user prompt the test sends):** What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?

**Expected outcome:** Analyze -> status ok, `standing=[d1]`. Fusion round 1: R1 defends, R2 revises (justified: `is_unjustified` is False against the peer claims), R3 defends; the convergence check marks d1 resolved -> exit `converged` after round 1, `final=[{d1, resolved}]`. 8 files; a later continue on a slot reads sticky `<slot>.chat.1` (no `.chat.2` exists).

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 2 reasoning chunk(s); 6 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 13 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 1 reasoning chunk(s); 4 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 18 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 4 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 12 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high, d2 low; finish_reason stop; 34 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high, d2 low -> standing=[d1]
3. Fusion round 1: `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R1 defend, R2 justified revise, R3 defend
4. Exit: (no LLM call) -- `converged` after round 1

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "planted_factual",
  "prompt": "What is the maximum gyroscope full-scale range of the Bosch BMI088 IMU?",
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
      "phase": "Exit",
      "files": [],
      "note": "`converged` after round 1"
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
