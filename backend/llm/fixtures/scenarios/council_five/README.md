# Scenario `council_five`

A council of FIVE (claude = R1, chatgpt = R2, grok = R3, gemini = R4, deepseek = R5, all OpenRouter slugs). R4 answers 20 MHz; the other four give the datasheet's 10 MHz. Four of the five state that SPI modes 0 and 3 are supported. The extraction plants `d1` (materiality high, one Position for each of R1..R5) and one agreement over R1, R2, R3 and R5.

**Prompt (the user prompt the test sends):** What is the maximum SPI clock frequency the Bosch BMI088 IMU supports?

**Expected outcome:** Send -> five slots, five threads. Analyze -> status ok, the analyst prompt says `five anonymous expert responses (R1, R2, R3, R4, R5)` and the strict enum is R1..R5; `standing=[d1]`. Fusion round 1: R1, R2, R3 and R5 defend, R4 revises (justified) -> convergence resolved -> exit `converged`, `final=[{d1, resolved}]`. 12 files.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok, R4=gemini, R5=deepseek. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 10 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 10 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 1 reasoning chunk(s); 10 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: defend; finish_reason stop; 10 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 9 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 10 chunks |
| `gemini.chat.1.jsonl` | R4 chat reply; finish_reason stop; 1 reasoning chunk(s); 10 chunks |
| `gemini.defense.1.jsonl` | R4 on d1: revise, justified; finish_reason stop; 17 chunks |
| `deepseek.chat.1.jsonl` | R5 chat reply; finish_reason stop; 1 reasoning chunk(s); 8 chunks |
| `deepseek.defense.1.jsonl` | R5 on d1: defend; finish_reason stop; 10 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high; finish_reason stop; 25 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved; finish_reason stop; 4 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`, `gemini.chat.1.jsonl`, `deepseek.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high -> standing=[d1]; the enum and prompt count five labels
3. Fusion round 1: `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl`, `gemini.defense.1.jsonl`, `deepseek.defense.1.jsonl`, `analyst.convergence.1.jsonl` -- R1, R2, R3, R5 defend; R4 justified revise
4. Exit: (no LLM call) -- `converged` after round 1

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "council_five",
  "prompt": "What is the maximum SPI clock frequency the Bosch BMI088 IMU supports?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok",
    "R4": "gemini",
    "R5": "deepseek"
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
        "grok.chat.1.jsonl",
        "gemini.chat.1.jsonl",
        "deepseek.chat.1.jsonl"
      ]
    },
    {
      "phase": "Analyze",
      "files": [
        "analyst.extraction.1.jsonl"
      ],
      "note": "d1 high -> standing=[d1]; the enum and prompt count five labels"
    },
    {
      "phase": "Fusion round 1",
      "files": [
        "claude.defense.1.jsonl",
        "chatgpt.defense.1.jsonl",
        "grok.defense.1.jsonl",
        "gemini.defense.1.jsonl",
        "deepseek.defense.1.jsonl",
        "analyst.convergence.1.jsonl"
      ],
      "note": "R1, R2, R3, R5 defend; R4 justified revise"
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
      "text": "The BMI088 SPI interface runs at up to 10 MHz. It supports SPI modes 0 and 3 (CPOL/CPHA both 0 or both 1), 4-wire operation, and the accelerometer and gyroscope each have their own chip select.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Up to 10 MHz on SPI. The device accepts SPI mode 0 or mode 3, and the two sensors are addressed through separate chip-select lines; I2C is limited to 400 kHz by comparison.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "10 MHz is the maximum SPI clock. Both mode 0 and mode 3 work, and each sensor (accel, gyro) has its own CS pin, so you can clock them independently.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "gemini.chat.1.jsonl": {
      "kind": "chat",
      "label": "R4",
      "text": "The BMI088 supports SPI clock rates up to 20 MHz, which is why it is popular in flight controllers that poll the gyroscope at high rates. Either SPI mode 0 or mode 3 may be used.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "deepseek.chat.1.jsonl": {
      "kind": "chat",
      "label": "R5",
      "text": "Maximum SPI clock: 10 MHz, per the datasheet's digital interface specification. Modes 0 and 3 are supported and there is one chip select per sensor core.",
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
      "stance": "defend"
    },
    "grok.defense.1.jsonl": {
      "kind": "defense",
      "label": "R3",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "defend"
    },
    "gemini.defense.1.jsonl": {
      "kind": "defense",
      "label": "R4",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "revise",
      "unjustified": false
    },
    "deepseek.defense.1.jsonl": {
      "kind": "defense",
      "label": "R5",
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
  },
  "council": [
    "claude",
    "chatgpt",
    "grok",
    "gemini",
    "deepseek"
  ],
  "slot_config": {
    "slots": {
      "claude": {
        "model": "anthropic/claude-opus-5",
        "effort": "medium"
      },
      "chatgpt": {
        "model": "openai/gpt-5.6-sol",
        "effort": "medium"
      },
      "grok": {
        "model": "x-ai/grok-4.6",
        "effort": "medium"
      },
      "gemini": {
        "model": "google/gemini-3.8-flash",
        "effort": "medium"
      },
      "deepseek": {
        "model": "deepseek/deepseek-v4-pro",
        "effort": "high"
      }
    },
    "analyst_model": "openai/gpt-5.6-luna",
    "max_iterations": 2,
    "materiality_min": "medium",
    "grounded": false
  }
}
```
