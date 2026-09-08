# Triplex API contract

> FROZEN CONTRACT (contract-v1). Binding for every workstream. Changes go through the integrator via `frozen_change_requests`; never edit in a feature branch.

The wire format (HTTP + SSE), the shared types in `backend/schemas.py`, the config surface, the cross-workstream function signatures (stubbed in Stage 0), and the frontend state contract.

### `docs/api-contract.md` — HTTP + SSE

All feature endpoints stream SSE over POST (`text/event-stream`, one JSON object per `data:`
line, `type` inside, `X-Accel-Buffering: no`). Pre-stream failures are plain JSON with HTTP
status (`404`, `409 {error, ...}`, `422`). `error{message}` is always the last event when
emitted; exactly one of `slot_done`/`slot_error` per slot per turn. Clients refetch
`GET /api/conversations/{id}` after `turn_done`, `analyze_done`, `fusion_done`.

- `GET/POST /api/conversations`, `GET/DELETE /api/conversations/{id}`, `PATCH …/title`,
  `GET/PUT …/slot_config` (422 when `effort ∉ get_meta(model).efforts` and meta known),
  `GET /api/models` → `list[ModelMeta]`.
- `POST …/send {prompt}`, `POST …/slots/{slot}/continue {prompt}` →
  `turn_start{turn_id, feature, slots}`, `slot_start{slot, model, effort, effort_coerced}`,
  `slot_delta{slot, text}`, `slot_reasoning{slot, text}`, `slot_citations{slot, items}`,
  `slot_done{slot, usage, finish_reason, truncated}`, `slot_error{slot, code, error_type, message,
  partial}`, `turn_done{turn_id, usage}`, `error{message}`.
- `POST …/analyze {of_turn?, force?}` → `analyze_start{turn_id, of_turn}`,
  `analyze_retry{error}`, `analyze_done{turn, cached}` | `analyze_degraded{turn}`.
- `POST …/fusion {of_analyze?, max_iterations (required, 1..5)}` → (if Analyze must be auto-run:
  the full `analyze_*` sequence first) `fusion_start{turn_id, of_analyze, max_iterations,
  standing}`, `round_start{round}`, `exchange{round, …Exchange}`, `round_done{round,
  post_round_status, changed}`, `fusion_done{turn, exit_reason, usage}`.


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
  partial: dict[SlotId,str]}`; `ContinueTurn{type:"continue", slot, prompt, response: str|None,
  error: str|None}`; `AnalyzeTurn{type:"analyze", of_turn: str, extraction: Extraction|None,
  status:"ok"|"degraded", error: str|None, raw_attempts: list[str]}`; `FusionTurn{type:"fusion",
  of_analyze: str, max_iterations, standing: list[str], rounds: list[FusionRound],
  final: list[RoundStatus], exit_reason:"converged"|"stalemate"|"max_iterations"|"error"}`;
  `Turn = Annotated[Union[...], Field(discriminator="type")]`. `of_turn`/`of_analyze` are turn
  ids, never indexes. `store.append_turn` never assigns ids and rejects duplicates.
- `Conversation{schema_version, id, title, created_at, updated_at, slot_config, threads:
  dict[SlotId, list[ThreadMessage]], turns: list[Turn], anon_map: dict[Label, SlotId]}`;
  `ConversationPublic` = same minus `anon_map`; `to_public(conv)`; `ConversationSummary{id,
  title, created_at, updated_at, turn_count}`; `new_anon_map(rng=None)` (shuffled permutation,
  stamped by `store.create`, never re-derived).
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
FORBIDDEN_IDENTITY_STRINGS` (slot ids, configured slugs, vendor/product names; matched
case-insensitively on word boundaries). Feature-private constants live in the feature module.


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
async def create(slot_config: SlotConfig | None = None, title: str | None = None) -> Conversation
async def load(conv_id: str) -> Conversation | None
async def list_summaries() -> list[ConversationSummary]
async def delete(conv_id) / rename(conv_id, title) / update_slot_config(conv_id, cfg) -> Conversation
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
Feature generators yield the SSE event dicts below; routers wrap them in `StreamingResponse`.


### Frontend contract (`src/state`, `src/api`, W8 = Stage 0)

Slices (keys frozen): `conversation, conversations, slotConfig, models, slots, analyze, fusion,
meter`. `registerSlice(key, reducer, initial)`; every slice receives every action. Actions
(frozen names): `sse/start{feature}`, `sse{feature, event}`, `sse/end{feature}`,
`sse/abort{feature}`, `conversation/loaded{conversation}`, `conversations/list{items}`,
`slotConfig/loaded`, `slotConfig/update{patch}`, `models/loaded{items}`. `runStream(feature,
url, body)` checks `response.ok` (surfaces JSON `detail`/`error`), reads the buffered SSE
stream (`{stream:true}` decode, `\n\n` framing, skip `:` lines, AbortController) and dispatches
every event verbatim; `analyze_*` events route to the `analyze` slice regardless of which
feature opened the stream. `slots.<slot>` holds `{buffer, reasoning, citations, status, usage,
truncated, error}`; the column renders the persisted thread (kind-styled) plus the live buffer.
Each feature ships `features/<x>/{index.jsx, slice.js}`; `index.jsx` registers its slice at
module scope and exports the pane. Test helper `dispatchEvents(events)` for synthetic streams.
`package.json`: `"test": "vitest run --passWithNoTests"`, `"test:e2e": "playwright test"`;
vitest `environment: jsdom`, `setupFiles: src/test-setup.js`, deps `@testing-library/{react,
jest-dom,user-event}`, `jsdom`, `@playwright/test`, `react-markdown`, `remark-gfm`.

---


