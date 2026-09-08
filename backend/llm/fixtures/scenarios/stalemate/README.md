# Scenario `stalemate`

A genuinely contested design question: R1 and R3 favour a Mahony-style complementary filter, R2 an EKF. The extraction plants `d1` (high) with one Position per label. In round 1 all three labels DEFEND.

**Prompt (the user prompt the test sends):** For a 250 g quadrotor flight controller running on a Cortex-M4 at 168 MHz, is a Mahony-style complementary filter or an extended Kalman filter the better choice for attitude estimation?

**Expected outcome:** Fusion round 1 is all-defend -> `changed=false` -> exit `stalemate` after round 1 WITHOUT an analyst convergence call (no `analyst.convergence.*` file exists; such a call would be a mock_miss and fail the test). `final=[{d1, standing}]` with both sides' justifications on the exchanges.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 27 chunks |
| `claude.defense.1.jsonl` | R1 on d1: defend; finish_reason stop; 17 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 24 chunks |
| `chatgpt.defense.1.jsonl` | R2 on d1: defend; finish_reason stop; 18 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 21 chunks |
| `grok.defense.1.jsonl` | R3 on d1: defend; finish_reason stop; 16 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 2 agreement(s), divergences: d1 high; finish_reason stop; 44 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- d1 high -> standing=[d1]
3. Fusion round 1: `claude.defense.1.jsonl`, `chatgpt.defense.1.jsonl`, `grok.defense.1.jsonl` -- all defend; NO convergence call
4. Exit: (no LLM call) -- `stalemate` after round 1

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "stalemate",
  "prompt": "For a 250 g quadrotor flight controller running on a Cortex-M4 at 168 MHz, is a Mahony-style complementary filter or an extended Kalman filter the better choice for attitude estimation?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": "stalemate",
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
        "grok.defense.1.jsonl"
      ],
      "note": "all defend; NO convergence call"
    },
    {
      "phase": "Exit",
      "files": [],
      "note": "`stalemate` after round 1"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "For a 250 g quadrotor a Mahony-style complementary filter is the better choice. On a Cortex-M4 at 168 MHz an EKF with a 6- or 7-state quaternion model is affordable, but the cost is not the point: the filter's accuracy is dominated by vibration on the accelerometer and by how well you tune the accelerometer trust, not by the estimator structure. A Mahony filter with a bias estimator runs in a few microseconds at 1 kHz, has two gains you can tune on the bench, and behaves predictably under saturation. An EKF gives you covariance bookkeeping you will not use on a vehicle that has no aiding sensors beyond the IMU and a magnetometer.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "An EKF is the better choice, and the Cortex-M4 has plenty of headroom for it. A multiplicative quaternion EKF with gyro-bias states runs comfortably at 500 Hz to 1 kHz with hardware floating point; a well-written implementation takes under 50 microseconds per update. The advantage over a complementary filter is that measurement trust adapts through the covariance: during aggressive maneuvers the accelerometer innovation grows and the filter automatically leans on the gyro, whereas a fixed-gain filter needs hand-tuned heuristics for the same behaviour. It also makes adding a magnetometer, barometer, or optical flow later a matter of adding a measurement model rather than redesigning the estimator.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Go with the Mahony complementary filter. On a small quad the attitude problem is not observability-limited, it is vibration-limited, and a two-gain fixed-structure filter handles that as well as an EKF once you low-pass the accelerometer properly. The EKF's adaptive trust sounds attractive but in practice its covariance is tuned by hand anyway and the linearisation adds failure modes during fast rolls. Runtime is not the deciding factor on a 168 MHz M4; simplicity and predictable behaviour are, and the complementary filter wins on both.",
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
      "stance": "defend"
    },
    "grok.defense.1.jsonl": {
      "kind": "defense",
      "label": "R3",
      "divergence": "d1",
      "finish_reason": "stop",
      "stance": "defend"
    }
  }
}
```
