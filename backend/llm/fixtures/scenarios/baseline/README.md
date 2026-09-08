# Scenario `baseline`

Three compatible answers: all three responses give the same account of gyroscope drift, the accelerometer as a noisy gravity reference, complementary/Kalman blending and the unobservability of yaw. The analyst extraction contains agreements only and an empty `divergences` list, so `standing` is empty.

**Prompt (the user prompt the test sends):** Why do attitude estimators fuse gyroscope and accelerometer data rather than relying on either sensor alone?

**Expected outcome:** Analyze -> status ok with four agreements and no divergences. Fusion after an explicit Analyze -> pre-stream `409 {detail:{error:"nothing_to_fuse"}}`; Fusion on the auto-run path -> the `analyze_*` events followed by the terminal `error{message:"nothing_to_fuse"}` and no fusion turn. No defense or convergence fixture exists (any such call would be a mock_miss).

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 24 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 1 reasoning chunk(s); 24 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 21 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 4 agreement(s), divergences: none; finish_reason stop; 27 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl`
2. Analyze: `analyst.extraction.1.jsonl` -- agreements only, `standing` empty
3. Fusion: (no LLM call) -- no call: 409 nothing_to_fuse after an explicit Analyze, or `error{nothing_to_fuse}` right after `analyze_done` on the auto-run path

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "baseline",
  "prompt": "Why do attitude estimators fuse gyroscope and accelerometer data rather than relying on either sensor alone?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "ok",
  "exit_reason": null,
  "final": null,
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
      "note": "agreements only, `standing` empty"
    },
    {
      "phase": "Fusion",
      "files": [],
      "note": "no call: 409 nothing_to_fuse after an explicit Analyze, or `error{nothing_to_fuse}` right after `analyze_done` on the auto-run path"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "Because the two sensors fail in complementary ways. A gyroscope gives a clean, high-bandwidth angular-rate signal, but attitude comes from integrating it, so bias and noise accumulate into unbounded drift within seconds to minutes. An accelerometer measures the gravity vector directly, which gives a drift-free reference for roll and pitch, but it is noisy and corrupted by linear acceleration and vibration. Fusing them, whether with a complementary filter or a Kalman filter, uses the gyro for short-term dynamics and the accelerometer to bound long-term drift. Neither sensor observes yaw about gravity, so heading needs a magnetometer or another aiding source.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Each sensor alone has a failure mode the other covers. Integrating gyroscope rates gives smooth attitude over short intervals but drifts without bound because bias errors integrate. An accelerometer provides an absolute gravity reference for roll and pitch that does not drift, yet it is noisy and biased by any linear acceleration of the vehicle. A complementary or Kalman filter blends the two: high-pass the gyro integral, low-pass the accelerometer tilt, and the result is both smooth and drift-bounded. Yaw is unobservable from gravity alone, so a magnetometer or GNSS heading is added for full 3-axis attitude.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Gyros drift, accelerometers shake; fusing hides both weaknesses. Integrated gyroscope output tracks fast rotations accurately but random walk and bias make the angle wander over time. The accelerometer sees gravity and so anchors roll and pitch, but every bump and any sustained acceleration corrupts that reading. Blending them with a complementary filter or an EKF keeps the gyro's short-term accuracy while the accelerometer slowly corrects long-term drift. Heading still needs a magnetometer or GNSS because gravity gives no information about rotation around the vertical axis.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {},
      "agreements": 4
    }
  }
}
```
