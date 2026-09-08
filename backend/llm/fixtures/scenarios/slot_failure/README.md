# Scenario `slot_failure`

R1 and R2 answer normally. The grok stream emits two content chunks of partial text and then a mid-stream error chunk (502 provider_unavailable) under HTTP 200, with no usage chunk.

**Prompt (the user prompt the test sends):** Which accelerometer output data rate should I select on the BMI088 for a 400 Hz attitude control loop?

**Expected outcome:** Send -> `slot_done` for claude and chatgpt, `slot_error{slot:"grok", code:502, error_type:"provider_unavailable", message:"Provider disconnected", partial}` with the partial text; NOTHING is appended to the grok thread (no orphan user message), `responses.grok` is null, `errors.grok` / `partial.grok` set on the turn. Analyze -> pre-stream `409 {detail:{error:"incomplete_send_turn", missing:["grok"]}}`; no analyst fixture exists.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 18 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason stop; 16 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; ends with error chunk 502 provider_unavailable; 9 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl` -- grok: partial text then error chunk -> slot_error
2. Analyze: (no LLM call) -- no call: 409 incomplete_send_turn, missing=[grok]

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "slot_failure",
  "prompt": "Which accelerometer output data rate should I select on the BMI088 for a 400 Hz attitude control loop?",
  "anon_map": {
    "R1": "claude",
    "R2": "chatgpt",
    "R3": "grok"
  },
  "analyze_status": "incomplete_send_turn",
  "exit_reason": null,
  "final": null,
  "sequence": [
    {
      "phase": "Send",
      "files": [
        "claude.chat.1.jsonl",
        "chatgpt.chat.1.jsonl",
        "grok.chat.1.jsonl"
      ],
      "note": "grok: partial text then error chunk -> slot_error"
    },
    {
      "phase": "Analyze",
      "files": [],
      "note": "no call: 409 incomplete_send_turn, missing=[grok]"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "Select 1600 Hz ODR with the normal (non-OSR4) filter, giving roughly 280 Hz of bandwidth, and decimate or average four samples per 400 Hz control step. Running the accelerometer at exactly the loop rate is not possible in a useful way (the ODR table is 12.5 Hz times powers of two up to 1600 Hz), and the oversampling reduces vibration aliasing more than picking the nearest 400 Hz setting would.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Use ACC_CONF = 0xAC: 1600 Hz ODR with the OSR4 setting, which gives about 145 Hz bandwidth. That is well above the ~50 Hz attitude bandwidth of a small vehicle, and the 4x oversampling relative to the 400 Hz loop lets you average out propeller vibration. Do not use the 400 Hz ODR setting directly, since its anti-aliasing filter sits close to the loop rate.",
      "finish_reason": "stop"
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Run the accelerometer at 1600 Hz and average down to the 400 Hz loop rate. The BMI088 accelerometer ODR options are 12.5, 25, 50, 100, 200, 400, 800 and 1600 Hz; picking 1600 Hz with ",
      "error": {
        "code": 502,
        "error_type": "provider_unavailable"
      }
    }
  }
}
```
