# Scenario `vendor_in_prompt`

The USER PROMPT names a vendor ("Claude, ..."); every model response, extraction and defense stays vendor-name-free. R2 (chatgpt) is wrong with 8 MHz; R1 and R3 give 10 MHz. Round 1: R1 defends, R2 revises (justified), R3 defends; d1 resolved.

**Prompt (the user prompt the test sends):** Claude, what is the maximum SPI clock frequency supported by the BMI088?

**Expected outcome:** Leak tests still pass under the scope rule: the vendor name appears only in the user prompt (and therefore in thread history), never in Triplex-authored text of the analyst, challenge or convergence prompts. Fusion exits `converged` after round 1, `final=[{d1, resolved}]`.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 13 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 11 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 7 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 19 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 9 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 10 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 2 agreement(s), divergences: d1 high; finish_reason stop; 24 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl` -- the user prompt says "Claude"; replies are vendor-free
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high -> standing=[d1]
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
  "scenario": "vendor_in_prompt",
  "prompt": "Claude, what is the maximum SPI clock frequency supported by the BMI088?",
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
      ],
      "note": "the user prompt says \"Claude\"; replies are vendor-free"
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
      "text": "The BMI088 supports SPI clock frequencies up to 10 MHz for both the accelerometer and the gyroscope interfaces (SPI mode 0 or 3, 4-wire; the accelerometer also supports 3-wire). Note that the accelerometer's SPI read protocol returns a dummy byte before the data, so budget one extra byte per transfer.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "The maximum SPI clock is 8 MHz for the BMI088. Use SPI mode 0 or 3 and remember the accelerometer's read transactions include a leading dummy byte.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "10 MHz max SPI clock on both dies. Mode 0 or 3, MSB first, and the accelerometer's SPI reads carry one dummy byte before the payload; the gyroscope's do not.",
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
