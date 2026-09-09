# Triplex API contract

> FROZEN CONTRACT (contract-v1). Binding for every workstream. Changes go through the integrator via `frozen_change_requests`; never edit in a feature branch.

The wire format (HTTP + SSE), the shared types in `backend/schemas.py`, the config surface, the cross-workstream function signatures (stubbed in Stage 0), and the frontend state contract.

### `docs/api-contract.md` — HTTP + SSE

All feature endpoints stream SSE over POST (`text/event-stream`, one JSON object per `data:`
line, `type` inside, `X-Accel-Buffering: no`).

**Pre-stream failures** are plain JSON with an HTTP status in FastAPI's envelope
`{"detail": {"error": "<code>", ...extra}}`, always raised through `backend/api_errors.py`:
`not_found()` (404, `what`), `conflict("busy")`, `conflict("incomplete_send_turn", missing=[...])`,
`conflict("nothing_to_fuse")`, `conflict("analyze_degraded")`, `conflict("no_send_turn")`,
`unprocessable("<code>", ...)` (422; codes in use: `empty_prompt`, `not_a_send_turn`,
`not_an_analyze_turn`, `unsupported_effort`, `invalid_max_iterations`). Tests assert `r.status_code` and
`r.json()["detail"]["error"]`; FastAPI's own request-body validation keeps its default
`{"detail": [...]}` list (the frontend renders it as `code: "validation_error"`).

**Rule:** a feature generator performs EVERY pre-check (store.load → 404, entering `busy_guard`
→ 409 busy, argument checks → 409/422) BEFORE its first `yield`; routers
`return await sse.sse_response(gen)`, which awaits that first event so those HTTPExceptions
become the JSON errors above. After the first event nothing can change the HTTP status: a
failure is emitted as the terminal `error{message}` event and the generator returns.
`error{message}` is always the last event when emitted; exactly one of `slot_done`/`slot_error`
per slot per turn. Clients refetch `GET /api/conversations/{id}` after `turn_done`,
`analyze_done`, `fusion_done`.

- `GET /api/conversations` → 200 `list[ConversationSummary]`, newest `updated_at` first.
- `POST /api/conversations` body `{title?: str, slot_config?: SlotConfig}` (empty `{}` allowed:
  title "New conversation", `settings().default_slot_config`) → 201 `ConversationPublic`.
- `GET /api/conversations/{id}` → 200 `ConversationPublic`. Ids are uuid4 strings; a non-uuid
  or unknown id → 404 `{detail:{error:"not_found", what:"conversation"}}` (never a path).
- `DELETE /api/conversations/{id}` → 204 empty (404 if missing).
- `PATCH /api/conversations/{id}/title` body `{title: str}` (1..200 chars, else 422) → 200
  `ConversationPublic`.
- `GET /api/conversations/{id}/slot_config` → 200 `SlotConfig`. `PUT …/slot_config` body = a
  full `SlotConfig` → 200 the stored `SlotConfig` (NOT the conversation). 422
  `{detail:{error:"unsupported_effort", slot, model, effort, supported:[...]}}` only when
  `catalog.get_meta(model)` is not None and `effort ∉ meta.efforts`; W2 imports lazily
  (`from ..llm import catalog` inside the handler) so tests can
  `monkeypatch.setattr("backend.llm.catalog.get_meta", ...)`.
- `GET /api/models` → 200 bare JSON array of `ModelMeta` (offline fixture in mock mode).
- `GET /api/session/cost` → 200 `{spent_usd, cap_usd, remaining_usd, exceeded, enforced}` =
  `backend.llm.metering.session_cost_status()` (process-level, not per conversation; `enforced`
  is false in mock mode). Owner: integrator (`backend/routers/session.py`).
- Request bodies: `POST …/send {prompt: str}` (blank → 422 `{detail:{error:"empty_prompt"}}` via
  `unprocessable("empty_prompt")`); `POST …/slots/{slot}/continue {prompt}` — the router declares
  `slot: str` and raises `api_errors.not_found("slot")` when `slot not in SLOT_IDS` (a `SlotId`
  Literal path param would produce a 422 validation array instead);
  `POST …/analyze {of_turn?: str, force?: bool=false}`;
  `POST …/fusion {of_analyze?: str, max_iterations: int}` (required, 1..5; pydantic 422 otherwise).
- `POST …/send {prompt}`, `POST …/slots/{slot}/continue {prompt}` (`turn_start.feature` is
  `"send"` or `"continue"`; `slots` is `["claude","chatgpt","grok"]` for send and `[<slot>]` for
  continue; the client uses the `runStream` feature key `"send"` for both and the meter books
  continue calls under the Send row) →
  `turn_start{turn_id, feature, slots}`, `slot_start{slot, model, effort, effort_coerced}`,
  `slot_delta{slot, text}`, `slot_reasoning{slot, text}`, `slot_citations{slot, items}`,
  `slot_done{slot, usage, finish_reason, truncated}`, `slot_error{slot, code, error_type, message,
  partial}`, `turn_done{turn_id, usage}`, `error{message}`.
- `POST …/analyze {of_turn?, force?}` → `analyze_start{turn_id, of_turn}`,
  `analyze_retry{error}`, `analyze_done{turn, cached}` | `analyze_degraded{turn}`.
- `POST …/fusion {of_analyze?, max_iterations (required, 1..5)}` → (if Analyze must be auto-run:
  the full `analyze_*` sequence first) `fusion_start{turn_id, of_analyze, max_iterations,
  standing}`, `round_start{round}`, `exchange{round, …Exchange}`, `round_done{round,
  post_round_status, changed}`, `fusion_done{turn, exit_reason, usage}` (`usage` = `turn.usage`,
  a FeatureUsage). `fusion_done` is emitted for EVERY persisted FusionTurn, including
  `exit_reason:"error"`. On the auto-run path the stream may instead end after `analyze_done` /
  `analyze_degraded` with the terminal `error{message:"nothing_to_fuse"|"analyze_degraded"}` (no
  fusion turn persisted); the fusion pane treats these as normal, non-crash end states.


### `backend/schemas.py` (pydantic v2, `SCHEMA_VERSION = 1`)

- `SlotId = Literal["claude","chatgpt","grok"]`; `Label = Literal["R1","R2","R3"]`;
  `Effort = Literal["off","low","medium","high"]`; `Materiality = Literal["high","medium","low"]`,
  `MATERIALITY_RANK = {"low":0,"medium":1,"high":2}`.
- `SlotSpec{model, effort}`; `SlotConfig{slots: dict[SlotId,SlotSpec], analyst_model,
  max_iterations:int=2 (1..5), materiality_min: Materiality="medium", grounded:bool=False}`.
- `ThreadMessage{role:"user"|"assistant", content, kind:"chat"|"fusion_challenge"|"fusion_reply",
  turn_id:str, ts, meta: dict|None}` (`meta={divergence_id, round}` for fusion messages);
  `to_openai(msg) -> {role, content}`.
- `Usage{prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, latency_ms, model, role,
  purpose, generation_id|None}`; `UsageTotals{prompt_tokens, completion_tokens, reasoning_tokens,
  cost_usd, latency_ms, calls}` (sums; `latency_ms` = feature wall clock);
  `FeatureUsage{calls: list[Usage], totals: UsageTotals}`.
- `Position{model: Label, claim, evidence_cited: str|None}`; `Divergence{id, topic,
  positions: list[Position], materiality}`; `Agreement{topic, statement, models: list[Label]}`;
  `Extraction{agreements, divergences}` (analyst response schema, purpose `extraction`).
- `DefenseReply{stance:"defend"|"revise", justification, revised_claim: str|None,
  confidence: float (0..1), persuaded_by: str|None}` (model-facing, purpose `defense`).
- `ConvergenceCheck{statuses: list[RoundStatus]}` (analyst response schema, purpose `convergence`).
- `Exchange{divergence_id, model: Label, stance:"defend"|"revise"|"unavailable", justification,
  revised_claim, confidence, persuaded_by, flagged_unjustified: bool, error: str|None}`;
  `RoundStatus{divergence_id, status:"resolved"|"resolved_unjustified"|"standing"}`;
  `FusionRound{round, exchanges, post_round_status, changed}`.
- Turns (all have `id: str` uuid4 minted by the feature *before* its first SSE event, `ts` ISO
  UTC `Z`, `slot_config` as-run stamp, `usage: FeatureUsage`):
  `SendTurn{type:"send", prompt, responses: dict[SlotId, str|None], errors: dict[SlotId,str],
  partial: dict[SlotId,str], reasoning: dict[SlotId,str], citations: dict[SlotId,list[dict]],
  truncated: dict[SlotId,bool], effort_applied: dict[SlotId,Effort]}`; `ContinueTurn{type:"continue",
  slot, prompt, response: str|None, error: str|None, reasoning: str|None, citations: list[dict],
  truncated: bool, effort_applied: Effort|None}`; `AnalyzeTurn{type:"analyze", of_turn: str, extraction: Extraction|None,
  status:"ok"|"degraded", error: str|None, raw_attempts: list[str]}`; `FusionTurn{type:"fusion",
  of_analyze: str, max_iterations, standing: list[str], rounds: list[FusionRound],
  final: list[RoundStatus], exit_reason:"converged"|"stalemate"|"max_iterations"|"error"}`;
  `Turn = Annotated[Union[...], Field(discriminator="type")]`. `of_turn`/`of_analyze` are turn
  ids, never indexes. `store.append_turn` never assigns ids and rejects duplicates.
- `Conversation{schema_version, id, title, created_at, updated_at, slot_config, threads:
  dict[SlotId, list[ThreadMessage]], turns: list[Turn], anon_map: dict[Label, SlotId]}`;
  `ConversationPublic` = same minus `anon_map`; `to_public(conv)`; `ConversationSummary{id,
  title, created_at, updated_at, turn_count}`; `new_anon_map(rng=None)` (shuffled permutation,
  stamped by `store.create` in LIVE mode; mock mode stamps `store.MOCK_ANON_MAP`; never re-derived).
- `Delta{kind:"text"|"reasoning"|"citations"|"done"|"error", text, items, usage, finish_reason,
  truncated, generation_id, code, message, error_type}`.
- `ModelMeta{id, name, vendor, context_length, price_prompt, price_completion (USD/token),
  efforts: list[Effort], mandatory_reasoning: bool, structured_outputs: bool, raw: dict}` with
  the rule: `off ∈ efforts` iff reasoning meta present and not mandatory; `low/medium/high ∈
  efforts` iff `supported_efforts` is null or contains the name; no reasoning meta → `["off"]`.
- Helpers: `strict_json_schema(model_cls) -> dict` (recursive `additionalProperties:false`, all
  properties required, `$defs` kept); `is_unjustified(reply: DefenseReply, peer_claims:
  list[str]) -> bool` := `stance=="revise" and (revised_claim is None or
  len(justification.strip()) < 80 or persuaded_by is None or len(persuaded_by.strip()) < 20
  or no ≥6-letter token of justification appears in any peer claim)`.
- `tests/test_schemas.py` (Stage 0): valid/invalid Extraction, FusionRound, Exchange,
  RoundStatus, discriminated Turn round-trip, `to_public` strips `anon_map`,
  `strict_json_schema(Extraction)` has no object without `additionalProperties:false`,
  `is_unjustified` truth table.


### `backend/config.py` (frozen; everything read at call time via `settings()`, never at import)

`OPENROUTER_API_KEY, OPENROUTER_BASE_URL, HTTP_REFERER, APP_TITLE="Triplex", DATA_DIR
(absolute; default <repo>/data), HOST=127.0.0.1, PORT=8001, MOCK_OPENROUTER, MOCK_SCENARIO,
MOCK_FIXTURES_DIR, MOCK_RECORD_DIR, MOCK_DELAY_MS=0, DEFAULT_SLOT_CONFIG, MAX_ITERATIONS_CAP=5,
MAX_TOKENS_STAGE={send:8000, continue:8000, extraction:4000, defense:2000, convergence:1000},
SESSION_COST_CAP_USD (default 10; live calls refused once exceeded), REQUEST_TIMEOUT_S=300,
CATALOG_TTL_S=86400, GROUNDED_ENGINE=None, GROUNDED_MAX_RESULTS=5, LOG_LEVEL,
FORBIDDEN_IDENTITY_STRINGS` (vendor/product names + slot ids, matched case-insensitively on word
boundaries) and `FORBIDDEN_MODEL_CODENAMES` (`luna`, `sol`, `astra`: matched only in slug context,
i.e. preceded by `-`). `settings().default_slot_config` is a fresh `DEFAULT_SLOT_CONFIG` copy with
`.env` overrides `SLOT_<CLAUDE|CHATGPT|GROK>_MODEL / _EFFORT`, `ANALYST_MODEL`,
`FUSION_MAX_ITERATIONS`, `MATERIALITY_MIN`, `GROUNDED_DEFAULT` (spec R2). Feature-private
constants live in the feature module.


### Cross-workstream function signatures (frozen; Stage 0 ships stub modules raising `NotImplementedError` so every worktree imports cleanly; importers import lazily inside handlers and monkeypatch in tests)

```python
# backend/llm/client.py                         (W1 fills)
async def stream_completion(*, role: str, purpose: str, model: str, messages: list[dict],
    effort: Effort | None, max_tokens: int | None, response_format: dict | None = None,
    plugins: list[dict] | None = None) -> AsyncIterator[Delta]
async def complete_json(*, role: str, purpose: str, model: str, messages: list[dict],
    schema_model: type[BaseModel], effort: Effort | None, max_tokens: int | None, retries: int = 1
    ) -> tuple[BaseModel | None, str, FeatureUsage, str | None]   # (parsed, raw_text, usage, error)
# backend/llm/catalog.py                        (W1)
async def get_catalog(*, force_refresh: bool = False) -> list[ModelMeta]
def get_meta(model: str) -> ModelMeta | None        # from cache / offline fixture; None if unknown
# backend/llm/reasoning.py                      (W1)
def build(effort: Effort | None, meta: ModelMeta | None) -> tuple[dict | None, Effort, bool]  # (reasoning, applied, coerced)
# backend/llm/stream.py                         (W1)
def parse_sse_lines(lines: Iterable[str]) -> Iterator[Delta]
# backend/store/conversations.py                (W2)
async def create(slot_config: SlotConfig | None = None, title: str | None = None,
                 *, anon_map: dict[Label, SlotId] | None = None) -> Conversation
    # anon_map (tests only) stamped verbatim; else MOCK_ANON_MAP in mock mode, new_anon_map() live
async def load(conv_id: str) -> Conversation | None
async def list_summaries() -> list[ConversationSummary]
async def delete(conv_id: str) -> bool                       # False when missing (router -> 404)
async def rename(conv_id: str, title: str) -> Conversation      # raises api_errors.not_found() when missing
async def update_slot_config(conv_id: str, cfg: SlotConfig) -> Conversation  # replaces the object; not_found() when missing
async def append_to_thread(conv_id, slot: SlotId, msgs: list[ThreadMessage]) -> None   # atomic batch
async def append_turn(conv_id, turn: Turn) -> None
def busy_guard(conv_id) -> AsyncContextManager   # second feature call on same conv → 409 busy
# backend/anon.py                               (W3)
def labels(conv) -> dict[Label, SlotId]; def label_of(conv, slot) -> Label; def slot_of(conv, label) -> SlotId
def render_peer_block(peers: list[PeerState], exclude: Label) -> str   # PeerState{label, claim, justification|None} in schemas
def scrub(text) -> str; def find_leaks(text) -> list[str]
# backend/features/send.py                      (W4)
async def run_send(conv_id, prompt) -> AsyncIterator[dict]; async def run_continue(conv_id, slot, prompt) -> AsyncIterator[dict]
# backend/features/analyze.py                   (W5)
async def run_analyze(conv_id, *, of_turn: str | None = None, force: bool = False) -> AsyncIterator[dict]
# backend/features/fusion.py                    (W6)
async def run_fusion(conv_id, *, of_analyze: str | None, max_iterations: int) -> AsyncIterator[dict]
```
Feature generators yield the SSE event dicts below; routers `return await sse.sse_response(gen)`
(never a bare `StreamingResponse`). Every pre-check runs before the first yield; `busy_guard` is
entered LAST, after every 404/409/422 check.


### Frontend contract (`src/state`, `src/api` — frozen W8 code; this text matches it verbatim)

**Core slices** (`state/reducers.js`): `conversation` (ConversationPublic exactly as GET returns
it, or null), `conversations` (list of ConversationSummary), `slotConfig`, `models`
(`{items, byId, loaded, error}`), `streams` (`streams.<feature> = {status: 'idle'|'streaming'|
'done'|'error'|'aborted', error, httpStatus}` for `send`, `analyze`, `fusion` — disable buttons on
`streaming`). **Feature slices** registered from `features/<x>/index.jsx` at module scope via
`registerSlice(key, reducer, initial)`: `slots` (W9), `analyze` (W10), `fusion` (W11), `meter`
(W12). Every slice receives every action (combineReducers semantics); untouched slices keep
identity.

**Actions** (frozen names): `sse/start{feature}`, `sse{feature, event}`,
`sse/end{feature, ok, error?, status?, body?}`, `sse/abort{feature}`,
`conversation/loaded{conversation}`, `conversation/cleared`, `conversation/created{summary}`,
`conversation/deleted{id}`, `conversation/renamed{id, title}`, `conversations/list{items}`,
`slotConfig/loaded{conversationId?, slotConfig}`, `slotConfig/update{patch}`,
`models/loaded{items}`, `models/error{error}`, `@@slice/registered`.

**Streams** (`api/runStream.js`): `runStream(dispatch, feature, url, body, {onEvent?})` or
`const run = useRunStream(); run(feature, url, body, opts)`; `abortStream(feature)`. It checks
`response.ok` first (non-ok → `sse/end{ok:false, status, body}` + throws `ApiError{status, code,
message}`), reads the buffered SSE stream (`decode(value,{stream:true})`, `\n\n` framing, `:`
comment lines skipped, `[DONE]` swallowed, AbortController) and dispatches every event verbatim
as `{type:'sse', feature, event}`; a terminal `error` event ends with `sse/end{ok:false}`.
`analyze_*` events are routed to the `analyze` slice regardless of which feature opened the
stream (Fusion's auto-run). Continue streams use `feature: 'send'`.

**HTTP** (`api/http.js`): `api.*` primitives plus dispatching loaders — `loadConversations(dispatch)`,
`loadConversation(dispatch, id)`, `createConversation(dispatch, body?)`, `deleteConversation(dispatch,
id)`, `renameConversation(dispatch, id, title)`, `loadModels(dispatch)`, `saveSlotConfig(dispatch,
conversationId, patch, current)` (optimistic `slotConfig/update`, PUT of the merged full config,
`slotConfig/loaded` with the server copy; reloads on failure). `ApiError.code` is `detail.error`
or `'validation_error'` for FastAPI validation arrays. Panes that load on mount must swallow
rejections (`loadModels(dispatch).catch(() => {})`) — the frozen smoke test renders `<App/>`
under Node's fetch, where a relative URL rejects. The pane that opened a stream calls
`loadConversation(dispatch, id)` once after `runStream` resolves; W9 also calls
`loadConversations(dispatch)` after the first send of a conversation resolves (the backend
auto-titles it), and the sidebar (W12) renders `state.conversation.title` for the selected row.

**Derived rules for panes:** latest send turn = last element of `conversation.turns` with
`type === 'send'`; it is complete when every slot in `responses` is non-null (Analyze button
rule). Fusion button enabled when the latest send turn is complete and no ok `analyze` turn for it
has an empty `standing` set (materiality rank ≥ the current `slotConfig.materiality_min`,
`RANK = {low:0, medium:1, high:2}` duplicated locally) — when no ok analyze exists the stream
auto-runs Analyze first and the pane renders the `analyze_*` prefix; disabled while any stream
is `streaming`; iterations stepper default =
`slotConfig.max_iterations`, range 1..5. Per-column model dropdown = `models.items.filter(m =>
m.vendor === SLOT_VENDORS[slot])` plus the currently configured slug if absent, with
`SLOT_VENDORS = {claude:'anthropic', chatgpt:'openai', grok:'x-ai'}` duplicated inside
`features/send`; effort options = `models.byId[model]?.efforts ?? ['off','low','medium','high']`
(a mandatory-reasoning model simply lacks `'off'`). Main composer with no conversation:
`await createConversation(dispatch, {})` then send. `slots.<slot>` (W9) holds `{buffer,
reasoning, citations, status, usage, truncated, error}` and the column renders the persisted
thread (kind-styled) plus the live buffer; after refetch it shows the persisted per-slot
`reasoning/citations/truncated/effort_applied` from the turn.

**Test helpers** (`state/testing.jsx`): `applyEvents(feature, events, {state?, preloaded?})`
(events without a frozen action name are wrapped as `{type:'sse', feature, event}`),
`renderWithStore(ui, {preloaded?})`, `sample.{turnStart, slotStart, slotDelta, slotDone,
slotError, turnDone}`. Pane tests stub `fetch` with `vi.stubGlobal` or preload the store.
`package.json`: `"test": "vitest run --passWithNoTests"`, `"test:e2e": "playwright test"`;
vitest `environment: jsdom`, `setupFiles: src/test-setup.js`; deps `@testing-library/{react,
jest-dom,user-event}`, `jsdom`, `@playwright/test`, `react-markdown`, `remark-gfm`.


## Addendum (contract-v1 review)

### LLM layer (`backend/llm`, W1)

- `stream_completion` **never raises**. Order: zero or more `text | reasoning | citations`
  deltas, then exactly one terminal delta and nothing after it — `done` (always with
  `usage: Usage`, synthesised from catalog price × tokens with `cost_usd` when the usage chunk is
  missing; `finish_reason`; `truncated = finish_reason == "length"`; `generation_id`) or
  `error{code, message, error_type}` (HTTP-level failures, httpx/timeout errors, mock_miss and
  the cost cap all take this form; `usage` is None). `reasoning` deltas are incremental
  fragments. `citations` deltas carry `items` = the OpenRouter annotation objects passed through
  VERBATIM (`[{"type":"url_citation","url_citation":{"url","title","content"?,"start_index"?,
  "end_index"?}}]`), de-duplicated by `url_citation.url`, emitted once per chunk that carries
  annotations; the UI reads `item.url_citation.url/title`.
- Slot error codes minted by Send/continue themselves: `empty_reply` (error_type `triplex`; a
  `done` with empty/whitespace text — nothing appended) and `internal_error`; transport codes
  (`cost_cap_exceeded`, `mock_miss`, HTTP codes) pass through. Fusion's `exchange{…error}` and
  its terminal `error{message}` are scrubbed (`[model]`) before they are emitted or persisted.
- Cost cap: when `settings().mock_openrouter` is false and the session total would exceed
  `SESSION_COST_CAP_USD`, the transport yields a single `Delta(kind="error",
  code="cost_cap_exceeded", error_type="triplex", message=…)`; Send/continue map it to
  `slot_error{code:"cost_cap_exceeded"}`, `complete_json` returns `error="cost_cap_exceeded"`;
  the UI shows a persistent warning when any event carries that code.
- `complete_json(retries=N)` makes at most N+1 attempts; a retry happens only on
  lenient-parse/pydantic failure — never on a transport/`error` delta, which returns immediately
  as `(None, "", usage, message)` — and appends `{"role":"assistant","content":<raw>}` +
  `{"role":"user","content":"Your previous output failed validation: <error>. Return only the
  corrected JSON."}`. Returns `parsed` (schema_model instance or None), `raw_text` (last
  attempt's concatenated text), `usage` (one `Usage` per attempt), `error` (`str(ValidationError)`,
  parse message or transport message; None on success). `retries=0` disables the internal retry.
- `effort=None` → omit `reasoning`, applied `"off"`, coerced False; features always pass the
  configured Effort. `reasoning.build`: if no lower supported effort exists, use the lowest
  supported one (`coerced=True`); for a mandatory-reasoning model asked for `off`, applied = the
  lowest name in `meta.efforts`, `coerced=True`, reasoning omitted so the provider default runs;
  `slot_start.effort` reports the applied value.
- Create the `httpx.AsyncClient` per call (or lazily per running loop): pytest-asyncio gives
  every test a fresh event loop, so a module-level client raises "Event loop is closed".
- `ModelMeta.vendor` = the slug prefix before the first `/` (`anthropic`, `openai`, `x-ai`, …),
  never OpenRouter's display name; `name` = OpenRouter `name`. `schemas.SLOT_VENDORS` maps
  slots to vendors. `llm/fixtures/models.json` must contain at least the eight distinct slugs in
  `docs/decisions.md` (three defaults, the analyst, two flagships, two budget) with their verified
  `reasoning` blocks and `supported_parameters`.
- Transport tests (W1) that exercise the real httpx path offline do `monkeypatch.setenv(
  "MOCK_OPENROUTER", "0"); monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")` inside the
  test and then use `respx.mock` / `@respx.mock` normally — routers nest under the autouse blocker.

### Store (`backend/store`, W2)

- `create(slot_config=None, title=None, *, anon_map=None)`: `anon_map` (tests only) is validated
  as a permutation of SLOT_IDS and stamped verbatim; otherwise `MOCK_ANON_MAP =
  {"R1":"claude","R2":"chatgpt","R3":"grok"}` when `settings().mock_openrouter`, else
  `new_anon_map()`. `delete -> bool` (False when missing); `rename` / `update_slot_config ->
  Conversation` (raise `api_errors.not_found()` when missing). `update_slot_config` replaces the
  object; nothing mutates a SlotConfig in place; every turn stamps
  `conv.slot_config.model_copy(deep=True)`.
- No process-level cache of documents or the index; every call resolves `settings().data_dir`
  afresh. `busy_guard` semantics are in its docstring (feature enters before first yield,
  producer task releases in `finally`, re-entrant per task via a ContextVar).

### Mock capture (`backend/llm/mock.py`)

`mock.calls` records every transport call in order (`{role, purpose, model, messages, reasoning,
response_format, plugins, max_tokens, fixture}` — dicts, so `mock.calls[i]["fixture"]`);
`mock.reset()` clears counters and calls.
`MOCK_SCENARIO` and `MOCK_FIXTURES_DIR` are read from `settings()` on every lookup; tests switch
scenario with `monkeypatch.setenv("MOCK_SCENARIO", "stalemate")`.
