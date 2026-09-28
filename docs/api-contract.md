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
  title "New conversation", `settings().default_slot_config`) → 201 `ConversationPublic`. Since
  2026-09-27: a given `slot_config` is validated first (the same 422s as the PUT below) and an omitted one
  is the session default the desktop pushed, else `settings().default_slot_config` — Council addendum.
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
  `"send"` or `"continue"`; `slots` is the conversation's council for send — `["claude","chatgpt","grok"]`
  for the classic three, 2..5 members since 2026-09-27 (Council addendum) — and `[<slot>]` for
  continue; the client uses the `runStream` feature key `"send"` for both and the meter books
  continue calls under the Send row) →
  `turn_start{turn_id, feature, slots}`, `slot_start{slot, model, effort, effort_coerced}`,
  `slot_delta{slot, text}`, `slot_reasoning{slot, text}`, `slot_citations{slot, items}`,
  `slot_done{slot, usage, finish_reason, truncated}`, `slot_error{slot, code, error_type, message,
  partial}`, `turn_done{turn_id, usage}`, `error{message}`.
- `POST …/refactor {of_turn?, force?}` → `refactor_start{turn_id, of_turn}`,
  `refactor_retry{error}`, `refactor_done{turn, cached}` | `refactor_degraded{turn}`. Added at S11.
  Same pre-checks, same cache-per-send-turn and the same busy guard as Analyze. `refactor_retry` is
  PROGRESS, not a failed attempt: one per analyst call (the map call, then one per label, plus one
  when a reply has to be quoted in pieces), which is why the pane shows it as a status line.
- `POST …/preparse {prompt}` → `preparse_start{}`, `preparse_retry{error}`,
  `preparse_done{prompt, original, question, usage}` | `preparse_degraded{error, original,
  raw_attempts, usage}`. Added 2026-09-23 (Pre-parse). A PREVIEW for the desktop prompt bar: one
  analyst call restates the question clearly and succinctly (`prompts/preparse.py`), then the
  deterministic answer-format block is appended LAST (`compose`) and the result replaces the
  composer text for the user to review, edit and Send — Send itself is unchanged and still
  verbatim. Pre-stream errors in order: 404 `not_found/conversation`, 422 `empty_prompt` (blank, or
  nothing but the answer block), 422 `prompt_too_long{chars, max}` (over `CONDENSE_CHUNK_CHARS`, the
  measured single-message bound — never truncated), 409 `busy` LAST. Nothing is persisted — no turn,
  no schema change; `preparse_retry` is PROGRESS (one narration per analyst call). Unlike every
  other feature the call runs INLINE in the stream, so a client abort cancels it and frees the
  analyst page (`docs/semantics.md`, "Pre-parse").
- `POST …/analyze {of_turn?, force?}` → `analyze_start{turn_id, of_turn}`,
  `analyze_retry{error}`, `analyze_done{turn, cached}` | `analyze_degraded{turn}`. When an ok
  Refactor turn exists for the send turn, Analyze compares ITS restated question and reduced
  replies instead of the raw ones (`analyze.refactored_input`); a degraded Refactor is ignored.
  `analyze_retry` carries two kinds of `error`: a failed attempt being sent back, and — from
  S10, on a conversation over the size bound — progress: one per label as its reply is condensed
  before the comparison, plus one more when that reply is condensed in pieces. EVERY progress
  narration begins `splitting the analyst prompt` (`analyze.SPLIT_NOTICE_PREFIX`; the chunk
  narration shares the prefix), and that prefix is the one thing a client may key on to tell
  progress from a failed attempt. No new event type was added for the split, so a client that
  ignores the distinction still behaves correctly.
- `POST …/fusion {of_analyze?, max_iterations (required, 1..5)}` → (if Analyze must be auto-run:
  the full `analyze_*` sequence first) `fusion_start{turn_id, of_analyze, max_iterations,
  standing}`, `round_start{round}`, `exchange{round, …Exchange}`, `round_done{round,
  post_round_status, changed}`, `fusion_done{turn, exit_reason, usage}` (`usage` = `turn.usage`,
  a FeatureUsage). `fusion_done` is emitted for EVERY persisted FusionTurn, including
  `exit_reason:"error"`. On the auto-run path the stream may instead end after `analyze_done` /
  `analyze_degraded` with the terminal `error{message:"nothing_to_fuse"|"analyze_degraded"}` (no
  fusion turn persisted); the fusion pane treats these as normal, non-crash end states.
- `POST …/plan {of_fusion?, force?, model?}` → `plan_start{turn_id, of_fusion, model}`,
  `plan_retry{error}`, `plan_done{turn, cached}` | `plan_degraded{turn}`. Added 2026-09-27 (Plan,
  "one agent after Fusion"). ONE call to ONE agent turns a Fusion report into an executable
  procedure (`Plan`: objective, prerequisites, numbered steps with action / why / inputs / outputs /
  verify, a decision point for every divergence left standing or resolved only through unjustified
  revisions, risks, done-when). `model` resolves `body.model` → `slot_config.plan_model` →
  `web:claude` in desktop mode, `anthropic/claude-opus-5.5` otherwise, is stamped on
  `PlanTurn.model` and carried in `plan_start`; the only validation is non-blank (422 `empty_model`)
  — a `web:<site>` pane, `web:<site>:analyst`, `ollama:<name>` or an OpenRouter slug all pass, and
  the transport's own refusal (`missing_api_key`, `not_captured`, a bridge code) is a DEGRADED turn,
  as for Refactor. Pre-stream errors in order: 404 `not_found/conversation` → the fusion turn
  (`of_fusion` omitted → the newest fusion turn, none → 409 `no_fusion_turn`; an unknown id → 404
  `not_found/turn`; another type → 422 `not_a_fusion_turn`) → 422 `empty_model` (a `model` given
  but blank) → 422 `plan_input_too_large{chars, max}`
  when the rendered input exceeds `PLAN_INPUT_MAX_CHARS` (= `analyze.CONDENSE_CHUNK_CHARS`, the
  measured one-message bound; nothing called, nothing persisted, never truncated) → cache: unless
  `force`, the newest ok PlanTurn for that fusion turn replays `plan_start` (with the model that made
  it) + `plan_done{cached:true}`, no guard, no call → 409 `busy` LAST. `plan_retry` is PROGRESS: one
  narration while the agent writes, then — only when the one correction attempt runs (the web
  no-retry rule applies) — a second `plan_retry` whose `error` is the validation error the
  correction message carries. The call is `role="analyst"`,
  `purpose="extraction"` (the frozen `Purpose` literal has no room, as for Refactor and Pre-parse;
  the meter books it under its own `Plan` row); `plan_done` / `plan_degraded` is the last event and
  follows the persisted turn. The whole prompt is ONE user message on every transport, and a
  SUCCESSFUL plan typed into a council member's pane (`web:<slot>`, not `:analyst`) mirrors
  `[plan_request, plan_reply]` into that slot's thread (`docs/semantics.md`, "Plan").


### `backend/schemas.py` (pydantic v2, `SCHEMA_VERSION = 1`)

- `SlotId = Literal["claude","chatgpt","grok"]`; `Label = Literal["R1","R2","R3"]` (widened on
  2026-09-27 to the seven-vendor catalog and `R1..R5`; a conversation seats 2..5 and uses the label
  prefix of its size — Council addendum);
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
- Plan (2026-09-27, append-only; `SCHEMA_VERSION` stays 1 and every earlier document validates
  unchanged): `SlotConfig.plan_model: str|None = None` (a per-conversation default for the plan agent;
  the picker's choice is otherwise per run); `ThreadMessage.kind` += `"plan_request"|"plan_reply"`
  (the exchanges a pane-typed plan mirrors into that site's thread — one pair per attempt,
  `meta={"plan_turn": <turn id>, "attempt": n}`, only when that member is seated on `web:<slot>`);
  `PlanStep{number:int, title, action, why="", inputs=[], outputs=[], verify=""}`,
  `PlanDecision{divergence_id: str|None=None, topic, options=[], recommendation="", rationale=""}`,
  `PlanRisk{risk, mitigation=""}`, `Plan{objective, prerequisites=[], steps=[], decisions=[],
  risks=[], done_when=[]}` (the agent's response schema, purpose `extraction`);
  `PlanTurn{type:"plan", of_fusion: str, model: str, plan: Plan|None, status:"ok"|"degraded",
  error: str|None, raw_attempts: list[str]}`; `Turn` += `PlanTurn`. `of_fusion` is a turn id, never
  an index. `backend/config.py`: `MAX_TOKENS_STAGE["plan"] = 8000`.
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
(W12) — and, later, `refactor` (S11, `features/analyze/index.jsx`), `panes` / `preparse` (desktop,
`features/desktop/index.jsx`) and `plan` (2026-09-27, `features/fusion/index.jsx`; its shape is in
the Plan addendum). Every slice receives every action (combineReducers semantics); untouched slices keep
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


## Desktop addendum (Stage 2+)

`transport_disabled` was minted in `backend/llm/client.py` from the constant in `backend/llm/bridge.py` (the desktop codes live there) until 2026-09-27 — since the Council addendum the guard mints `missing_api_key`, and only while no session key has been pushed; the bridge router's accept INFO line names version/sites/capture/analyst only, never the token.

Additive, written at Stage 0 (tag `S4`) so the Stage 2 `bridge-backend` workstream builds against text
that exists. The wire shapes live in `docs/desktop-contract.md` (§1 bridge protocol, §6 backend keys /
routing / endpoints). Nothing above changes: the OpenRouter and mock paths stay byte-identical, and the
web app never sends the new field.

- **`POST /api/conversations/{id}/send` body gains `slots: list[str] | null` (optional)** — the body is
  `{prompt: str, slots?: list[str] | null}`. Omitted or `null` = all three slots (identical to today's
  run; the conversation's whole council since 2026-09-27, judged against that council — Council addendum); an unknown slot → 404 `{detail:{error:"not_found", what:"slot"}}` via `not_found("slot")`;
  `[]` → 422 `{detail:{error:"empty_slots"}}` via `unprocessable("empty_slots")`; duplicates are
  removed and the list is ordered as `SLOT_IDS` (`claude, chatgpt, grok`). `turn_start.slots` lists the
  subset, exactly one `slot_start` … `slot_done|slot_error` follows per listed slot, and the persisted
  `SendTurn.responses` (and `errors/partial/reasoning/citations/truncated/effort_applied`) holds only
  those slots, so Analyze reports the unlisted ones as `409 incomplete_send_turn{missing:[…]}`.
  Signature: `run_send(conv_id, prompt, *, slots=None)` → `_stream_turn(conv, prompt, "send", slots
  or SLOT_IDS, started)`; `…/slots/{slot}/continue` is unchanged. (`docs/desktop-contract.md` §6.)
- **`slot_error.code` gains the desktop codes**, each with `error_type` `triplex` or `site`.
  `error_type:"triplex"` (minted by `backend/llm/bridge.py`, same shape as `cost_cap_exceeded`):
  `not_captured` (capture is off for that site — the reply stayed in the pane; nothing appended,
  `responses[slot]=None`, message "capture is off for <slot>; the reply is in the site pane"),
  `bridge_unavailable` (no Electron client connected), `bridge_disconnected` (the client dropped or was
  superseded mid-request), `bridge_no_ack` (no `accepted`/`rejected` within `BRIDGE_ACCEPT_TIMEOUT_S`),
  `timeout` (the existing code; no `result` within `timeout_s`, `cancel` sent), `transport_disabled`
  (`TRIPLEX_DESKTOP=1` and the model is neither `web:*` nor `ollama:*`; message asks to choose an
  analyst in the config bar), `bridge_bad_model` (unparseable `web:` slug). `error_type:"site"`
  (reported by Electron about the site view, passed through verbatim with `message` and, when the site
  produced text before failing, `partial`): the `rejected` codes sent before any DOM write —
  `view_busy`, `logged_out`, `challenge`, `blocked`, `analyst_not_chosen`, `unknown_site`,
  `view_crashed` — and the `result ok:false` codes `composer_not_found`, `send_not_found`,
  `not_submitted`, `reply_not_found`, `site_error`, `navigation`, `cancelled`, `adapter_gone`,
  `view_crashed` (and `timeout` from the adapter, also `site`). `complete_json` returns any of these as
  its `error` string exactly as it returns `cost_cap_exceeded` (no retry on a transport delta);
  Fusion marks the exchange `unavailable`; the UI treats every code it does not know as a plain
  failure. `max_tokens`, `response_format`, `plugins` and `reasoning` are ignored by the web transport
  (the site decides), so `slot_start.effort` is `off` for `web:*` models. (§1 delta mapping, §6.)
- **`WS /api/bridge`** (`backend/routers/bridge.py`) — the single Electron client: first frame
  `hello{protocol:1, token, version, sites, capture, analyst}` within 10 s (else close 4004; bad token
  4003; malformed 4001; a second valid hello supersedes with 4002), then `hello_ack{ping_s}`,
  `request` → `accepted|rejected` → `result`, `cancel`, `ping`/`pong`; frames and rules in
  `docs/desktop-contract.md` §1 and `desktop/protocol/bridge-v1.json`. The token never appears in a URL
  or a log line.
- **`GET /api/bridge/status`** → 200 `{connected, protocol, version, since, sites:{<slot>:{capture,
  health, health_ts}}, analyst, inflight}` = `bridge.hub.status()` (§6); the desktop renderer's
  `bridge-banner` keys on `connected`.
- **`GET /app`, `/app/`, `/app/{path}`** (`backend/routers/desktop_app.py`) → the built renderer from
  `TRIPLEX_APP_DIR` (`frontend/dist` built with `VITE_BASE=/app/`): `index.html` for extension-less
  paths, resolved-path containment, 404 for a missing asset and for every path when `TRIPLEX_APP_DIR`
  is unset (§6). Same origin as `/api`, so `main.py` CORS and `http.js` stay frozen.
- **`GET /api/models`** under `TRIPLEX_DESKTOP=1` returns `webmodels.desktop_catalog()` (`web:<slot>`,
  `web:<slot>:analyst` ×3, `ollama:<name>` per `OLLAMA_MODELS`; all `efforts=["off"]`,
  `structured_outputs=False`) instead of the OpenRouter catalog (Stage 3, §6); otherwise byte-identical.

## Export addendum (turn exports)

`GET /api/conversations/{conv_id}/export/{turn_id}?format=md|html` (`backend/routers/export.py`) → 200
`text/markdown; charset=utf-8` or `text/html; charset=utf-8`: ONE self-contained document for that one
turn (`send`, `continue`, `analyze`, `fusion`, `refactor` since S11, `plan` since 2026-09-27 — Plan
addendum), built by the pure `backend/export.py` (`build_document`
→ `render_markdown_doc` / `render_html_doc`, one document model rendered twice so the formats cannot
drift). `format` accepts `md`/`markdown`/`html`/`htm` in any case and defaults to `md`; an unknown value
is 422 `unknown_format`, an unknown conversation or turn is 404 `not_found`. Headers carry a suggested
filename (`Content-Disposition`, `X-Triplex-Export-Filename`, `-Type`, `-Turn`).

There is deliberately NO `pdf` format: the desktop shell prints the PDF from this HTML in an offscreen
window, so the document is authored once. Analyze and Fusion documents keep the R1/R2/R3 labels and are
asserted leak-free; a Send document names the slots, as its columns do on screen.

## Council addendum (2026-09-27 — "a council anyone can assemble", stage 1)

Additive. A conversation now seats a COUNCIL of 2..5 agents from a seven-vendor catalog, each on ONE
transport named by its model string exactly as before (`web:<site>` = a subscription session in the
desktop app, `ollama:<name>` = local, an `<org>/<model>` slug = OpenRouter on one key). Every document,
fixture, golden and prompt pin of the classic three is byte-identical: `SCHEMA_VERSION` stays 1, the
n=3 rendering of every count-aware prompt equals the old constant, and the 14 shipped scenarios are
untouched (`git diff --stat` over `backend/llm/fixtures/scenarios` shows only the two new directories).

**Vocabulary (`backend/schemas.py`, frozen; integrator commit `1fae192`).** `SlotId`/`SLOT_IDS` =
`claude, chatgpt, grok, gemini, deepseek, qwen, mimo` (the classic three FIRST — the order is
load-bearing for subset sends, export meta lines and the mock anon map); `DEFAULT_COUNCIL =
SLOT_IDS[:3]`; `COUNCIL_MIN = 2`, `COUNCIL_MAX = 5`; `SLOT_VENDORS` += `gemini: google, deepseek:
deepseek, qwen: qwen, mimo: xiaomi` (verified against the live OpenRouter `/models` on 2026-09-27:
google 41, deepseek 16, qwen 54, xiaomi 5 models); `Label`/`LABELS` = `R1..R5`. `SlotConfig.slots`'s
validator is `_council_size`: 2..5 keys of the catalog (the key literal rejects an unknown id; the old
rule "all three present" is gone). Helpers: `council_of(cfg) -> tuple[SlotId, ...]` (the config's slots
in CATALOG order, never the dict's key order), `council_labels(council)` = `LABELS[:n]`,
`new_anon_map(rng=None, council=DEFAULT_COUNCIL)`, `empty_threads(council=DEFAULT_COUNCIL)`.
`Conversation.threads`, `anon_map` and the per-slot maps of a `SendTurn` (`responses`, `errors`,
`partial`, `reasoning`, `citations`, `truncated`, `effort_applied`) are keyed by the conversation's
council, not the catalog. A literal v1 three-slot document validates unchanged with `council_of ==
DEFAULT_COUNCIL` (pinned in `tests/test_schemas.py`).

**`backend/config.py` (frozen).** `FORBIDDEN_IDENTITY_STRINGS` += `gemini, deepseek, qwen, mimo,
alibaba, xiaomi` (full words); new `FORBIDDEN_VENDOR_PREFIXES = ("google",)`, matched ONLY as a slug
prefix `google/` — "Google's TPU" in a claim is an ordinary word and must not scrub to `[model]`.
`anon.scrub` rewrites `google/` to `[model]/`; `anon.find_leaks` and `tests/helpers.find_identity_leaks`
report it as `google/`; `frontend/e2e/helpers.js` `IDENTITY_RE` and `features/export/leak.test.jsx`
mirror the additions. `DEFAULT_SLOT_CONFIG` and the `SLOT_<CLAUDE|CHATGPT|GROK>_MODEL/_EFFORT` env
overrides are unchanged (there are no `SLOT_GEMINI_*` keys — the desktop's default council is pushed
per session, below).

**`backend/llm/bridge_protocol.py` (frozen).** `BridgeSlot = Literal["claude","chatgpt","grok"]` and
`BRIDGE_SLOTS`: the bridge's OWN slot vocabulary (the sites with a Stage-1 adapter), decoupled from the
catalog; `AnalystChoice.slot`, `Hello.sites`, `HealthFrame.slot`, `Accepted.slot` and `Request.slot`
are typed `BridgeSlot`. `desktop/protocol/bridge-v1.json` is untouched — `gemini` stays an invalid slot
on the wire until a protocol v2. An OpenRouter or Ollama agent never crosses the bridge.

**New modules.** `backend/vendors.py` (pure): `Vendor(id, name, prefixes, family_words, identity,
web_site, stage2_site, default_model, default_effort="medium")`, `CATALOG` (SLOT_IDS order; the
`deepseek` default effort is `high` because `deepseek/deepseek-v4-pro` lists high/xhigh only), `BY_ID`,
`WEB_SITES == BRIDGE_SLOTS`, `STAGE2_SITES == ("gemini","deepseek","qwen")` (a site, no adapter yet;
`mimo` is token or local only), `display_name(slot)`, `default_slot_spec(slot)` (a fresh `SlotSpec` on
the vendor's default slug: `anthropic/claude-opus-5`, `openai/gpt-5.6-sol`, `x-ai/grok-4.6`,
`google/gemini-3.8-flash`, `deepseek/deepseek-v4-pro`, `qwen/qwen3.7-max`, `xiaomi/mimo-v2.6-pro`),
`vendor_of_model(model_id, name="") -> Vendor | None` (`web:<slot>[:analyst]` → that vendor even
without an adapter; `ollama:<name>` → a family word in the name; a slug → its org prefix, else a family
word on the tail or the display name — what admits community "uncensored" variants under other orgs,
`huihui-ai/qwen3-abliterated` → qwen; `mistralai/mistral-large-2512` → None, the negative control),
`openrouter_filter(models)`, `vendors_of(models)`. `backend/prompts/council.py`: `NUMBER_WORDS`,
`check_council_size(n)` (ValueError outside 2..5, never a clamp), `number_word`, `labels_for`,
`label_list` ("R1, R2, R3"), `label_or_list`, `label_and_list`, `schema_alternatives` (`"R1" | "R2" |
"R3"`), `others(n)` ("two others"; n=2 → "one other"). `backend/llm/session_key.py`: `set_key(key)`
(blank → ValueError), `clear_key()`, `get_key() -> str | None`, `status() -> {configured, prefix,
length}` — `prefix` is `"sk-or-v1-"` only for a key that starts with that public marker and `None` for
any other shape (nine characters of an unknown key would be nine characters of the secret); the key is
never logged. `backend/llm/fixtures/models.json` gains `google/gemini-3.8-flash`,
`deepseek/deepseek-v4-pro`, `qwen/qwen3.7-max`, `xiaomi/mimo-v2.6-pro` and
`mistralai/mistral-large-2512`.

**Endpoints.**
- `POST /api/conversations {title?, slot_config?}`: a given `slot_config` runs `validate_slot_config`
  FIRST (the same 422s as the PUT below, before anything is written); without one the council is the
  session default the desktop pushed (`PUT /api/session/defaults`), else `settings().default_slot_config`.
- `PUT …/slot_config`, in this order after the 404: 422 `{detail:{error:"web_slot_mismatch", slot,
  model}}` for the first slot (council order) whose `web:` model names another slot's site, a site
  without a Stage-1 adapter (`web:gemini`) or is malformed (`web:`, `web:claude:foo`) — `web:<slot>` and
  `web:<slot>:analyst` on the slot's own site both pass (the bridge decides the view); 422
  `unsupported_effort` as before; then `store.update_slot_config`: the same council → REPLACE as
  before; a different council (any change to the key set) → 409 `{detail:{error:"council_changed",
  current:[…], requested:[…]}}` once the conversation is no longer empty (a turn, a thread message) OR
  while a feature call is running on it (`locking.is_busy`; its coordinator holds the council it started
  with); on an empty idle conversation the threads and the anon map are re-stamped for the new council
  (`store.mock_anon_map(council)` in mock mode, `new_anon_map(council=…)` live).
- `POST …/send {prompt, slots?}`: `slots` is judged against the conversation's COUNCIL
  (`resolve_slots(slots, council)`): omitted/`null` → the whole council; an entry the council did not
  seat — an unknown id or a catalog vendor this conversation did not seat (`["gemini"]` on the three)
  → 404 `not_found/slot`; `[]` → 422 `empty_slots`; duplicates dropped, council (= catalog) order.
  `turn_start.slots` lists the council (or the subset). `POST …/slots/{slot}/continue` → 404
  `not_found/slot` for a slot outside the council. One `slot_start … slot_done|slot_error` per member.
- Analyze: `incomplete_send_turn{missing}` is over the turn's OWN council (`missing_responses`); the
  strict `response_format` enum is narrowed to the council's labels (`extraction_schema_for(labels)`,
  passed as `complete_json(response_schema=)` — a three-council payload carries exactly the R1/R2/R3
  enum it always did); an extraction that names a label outside R1..Rn is a validation failure
  (`analyze_retry{error:"validation_error: unknown label(s) ['R4']; only R1, R2, R3 exist"}`, the bad
  output echoed as the assistant turn) that drives the existing correction retry and degrade paths
  (local fixture `label_out_of_council`). `refactored_input(conv, of_turn, labels)`, `oversize_reply`,
  `_condense_all` and `condense_messages(n=)` run over the present labels.
- Fusion: `labels_with_position(div, labels)` is filtered to the council's labels (a label the analyst
  invented has no slot behind it and is never challenged); threads, `per_slot` and
  `convergence_messages(items, n=len(council))` run over `council_of(conv.slot_config)`.
- Pre-parse / Refactor: `restate_messages(question, n=)` ("put to two experts"), `reply_messages(…, n=)`;
  one reply call per label R1..Rn.
- `GET /api/models` under `TRIPLEX_DESKTOP=1`: `webmodels.desktop_catalog()` (`web:<site>` and
  `web:<site>:analyst` for the three sites, `ollama:<name>` per `OLLAMA_MODELS`) and then, ONLY when a
  session key has been pushed, `webmodels.tag_openrouter(openrouter_filter(await catalog.get_catalog(
  force_refresh=…)))` — COPIES of the OpenRouter entries a council row can seat, each with
  `raw.transport == "openrouter"` (`catalog._mem` keeps the untagged objects `get_meta` serves). Without
  a key nothing reaches the network. `raw.transport` ∈ `web | ollama | openrouter`. Outside desktop
  mode byte-identical.
- `GET /api/ollama/models` (`backend/routers/ollama.py`, new) → 200 `{base_url, loopback, models:
  [name, …]}` = `ollama.list_local_models(timeout_s=2.0)`: the names at `<server>/api/tags`, read from
  a LOOPBACK `OLLAMA_BASE_URL` only (`[]` without a request otherwise), never raises, `[]` on any
  failure (no server, timeout, non-2xx, malformed body).
- Session routes (`backend/routers/session.py`; every one below requires `Authorization: Bearer
  <BRIDGE_TOKEN>` through `require_bridge_token`: 403 `bridge_token_unset` when the backend has no
  token, 401 `missing_token` without a Bearer header, 403 `bad_token` on a mismatch —
  `hmac.compare_digest`; `GET /api/session/cost` is unchanged and needs no token):
  `GET|DELETE /api/session/openrouter_key` → 200 `session_key.status()`; `PUT
  /api/session/openrouter_key` — the body is read by hand (`request.json()`, no typed parameter, so no
  validation 422 can echo the value) and anything but `{"key": <non-blank str>}` (a bare string, a
  list, malformed JSON, a blank key) is 422 `empty_key` → 200 `status()`; the key never appears in a
  response body or a log line. `GET /api/session/defaults` → `{slot_config: SlotConfig | null}`; `PUT
  /api/session/defaults {slot_config}` → `validate_slot_config` (the same 422s as a PUT on a
  conversation, at push time) then the in-process default (`session_defaults()`, a fresh copy per
  call) → `{slot_config}`; `DELETE` → `{slot_config: null}`.

**The desktop guard (`backend/llm/client.py`).** Under `TRIPLEX_DESKTOP=1` a model that is neither
`web:` nor `ollama:` is refused BEFORE the cost-cap and key checks ONLY while no session key has been
pushed: `slot_error{code:"missing_api_key", error_type:"triplex", message: DESKTOP_NO_KEY_MESSAGE}`
("desktop mode: no OpenRouter key is configured, so an OpenRouter model cannot be called; enter an
OpenRouter key on the Agents page, or choose a web:<slot> or ollama:<name> model"); nothing reaches the mock
or the network. `transport_disabled` is NO LONGER MINTED (the constant stays in `bridge.py`). With a
session key the OpenRouter branch runs as always — the cost cap first, then the key — with
`client.api_key()`: in desktop mode ONLY `session_key.get_key()`, never `settings().openrouter_api_key`
(a developer `.env` beside the checkout can never make the e2e backend place paid calls); outside
desktop mode the environment's key as before. `complete_json(..., response_schema: dict | None = None)`
is an append-only kwarg → `structured_response_format(purpose, schema_model, schema=None)`.

**Store.** `store.mock_anon_map(council)` = R1..Rn in catalog order (`mock_anon_map(DEFAULT_COUNCIL) ==
MOCK_ANON_MAP`, asserted at import); `_validate_anon_map(anon_map, council)`; `create()` resolves the
config FIRST, then the map and `empty_threads(council)`; `append_to_thread` to a slot outside the
conversation's council is a `ValueError` (nothing written). `store/files.read_document`: a document
that parses but fails validation is now a WARNING carrying the path and the `loc: type` list only
(`validation_locations`; `str(e)` would render `input_value=` — a prompt or a reply — into
`backend.log`) and is counted (`invalid_document_count()`); unreadable JSON stays an ERROR.

**Export.** `SLOT_NAMES` comes from the catalog (seven names); `anon_note(n)` (`ANON_NOTE ==
anon_note(3)`, byte for byte), `others_not_called(n)` ("the other slot was not called." for a pair),
"The {two|three|…} responses, reduced"; every document reads its count from the turn's own
`slot_config`.

**Frontend contract addendum.** `SLOT_IDS` (7), `DEFAULT_COUNCIL`, `COUNCIL_MIN/MAX`, `SLOT_VENDORS`
(7), `SLOT_LABELS` (7: Claude, ChatGPT, Grok, Gemini, DeepSeek, Qwen, MiMo), `SITES =
['claude','chatgpt','grok']`, `TRANSPORTS`, `transportOf(model)` (`web` / `ollama` / else
`openrouter`), `slotStyle(slot)` (one `--slot-color` custom property from the frozen `index.css`
tokens `--claude … --mimo`) and `councilOf(spec)` (the `{slots}` keys in catalog order; null without)
are mirrored in `features/send/slice.js` and `features/desktop/slice.js` (features never import each
other); `LABELS` (5), `labelsFor(n)`, `councilOfTurn(turn)` (its `slot_config.slots` keys, else its
`responses` keys) and `councilSize(turn)` in `analyze/slice.js`, `analyze/refactorSlice.js` and
`fusion/derive.js`. Precedence everywhere: the frozen `slotConfig` slice → `panes.council` (the
desktop default, a slice read by KEY) → `DEFAULT_COUNCIL`. **Derived rule change:** a send turn is
complete when every slot of ITS OWN council has a non-null response (before, a two-agent turn was
never complete against a fixed three — the one functional bug of this work). `subsetSlots(slots,
council)` / `sendBody(prompt, slots, council)` post `{prompt, slots}` only for a strict subset of the
council, read from `conv.slot_config` AFTER the create round-trip. The `slots` slice is EAGER over the
seven ids (a slot outside the council never sees `slot_start`, so it stays `idle`); `vendorModels`
also admits every `ollama:*` entry. `SendPane({composer, council})` renders
`send-grid[data-council-size]`; `SlotColumn({solo})` drops the Continue box for a deck column and
carries `slot-<slot>-transport[data-transport=web|openrouter|ollama]`; `features/send/index.jsx`
exports `SlotColumn` by name (the desktop feature composes it). The Differs table's columns are
`labelsFor(councilSize(sendTurn))`; the meter's cost column, multiplier and cap alert return in
desktop mode when any member or the analyst is on OpenRouter (`meter[data-cost]`); the config bar's
desktop analyst picker adds two OpenRouter groups (structured-outputs first) once a key is configured.

## Plan addendum (2026-09-27 — "one agent after Fusion")

**Endpoint and turn.** `POST …/plan` and `PlanTurn` are above (the endpoint list and the schemas
section). One agent, one call, ONE user message: the rules, the JSON instruction (fenced for a
`web:` model, Refactor's wording), the `Plan` schema and the rendered Fusion outcome go out as a
single user message, because `bridge.text_for` types only the last user message into a pane — and the
same message goes to an analyst page, Ollama or OpenRouter (one code path). The rendered input quotes
the question, the agreements, every divergence with each side's latest claim and justification and
its status, and the Fusion exit, each in its own `prompts.delimited()` block behind one
`QUOTED_DATA_NOTICE`, every model-authored string `anon.scrub`bed — the agent sees R-labels only
(`docs/semantics.md`, "Plan").

**Export.** `GET …/export/{turn_id}` renders a `plan` turn titled `Plan`: header extras `planned
fusion turn` and `status` — NEVER the model string (it can name a vendor; no Analyze / Fusion /
Refactor document carries `analyst_model` either, and `tests/export/test_anonymity.py` is the
standing gate) — then Objective, Prerequisites (or "(none)"), the Procedure as a `#` / step / action
/ verify table followed by one heading per step with its action, why, inputs, outputs and verify
(empty ones skipped), Decision points (`{id} — topic`, or the topic alone when the id is null;
options, recommendation, rationale), Risks (`risk — mitigation`), Done when as a GFM task list
(`- [ ] …` in Markdown, disabled checkboxes in HTML), a degraded turn's error and raw attempts, the
usage last. Desktop: `desktop/main/export.js TURN_TYPES` lists `plan` — and `refactor`, which the
Analyze pane's second `ExportControl` had been sending as `turnType` since S11 while main rejected it
`bad_request`; `features/export/formats.js FEATURE_TURN_LABEL.plan = 'plan'`; `ExportControl
feature="plan" turnType="plan"` → `export-plan`.

**Frontend contract addendum.** The Plan section lives INSIDE `features/fusion/` (the S11 precedent:
Refactor lives inside `features/analyze/`; `App.jsx` is frozen with six regions), rendered by
`FusionPane` right after the final report under the same condition (a persisted fusion turn on
screen, no notice) — not a drawer tab. Slice `plan`, registered from `features/fusion/index.jsx`:
`{status: 'idle'|'running'|'working'|'done'|'degraded'|'error', turn, cached, notice, error,
ofFusion, model}`; `plan_start` → running (`ofFusion`, `model`), `plan_retry` → working (`notice`),
`plan_done` → done (`turn`, `cached`), `plan_degraded` → degraded (`error` = `turn.error`);
`error` / `sse/end{ok:false}` / `sse/abort` on feature key `'plan'` exactly as
`analyze/refactorSlice.js`; `conversation/loaded` hydrates from the newest fusion turn → the newest
ok plan turn for it (an in-flight or just-settled state for the same `ofFusion` is kept, as
`refactorSlice` keeps its `ofTurn`); `conversation/cleared` → initial. Pure helpers:
`newestFusionTurn` (imported from `fusion/slice.js`), `newestOkPlanTurn(conversation, ofFusion)`,
`planGate({fusion, streams})` → `{enabled, reason}` (enabled iff `fusion.status === 'done'` with a
`fusion.turnId`, no `fusion.notice` and no stream `streaming`), `defaultPlanModel(desktop)`
(`web:claude` | `anthropic/claude-opus-5.5`), `loadPlanModel(storage, desktop)` /
`persistPlanModel(storage, model)` (`localStorage 'triplex.plan.model'`), `planModelOptions({items,
desktop, keyConfigured})` → `[{label, options:[{id, name}]}]` (desktop: "your web sessions (typed
into this conversation's chat)" = `web:claude` "Claude — this conversation's chat" FIRST, then
`web:chatgpt`, `web:grok`; "hidden analyst pages" = the three `web:<site>:analyst`; "local (Ollama)"
= catalog items with `raw.transport === 'ollama'`; "OpenRouter" = `raw.transport === 'openrouter'`,
structured-outputs first, only when `keyConfigured`; browser: the OpenRouter catalog, structured
first, with the default id present even when the catalog lacks it; the three site names come from a
local `SITE_LABELS`, mirrored, never imported from another feature), `checkedSteps(storage, turnId)`
/ `toggleStep(storage, turnId, n)` (`localStorage 'triplex.plan.checked.<turnId>'`, every access in
try/catch). Test ids: `plan-root`, `plan-run` ("Make a plan" / "Re-plan" = `force:true`; the body
carries `{model, of_fusion: fusion.turnId}` so the plan is for the report on screen), `plan-model`
(a `<select>` of `<optgroup>`s), `plan-status[data-status]`, `plan-notice`, `plan-error`,
`plan-cached`, `plan-stale` (the plan is for another fusion turn than the one shown),
`plan-objective`, `plan-prerequisites`, `plan-steps` (the table: a `plan-step-<n>-done` checkbox,
`#`, title, action, verify; a `plan-step-<n>-details` row with why / inputs / outputs; the row's
`data-done`), `plan-decisions` (`plan-decision-<i>`), `plan-risks`, `plan-done-when` (read-only
checkboxes), `plan-model-used` ("made by <model>" — the raw string is fine ON SCREEN, the user picked
it), `plan-degraded` (error + `<details>` raw attempts), `plan-usage`, `export-plan`. The run is
`run('plan', url, body)` then `loadConversation(dispatch, id, {isCurrent})`, as `FusionPane.onRun`;
every button carries a `title`; styles are `plan*` classes in `fusion.module.css` on the existing
tokens. `send/slice.js threadItems` / `SlotColumn` label a `plan_request` / `plan_reply` message
"plan", as fusion messages are labelled. Meter: a `Plan` row (`FEATURE_ROWS` += `plan`; `plan_start`
resets the last-invocation row, `plan_done` books the turn's totals unless `cached`, `plan_degraded`
books); the cost-cap flag keys on the code in any event, as before.
