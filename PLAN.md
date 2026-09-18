# Triplex — Multi-Model Council for Research & Planning

> Working name: **Triplex** (after triplex flight-computer redundancy — three units vote,
> disagreement is a fault flag, not noise to average away). Rename freely.
>
> This file is the driving spec for Claude Code. Keep it at the repo root as `PLAN.md`,
> reference it from `CLAUDE.md`, and check items off as phases complete.

---

## 1. What this is

A local web app built around three fixed provider slots — **Claude, ChatGPT, Grok** —
each individually configurable (which model, what reasoning effort). Interaction is
tiered so you only pay for depth when you ask for it:

1. **Send (base)** — your prompt goes to all three models in parallel; all three
   responses are shown side by side. Nothing else happens.
2. **Analyze (on demand)** — a compare/contrast pass over the three responses: reports
   where they are similar (agreements) and where they differ (divergences).
3. **Fusion (on demand)** — the contrasting points are sent back to the other models,
   which iterate amongst themselves (defend or revise, round by round) up to a
   **user-settable max number of iterations**, with early exit on convergence.

Each model's conversation remains an independent thread you can continue solo to chase
rabbit holes; Analyze and Fusion are overlays on top of those threads.

Design stance: sensor fusion **plus integrity monitoring**. Agreement among correlated
sensors is weak evidence (shared training data = correlated errors), so unresolved
disagreement is surfaced, never silently averaged.

---

## 2. Requirements

### Functional

- [x] **R1 — Send (base feature):** one prompt → the three configured models in  ✅ S2 d4f0962: tests/send (3 parallel streams, per-slot payloads)
      parallel via OpenRouter; all three outputs streamed and displayed. No analysis
      unless requested.
- [x] **R2 — Per-model configuration:** for each slot (Claude / ChatGPT / Grok),  ✅ S1/S2: env overrides tests/test_config.py + UI controls + tests/send payload assertions
      independently set (a) the specific model and (b) the reasoning **effort**
      (e.g., off / low / medium / high), from both config file and UI.
- [x] **R3 — Analyze:** on-demand structured comparison of the latest responses:  ✅ S2: tests/analyze (planted_factual isolates d1; idempotent cached hit)
      similarities reported as agreements, differences as divergences with per-model
      positions and a materiality rating.
- [x] **R4 — Fusion:** on-demand iterative loop seeded by Analyze's divergences. Each  ✅ S2: tests/fusion (converged / stalemate / max_iterations / unjustified / unavailable)
      round, every model holding a differing position receives the (anonymized) peer
      claims and latest justifications and must defend or revise. Loop runs until all
      divergences resolve, nothing changed in a round (stalemate), or
      **`max_iterations`** — settable in the UI per run — is reached. Output is a
      fusion report with the per-divergence iteration trace and final status.
- [x] **R5 — Thread continuation:** post follow-ups into any single model's thread;  ✅ S2: tests/send rabbit-hole byte-identical threads; fusion messages in slot threads (tests/fusion)
      other threads untouched. Fusion exchanges live in the relevant model's history so
      later rabbit-holing carries that context.
- [x] **R6 — Grounded mode (later phase):** toggle to web-search-enabled variants for  ✅ Stage 4 smoke 2026-09-08: grounded Opus 5 answered a current-events question with a url_citation (was 🔶) toggle + plugin wired (S2); live citations verified in Stage 4
      questions needing current data (vendor parts, datasheets, pricing).

### Non-functional

- [x] Streaming responses; Analyze/Fusion progress shown round by round.  ✅ S1/S2: SSE token streaming; round_start/exchange/round_done events; live panes
- [x] Cost, token, and latency display **per feature invocation** (Fusion multiplies  ✅ S1 + review fixes: meter shows last invocation per feature + Fusion multiplier vs the fused Send
      calls; the meter must make that visible).
- [x] Local persistence of full conversation state (JSON on disk to start).  ✅ S1: backend/store JSON per conversation, atomic writes, sidecar index
- [x] Deterministic **mock/replay mode** for offline development and tests.  ✅ S1: backend/llm/mock + 14 scenarios; whole suite runs with outbound HTTP blocked
- [x] All keys via `.env` (never committed). Single provider key: OpenRouter.  ✅ S0: config.settings() + .env.example; conftest blanks the key for non-live tests

---

## 3. Starting point

**Fork `karpathy/llm-council`** (FastAPI backend + React frontend, `uv`-managed,
OpenRouter client, JSON-on-disk conversation store). Its always-on three-stage pipeline
becomes three separately triggered features.

| Keep | Replace | Add |
|---|---|---|
| Parallel collection + per-model tab view (= Send) | Always-on pipeline → on-demand **Analyze** / **Fusion** buttons | Per-slot model + effort settings |
| OpenRouter client & streaming plumbing | Peer *ranking* → structured divergence extraction | **Fusion iteration loop** with max-iterations control |
| JSON-on-disk store (upgrade later) | Chairman synthesis → lightweight fusion report | Thread continuation, cost meter, mock/replay layer |

The repo is explicitly offered as-is for modification and is small enough to read in one
sitting. If on inspection it fights these changes (Phase 0 will tell), keep this spec
and greenfield the same shape: FastAPI + small React UI + OpenRouter.

---

## 4. Architecture

```
React UI ────────── SSE/stream ────────── FastAPI backend
  │ per-slot model+effort controls            │
  │ [Send] [Analyze] [Fusion (max_iter)]      │
  │                                  orchestrator
  │                     ┌───────────────┼──────────────────┐
  │                   SEND           ANALYZE            FUSION
  │                   3 models       Analyst model      round loop:
  │                   in parallel    → agreements +     challenges → defend/revise
  │                                  divergences JSON   → convergence check
  │                     └───────────────┼──────────────────┘
  │                                OpenRouter API
  │                                     │
  └──────────────────────────── storage/ (JSON per conversation)
```

### Config (`config.py` / `.env`)

```python
SLOTS = {
    "claude": {"model": "<slug>", "effort": "high"},
    "chatgpt": {"model": "<slug>", "effort": "medium"},
    "grok":   {"model": "<slug>", "effort": "medium"},
}
# `effort` maps to OpenRouter's unified reasoning parameter, which translates to each
# provider's native control (thinking budget / reasoning effort). Verify the CURRENT
# parameter shape and per-model support at openrouter.ai during Phase 0 — some models
# ignore or fix their reasoning level. Do not hardcode from this document.

ANALYST_MODEL             = "..."   # runs Analyze + convergence checks (may be a slot model)
FUSION_MAX_ITERATIONS_DEF = 2       # default; UI-settable per fusion run (cap it, e.g. ≤5)
MATERIALITY_MIN           = "medium"  # divergences below this are reported but not fused
MAX_TOKENS_STAGE          = {...}     # per-call caps to bound cost
MOCK_OPENROUTER           = False     # replay fixtures instead of live calls
```

---

## 5. Data model

### Conversation store (per conversation JSON)

```jsonc
{
  "id": "uuid",
  "title": "...",
  "slot_config": { "claude": {"model": "...", "effort": "..."}, ... },  // as-run
  "threads": {                    // ONE history per slot — the source of truth
    "claude":  [ {"role": "user"|"assistant", "content": "..."} ],
    "chatgpt": [ ... ],
    "grok":    [ ... ]
  },
  "turns": [                      // artifacts per feature invocation
    { "type": "send",    "prompt": "...", "responses": {"claude": "...", ...},
      "usage": { ... } },
    { "type": "analyze", "of_turn": 0, "extraction": { /* schema below */ },
      "usage": { ... } },
    { "type": "fusion",  "of_analyze": 1, "max_iterations": 2,
      "rounds": [ /* FusionRound below */ ],
      "final": [ {"divergence_id": "d1", "status": "resolved"|"standing"} ],
      "usage": { ... } }
  ],
  "anon_map": { "R1": "claude", "R2": "chatgpt", "R3": "grok" }   // server-side only
}
```

### Extraction schema (Analyze output — enforce with pydantic)

```jsonc
{
  "agreements": [
    { "topic": "...", "statement": "...", "models": ["R1","R2","R3"] }
  ],
  "divergences": [
    {
      "id": "d1",
      "topic": "...",
      "positions": [
        { "model": "R1", "claim": "...", "evidence_cited": "... or null" }
      ],
      "materiality": "high" | "medium" | "low"
    }
  ]
}
```

### FusionRound schema (one per iteration)

```jsonc
{
  "round": 1,
  "exchanges": [
    { "divergence_id": "d1", "model": "R2",
      "stance": "defend" | "revise",
      "justification": "...",
      "revised_claim": "... or null",
      "confidence": 0.0 }
  ],
  "post_round_status": [ {"divergence_id": "d1", "status": "resolved"|"standing"} ],
  "changed": true          // did any stance/claim change this round?
}
```

---

## 6. Feature pipelines

**Send.** Deliver the prompt to each slot model with *that slot's own thread history*
prepended and its configured effort applied. Run in parallel, stream into per-slot tabs,
append to each thread. This is the whole base feature — stop here.

**Analyze.** Analyst model receives the three responses labeled `R1/R2/R3` (mapping to
real slots kept server-side only) and returns the Extraction schema as strict JSON:
where the responses are similar, where they differ, ignoring style and emphasis.
Validate with pydantic; on failure retry once with the validation error included; on
second failure degrade gracefully (show raw responses, disable Fusion for this turn).

**Fusion.** Requires an Analyze result (auto-run Analyze first if missing).

```
standing = divergences with materiality ≥ MATERIALITY_MIN
for round in 1 .. max_iterations:
    for each standing divergence:
        for each model whose current claim differs from the others:
            challenge it (in its own thread, peers anonymized) with the peers'
            latest claims + justifications → defend | revise (Appendix A)
    update each model's current claim from any revisions
    convergence check (analyst): mark divergences whose claims now match as resolved
    if all resolved OR no exchange changed anything this round: break   # early exit
report: per-divergence timeline of rounds + final resolved/standing status
```

Guards baked into the loop:

- **Anonymization is load-bearing** — council-style peer-review data shows models rate
  their own answers higher than peers do, and naming a rival invites brand deference.
  The anon map never appears in prompts or UI.
- **Anti-sycophancy** — the challenge prompt states that revising is only correct when
  persuaded by *specifics*; a `revise` with no substantive justification is flagged in
  the report rather than counted as clean convergence.
- **Stalemate is a valid outcome** — divergences still standing at loop exit are
  reported as such with both sides' final justifications. Never averaged.

---

## 7. UI spec

- **Slot header (×3):** provider label, model dropdown, effort selector (off / low /
  medium / high). Persisted per conversation; the as-run config is stamped on each turn.
- **Send** is the default action on the prompt box. Responses render as three columns
  or tabs, each with its **own input box** for solo continuation (R5). Fusion messages
  in a thread are visually marked.
- **Analyze button** appears once a send turn completes → renders the report:
  *Similar* (agreements list) and *Differs* (divergence table: topic | per-model
  position | materiality).
- **Fusion button** with an **iterations stepper** (default from config) → per-divergence
  timeline as rounds stream in (e.g., `R1 defends → R3 revises → resolved, round 2`),
  then the final report with standing items called out.
- **Footer:** tokens / $ / latency for the last invocation, broken out by feature —
  Fusion's multiplier should be impossible to miss.

Keep it plain and functional — this is a bench instrument, not a product demo.

---

## 8. Build phases

Each phase = one Claude Code session on its own git branch, driven in Plan Mode first,
with tests written from the acceptance criteria before implementation.

### Phase 0 — Bring-up & reconnaissance
- [x] Clone fork; `uv sync`; add OpenRouter key to `.env`; run the stock app end-to-end.  ✅ superseded: greenfield build (Appendix B); `uv sync` + `npm ci`; app runs in mock mode via ./start.sh
- [x] Fetch current OpenRouter slugs for the target Claude / ChatGPT / Grok models;  ✅ recon 2026-09-07 (docs/openrouter-notes.md, docs/decisions.md); catalog fixture backend/llm/fixtures/models.json
      verify the current unified-reasoning parameter shape and which slots honor it.
- [x] Run `/init`; trim `CLAUDE.md` (run commands, structure notes, "update PLAN.md  ✅ S0: CLAUDE.md in karpathy's structure (docs/reference/llm-council-CLAUDE.md kept verbatim)
      checkboxes as you go").
- [x] Capture 2–3 full raw API transcripts as `fixtures/` for replay.  ✅ Stage 4 smoke: 5 real transcripts recorded → backend/llm/fixtures/recordings/2026-09-08-smoke/ (was 🔶) hand-authored scenario corpus (S1); real transcripts recorded in Stage 4 (MOCK_RECORD_DIR)
- **AC:** stock flow completes with all three target models; costs visible in logs.  ✅ Stage 4 smoke: all three slots answered with their configured models; per-call INFO cost lines + summary $0.079

### Phase 1 — Test scaffolding & schemas
- [x] `MOCK_OPENROUTER=1` replay layer serving fixtures.  ✅ S1: backend/llm/mock.py (scenario counters, sticky-last, recorded lookup, calls capture)
- [x] Pydantic models for Extraction and FusionRound schemas + unit tests (valid,  ✅ S0/S1: tests/test_schemas.py + hypothesis fuzz of the lenient extractor (tests/llm)
      invalid, malformed/fenced/chatty JSON cases).
- **AC:** `uv run pytest` green with no network.

### Phase 2 — Send + per-model settings + threads (the base feature)
- [x] Strip the always-on pipeline: Send performs collection only.  ✅ greenfield: Send is collection only (backend/features/send.py); Analyze/Fusion are on-demand routes
- [x] Per-slot model + effort config, wired from UI to request payloads.  ✅ S1/S2: per-column model + effort controls → PUT slot_config → payload assertions in tests/send
- [x] Per-slot thread persistence and solo continuation (input box per tab).  ✅ S1/S2: threads per slot in the store; per-column solo composer; tests/send continue tests
- **AC:** a test asserts each slot's request carries its own model slug and reasoning
  setting; three outputs stream and render; rabbit-hole one slot ≥3 turns with the
  other threads byte-identical before/after.

### Phase 3 — Analyze
- [x] Analyst extraction on demand; strict-JSON prompt (Appendix A); validation + one  ✅ S2: backend/features/analyze.py — strict json_schema + lenient parse + one retry + degraded path
      retry; graceful-degrade path.
- [x] Similar / Differs report UI.  ✅ S1: frontend/src/features/analyze (Similar / Differs table, not-fused marker)
- **AC:** on a fixture with a planted factual disagreement, Analyze isolates it with
  correct per-model positions; re-running Analyze on the same turn is idempotent.

### Phase 4 — Fusion
- [x] Iteration loop per §6 with UI-settable `max_iterations`; early exit on  ✅ S2: backend/features/fusion.py — UI-settable max_iterations (1..5), converged/stalemate/cap exits
      convergence and on stalemate; convergence checks via analyst.
- [x] Exchanges appended to the correct slot thread; per-divergence timeline UI.  ✅ S2: challenge+reply appended with meta; S1: frontend/src/features/fusion timeline
- [x] Leak tests: no real slot/model names in any challenge prompt.  ✅ S2: leak tests over every captured defense/convergence payload (tests/fusion, tests/analyze)
- **AC:** `max_iterations=1` reduces to a single cross-exam round; a planted resolvable
  disagreement converges and exits before the cap; a planted stalemate exits at the cap
  with `standing` status and both justifications shown; unjustified `revise` is flagged.

### Phase 5 — Grounding & cost control
- [x] Grounded-mode toggle mapping slots to web-search-enabled variants (verify the  ✅ Stage 4 smoke: live citation observed (delta.annotations) (was 🔶) implemented via OpenRouter `plugins:[{id:web}]` (S2 tests/send grounded); live citation AC pending Stage 4
      current OpenRouter mechanism during this phase — do not trust this doc).
- [x] Per-call token caps enforced; footer cost meter from usage data, per feature.  ✅ S1/S2: MAX_TOKENS_STAGE per call, truncated flag + warning; meter from usage per feature
- **AC:** a current-events question answers with citations in grounded mode; a
  cap-exceeded path truncates gracefully with a visible warning.

### Phase 6 (stretch) — Agreement metrics & evaluation
- [ ] Numeric agreement score per divergence via embedding cosine (local Ollama
      `nomic-embed-text` — already running in your stack).
- [ ] Small eval set (~15 GNC/embedded questions with checkable answers); script
      comparing fused outcomes vs. each solo model — the Self-MoA check: confirm the
      council beats your best single model before trusting it.

---

## 9. Testing strategy

- **Unit:** schema validation, anonymization mapping, thread bookkeeping, effort→payload
  mapping, cap enforcement, loop-termination logic (converged / stalemate / cap).
- **Integration:** each feature end-to-end against replay fixtures; snapshot ("golden")
  tests on the Analyze report and fusion timeline for fixed inputs.
- **Robustness:** fuzz the Analyze/Fusion parsers with truncated and fenced output.
- **Leak tests:** real identities never appear in anonymized prompts.
- Live-API smoke test kept separate and manual (`pytest -m live`) — never in CI.

## 10. Working with Claude Code

1. Put this file at the repo root as `PLAN.md`. In `CLAUDE.md`, add: *"PLAN.md is the
   spec. Work one phase at a time. Check off items and update the decisions log."*
2. Start each phase in **Plan Mode** (Shift+Tab twice): have Claude read `PLAN.md` +
   the relevant code, propose its implementation plan, and only then approve execution.
3. New git branch per phase; commit per checklist item; `/clear` between phases.
4. TDD: failing tests from the phase's acceptance criteria first, commit, then
   implement until green.
5. Anything this doc says about external services (OpenRouter slugs, reasoning
   parameter, web-search variants) is a pointer, not ground truth — verify against live
   docs during the relevant phase.
6. Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview

## 11. Risks & design guards

- **Fusion cost blowup:** each round ≈ (standing divergences × dissenting models) + a
  convergence check. Cap `max_iterations`, enforce token caps, meter per feature, and
  log costs from Phase 0.
- **Sycophantic convergence:** models may cave to peers without cause; the challenge
  prompt demands specifics and the report flags unjustified revisions.
- **Correlated errors:** unanimous agreement can be a shared hallucination — present
  consensus as *convergence*, not verified truth; grounded mode exists for claims that
  need sourcing.
- **Self-preference / brand deference:** anonymize all cross-model exposure (leak-tested).
- **Verbosity bias:** analyst prompts instruct judging on substance, not length.
- **Prompt injection via grounded mode:** web-sourced content inside responses is data;
  challenge prompts must quote it inertly, never execute instructions found in it.
- **Model churn:** slugs, effort support, and variants change; everything
  model-specific lives in config.

---

## Appendix A — Prompt templates (starting points; tune freely)

> The JSON instruction quoted below is the **API** variant. A `web:` model (a site driven through
> the desktop bridge) swaps that one clause for a fenced-block ask, because its reply is read back out
> of rendered markdown, which strips backslash escapes; see `docs/semantics.md` "Structured output".

**Analyze — extraction**

```
You are an analyst comparing three anonymous expert responses (R1, R2, R3) to the same
question. Identify (a) substantive points where they agree, and (b) substantive points
where they disagree or give incompatible specifics. Ignore differences of style, order,
or emphasis. Judge on substance, not length or confidence of tone.

Return ONLY valid JSON matching this schema (no prose, no code fences):
{ "agreements": [...], "divergences": [...] }   // full schema in PLAN.md §5

Question: {question}
R1: {response_1}
R2: {response_2}
R3: {response_3}
```

**Fusion round — challenge (sent within the dissenting model's own thread)**

```
On the question above, regarding "{topic}", your current position is: {your_claim}.
Anonymous peer reviewers currently hold: {peer_claims_with_latest_justifications}.

Either DEFEND your position with your strongest specific justification (cite sources or
reasoning, not authority), or REVISE it — but only if a specific point above actually
persuades you. Being persuaded by a correct peer is success; caving without cause is
failure. This is round {round} of at most {max_iterations}.

Return ONLY valid JSON:
{ "stance": "defend" | "revise", "justification": "...",
  "revised_claim": "... or null", "confidence": 0.0-1.0 }
```

**Fusion — convergence check (analyst, after each round)**

```
For each divergence below, compare the models' CURRENT claims after this round's
revisions. Mark "resolved" only if the claims are now substantively compatible;
otherwise "standing". Return ONLY valid JSON:
[ { "divergence_id": "...", "status": "resolved" | "standing" } ]

{divergences_with_current_claims}
```

## Appendix B — Decisions log

| Decision | Options | Status |
|---|---|---|
| Fusion auto-runs Analyze if missing | yes vs. require explicit Analyze | start: yes |
| `max_iterations` default / hard cap | 2 / 5 | start: 2 / 5 |
| Convergence check | analyst call vs. embedding-similarity rule | start: analyst; revisit in Phase 6 |
| Analyst = a slot model? | reuse strongest vs. dedicated 4th model | superseded 2026-09-07 → see "Analyst model" row |
| Materiality threshold for Fusion | medium vs. high-only | start: medium |
| Storage upgrade | JSON-on-disk vs. SQLite | JSON until it hurts |
| Auth | none (localhost only) | none |
| Starting point | fork llm-council vs. greenfield same shape | **greenfield** (2026-09-07): llm-council has no LICENSE, no per-slot history, no token streaming, no reasoning params, no usage capture, no tests; used as design reference only |
| Execution model | one phase per sequential session vs. parallel staged agents | **parallel stages** with frozen contracts and disjoint file ownership (phase→stage map: P0+P1→Stage 0/1, P2–P4→Stage 1/2, P5→Stage 3, live AC→Stage 4, P6→out of scope) |
| Analyst model | reuse a slot model vs. dedicated 4th model | **dedicated** `openai/gpt-5.6-luna` (structured_outputs, seed, ~1/50 the cost of a flagship) |
| Who is challenged in Fusion | dissenters only vs. every model with a position | **every label holding a Position on a standing divergence, every round** (majority agreement is weak evidence); round cost = standing × labels + ≤1 analyst call |
| Stalemate | analyst call every round vs. shortcut | **all-defend round exits `stalemate` without an analyst call**; the "exits at the cap" AC is covered by the `standing_at_cap` scenario (`max_iterations` exit) |
| Effort vocabulary | OpenRouter's 7 levels vs. spec's 4 | **off / low / medium / high**; off = `{"enabled": false}`; mandatory-reasoning models hide "off" and coerce with a visible badge |
| Web search mechanism | `:online` suffix vs. `plugins` | **`plugins: [{"id": "web"}]`** on Send/continue only (never analyst or challenge calls) |
| Anon labels in UI | reveal mapping vs. never | **never**: Analyze/Fusion show R1/R2/R3 only; `anon_map` stripped from every API response |
| Client disconnect mid-Send | cancel upstream vs. run to completion | **run to completion and persist** (v1); concurrent feature calls on one conversation → 409 busy |
| Fusion reply in thread | raw JSON verbatim vs. rendered prose | **raw JSON verbatim** (faithful history), `meta={divergence_id, round}` |
| Slot controls placement | column header vs. global bar | **per-column model + effort controls** (spec §7) plus a global bar for analyst / iterations / grounded |
| Conversation title | LLM-generated vs. first prompt | **first prompt truncated to 60 chars**, renamable (no extra LLM call) |
| Unjustified revise | heuristic vs. analyst judgement | **deterministic rule** `schemas.is_unjustified` (needs `persuaded_by` + substantive overlap); a divergence resolved only through flagged revises is reported `resolved_unjustified` |
| Structured output | prompt-only vs. `response_format` | **strict `json_schema`** when the model lists `structured_outputs`, always followed by lenient parse + pydantic + one retry |
| Live cost cap | none vs. cap | **`SESSION_COST_CAP_USD=10`** enforced in the client |
| Build venue | local vs. Claude Code cloud | **local** (cloud needs a GitHub repo + environment secret; see docs/decisions.md) |
| Turn references | list index vs turn id | **uuid4 turn ids** (`of_turn`, `of_analyze`); indexes break under forced re-analysis and deletion |
| Reasoning / citations persistence | live only vs on the turn | **on the turn per slot** (never in threads, never replayed to models) |
| Error envelope | flat `{error}` vs FastAPI `{detail:{error}}` | **FastAPI envelope** via `backend/api_errors.py`; pre-stream checks run before the first SSE yield (`sse_response` primes the generator) |
| Anon map in mock mode | random vs fixed | **fixed R1=claude, R2=chatgpt, R3=grok** in mock mode so replay is deterministic; random live |
| Challenge prompt shape | Appendix A verbatim vs delimited topic | **topic scrubbed and quoted in its own `<<<TOPIC>>>` block** before "Your current position is:" (delimiter-breakout rule); every error text Fusion emits is scrubbed |
| Empty model reply | append "" vs fail the slot | **`slot_error{empty_reply}`**, nothing appended (an empty assistant turn is rejected by providers and would poison the thread) |
