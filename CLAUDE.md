# CLAUDE.md - Technical Notes for Triplex

PLAN.md is the spec. Work one stage at a time (phase→stage map in Appendix B). Check off items and update the decisions log (`docs/decisions.md`, "Build log").

This file contains technical details, architectural decisions, and important implementation notes for future development sessions. Its structure follows karpathy's llm-council CLAUDE.md (kept verbatim in `docs/reference/llm-council-CLAUDE.md`); Triplex is a greenfield build in the same shape, not a fork. The notes below describe the code as merged at tag `S3` (+ the W5 review fixes on `main`).

## Project Overview

Triplex is a three-slot council (Claude, ChatGPT, Grok via OpenRouter) with three separately triggered features. **Send** streams one prompt to all three models in parallel, each with its own thread history. **Analyze** is an on-demand compare/contrast pass that returns agreements and divergences as strict JSON. **Fusion** iterates on the divergences (defend or revise, round by round, up to a user-set `max_iterations`) and reports what converged and what is still standing. The key stance is sensor fusion *plus integrity monitoring*: models never see each other's identities (R1/R2/R3 only), and unresolved disagreement is surfaced, never averaged away.

## Architecture

### Backend Structure (`backend/`)

**`schemas.py`** (FROZEN contract, `SCHEMA_VERSION = 1`, append-only)
- Every shared pydantic model: `SlotConfig`/`SlotSpec`, `ThreadMessage` (+ `to_openai()` projection: role + content only), `Usage`/`UsageTotals`/`FeatureUsage`, `Extraction`, `DefenseReply`, `ConvergenceCheck`, `Exchange`/`FusionRound`/`RoundStatus`, `PeerState`, the discriminated `Turn` union (`send` / `continue` / `analyze` / `fusion`), `Conversation` + `ConversationPublic` + `ConversationSummary`, `Delta`, `ModelMeta`
- Helpers: `strict_json_schema()` (OpenAI strict shape; drops `default`/bounds/`format`, pydantic still enforces them), `is_unjustified()` (deterministic anti-sycophancy rule), `efforts_from_reasoning_meta()`, `new_anon_map()`, `to_public()` (strips `anon_map`), `sse_frame()`, `canonical_request_key()`; `SLOT_VENDORS` — duplicated in `features/send/slice.js` because `state/*` is frozen

**`config.py`** (FROZEN)
- `settings()` reads the environment at CALL time (`.env` loaded once, `override=False`) — never cache it at import; tests and worktrees set env first
- `DEFAULT_SLOT_CONFIG` is a singleton that is NEVER handed out: `store.create` uses `settings().default_slot_config` (a fresh deep copy with `.env` overrides `SLOT_<CLAUDE|CHATGPT|GROK>_MODEL/_EFFORT`, `ANALYST_MODEL`, `FUSION_MAX_ITERATIONS`, `MATERIALITY_MIN`, `GROUNDED_DEFAULT`)
- `ANALYST_EFFORT="medium"`, `MAX_ITERATIONS_CAP=5`, `MAX_TOKENS_STAGE` (send/continue 8000, extraction 4000, defense 2000, convergence 1000), `FORBIDDEN_IDENTITY_STRINGS` (word-bounded) + `FORBIDDEN_MODEL_CODENAMES` (`luna`/`sol`/`astra`, matched only after a `-`)
- Backend runs on **port 8001** (NOT 8000 — another local app uses 8000); `PORT` (or `BACKEND_PORT`) / `HOST` from env; `SESSION_COST_CAP_USD=10`, `REQUEST_TIMEOUT_S=300`, `CATALOG_TTL_S=86400`, `GROUNDED_ENGINE`/`GROUNDED_MAX_RESULTS=5`

**`main.py`** (FROZEN) — app factory + CORS (localhost 5173/5174/3000) + `GET /` health `{status, service, schema_version, mock}` + `pkgutil` auto-discovery of `backend/routers/*.py` exporting `router`. Adding a feature adds ZERO lines here.

**`sse.py`** (FROZEN) — `sse_response(gen)` awaits the FIRST event before building the `StreamingResponse`, so an `HTTPException` raised before the first yield is a plain JSON error; after that the status is committed to 200 and every failure must be the terminal `error{message}` event. **`api_errors.py`** (FROZEN) — `not_found(what)` 404, `conflict(code, **extra)` 409, `unprocessable(code, **extra)` 422, all in FastAPI's `{detail:{error, ...}}` envelope.

**`anon.py`** — the anonymization firewall
- `labels()/label_of()/slot_of()` read the persisted `anon_map` only (ValueError on a bad map; never re-derived from position); `render_peer_block(peers, exclude)` = `QUOTED_DATA_NOTICE` + one `delimited(label, ...)` section per peer in R1/R2/R3 order, claims and justifications `scrub`bed to `[model]`
- `find_leaks()` mirrors `tests.helpers.find_identity_leaks` exactly, logs a WARNING and never raises — runtime leak checks are advisory; the tests are the gate

**`store/`** — the ONLY code that touches disk
- `conversations.py`: frozen public API (`create/load/list_summaries/delete/rename/update_slot_config/append_to_thread/append_turn/busy_guard/is_busy`); every mutation is a locked read-modify-write (`_modify`); `create()` stamps `MOCK_ANON_MAP` (R1=claude, R2=chatgpt, R3=grok) in mock mode, a random permutation live, `anon_map=` verbatim for tests; `update_slot_config` REPLACES the object; no process-level cache — `settings().data_dir` is resolved per call
- `files.py`: `<DATA_DIR>/conversations/<uuid4>.json`, tmp-in-same-dir + fsync + `os.replace`; `is_uuid4` accepts only the canonical lowercase v4 form (a non-uuid id is "missing", never a path); a corrupt document is logged and reported as missing
- `index.py`: sidecar `_index.json` of `ConversationSummary` upserted on every write; `read_summaries` reconciles against `os.scandir` (drops vanished, parses unlisted), newest `updated_at` first, ties = most recently written
- `locking.py`: `lock_for(key)` per-key `asyncio.Lock` re-created when the running loop changes (pytest-asyncio gives every test a fresh loop); `BusyGuard` = module dict `conv_id -> acquisition token` + a `ContextVar` of held tokens — re-entrancy is bound to the SPECIFIC token, so a stale entry left in a context after the producer task released it never bypasses a later acquisition; only the object that acquired releases; release rebuilds the ContextVar (a `reset()` token is invalid in the producer's copied context)

**`llm/`** — the only code that talks to OpenRouter
- `client.py`: `stream_completion()` NEVER raises (0+ `text|reasoning|citations` deltas, then exactly one `done{usage}` or `error{code,message,error_type}`); dispatches to `mock.stream` when `MOCK_OPENROUTER=1`; live path refuses with `cost_cap_exceeded` when `metering.session_cost_usd() >= SESSION_COST_CAP_USD` and with `missing_api_key` without a key; one `httpx.AsyncClient` per call; `provider:{require_parameters:true}` whenever `response_format` is set; missing `usage.cost` → `GET /generation?id=` (10 s, never raises) → catalog price; a 2xx body with no SSE data is an error delta, never an empty `done`; `aclose()` on the generator closes the transport at once. `_Recorder` tees live calls under `MOCK_RECORD_DIR` (`<role>.<purpose>.<n>.jsonl` created with mode `x`, numbering continues from disk, plus `recorded/<sha256>.jsonl` and `requests.jsonl`). `complete_json()`: strict `response_format` iff `get_meta(model).structured_outputs`; `extract_json` strips fences and scans outermost balanced objects (an inner object never masks a truncated outer one); `retries+1` attempts, retry only on parse/validation failure, never on a transport delta (returned as `(None, "", usage, message)`, `cost_cap_exceeded` kept as the stable key); an empty reply is not echoed back as an assistant turn; `finish_reason == "length"` logs one WARNING (the frozen tuple has no `truncated` field)
- `stream.py`: `SSEParser.feed(line)/finish()` (+ `parse_sse_lines` for iterables); skips `:` comments and non-`data:` lines, `[DONE]` finishes, top-level `error` → error delta and STOP; `reasoning_details[]` text/summary + bare `delta.reasoning`/`reasoning_content` (not doubled); citations from `delta.annotations` and `message.annotations`, de-duplicated by `url_citation.url`; the chunk carrying `usage` is `done` (`truncated = finish_reason=="length"`, `finish_reason` = last non-null seen); no usage chunk → synthesised `EstimatedUsage`; `usage_cost_missing` tells the client to try `/generation`
- `reasoning.py`: `build(effort, meta) -> (param|None, applied, coerced)`; `off` → `{"enabled": false}` unless mandatory (omit, coerce to the lowest real effort) or no reasoning meta (omit); unsupported effort → nearest lower supported, else lowest; unknown model → as configured; never raises
- `catalog.py`: live `GET /models` cached in memory + `<DATA_DIR>/models.json` (TTL); mock mode or ANY failure → `llm/fixtures/models.json`, with a 60 s no-retry window after a failed fetch (`force_refresh=True` always retries); `get_meta()` never does network I/O
- `metering.py`: process-level live cost total (`add_session_cost`, `session_cost_status()` → `{spent_usd, cap_usd, remaining_usd, exceeded, enforced}`; `enforced` is false in mock mode); `usage_from_chunk`, `estimate_usage` (`EstimatedUsage` marker), `price_fallback`; `format_log_line` = the one INFO line per call
- `mock.py`: replay for `MOCK_OPENROUTER=1`; `recorded/<sha256>.jsonl` first, else `scenarios/<MOCK_SCENARIO>/<role>.<purpose>.<n>.jsonl` with per-`(scenario, role, purpose)` counters, sticky-last, else a `mock_miss` error chunk; `calls` captures every request (`fixture` names the file served); `reset()` is autouse in tests; `MOCK_DELAY_MS` paces deltas
- `errors.py`: the codes Triplex mints (`cost_cap_exceeded`, `missing_api_key`, `timeout`, `transport_error`, `http_error`, `mock_miss`, `parse_error`) and `error_type="triplex"`; OpenRouter's own codes pass through verbatim

**`features/`** — one module per feature; each yields the SSE event dicts in `docs/api-contract.md`, normative behaviour in `docs/semantics.md`
- `send.py`: `run_send`/`run_continue`; pre-checks 404 → 422 `empty_prompt` → 404 slot → **busy guard LAST**; ONE coordinator task per turn owns every LLM call and write, pushes events to a queue the generator drains (a disconnect never cancels it); request = `threads[slot]` + verbatim prompt, nothing Triplex-authored; `[user, assistant]` appended together at `slot_done`, nothing on `slot_error` (partial kept on the turn), truncated replies still appended; the first send auto-titles via `store.rename(prompt[:60])` before `append_turn`; `turn_done` only after `append_turn`; `wait_for_background()` for tests
- `analyze.py`: pre-checks 404 → resolve `of_turn` (404 turn / 422 `not_a_send_turn` / 409 `no_send_turn`) → 409 `incomplete_send_turn{missing}` → cache hit replays `analyze_start` + `analyze_done{cached:true}` with NO guard and NO call → guard LAST; `ATTEMPTS=2`, each `complete_json(retries=0)`; `retry_follow_up`: identical request when there was no output at all, the correction message otherwise, the bad output echoed as assistant only when non-blank; `analyze_done`/`analyze_degraded` is the last event (no `error` after a degrade); the guard is released before the final event is enqueued
- `fusion.py`: pre-checks 404 → 422 `invalid_max_iterations` → resolve `of_analyze` (404 / 422 `not_an_analyze_turn` / 409 `analyze_degraded`) → 409 `nothing_to_fuse` (existing Analyze) or Analyze's own pre-checks (auto-run path) → guard LAST; the producer auto-runs the REAL `run_analyze` inside the stream (its events forwarded; `error{analyze_degraded|nothing_to_fuse}` ends it with no fusion turn); loop exactly as `docs/semantics.md`: every label with a Position on every standing divergence, sequential per slot / slots in parallel, `complete_json(retries=1)`, challenge + raw reply appended with `meta={divergence_id, round}`, `unavailable` on failure (nothing appended), all-unavailable → `error` (before stalemate), no revise → `stalemate` with no analyst call, else ONE convergence check over the revised ids; `resolved_unjustified` when every revise on that id was flagged; a `BaseException` from the producer before the first event is re-raised as a pre-stream JSON error
- `slot_config.py`: `validate_slot_config` → 422 `unsupported_effort` only when the catalog KNOWS the model; imports `catalog` lazily so tests can monkeypatch `get_meta`

**`routers/`** (auto-mounted): `send.py` (`POST …/send`, `…/slots/{slot}/continue`; `slot` is `str` and rejected with `not_found("slot")` — a Literal would 422), `analyze.py` (body optional), `fusion.py` (`max_iterations` required 1..5 — pydantic's own 422 list), `conversations.py` (CRUD + `PATCH …/title` 1..200 chars; everything through `to_public`), `config.py` (`GET/PUT …/slot_config`; PUT returns the STORED `SlotConfig`, not the conversation), `models.py` (`GET /api/models?force_refresh=`), `session.py` (`GET /api/session/cost`)

**`prompts/`** — every Triplex-authored string that reaches a model (leak tests scan them)
- `__init__.py`: `delimited(label, text)` wraps quoted data in `<<<LABEL>>> … <<<END LABEL>>>` and **neutralises every `<<<` inside** (`<< <`) so quoted text can never close its own block; `QUOTED_DATA_NOTICE`
- `send.py`: deliberately prompt-free (`user_message`, `web_plugins` → `[{"id":"web", engine?, max_results}]` iff grounded, `title_from_prompt`)
- `analyze.py`: `SYSTEM` + `build_messages(question, {R1..R3})` = `[system, user(question + notice + delimited blocks)]`; `retry_message`
- `fusion.py`: `challenge_prompt` (notice, `YOUR CLAIM` / `YOUR JUSTIFICATION` delimited, peer block, Appendix A anti-sycophancy clause verbatim + round counter, JSON instruction asking for `persuaded_by`); `convergence_messages` (`[system, user(delimited JSON array)]`, answer `resolved|standing` only)

### Frontend Structure (`frontend/src/`)

**`App.jsx`** (FROZEN) — pure layout with six `data-testid` regions; imports each pane by convention from `features/<x>/index.jsx`. **`main.jsx`** renders under `StrictMode` on purpose: double-invoked effects are the canary for double-subscribed streams.

**`state/`** (FROZEN) — `store.jsx` (`StoreProvider({preloaded})`, `useSlice`, `useDispatch`; late-registered slices are initialised via `onRegister`), `registry.js` (`registerSlice(key, reducer, initial)`; every slice gets every action; untouched slices keep identity), `reducers.js` (core slices `conversation, conversations, slotConfig, models, streams` + the frozen action names; a terminal `error` event flips `streams.<f>` to `error` even under HTTP 200), `testing.jsx` (`applyEvents`, `renderWithStore`, `sample.*`)

**`api/`** (FROZEN) — `sse.js` (buffered reader: `decode(value,{stream:true})`, split on `\n\n`, `:` lines skipped, `reader.cancel()` on early exit — fixes llm-council's dropped-frame bug), `http.js` (`ApiError.code` = `detail.error` or `validation_error`; loaders dispatch the frozen actions; `loadModels` shares one in-flight request; `saveSlotConfig` is optimistic then PUT, reload on failure; `isCurrent` hooks drop late responses), `runStream.js` (one `AbortController` per feature; a superseded stream never reports `sse/abort` over the new one; `sse/end{ok:false}` when the last event is `error`)

**`features/send/`** — `index.jsx` registers `slots`; `slice.js`: `slot_start` is the ONLY idle→streaming transition, so any later event for an `idle` slot is a stale stream and is ignored (conversation A never streams into B); `conversation/loaded` drops live buffers; pure helpers `vendorModels/effortsFor/nearestEffort` (mirror of `reasoning.build`), `turnExtras/slotTurns/threadItems` (errored turns interleaved into the history), `isCostCapError`, `safeCitationHref` (http(s) only); `SendPane.jsx`: creates a conversation when none, streams send AND continue under feature key `'send'`, refetches, `loadConversations` after the first send (auto-title); pending prompt / banner / refetch are scoped to the conversation the turn started in; composer locked while any stream runs or until the refetch settles; `SlotColumn.jsx`: header model/effort selects save through `saveSlotConfig` (effort coerced to the nearest supported on a model change), persisted thread with fusion messages labelled and replies pretty-printed as JSON, live buffer with cursor, reasoning `<details>`, domain-named citation links, truncation warning, cost-cap notice, scroll-to-newest on load and while streaming
**`features/analyze/`** — `slice.js` handles `analyze_*` events REGARDLESS of `a.feature` (Fusion auto-runs Analyze on its own stream); hydrates from the newest ok analyze turn of the latest send turn; `AnalyzePane.jsx`: Analyze / Re-run (`force`), `cached` chip, Similar / Differs table (R-labels only, rows below `materiality_min` marked "not fused"), degraded box with raw attempts
**`features/fusion/`** — `slice.js`: `error{nothing_to_fuse|analyze_degraded}` (and the same codes in a pre-stream 409 body) are `notice`s, not failures; a running timeline is never clobbered by `conversation/loaded`; a failed run keeps its partial timeline unless the server now holds the very turn it announced; `derive.js`: `fusionGate` (button rule), `standingIds`, `buildTimeline`, `latestClaim/latestJustification`, `traceText`, `clampIterations`; `FusionPane.jsx`: stepper 1..5 (a cleared number input stays `''` until blur), gate hint, progress line, per-divergence timeline, final report with both sides' latest justifications, stale marker after a newer Send
**`features/config/index.jsx`** — global bar: analyst model (structured-outputs models grouped first), default iterations, materiality threshold, grounded toggle; a save sequence counter lets only the LATEST PUT's response land, and never for a conversation no longer selected
**`features/meter/`** — `slice.js`: last-invocation rows + per-conversation cumulative rows + total, recomputed from persisted turns on `conversation/loaded`; Fusion multiplier = last Fusion cost / cost of the Send it fused (`analyzeOfTurn` → `sendCostByTurn`); cached `analyze_done` books nothing, `analyze_degraded` does; any event carrying `cost_cap_exceeded` sets the persistent `costCapExceeded` flag; `index.jsx` renders the table, `×N vs Send` badge, truncated count and the cap warning
**`features/conversations/index.jsx`** — sidebar: New / select / delete are DISABLED while any stream runs (a switch mid-stream would snap back and book usage into the wrong conversation); latest-select-wins sequence; inline rename; deleting the open conversation dispatches `conversation/cleared`

**Styling** — light theme, primary `#4a90e2`; palette tokens and `.markdown-content` (12px padding; every ReactMarkdown wrapped) in `index.css`; `App.css` is layout only (main column scrolls, Send grid 62vh, `.app-analyze:empty`/`.app-fusion:empty` hidden); each feature ships its own `*.module.css`

**`frontend/e2e/`** (Playwright, system Chrome) — `helpers.js` (per-scenario `PROMPTS`, `snap()` screenshots into `docs/screenshots/` through a tall viewport, `sendPrompt/runAnalyze/runFusion/getConversation`); default scenario specs `smoke`, `flow` (01–04 screenshots), `settings`, `persistence`, `guard` (holds the send response for 1.5 s to assert the locks + meter rows); scenario-gated specs `stalemate`, `cap`, `degrade`, `truncated`, `grounded` skip unless `MOCK_SCENARIO` matches — the scenario is fixed per server start, so each runs on its own ports (see Testing Notes)

## Key Design Decisions

### Threads are the source of truth
Each slot has ONE independent message history (`threads[slot]`). Send prepends that slot's own history; solo continuation appends to one thread and leaves the others byte-identical; Fusion challenges and replies are appended to the challenged slot's thread so later rabbit-holing carries that context. `turns[]` are artifacts of feature invocations, not the history; reasoning, citations, truncation and `effort_applied` live on the turn, never in threads.

### Anonymization is load-bearing
Models are shown as R1/R2/R3 everywhere (analyst prompts, challenge prompts, reports, UI). The mapping lives only in the persisted document, is fixed in mock mode (R1=claude, R2=chatgpt, R3=grok, so fixtures/goldens/Playwright are deterministic) and random live, and is stripped from every API response (`tests/e2e` asserts no body ever contains `anon_map`). Leak tests scan every Triplex-authored prompt for vendor/product names, slot ids and slug code names; user prompts and raw model replies are out of scope.

### Strict JSON with a safety net
Analyst and defense calls use OpenRouter `response_format: json_schema` (strict, `require_parameters`) when the model lists `structured_outputs`, then always lenient parse + pydantic + one retry carrying the validation error. A second failure degrades (`status: degraded`, Fusion disabled for that turn) instead of failing the request; `tests/e2e/test_robustness.py` fuzzes truncated / fenced / chatty / prose / schema-breaking / empty / error outputs through the real HTTP flow.

### Anti-sycophancy is a rule, not a vibe
A `revise` is flagged unjustified by `schemas.is_unjustified()` (short justification, no `persuaded_by`, or no substantive overlap with the peer claims shown). A divergence that resolves only through flagged revises is reported `resolved_unjustified`, never as clean convergence. An all-defend round exits `stalemate` without an analyst call.

### One producer task per feature call, and one call per conversation
Every feature runs all its pre-checks before the first yield, enters `store.busy_guard` LAST, then spawns ONE task that owns every LLM call and persistence write and releases the guard in its `finally` after the last write; the generator only drains that task's queue. A client disconnect therefore never cancels work or releases the guard early; a second concurrent call on the same conversation is `409 busy`. `run_fusion` can call `run_analyze` because the guard is re-entrant for the task that acquired it (and tasks created from it).

### Error Handling Philosophy
- Continue with the slots that succeed; never fail the whole Send because one model failed
- A slot that errors mid-stream gets nothing appended to its thread; partial text is kept on the turn and the column shows the errored turn in place
- Pre-stream failures are plain JSON `{detail:{error:<code>}}` (raised before the first yield); mid-stream failures are `slot_error` / `error` events; the LLM layer never raises

### UI/UX Transparency
- Every raw model output is visible in its column; the Analyze report shows per-label positions and materiality; the Fusion timeline shows each stance, flagged revisions and the exit reason; the meter shows last-invocation and cumulative cost per feature with Fusion's multiplier vs the Send it fused
- Agreements are captioned "convergence, not verified truth" — correlated models can share a hallucination

## Important Implementation Details

### Relative Imports
All backend modules use relative imports (`from .config import ...`). Run the backend as `uv run python -m backend.main` from the project root, never from inside `backend/`.

### Port Configuration
- Backend 8001 (`PORT`/`BACKEND_PORT`); frontend 5173 (`VITE_PORT`); Vite proxies `/api` to the backend (`vite.config.js` reads `BACKEND_PORT`), so no CORS dance in dev
- Playwright uses 8011/5174 with `DATA_DIR=./data/e2e-<port>` and `reuseExistingServer: false`; scenario specs use 8012+/5175+

### Reasoning effort
`off / low / medium / high`. `off` is sent as `{"enabled": false}`; a model whose catalog entry says `mandatory: true` has no `off` in `efforts`, so the UI hides it and `reasoning.build` coerces (`slot_start.effort_coerced`, a "(coerced)" badge). Effort options come from `GET /api/models`, not a hardcoded table; `PUT slot_config` rejects an unsupported effort only for a model the catalog knows.

### Usage / cost
OpenRouter always includes `usage` (with `cost`) in the final streaming chunk — `usage: {include: true}` is deprecated and must not be sent. Missing `cost` → `/generation` lookup (live) → catalog price × tokens; no usage chunk at all → an estimate flagged `usage=estimated` in the log line. The process-level total is enforced in `llm/client.py` (`spent >= SESSION_COST_CAP_USD` refuses every live call with `cost_cap_exceeded`; never in mock mode) and read back at `GET /api/session/cost`; the UI keys its persistent warning on that code.

### Mock mode
`MOCK_OPENROUTER=1 MOCK_SCENARIO=<name>` replays `backend/llm/fixtures/scenarios/<name>/<role>.<purpose>.<n>.jsonl` (raw OpenRouter chunks, 14 committed scenarios listed in `docs/fixtures.md`) through the real parser; the whole test suite runs offline with outbound HTTP blocked by `respx`. Live traffic can be teed into the same format with `MOCK_RECORD_DIR`.

### Prompt injection guards
Model- and web-authored text only ever enters a prompt inside `prompts.delimited()` blocks behind `QUOTED_DATA_NOTICE`, with `<<<` neutralised; peer claims are additionally `anon.scrub`bed. The `injection` scenario proves a planted instruction stays inside its delimiters in every analyst and challenge payload.

### Frozen files and ownership
Shared files (`backend/{schemas,config,main,sse,api_errors}.py`, every `__init__.py`, `pyproject.toml`, `uv.lock`, `frontend/{package.json,package-lock.json,vite.config.js,index.html,playwright.config.js}`, `frontend/src/{App.jsx,main.jsx,index.css,App.css,test-setup.js,smoke.test.jsx}`, `frontend/src/{state,api}/*`, `tests/{conftest,helpers}.py` and the Stage-0 `tests/test_*.py`, `docs/*.md`, `scripts/check_freeze.sh`, `start.sh`, `README.md`, `PLAN.md`, `CLAUDE.md`) are frozen after Stage 0. Every other path has exactly one owner per stage (feature module / router / prompts / pane / slice / CSS module / `tests/<area>/`). A workstream that needs a change requests it (`frozen_change_requests`) and the integrator lands it on `main`; `scripts/check_freeze.sh <branch> <owned-prefix>... ['!<excluded>']` enforces this before every merge.

## Common Gotchas

1. **Module Import Errors**: always `uv run python -m backend.main` from the repo root
2. **settings() at import**: never; environment is read per call so tests can set `DATA_DIR` / `MOCK_*` first
3. **`DEFAULT_SLOT_CONFIG` identity**: pydantic keeps instances by identity — never alias it; copy (`settings().default_slot_config`, `model_copy(deep=True)`)
4. **`usage.include`**: deprecated on OpenRouter — usage arrives anyway in the last chunk
5. **`reasoning.effort: "none"`**: rejected by Claude; use `{"enabled": false}`, and only at effort ≤ high
6. **SSE comments**: OpenRouter sends `: OPENROUTER PROCESSING` keep-alives; never `JSON.parse` a line starting with `:`
7. **Mid-stream errors** arrive as a `data:` chunk with a top-level `error` under HTTP 200 — possibly as the only event
8. **Busy guard**: enter it LAST (after every 404/409/422 check) and release it in the producer task's `finally`, never from the generator; a guard that entered as a re-entrant no-op exits as a no-op
9. **asyncio.Lock and loops**: a lock that once had waiters is bound to its loop — `locking.lock_for` re-creates locks per running loop; create `httpx.AsyncClient` per call
10. **Empty assistant content**: providers reject it — never echo a blank model reply back as an assistant turn on a retry (client and Analyze both apply the rule)
11. **Continue streams use feature key `'send'`** in the frontend, and `analyze_*` events arrive on the `'fusion'` stream during auto-run; slices must not key on `a.feature` alone
12. **Sticky-last fixtures**: a scenario counter past the last file re-serves it; a missing role/purpose file is a `mock_miss` error, not a hang — `stalemate` deliberately has no convergence file
13. **Recorded directories** hold `requests.jsonl` and `recorded/` that must be deleted before shipping under `backend/llm/fixtures/scenarios/` (the corpus validator allows only `<role>.<purpose>.<n>.jsonl` + `README.md`)
14. **Playwright scenario is fixed per server start**: scenario-gated specs skip on the default run; run them on their own ports, one scenario per invocation
15. **Worktrees**: agents start from a fresh checkout — run `uv sync --frozen` and `npm ci` first; never `uv add` / `npm install <pkg>`; do not start servers in a worktree (test through the ASGI client / vitest)

## Future Enhancement Ideas

- Stage 4 (live): run `tests/live` and the two scripts against real OpenRouter, record a real scenario with `record_fixtures.py`, verify the grounded-citation and cost-cap ACs marked pending in PLAN.md
- Phase 6 (out of scope for the first build): embedding-based agreement score per divergence via local Ollama `nomic-embed-text`, a ~15-question GNC eval set, and a Self-MoA comparison script
- SQLite when JSON-on-disk hurts; export a conversation (threads + reports) to markdown

## Testing Notes

- `uv run pytest -q` — 1102 offline tests (unit, feature, `tests/e2e` HTTP flows over every scenario, syrupy goldens in `tests/e2e/__snapshots__`, hypothesis fuzz, leak sweep, cost-meter truth, the scripts driven in-process against `respx`); `-m 'not live'` is the default `addopts`, outbound HTTP is blocked by the shared conftest; regenerate goldens deliberately with `uv run pytest tests/e2e/test_golden.py --snapshot-update`
- `uv run pytest -m live -rs tests/live` — nine budgeted live checks (needs `OPENROUTER_API_KEY` in `.env`; skipped without it; never in CI; cumulative cost asserted < $0.50; honours `MOCK_RECORD_DIR`)
- `cd frontend && npm test` (vitest, 255 tests) and `npm run build`
- `cd frontend && npx playwright test` — default run (`MOCK_SCENARIO=planted_factual`, ports 8011/5174): `smoke`, `flow`, `settings`, `persistence`, `guard`; scenario-gated runs, one per invocation on their own ports: `MOCK_SCENARIO=stalemate BACKEND_PORT=8012 VITE_PORT=5175 npx playwright test e2e/stalemate.spec.js`, then `standing_at_cap` 8013/5176 `cap`, `analyst_degrade` 8014/5177 `degrade`, `truncated` 8015/5178 `truncated`, `grounded` 8016/5179 `grounded`, and `MOCK_DELAY_MS=200 BACKEND_PORT=8017 VITE_PORT=5180 npx playwright test e2e/guard.spec.js` for a paced trace; screenshots land in `docs/screenshots/`
- `MOCK_OPENROUTER=1 MOCK_SCENARIO=planted_factual MOCK_DELAY_MS=20 ./start.sh` — offline demo (backend :8001, Vite :5173); `./start.sh` alone runs live
- `uv run python scripts/live_smoke.py [--record DIR] [--budget-usd 0.5] [--allow-mock]` — catalog, one call per slot at the configured effort, an analyst `Extraction`, one grounded call; refuses without a key or under `MOCK_OPENROUTER=1` unless `--allow-mock`; exit 0/1/2/3 = ok / check failed / refused / budget hit
- `uv run python scripts/record_fixtures.py --scenario <name> [--fixtures-dir data/recordings] [--grounded] [--max-iterations N] [--budget-usd 2]` — records a live Send → Analyze → Fusion through the ASGI app with the fixed anon map into `<fixtures-dir>/scenarios/<name>` and writes a README skeleton; refuses a directory that already holds fixtures; replay with `MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR=data/recordings MOCK_SCENARIO=<name> ./start.sh`
- `scripts/check_freeze.sh <branch> <owned-prefix>...` — the integrator's pre-merge ownership gate

## Data Flow Summary

```
User prompt
    ↓
SEND: per-slot history + prompt → 3 parallel OpenRouter streams → 3 live columns
      each slot's [user, assistant] appended to ITS thread at slot_done; turn persisted before turn_done
    ↓  (on demand; cached per send turn unless forced)
ANALYZE: latest send turn, labelled R1/R2/R3 → analyst (strict JSON, one retry) → {agreements, divergences} | degraded
    ↓  (on demand, max_iterations from the stepper; auto-runs Analyze when none is ok)
FUSION: for each standing divergence, every label with a position is challenged in its own thread
        → defend | revise (flagged if unjustified) → analyst convergence check (only after a revise)
        → exit: converged | stalemate | max_iterations | error   (standing items reported with both sides)
    ↓
Footer meter: tokens / $ / latency per feature (last invocation + this conversation, Fusion ×N vs Send);
threads + turns persisted as JSON per conversation; GET /api/session/cost tracks the live cap
```

The Send path is fully parallel and streams token by token; Analyze and Fusion are overlays that never run unless asked.
