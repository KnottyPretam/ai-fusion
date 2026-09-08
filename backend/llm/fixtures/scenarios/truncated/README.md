# Scenario `truncated`

R1 and R3 complete the derivation. `chatgpt.chat.1` stops mid-derivation with `finish_reason="length"` on its last text chunk AND on its usage chunk (the one fixture where the usage chunk repeats the finish reason). The extraction has agreements plus a low-materiality divergence about completeness (not fused).

**Prompt (the user prompt the test sends):** Derive the discrete-time process noise covariance Q for a constant-velocity Kalman filter with sample period T, assuming white acceleration noise.

**Expected outcome:** Send -> `slot_done{slot:"chatgpt", finish_reason:"length", truncated:true}`; the truncated reply IS appended to the chatgpt thread and `truncated.chatgpt` is true on the turn; the UI shows a warning. Analyze -> status ok with no standing divergence at `materiality_min=medium`.

Anonymization is the fixed mock map R1=claude, R2=chatgpt, R3=grok. Every fixture is
JSONL of raw OpenRouter chunk objects (no comments, no `[DONE]`); successes end with the
usage chunk (`usage.cost`), errors end with the error chunk.

## Files

| File | Content |
|---|---|
| `claude.chat.1.jsonl` | R1 chat reply; finish_reason stop; 1 reasoning chunk(s); 27 chunks |
| `chatgpt.chat.1.jsonl` | R2 chat reply; finish_reason length; 1 reasoning chunk(s); 25 chunks |
| `grok.chat.1.jsonl` | R3 chat reply; finish_reason stop; 1 reasoning chunk(s); 20 chunks |
| `analyst.extraction.1.jsonl` | Extraction, 2 agreement(s), divergences: d1 low; finish_reason stop; 29 chunks |

## Exact per-role call sequence

1. Send: `claude.chat.1.jsonl`, `chatgpt.chat.1.jsonl`, `grok.chat.1.jsonl` -- chatgpt ends with finish_reason length -> truncated:true
2. Analyze: `analyst.extraction.1.jsonl` -- agreements + d1 low; nothing standing at materiality_min=medium

Counter rule: `n = 1 + number of earlier calls with the same (scenario, role, purpose)`;
within one Fusion round a slot consumes `<slot>.defense.k` for d1 then `.k+1` for d2
(standing order); sticky-last never advances beyond the last existing file.

## Machine-readable expectations

Validated by `tests/fixtures/test_scenarios.py`. Regenerate this directory with
`uv run python -m tests.fixtures.build_scenarios`.

```json
{
  "scenario": "truncated",
  "prompt": "Derive the discrete-time process noise covariance Q for a constant-velocity Kalman filter with sample period T, assuming white acceleration noise.",
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
      ],
      "note": "chatgpt ends with finish_reason length -> truncated:true"
    },
    {
      "phase": "Analyze",
      "files": [
        "analyst.extraction.1.jsonl"
      ],
      "note": "agreements + d1 low; nothing standing at materiality_min=medium"
    }
  ],
  "files": {
    "claude.chat.1.jsonl": {
      "kind": "chat",
      "label": "R1",
      "text": "Model the acceleration as continuous white noise w(t) with spectral density q. The continuous state is x = [p, v] with F = [[0, 1], [0, 0]] and G = [0, 1]^T. Discretising over T gives the transition Phi = [[1, T], [0, 1]] and Q = integral from 0 to T of Phi(tau) G q G^T Phi(tau)^T d tau, which evaluates to Q = q * [[T^3/3, T^2/2], [T^2/2, T]]. The cheaper piecewise-constant-acceleration approximation, where a is constant over each step, gives Q = sigma_a^2 * [[T^4/4, T^3/2], [T^3/2, T^2]]; the two agree in structure but scale differently with T, so pick one and tune q or sigma_a rather than mixing them.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "chatgpt.chat.1.jsonl": {
      "kind": "chat",
      "label": "R2",
      "text": "Start from the continuous-time model: position p and velocity v, with v-dot equal to white noise w(t) of spectral density q. The state transition over one period T is Phi = [[1, T], [0, 1]]. The discrete process noise is the integral of Phi(tau) G q G^T Phi(tau)^T over tau from 0 to T, where G = [0, 1]^T. Writing out Phi(tau) G = [tau, 1]^T, the integrand becomes q * [[tau^2, tau], [tau, 1]]. Integrating term by term: the (1,1) entry is q * T^3 / 3, the (1,2) and (2,1) entries are q * T^2 / 2, and the (2,2) entry",
      "finish_reason": "length",
      "reasoning_blocks": 1
    },
    "grok.chat.1.jsonl": {
      "kind": "chat",
      "label": "R3",
      "text": "Continuous model: p-dot = v, v-dot = w, with E[w(t) w(s)] = q delta(t - s). Discretise: Phi = [[1, T], [0, 1]], and Q = q * [[T^3/3, T^2/2], [T^2/2, T]] from integrating Phi(tau) G G^T Phi(tau)^T q over the step. If you instead assume a piecewise-constant acceleration with variance sigma_a^2 per step you get Q = sigma_a^2 * [[T^4/4, T^3/2], [T^3/2, T^2]]. Both are standard; the continuous white-noise form is the one that stays consistent if you change T.",
      "finish_reason": "stop",
      "reasoning_blocks": 1
    },
    "analyst.extraction.1.jsonl": {
      "kind": "extraction",
      "valid": true,
      "finish_reason": "stop",
      "divergences": {
        "d1": "low"
      },
      "agreements": 2
    }
  }
}
```
