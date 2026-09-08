# Scenario `two_divergences`

Two high-materiality divergences with one Position per label on each: d1 (gyroscope range: R2 wrong with 1000 deg/s) and d2 (SPI clock: R2 wrong with 8 MHz). Round 1: R1 defends both, R2 revises both (justified; d1 fully, d2 only partially), R3 defends both; the analyst marks d1 resolved and d2 standing.

**Prompt (the user prompt the test sends):** What are the BMI088 gyroscope's maximum full-scale range and its maximum SPI clock frequency?

**Expected outcome:** Tests pass `max_iterations=2`. Round 1 consumes `<slot>.defense.1` for d1 then `.defense.2` for d2 (standing order) and `analyst.convergence.1` -> d1 resolved, d2 standing. Round 2 challenges d2 ONLY (d1 is not re-challenged): every slot counter is at 3 so sticky `.defense.2` is served (R2 revises d2 again), then `analyst.convergence.2` -> sticky `.1`, whose d1 line is ignored (d1 keeps resolved) and d2 stays standing. round == cap -> exit `max_iterations`, `final=[{d1, resolved}, {d2, standing}]`. 11 files.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 9 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 11 chunks |
| `claude.defense.2.jsonl` | R1 on d2: defend; finish_reason stop; 10 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 5 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: revise, justified; finish_reason stop; 16 chunks |
| `chatgpt.defense.2.jsonl` | R2 on d2: revise, justified; finish_reason stop; 19 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 7 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 10 chunks |
| `grok.defense.2.jsonl` | R3 on d2: defend; finish_reason stop; 9 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 1 agreement(s), divergences: d1 high, d2 high; finish_reason stop; 34 chunks |
| `analyst.convergence.1.jsonl` | ConvergenceCheck: d1 resolved, d2 standing; finish_reason stop; 5 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high, d2 high -> standing=[d1, d2]
3. Fusion round 1: `claude.defense.1.jsonl`, `claude.defense.2.jsonl`, `chatgpt.defense.1.jsonl`, `chatgpt.defense.2.jsonl`, `grok.defense.1.jsonl`, `grok.defense.2.jsonl`, `analyst.convergence.1.jsonl` -- per slot: `.defense.1` for d1 then `.defense.2` for d2; d1 resolved, d2 standing
4. Fusion round 2 (d2 only): `claude.defense.2.jsonl (sticky)`, `chatgpt.defense.2.jsonl (sticky)`, `grok.defense.2.jsonl (sticky)`, `analyst.convergence.1.jsonl (sticky)` -- d1 not re-challenged; convergence `.1` served sticky, its d1 line ignored
5. Exit: (no LLM call) -- `max_iterations` at round 2 == cap

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "two_divergences",
  "prompt": "What are the BMI088 gyroscope's maximum full-scale range and its maximum SPI clock frequency?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": "max_iterations",
  "final": {
    "d1": "resolved",
    "d2": "standing"
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
      "note": "d1 high, d2 high -> standing=[d1, d2]"
    },
    {
      "phase": "Fusion round 1",
      "files": [
        "claude.defense.1.jsonl",
        "claude.defense.2.jsonl",
        "chatgpt.defense.1.jsonl",
        "chatgpt.defense.2.jsonl",
        "grok.defense.1.jsonl",
        "grok.defense.2.jsonl",
        "analyst.convergence.1.jsonl"
      ],
      "note": "per slot: `.defense.1` for d1 then `.defense.2` for d2; d1 resolved, d2 standing"
    },
    {
      "phase": "Fusion round 2 (d2 only)",
      "files": [
        "claude.defense.2.jsonl (sticky)",
        "chatgpt.defense.2.jsonl (sticky)",
        "grok.defense.2.jsonl (sticky)",
        "analyst.convergence.1.jsonl (sticky)"
      ],
      "note": "d1 not re-challenged; convergence `.1` served sticky, its d1 line ignored"
    },
    {
      "phase": "Exit",
      "files": [],
      "note": "`max_iterations` at round 2 == cap"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "The gyroscope full-scale range is selectable from 125 deg/s up to 2000 deg/s, and both the gyroscope and accelerometer SPI interfaces run at up to 10 MHz (minimum SCK period 100 ns).",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "The gyroscope maxes out at 1000 deg/s full scale, and the SPI bus is limited to 8 MHz.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "2000 deg/s is the top gyroscope range (125, 250, 500, 1000, 2000 selectable), and the SPI clock goes up to 10 MHz on both dies.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {
        "d1": "high",
        "d2": "high"
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
    "claude.defense.2.jsonl": {
      "kind": "defense",
      "label": "R1",
      "divergence": "d2",
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
      "divergence": "d2",
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
    "grok.defense.2.jsonl": {
      "kind": "defense",
      "label": "R3",
      "divergence": "d2",
      "finish_reason": "stop",
      "stance": "defend"
    },
    "analyst.convergence.1.jsonl": {
      "kind": "convergence",
      "finish_reason": "stop",
      "statuses": {
        "d1": "resolved",
        "d2": "standing"
      }
    }
  }
}
```
