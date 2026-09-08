# CLAUDE.md - Technical Notes for Triplex

PLAN.md is the spec. Work one stage at a time (phase→stage map in Appendix B). Check off items and update the decisions log.

This file contains technical details, architectural decisions, and important implementation notes for future development sessions. Its structure follows karpathy's llm-council CLAUDE.md (kept verbatim in `docs/reference/llm-council-CLAUDE.md`); Triplex is a greenfield build in the same shape, not a fork.

## Project Overview

Triplex is a three-slot council (Claude, ChatGPT, Grok via OpenRouter) with three separately triggered features. **Send** streams one prompt to all three models in parallel, each with its own thread history. **Analyze** is an on-demand compare/contrast pass that returns agreements and divergences as strict JSON. **Fusion** iterates on the divergences (defend or revise, round by round, up to a user-set `max_iterations`) and reports what converged and what is still standing. The key stance is sensor fusion *plus integrity monitoring*: models never see each other's identities (R1/R2/R3 only), and unresolved disagreement is surfaced, never averaged away.

## Architecture

### Backend Structure (`backend/`)

**`schemas.py`** (FROZEN contract)
- Every shared pydantic model: `SlotConfig`, `ThreadMessage`, `Usage`/`FeatureUsage`, `Extraction`, `DefenseReply`, `ConvergenceCheck`, `Exchange`/`FusionRound`, the discriminated `Turn` union (`send` / `continue` / `analyze` / `fusion`), `Conversation` + `ConversationPublic`, `Delta`, `ModelMeta`
- Helpers: `strict_json_schema()` (OpenAI strict mode shape), `is_unjustified()` (deterministic anti-sycophancy rule), `new_anon_map()`, `sse_frame()`, `canonical_request_key()`
- Append-only after Stage 0; imports nothing from feature code

**`config.py`** (FROZEN)
- `settings()` reads the environment at CALL time — never cache it at import (tests and worktrees set env first)
- `DEFAULT_SLOT_CONFIG` seeds a new conversation's persisted `slot_config`; feature code reads the conversation's config, never this module at request time
- `MAX_TOKENS_STAGE`, `MAX_ITERATIONS_CAP`, `FORBIDDEN_IDENTITY_STRINGS`
- Backend runs on **port 8001** (NOT 8000 — another local app uses 8000); `HOST`/`PORT` from env

**`main.py`** (FROZEN)
- App factory + CORS + `pkgutil` auto-discovery of `backend/routers/*.py` exporting `router`
- Adding a feature adds ZERO lines here

**`llm/`** — the only code that talks to OpenRouter
- `client.py`: `stream_completion()` (async generator of `Delta`) and `complete_json()` (streams internally, lenient parse → pydantic → one retry)
- `stream.py`: SSE parser (skip `:` comments, `[DONE]`, mid-stream `error` chunks under HTTP 200, final usage chunk with an empty delta, `reasoning_details`, `annotations`)
- `reasoning.py`: effort → `reasoning` object; never raises; `off` = `{"enabled": false}`; mandatory-reasoning models are coerced with a visible badge
- `catalog.py`: `/api/v1/models` cache + offline fixture `llm/fixtures/models.json`
- `mock.py`: replay transport for `MOCK_OPENROUTER=1` (see `docs/fixtures.md`)
- `metering.py`: `Usage` from the usage chunk + wall clock; one INFO log line per call

**`store/conversations.py`** — the ONLY module that touches disk
- One JSON file per conversation under `DATA_DIR`, atomic tmp+rename, per-conversation lock around the read-modify-write only, sidecar index for listing
- `create()` stamps the `anon_map` (a random permutation) once; it is never re-derived
- Generic `append_to_thread()` / `append_turn()`; features construct their own turn objects and never edit the store

**`anon.py`** — the anonymization firewall
- R1/R2/R3 ↔ slot mapping read from the persisted document; `render_peer_block()` scrubs claims before they enter a challenge prompt
- The mapping never appears in prompts, API responses, or the UI

**`features/{send,analyze,fusion}.py`** + **`routers/*.py`** + **`prompts/*.py`**
- One module per feature; each yields the SSE event dicts defined in `docs/api-contract.md`; the router wraps the generator with `sse.sse_response()`
- Normative behaviour (thread append rules, idempotency, the Fusion loop, exit reasons) is in `docs/semantics.md`

### Frontend Structure (`frontend/src/`)

**`App.jsx`** (FROZEN)
- Pure layout. Imports each pane by convention from `features/<x>/index.jsx`; never edited after Stage 0

**`state/store.jsx`, `state/registry.js`, `state/reducers.js`** (FROZEN)
- Slot-keyed store (`useReducer` + context). Slice keys: `conversation, conversations, slotConfig, models, slots, analyze, fusion, meter`
- `registerSlice(key, reducer, initial)`: every slice receives every action; features register their slice from their own `index.jsx`

**`api/sse.js`, `api/http.js`, `api/runStream.js`** (FROZEN)
- Buffered SSE reader (`decode(value, {stream:true})`, split on `\n\n`, skip `:` lines, AbortController) — fixes the unbuffered-chunk bug llm-council's `api.js` had
- `runStream(feature, url, body)` checks `response.ok` first and dispatches every event verbatim as `{type:'sse', feature, event}`

**`features/send/`** — three live columns (one per slot), each with its own model/effort controls, its own solo composer, and the persisted thread with fusion messages visually marked
**`features/analyze/`** — Analyze button + *Similar* / *Differs* report (R-labels only)
**`features/fusion/`** — Fusion button + iterations stepper + per-divergence timeline derived from `rounds`
**`features/config/`, `features/meter/`, `features/conversations/`** — global bar (analyst, iterations, grounded), per-feature cost meter, sidebar

**Styling**
- Light theme, primary color `#4a90e2`; palette tokens in `index.css`
- Global `.markdown-content` rules in `index.css` (12px padding); every ReactMarkdown is wrapped in `<div className="markdown-content">`
- Each feature ships its own `*.module.css`; `index.css` / `App.css` are frozen

## Key Design Decisions

### Threads are the source of truth
Each slot has ONE independent message history (`threads[slot]`). Send prepends that slot's own history; solo continuation appends to one thread and leaves the others byte-identical; Fusion challenges and replies are appended to the challenged slot's thread so later rabbit-holing carries that context. `turns[]` are artifacts of feature invocations, not the history.

### Anonymization is load-bearing
Models are shown as R1/R2/R3 everywhere (analyst prompts, challenge prompts, reports, UI). The mapping lives only in the persisted document and is stripped from every API response. Leak tests scan every Triplex-authored prompt for vendor/product names and slot ids.

### Strict JSON with a safety net
Analyst and defense calls use OpenRouter `response_format: json_schema` (strict) when the model supports it, then always run lenient parsing + pydantic validation + one retry carrying the validation error. A second failure degrades gracefully (`status: degraded`, Fusion disabled for that turn) instead of failing the request.

### Anti-sycophancy is a rule, not a vibe
A `revise` is flagged unjustified by `schemas.is_unjustified()` (short justification, no `persuaded_by`, or no substantive overlap with the peer claims). A divergence that resolves only through flagged revises is reported as `resolved_unjustified`, never as clean convergence. An all-defend round exits as `stalemate`.

### Error Handling Philosophy
- Continue with the slots that succeed; never fail the whole Send because one model failed (carried over from llm-council)
- A slot that errors mid-stream gets nothing appended to its thread (no orphan user message); partial text is kept on the turn
- Pre-stream failures are plain JSON with an HTTP status; mid-stream failures are `slot_error` / `error` events

### UI/UX Transparency
- Every raw model output is visible in its column; the Analyze report shows per-label positions and materiality; the Fusion timeline shows each stance, flagged revisions, and the exit reason
- Agreements are captioned "convergence, not verified truth" — correlated models can share a hallucination

## Important Implementation Details

### Relative Imports
All backend modules use relative imports (`from .config import ...`). Run the backend as `python -m backend.main` from the project root, never from inside `backend/`.

### Port Configuration
- Backend: 8001 (env `PORT`); frontend: 5173 (env `VITE_PORT`); the Vite dev server proxies `/api` to the backend, so no CORS dance in dev
- Playwright uses 8011/5174 and never reuses a running server

### Reasoning effort
`off / low / medium / high` in the UI. `off` is sent as `{"enabled": false}`; models whose catalog entry says `mandatory: true` cannot be turned off, so the UI hides "off" and the client coerces with `effort_coerced: true`. Effort options per model come from `GET /api/models` (catalog metadata), not from a hardcoded table.

### Usage / cost
OpenRouter always includes `usage` (with `cost`) in the final streaming chunk — `usage: {include: true}` is deprecated and must not be sent. The meter shows tokens / $ / latency per feature so Fusion's multiplier is impossible to miss. `SESSION_COST_CAP_USD` refuses live calls once exceeded.

### Mock mode
`MOCK_OPENROUTER=1 MOCK_SCENARIO=<name>` replays `backend/llm/fixtures/scenarios/<name>/<role>.<purpose>.<n>.jsonl` (raw OpenRouter SSE chunks) through the real parser; the whole test suite runs offline with outbound HTTP blocked.

### Frozen files and ownership
Shared files (`schemas.py`, `config.py`, `main.py`, `App.jsx`, `state/*`, `api/*`, lockfiles, `docs/*.md`, `tests/conftest.py`) are frozen after Stage 0. A workstream that needs a change requests it (`frozen_change_requests`) and the integrator lands it on `main`. `scripts/check_freeze.sh` enforces this before every merge.

## Common Gotchas

1. **Module Import Errors**: always `uv run python -m backend.main` from the repo root
2. **settings() at import**: never; environment is read per call so tests can set `DATA_DIR` / `MOCK_*` first
3. **`usage.include`**: deprecated on OpenRouter — usage arrives anyway in the last chunk
4. **`reasoning.effort: "none"`**: rejected by Claude; use `{"enabled": false}`, and only at effort ≤ high
5. **SSE comments**: OpenRouter sends `: OPENROUTER PROCESSING` keep-alives; never `JSON.parse` a line starting with `:`
6. **Mid-stream errors** arrive as a `data:` chunk with a top-level `error` under HTTP 200 — possibly as the only event
7. **Worktrees**: agents start from a fresh checkout — run `uv sync --frozen` and `npm ci` first; never `uv add` / `npm install <pkg>`
8. **Ports**: do not start servers in a worktree; test through the ASGI client / vitest

## Future Enhancement Ideas

- Phase 6 (out of scope for the first build): embedding-based agreement score per divergence via local Ollama `nomic-embed-text`, a ~15-question GNC eval set, and a Self-MoA comparison script
- SQLite when JSON-on-disk hurts
- Export a conversation (threads + reports) to markdown

## Testing Notes

- `uv run pytest -q` — unit, feature, e2e, golden (syrupy), fuzz (hypothesis) and leak tests, all offline (`-m 'not live'` is the default; outbound HTTP is blocked by the shared conftest)
- `cd frontend && npm test` (vitest) and `npm run build`; `npx playwright test` drives the app in mock mode in the system Chrome on ports 8011/5174
- `uv run pytest -m live` — manual live smoke test against OpenRouter; needs `OPENROUTER_API_KEY` in `.env`; never in CI
- `scripts/record_fixtures.py` records real traffic into `backend/llm/fixtures/recorded/` for replay

## Data Flow Summary

```
User prompt
    ↓
SEND: per-slot history + prompt → 3 parallel OpenRouter streams → 3 live columns
      each slot's [user, assistant] appended to ITS thread when its stream ends
    ↓  (on demand)
ANALYZE: latest send turn, labelled R1/R2/R3 → analyst (strict JSON) → {agreements, divergences}
    ↓  (on demand, max_iterations from the UI)
FUSION: for each standing divergence, every label with a position is challenged in its own thread
        → defend | revise (flagged if unjustified) → analyst convergence check
        → exit: converged | stalemate | max_iterations   (standing items reported with both sides)
    ↓
Footer meter: tokens / $ / latency per feature; threads + turns persisted as JSON per conversation
```

The Send path is fully parallel and streams token by token; Analyze and Fusion are overlays that never run unless asked.
