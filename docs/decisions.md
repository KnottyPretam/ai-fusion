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

