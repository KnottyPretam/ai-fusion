# Decisions and rationale

PLAN.md Appendix B is the decisions log of record (one row per decision). This file holds the rationale, the verified facts behind each decision, and the execution model.

### Decisions taken from recon (spec §3 explicitly permits this)

1. **Greenfield, same shape (FastAPI + Vite/React + httpx → OpenRouter), not a fork.**
   llm-council has **no LICENSE file** (all-rights-reserved by default), is unmaintained, sends
   *no* history to models, has *no* token streaming, *no* reasoning params, discards `usage`,
   has *no* tests, and hard-wires its 3-stage pipeline into the request handler. It is used
   only as a design reference (anonymized peer review; FastAPI SSE + Vite shell).
2. **OpenRouter facts (verified 2026-09-07) that override the spec's placeholders**
   - Reasoning: `"reasoning": {"effort": "low|medium|high|xhigh|max|minimal|none"}`;
     off = `{"enabled": false}` (Claude rejects `none`; `enabled:false` only legal at ≤ high);
     `{"exclude": true}` hides but still bills. `GET /api/v1/models` carries per-model
     `reasoning.{supported_efforts, mandatory, default_enabled}`; `mandatory:true` models
     (claude-fable-5.1, grok-4.6, gpt-6-astra…) cannot be turned off.
   - Usage: `usage: {include: true}` is **deprecated/no-op**; usage (incl. `cost` and
     `completion_tokens_details.reasoning_tokens`) always arrives in the final SSE chunk,
     which has one choice with an empty delta (not an empty `choices` array).
   - Streaming: skip `: OPENROUTER PROCESSING` comment lines; `[DONE]` sentinel; mid-stream
     errors are a `data:` chunk with top-level `error{code:int|str, message, metadata.error_type}`
     under HTTP 200 (may be the only event). Reasoning arrives as
     `delta.reasoning_details[]` (`reasoning.text`/`.summary`/`.encrypted`); handle a bare
     `delta.reasoning` string defensively. Generation id in `X-Generation-Id` header.
   - Structured output: `response_format: {type:"json_schema", json_schema:{name, strict:true,
     schema}}` on models listing `structured_outputs`; strict mode needs object root,
     `additionalProperties:false`, all properties required; unsupported → error, not fallback.
   - Web search: `plugins: [{"id":"web", …}]` (or `:online`); citations return as
     `message.annotations[].url_citation`; streaming placement undocumented. ~$0.001–0.015/req.
   - Headers: `Authorization`, `HTTP-Referer`, `X-OpenRouter-Title`. Post-hoc cost:
     `GET /api/v1/generation?id=…`.
   - Default slugs (UI/config-changeable; all support effort selection + structured outputs):

     | Slot | Default | $/M in/out | Notes |
     |---|---|---|---|
     | claude | `anthropic/claude-opus-5` | 5 / 25 | efforts low…max; off allowed |
     | chatgpt | `openai/gpt-5.6-sol` | 2 / 10 | efforts low…max + none |
     | grok | `x-ai/grok-4.6` | 2 / 6 | efforts low…xhigh; **reasoning mandatory** |
     | analyst | `openai/gpt-5.6-luna` | 0.2 / 1.2 | structured_outputs + seed |

     Flagship: `anthropic/claude-fable-5.1` (10/50, mandatory), `openai/gpt-6-astra` (10/50).
     Budget: `anthropic/claude-sonnet-5`, `openai/gpt-5.6-luna`, `x-ai/grok-4.3`.
3. **Toolchain (Ubuntu 20.04, 8 CPU, 31 GB, git 2.25, no passwordless sudo):** install `uv`
   (→ `~/.local/bin`, on PATH) + `uv python install 3.12`; Node 22/npm 10 present; `jq`
   static binary (dev convenience); Playwright via npm using system Chrome (`channel:
   'chrome'`, no sudo `install-deps`). No `gh` (no GitHub push requested). Ollama 0.33 runs
   but lacks `nomic-embed-text` (Phase 6 only).
4. **No OpenRouter key existed on this machine** (env, shell rc, `~/.hermes/.env` checked; the
   latter has only a commented-out line). The user is adding `~/dev/ai-fusion/.env` with
   `OPENROUTER_API_KEY=…` (gitignored) before execution starts. Stages 0–3 still run fully
   offline in mock mode; Stage 0 verifies the file exists (existence only, value never
   printed) and Stage 4 pauses to ask if it is still missing. Live spend cap: **$10**
   (`SESSION_COST_CAP_USD=10`).

---


## Execution model

- **Disjoint ownership.** Every path has exactly one owner per stage (tables below, including
  every `tests/<area>/` directory). Shared files are written once in Stage 0 and **frozen**:
  `backend/{schemas,config,main}.py`, `backend/*/__init__.py`, all Stage-0 stubs,
  `pyproject.toml`, `uv.lock`, `frontend/package.json`, `package-lock.json`, `vite.config.js`,
  `frontend/src/{App.jsx,main.jsx,index.css,App.css,test-setup.js}`, `frontend/src/state/*`,
  `frontend/src/api/*`, `tests/conftest.py`, `docs/*.md`. Feature code adds its own
  module/router/pane/slice/CSS-module; routers are auto-discovered (`pkgutil` over
  `backend/routers`); panes are imported by convention from `features/<x>/index.jsx`
  placeholders shipped in Stage 0, so `App.jsx` is **never edited after Stage 0**.
- **One Workflow per stage.** Agents run with `isolation: 'worktree'`, start with
  `uv sync --frozen` and `cd frontend && npm ci`, never run `uv add`/`npm install <pkg>`, never
  start servers (Stages 1–2 test through the ASGI client / vitest), end with
  `git add -A && git commit`, and return structured output
  `{branch, head_sha, worktree_path, files_changed, tests_passed, frozen_change_requests,
  open_issues, summary}`. Cross-workstream needs go into `frozen_change_requests`; the
  integrator applies them on `main` between stages (re-tag `contract-vN`) — never the agent.
- **Integrator (main session) gate per stage:** `git status --porcelain` empty →
  `scripts/check_freeze.sh <branch> <owned-paths>` (diff vs the contract tag must touch only
  owned paths) → `git merge --no-ff` largest-first → full offline suite → tag `S<n>` →
  `git worktree remove --force` + `git branch -d` for each agent → launch the **adversarial
  review workflow** for `S<n>` (3 lenses per workstream: spec-AC compliance, correctness/races,
  anonymization leaks; UX lens for panes) **concurrently with the next stage's agents**
  (review fixes touch only prior-stage files, landed on `main` before the next merge).
- **Concurrency:** cap 6 agents per workflow on this box; thunks ordered largest-first.
- **Ports:** `config.py` reads `HOST/PORT` (127.0.0.1:8001); `vite.config.js` reads
  `BACKEND_PORT`/`VITE_PORT` (8001/5173). Playwright uses 8011/5174, `reuseExistingServer:false`.


## User decisions (confirmed 2026-09-07)

1. **Greenfield**, same shape; llm-council is a design reference only.
2. **OpenRouter key added now** by the user in `~/dev/ai-fusion/.env`; live cost cap **$10**.
3. **Scope: through Phase 5** (Stages 0–4). Stage 5 / Phase 6 is out of scope for this run
   and stays documented as a follow-up.
4. **Fusion challenges every model holding a position** on each standing divergence, every
   round (recorded in PLAN.md Appendix B with the cost formula).
5. **Run locally on this box.** Cloud execution was evaluated (Claude Code cloud session or a
   one-off routine; both need a GitHub repo, the key as an environment secret, and
   `openrouter.ai` allowed; sandbox CPU count undocumented) and is documented in
   `docs/decisions.md` as an alternative venue, not used in this run.
6. **`CLAUDE.md` is based on karpathy's** llm-council CLAUDE.md (same structure and voice;
   original kept verbatim under `docs/reference/`).



## Build log (2026-09-08)

Gates at every tag: `uv run pytest -q` (1102 passed, 9 live deselected at S3), `cd frontend &&
npm test` (255 vitest tests at S3) and `npm run build`; from S3 on, the Playwright matrix (11
scenario runs: `smoke`, `flow`, `settings`, `persistence`, `guard` on the default scenario plus
`stalemate`, `cap`, `degrade`, `truncated`, `grounded` and the paced `guard` on their own ports).

| Tag | Commit | What merged |
|---|---|---|
| `contract-v1` | `6cb5041` (2026-09-07) | Stage 0: frozen contracts (`docs/{api-contract,semantics,fixtures}.md`, `backend/{schemas,config,main,sse,api_errors}.py`, `frontend/src/{state,api}`, `tests/conftest.py`), stub modules raising `NotImplementedError`, the app shell, `start.sh`, `check_freeze.sh`; W0 verification fixes (signature block, busy-guard lifecycle, fixture sequences) |
| `S1` | `09beaaa` (2026-09-07) | Stage 1: W1 llm (client, SSE parser, reasoning, catalog, mock, metering, `GET /api/models`), W2 store (JSON on disk, busy guard, conversation/config routers), W3 anon, W-fix fixtures (14 scenarios, 98 JSONL files, corpus validator), W9 send-ui, W10 analyze-ui, W11 fusion-ui, W12 chrome-ui; frozen change requests applied on `main` |
| `S2` | `d4f0962` (2026-09-08) | Stage 2: W4 send-be (Send + solo continue, producer model), W5 analyze-be (extraction, cache rule, single retry, degraded path), W6 fusion-be (the loop, auto-run Analyze, exit reasons); 422 codes documented |
| `S3` | `0099d84` (2026-09-08) | Stage 3: e2e-offline (`tests/e2e`: full flows over every scenario, syrupy goldens, hypothesis fuzz of malformed model output, leak sweep, cost-meter truth), Playwright scenario matrix, phase5-backend (grounded/cost-cap hardening, `GET /api/session/cost`, `scripts/live_smoke.py`, `scripts/record_fixtures.py`, `tests/live`), phase5-frontend (grounded badge and composer hint, per-column cost-cap notices, citation/truncation audits); the S1 review fixes (W1/W9/W11/W12) and the delimiter-neutralisation fix landed via `S3-wire`. After S3: W5 review fixes on `main` (`2db166d`, `21783ed`: retry parity, nested guard release) |

Notable integrator decisions during the build:

- **Token-based busy guard.** Re-entrancy of `store.busy_guard` is bound to the specific
  acquisition (a token in a module dict plus a `ContextVar` of held tokens), not to the
  conversation id: a context that once held the id keeps a stale entry after the producer task
  (a context copy) released it, and that entry must not let it bypass a later acquisition by
  another task. Only the object that acquired releases; release rebuilds the `ContextVar`
  instead of `reset()` because it happens in the producer's copied context.
- **Fixed anonymization map in mock mode.** `store.create` stamps R1=claude, R2=chatgpt,
  R3=grok whenever `MOCK_OPENROUTER=1` (random permutation live), so slot-keyed scenario
  fixtures, goldens, Playwright and the `start.sh` demo are deterministic; `record_fixtures.py`
  records with the same map so live recordings replay under the same labels.
- **Delimiter neutralisation.** `prompts.delimited` rewrites every `<<<` inside quoted text to
  `<< <`, so a model- or web-authored string can never close its own `<<<LABEL>>>` block and
  spill instructions into the un-quoted zone (S2 review finding; frozen test).
- **`sse_response` primes the generator.** The router awaits the feature's first event before
  building the `StreamingResponse`, which is what lets every pre-check (404/409/422) stay a
  plain JSON error in FastAPI's `{detail:{error}}` envelope; after the first event only the
  terminal `error{message}` event is possible.
- **Per-invocation meter rows.** The footer shows the LAST invocation of each feature (spec §7)
  next to the conversation's cumulative rows, and Fusion's multiplier is the last Fusion's cost
  over the cost of the Send it actually fused (resolved through `of_analyze` → `of_turn`), so it
  never shrinks as the conversation grows.
- **Sidebar streaming guard.** New / select / delete are disabled while any feature stream is
  running: the pane that opened the stream refetches the conversation it captured when the
  stream ends, so a switch mid-stream would snap back and book the in-flight usage into the
  wrong conversation. The Send pane additionally scopes its pending prompt, refetch and error
  banner to the conversation the turn started in, and the `slots` slice ignores events for a
  slot that is no longer `streaming`.
- **Empty-reply rule.** A blank model reply is never echoed back as an `assistant` turn on a
  retry (providers reject empty assistant content, which would turn the single retry into a
  guaranteed 400): `complete_json` and Analyze's own retry both send the correction message
  alone, and Analyze re-sends the identical request when there was no output at all (a
  transport error or an empty stream).

---

## Desktop pivot (2026-09-16)

**Why.** Stage 4 (live OpenRouter validation) stalled: the OpenRouter account is unfunded (HTTP 402 on
every live call), and the user then rejected pay-per-token altogether — they want Triplex to use the
ChatGPT, Claude and Grok subscriptions they already pay for, in a desktop GUI that keeps each site's own
interface (switch between the three, or see all three in one window) with one unified prompt bar. The plan
of record is rev 3 (`~/.claude/plans/i-already-have-a-frolicking-dusk.md`, "Triplex Desktop — three
subscriptions, one window, one prompt"); its frozen contracts §1–§8, architecture diagram and decision
list are copied verbatim into `docs/desktop-contract.md`. OpenRouter code, mock mode, every fixture and
the whole offline suite stay as the offline path; live OpenRouter runs are out of scope from here on.
Tauri was ruled out on this box (no `libwebkit2gtk-4.1` on focal, no Rust, multi-webview unstable);
Electron 44 runs (three Electron apps already do; Chromium builds against glibc 2.31).

**User decisions (2026-09-16).**
1. **Grok pane = `grok.com`** — the same page Chrome's "install app" turns into a standalone PWA; an
   embedded pane is that page with the same standalone look. `TRIPLEX_GROK_SURFACE=x.com` is kept as an
   unverified escape hatch to `https://x.com/i/grok`.
2. **Scope = the full pipeline, with capture behind a per-site switch**: shell first (nothing read back),
   then reply capture that is off until the user flips it for that site, then Analyze and Fusion through
   the logins. Chosen with the terms of service stated: typing into the real composer is the least
   exposed act; reading the reply out of the DOM is what OpenAI's "programmatically extract Output" and
   Anthropic's "automated means" clauses name, and that is what Analyze/Fusion need.
3. **Analyst = a hidden page on the ChatGPT login** (`web:chatgpt:analyst`), switchable in the config bar
   to Claude, Grok or local Ollama `hermes3` (zero ToS exposure for the analyst step).

**Decisions taken** (the plan's numbered list, one line each; full text in `docs/desktop-contract.md`
Appendix B):
1. Shell-first staging: `S5` = shippable backend-free shell; `S6` capture + bridge; `S7` Analyze/Fusion + analyst + Ollama; `S8` logged-in calibration; tags `S1–S3` stay.
2. Electron 44 (`^44.4.1`, `@electron-internal/extract-zip >=1.0.4` override), `WebContentsView`, `sandbox:true` everywhere, one self-contained site preload (`site.cjs`) that also boots under a fake IPC and exports its pure functions; nothing exposed to the pages.
3. Capture off by default per site, persisted in `settings.json`, switched from the pane header next to the ToS wording (the three switches are the first-run notice).
4. Analyst default `chatgpt` (`settings.analyst`); the config bar offers `web:<slot>:analyst` ×3 and `ollama:<name>`; `null` is legal (Analyze disabled with a hint, bridge answers `analyst_not_chosen`).
5. Grok = `grok.com`; `TRIPLEX_GROK_SURFACE=x.com` → `https://x.com/i/grok` with the same cascades, not verified in Stage 4.
6. Stock UA (never set, never changed), no stealth, per-partition permission deny handlers, `will-navigate` policy, allow-listed `TRIPLEX_CHROMIUM_FLAGS`, `TRIPLEX_USER_DATA_DIR` isolation for e2e.
7. Health carries `session: ok|logged_out|challenge|blocked` from Stage 1; a request on a non-`ok` view is rejected before any DOM write and the pane (or the analyst tab) is auto-revealed.
8. Bridge auth = per-launch random token in the `hello` frame, never the URL (uvicorn logs query strings); machine-checked contract `desktop/protocol/bridge-v1.json` validated by pydantic and by the JS validator.
9. `web:` routing precedes the mock branch in `client.py`; `ollama:` reuses `_live_stream(base_url=, headers=, cost_lookup=False)`; `TRIPLEX_DESKTOP=1` refuses any other model with `transport_disabled`; the desktop backend runs on 8021 with `DATA_DIR=<userData>/data`, so a pre-pivot conversation can never route live with the `.env` key.
10. `backend/config.py` stays frozen: the new keys are private `os.environ` reads inside `bridge.py` / `ollama.py` / `webmodels.py`.
11. Subset sends are real from Stage 1's per-target toggles (IPC in `S5`; `PromptBody.slots` + `run_send(conv_id, prompt, *, slots=None)` in `S6`).
12. Site chat links are recorded by main, keyed `(conversation_id, slot)`, only after a navigation matching `chatUrlPattern` (≤15 s), never overwriting a matching link with a non-matching URL; a send with no link adopts the pane's current chat; "New chat everywhere" = new conversation + all panes to `newChatUrl`.
13. Insert phase serialized across views (main-side mutex around focus → insert → verify; observe in parallel); explicit `Range` before `execCommand`; hidden-view insertion spiked in Stage 0 with a recorded fallback order.
14. Zoom, keyboard shortcuts and window-bounds persistence in Stage 1; shortcuts handled once in main (`before-input-event` on every webContents + hidden menu accelerators).
15. Single owner per persisted key: layout mode / active tab / targets / drawer / analyst mirror → renderer `localStorage`; window bounds / zoom / capture / analyst / chat links → main `settings.json` / `chats.json`.
16. Final-text capture only (one `text` delta at done; streaming markdown re-renders are non-monotonic); a `delta` frame type is reserved.
17. Renderer served two ways: dev = Vite 5184 (`TRIPLEX_RENDERER_URL`); built = `frontend/dist` at `/app/` from the backend (`VITE_BASE=/app/`), so `main.py` CORS and `http.js` stay frozen; no custom scheme.
18. Electron spawns the backend from Stage 2 (`.venv/bin/python -m backend.main`, `uv run` fallback) unless `TRIPLEX_BACKEND_URL` attaches to an external one; Stage 1 needs no backend.
19. Tests: desktop unit tests = `node --test 'test/unit/**/*.test.js'` (quoted glob) over pure modules with injected fakes, no extra npm deps; bridge flow tests use an in-loop fake connection; the app Playwright project has its own ports (Vite 5184, backend 8021, fake site 5199).

**Tag plan.** `S4` Stage 0 — scaffold, contracts, spike (integrator only) → `S5` Stage 1 — shell v1:
three logged-in sites, tabs + split, one prompt, no backend (live checks 1–14) → `S6` Stage 2 — capture
and bridge: the unified prompt becomes a Triplex Send (live checks 15–22) → `S7` Stage 3 —
Analyze/Fusion in the desktop, hidden analyst view, Ollama, capture hardening (live checks 23–28) →
`S8` Stage 4 — logged-in verification and selector calibration (all 28, `docs/desktop-verification.md`).
The gate per stage is unchanged from rev 2: clean tree → `check_freeze.sh` per branch → merge
largest-first → full offline suite → app spec on `DISPLAY=:1` → live checks with the user → tag →
worktree cleanup → adversarial review (3 lenses) whose fixes land before the next merge. Worktree
agents additionally run `cd desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, never launch Electron,
and start no server except the fake site on 5199.

### Build log (desktop)

| Tag | Commit | What merged |
|---|---|---|
| `S4` | _pending_ | Stage 0: desktop scaffold (`desktop/` package + Electron 44, `main/main.js` + `sites.js` stubs, `preload/renderer.cjs` Stage 1 surface, `preload/site.cjs` stub, `protocol/bridge-v1.json`, fake site skeleton, `backend/llm/bridge_protocol.py` + `tests/bridge`, `frontend/src/main.jsx` switch + `DesktopApp.*` + `features/desktop` placeholder, `vite.config.js` `base`), frozen contracts (`docs/desktop-contract.md`), checklist skeleton, `check_freeze.sh --list`, `scripts/desktop_dev.sh`. **GPU (2026-09-16):** Electron 44.4.1 / Chromium 152.0.7977.78 on NVIDIA 390.157 reports every feature `disabled_software` (`gpu_compositing`, `rasterization`, `2d_canvas`, `webgl` off); `--ignore-gpu-blocklist`, `--use-gl=angle --use-angle=gl` and `--use-gl=egl` change nothing, so `TRIPLEX_CHROMIUM_FLAGS` stays empty and software rendering is accepted (tabs mode hides two views; per-pane zoom). **Hidden-view spike (2026-09-16):** on a `WebContentsView` attached with `setVisible(false)` all four methods inserted and read back on the fake ProseMirror composer — `webContents.focus()` + Range + `execCommand('insertText')`, Range + `execCommand` without focus, `webContents.insertText`, and 1×1 px on-screen bounds — winner `wcFocus+range+execCommand`, no fallback needed (visible control also ok). **Live sign-in:** _pending_ (all three sites, which one via the Google popup, still signed in after restart, pane `navigator.userAgent` contains `Electron/44`). |
| `S5` | 2026-09-16 (`2526807`) | Stage 1: shell v1 — three logged-in sites, tabs + split, zoom, shortcuts, unified prompt over IPC (no backend). **Gate:** pytest 1279, vitest 355 + build, desktop unit 204 + adapters 64, app spec 7/7 on DISPLAY=:1, freeze checks OK on the three worktree branches. **Review (3 lenses, 13 agents):** 4 confirmed findings fixed — session detection scoped to alert-like containers (a reply saying "rate limit" or holding a /login link no longer locks a pane), idempotent insertion with after == before + text verification, renderer window pinned to its origin with sender-frame checks, SSO child windows policed recursively + a web-contents-created backstop — plus 15 minors (will-redirect, E2E loopback hosts, bluetooth chooser cancel, budget = composer + send + 2×verify + 2×settle, health/zoom replay, composer read-only while sending, new-chat-all gated, visible-first composer, exact/corroborated challenge title, parked pre-config ops, countMessages/countAssistant split); the contested prompt:send interleave was refuted but runs are queued anyway. **Live (user, 2026-09-16):** signed in on all three; split-mode send typed + submitted on Claude and ChatGPT; Grok never submitted — a probe under the user's session showed grok.com's composer is a TipTap `div.tiptap.ProseMirror[role=textbox][aria-label="Ask Grok anything"]` plus a hidden 14 px helper textarea that the bare `textarea` fallback matched; `button[type=submit][aria-label=Submit][data-testid=chat-submit]` exists only once the editor has text. Grok cascade corrected (§4), fake site mirrors the swap, a regression test reproduces the old failure. **Playwright + Electron:** WebContentsViews are reported as windows (pick the renderer by URL); CDP-dispatched keys never reach before-input-event (shortcuts exercised via webContents.sendInputEvent). Checklist items 7–14 still to be walked with the user after the Grok retry. |
| `S6` | 2026-09-16 | Stage 2: capture + bridge — the unified prompt is a Triplex Send (`POST /send {prompt, slots?}` via `useSendTurn`), `web:` transport + `WS /api/bridge` (token in `hello`, never the URL), Electron spawns the backend on 8021 (`DATA_DIR=<userData>/data`, `TRIPLEX_DESKTOP=1`, `OPENROUTER_API_KEY` pinned empty) or attaches to a loopback `TRIPLEX_BACKEND_URL`, per-pane capture switches (off by default, ToS notice), `observe` capture with selectors v2, chat links per conversation (`chats.json`, https on site hosts only), sidebar navigation, DOM snapshots scrubbed of text/e-mails/ids, renderer served at `/app/`. **Gate:** pytest 1453, vitest 388 + builds, desktop unit 313 + adapters 95, app spec 13/13 on DISPLAY=:1 (attach mode), freeze checks OK on the four worktree branches, `scripts/desktop.sh` end to end (spawned backend, bridge connected in 6 s). **Review (4 lenses, 26 agents; a first attempt was refused by the usage limit):** confirmed — `openChats(null)` navigated every pane (now 'kept'), a first Send raced its own conversation-switch navigation (renderer adopts the Send-created id; main awaits its own pending navigations before `ready`), snapshot scrub left e-mail addresses (whole tokens replaced), the loopback HTTP API had no Host/Origin check (TrustedHost under `TRIPLEX_DESKTOP=1`, WebSocket Origin → 4003); minors landed — ack-before-attach in one try/finally, connection-scoped `dispatch`, capture/analyst re-sent after `hello_ack`, pre-spawn port probe (`port_in_use`), bogus `assistantCount` → adapter-sampled baseline, opacity/pointer-events visibility, all `assistantText` matches joined, shadow-root walk cached per sample, `pickIpc` prefers Electron, fake-site `?doneLagMs`/`?twoTurns`, redacted pydantic log lines, https-only chat links, `prompt:send` handler deleted, parallel bounded `openChats`, remote `TRIPLEX_BACKEND_URL` refused. Contested and deferred: Analyze's correction retry against a site after a site error (Stage 3, with the analyst view); Fusion's own-claim scrub (refuted: analyst-authored text). **Integration bugs found by the app spec:** a stop button shown for a 150 ms reply lingered in main's health cache and rejected the next Send (`view_busy`) — main now re-reads health before rejecting and the adapter republishes on DOM mutations; the fake site minted a new chat id per submit (real sites keep it) — fixed. **Live (user):** item 15 pass; items 16–22 pending the user's run on the built app. |
| `S7` | 2026-09-17 | Stage 3: Analyze/Fusion in the desktop — the hidden analyst page on a chosen login (`analyst-views.js`, always observes, auto-revealed on a challenge), the drawer (Analyze / Fusion / Captured / Settings + the analyst chooser), the desktop catalog and the `ollama:` transport, markdown-preserving capture (`toMarkdown`), and DARK MODE (user request: a dark palette beside the light one in `index.css`, switched by `data-theme` with `prefers-color-scheme` as the default; the site views follow through Electron's `nativeTheme.themeSource` — Triplex never injects CSS into a page it does not own). **Gate:** pytest 1547, vitest 431 + builds, desktop unit 403 + adapters 114, app spec 18/18 on DISPLAY=:1. **Review (4 lenses, 22 agents):** confirmed — Fusion's convergence retry re-typed its whole payload into a NEW hidden analyst chat after an empty reply (the web no-retry rule was Analyze-only; now central in `client.complete_json`, one frame per round), and a paragraph above a code block could be deleted from a capture; 13 minors landed (markdown fidelity, analyst lifecycle, meter wording, a loopback warning for a remote `OLLAMA_BASE_URL`). Seven findings were contested and refuted. **Live findings (user testing, the value of Stage 4 arriving early):** (1) chatgpt.com mounts a ~12-char placeholder reply, UNMOUNTS the container for ~10 s, then remounts the real one — observe held the detached node, froze at the placeholder and could only end by timeout; fixed by dropping a disconnected container, by not applying the first-token deadline once a container has been seen, and by bounding that gap with the capture budget (the last one found by the regression-test pass, mutation-checked). (2) chatgpt.com records a PLACEHOLDER chat URL `/c/WEB:<uuid>` while the first reply streams; it 404s on a revisit, so `chatUrlPattern` now ends the id at the segment (applied to grok for symmetry). (3) Analyze said "waiting for all three responses" for replies that were finished-but-uncaptured or failed; it now names the slots, the cause and the fix (a new Send). (4) The drawer rendered a blank slab with no conversation selected. **Checklist:** 16, 17, 28 (chatgpt) pass; 18 fixed and awaiting a user re-run. |
| `S10` | 2026-09-20 (`4171a1c`, `914e7e1`, `475b71b`) | Analyze at raised effort — the capture must not end mid-reply, and the analyst wait must be sized for THINKING. Trigger: the user raised reasoning effort inside ChatGPT and Claude, and Analyze degraded every time with `parse_error: no JSON object found in the response`, having compared a 13-character fragment stamped `ok`. **Capture (A):** all three end signals now sit inside one `endSeen === null && !isBlank(text)` gate (only `quiet` had it); the stillness clocks FREEZE across chatgpt's measured ~10 s container gap and `findStop()` is sampled with no container so the button can still withdraw a pending signal; a container swap resets `lastText`/`endSeen`/`endSeenAt`/`lastChangeAt`; `settleMs` became a per-site selector value (chatgpt 1200, others 400). **Shape gate (B):** `looksComplete(text, expect)` plus `observe({expect})` — an end signal cannot resolve while a `json` answer's braces do not balance, gated on `STRUCTURED_PURPOSES` (extraction/defense/convergence) so Fusion's defense replies are covered and a pane's prose chat is not. An unmet shape now FAILS with the prose as the partial, bounded by `incompleteGraceMs` rather than the whole budget. **Split (D):** over `SPLIT_MIN_CHARS` (12,000) of quoted replies each label is condensed on its own first (`purpose="extraction"`, JSON claims, no new schema or event type), a reply over `REPLY_BUDGET_CHARS` (30,000) degrades loudly naming the label with no analyst call, and the condensed set is RE-MEASURED (`condense_ineffective`) so three sub-calls that shrink nothing cannot spend a fourth to fail the same way. **Thinking (2026-09-20, the second live round):** two live runs came back `chars=0` at 302 s and 572 s while read-only probes showed ChatGPT had answered both correctly (5,847 / 5,614 chars of valid claims JSON). **Ruled out and not to be re-diagnosed:** a hidden analyst `WebContentsView` really does keep Electron's default 0×0 bounds (`layout.applyLayout` gives a hidden view only `setVisible(false)`), but a 0×0 view reads the same 5,621 characters from that chat as a 1200×800 one. The cause is that with a reasoning mode on inside chatgpt.com the assistant container mounts EARLY and stays EMPTY for as long as the model thinks — over 570 s straight with the stop control visible — and 570 s was simply the most a 600 s bridge grant allowed. Fixed by `BRIDGE_ANALYST_TIMEOUT_S` (1800 s, floored at `BRIDGE_TIMEOUT_S`) for `view: analyst`, `ANALYST_CAPTURE_PATIENCE` scaling the overall budget separately from the lull windows (analyst capture 570 s → 1200 s), a ceiling that also leaves room for main's own ~44 s of navigate/compose/submit, and an empty-container-at-budget message that distinguishes "still working (stop control up)" from "never showed a stop control". **Observability (E):** `bridge … done_by=<signal> chars=<n>` and one orchestrator line per capture. **Deviation from the plan (C1):** the re-read landed INSIDE `observe` (one final re-sample before failing an incomplete expected answer), not as a backend-initiated `reread` request. A new bridge request kind would mean editing `desktop/protocol/bridge-v1.json` and `bridge_protocol.py`, which the same plan freezes; and the case it was designed for — a fragment reaching the backend and failing to parse — is exactly what the shape gate now makes impossible, while re-reading the same DOM with the same extractor returns the same string. **Gate:** pytest 1685 (18 snapshots unchanged, so a normal conversation still takes exactly one analyst call), vitest 555, desktop unit 510, adapters 131, app spec 20/20 on DISPLAY=:1 (own port set: `TRIPLEX_FAKE_PORT` 5198 / `VITE_PORT` + `TRIPLEX_RENDERER_URL` 5185 / `TRIPLEX_BACKEND_PORT` + `TRIPLEX_BACKEND_URL` 8022 — the spec reads the two URL vars, not the port vars alone). **Live:** the split path verified end to end against a real (free) analyst — 19,065 chars of replies → condensations of 1,205/1,292/1,371 → 3,868 total, under the threshold, with `condense_failure` naming R1 exercised for real on a provider error. The web-transport Analyze re-run is still pending the user, who alone can type into their own ChatGPT account. **Separate defect found while verifying, NOT the desktop failure:** on the OpenRouter path a reasoning analyst can spend all of `MAX_TOKENS_STAGE["extraction"]` (4,000) on reasoning tokens before emitting any JSON, producing the identical `parse_error` message (measured: 4,615 reasoning tokens → truncated, retry at 1,886 → ok; 4,650 and 4,555 → degraded on both attempts). Correlational, not controlled — the free provider went 503 before the raised-budget probe completed. The web transport deletes `max_tokens` ("the site decides"), so it cannot explain the desktop failure; left unchanged because `MAX_TOKENS_STAGE` is in frozen `config.py` and three tests pin 4,000 deliberately. |
