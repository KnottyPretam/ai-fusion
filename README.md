# Solomon's Judgement

A three-slot model council — **Claude / ChatGPT / Grok** via OpenRouter — with three separately
triggered features: **Send** (parallel, streamed, per-slot threads), **Analyze** (agreements and
divergences as strict JSON) and **Fusion** (an iterative defend/revise loop with a user-set
iteration cap; stalemate is a valid outcome). Bench instrument, not a product.

The app is **Solomon's Judgement** to anyone using it — the window, the menu, the taskbar icon
and every exported document. `triplex` stays the codename in the code: `window.triplex`, the
`TRIPLEX_*` variables, the `triplex.*` storage keys, the python package, the `data-testid`s and
the userData directory `~/.config/triplex-desktop`, which holds the three logged-in sessions and
must not move. The one string lives in `desktop/main/branding.js`, `frontend/src/branding.js` and
the backend's `APP_TITLE`.

`PLAN.md` is the spec; `CLAUDE.md` has the technical notes; `docs/` holds the frozen contracts
(`api-contract.md`, `semantics.md`, `fixtures.md`) and the build log (`decisions.md`).

## Run

```bash
cp .env.example .env            # add OPENROUTER_API_KEY (live only)
uv sync && (cd frontend && npm ci)
./start.sh                      # live: backend http://127.0.0.1:8001, frontend http://localhost:5173
MOCK_OPENROUTER=1 MOCK_SCENARIO=planted_factual MOCK_DELAY_MS=20 ./start.sh   # offline demo, no key needed
```

The offline demo replays a committed scenario through the real code paths. Every scenario
(`planted_factual`, `stalemate`, `standing_at_cap`, `analyst_degrade`, `truncated`, `grounded`,
`injection`, …) is listed with its planted content and expected outcome in the table in
`docs/fixtures.md`; each `backend/llm/fixtures/scenarios/<name>/README.md` gives the prompt to type
and the exact per-role call sequence. In mock mode R1=claude, R2=chatgpt, R3=grok. Screenshots of
the flow and of every scenario are in `docs/screenshots/`.

## Desktop app (your own ChatGPT / Claude / Grok logins)

`desktop/` is an Electron 44 app that embeds the real chatgpt.com, claude.ai and grok.com web apps —
each signed in with your own consumer subscription, no API key, no OpenRouter credits — in **tabs**
(one site at a time) or **split** (all three side by side), with **one prompt bar** that types the same
request into every selected site and submits it. The Triplex pipeline is kept: from Stage 2 the unified
prompt is a Triplex Send whose transport is the site page (`web:chatgpt` …, a WebSocket bridge from the
backend to Electron; the site's own chat is the per-slot thread), and from Stage 3 Analyze and Fusion run
through the same logins with a hidden analyst page (ChatGPT by default; Claude, Grok or local Ollama
`hermes3` selectable). OpenRouter is not removed: it stays the mock/offline path and the web app above is
unchanged. Contracts: `docs/desktop-contract.md`; live checklist: `docs/desktop-verification.md`;
rationale and stage log: `docs/decisions.md` ("Desktop pivot").

**Terms of service.** Capture — reading a reply out of the page into Triplex — is **off by default, per
site**, and is switched on from each pane's header next to this wording. Typing a prompt into a site's own
composer is the least exposed act; reading the reply out of the DOM is what the consumer terms name
(OpenAI: "automatically or programmatically extract data or Output"; Anthropic: no access "through
automated or non-human means" outside the API; xAI: no automated access beyond a conventional browser).
Triplex keeps the stock Electron user agent, uses no stealth scripts, no CDP and no private APIs, makes one
human-paced request per pane through the real UI, never retries on its own, and stops with a coded error on
a Cloudflare challenge or an "Unusual activity" notice. Analyze and Fusion need capture on for the sites
they read; the Ollama analyst keeps that step local. Flip the switches knowing this.

```bash
scripts/desktop_dev.sh              # dev: Vite on :5184 + Electron (needs DISPLAY; Stage 0/1: no backend, nothing read back)
scripts/desktop.sh                  # built (Stage 2): frontend/dist served by the desktop backend at http://127.0.0.1:8021/app/
cd desktop && npm test              # unit tests;  npx playwright test --project adapters → fake site on :5199, system Chrome
```

Sessions and settings live in `~/.config/triplex-desktop/` (`Partitions/` per site, `settings.json`,
`chats.json`, a `selectors.json` override with hot reload, `snapshots/` — the last three arrive with Stages 1–2). Ports: desktop backend 8021,
Vite 5184, fake site 5199 — the web app keeps 8001/5173 (and 8011/5174 for its Playwright run).

**Stage status: Stage 0 (S4): scaffold** — Electron shell with the three login pages, frozen contracts,
hidden-insert spike. Next: Stage 1 (S5) shell v1, Stage 2 (S6) capture + bridge, Stage 3 (S7)
Analyze/Fusion + analyst + Ollama, Stage 4 (S8) logged-in verification and selector calibration.

## Test

```bash
uv run pytest -q                                   # 1279 offline tests; outbound HTTP blocked
cd frontend && npm test && npm run build           # vitest (268) + production build
cd frontend && npx playwright test                 # browser flow in mock mode, system Chrome, ports 8011/5174
```

Scenario-gated Playwright specs skip unless the servers were started with their scenario, so run
each on its own ports (one scenario per invocation; screenshots land in `docs/screenshots/`):

```bash
cd frontend
MOCK_SCENARIO=stalemate       BACKEND_PORT=8012 VITE_PORT=5175 npx playwright test e2e/stalemate.spec.js
MOCK_SCENARIO=standing_at_cap BACKEND_PORT=8013 VITE_PORT=5176 npx playwright test e2e/cap.spec.js
MOCK_SCENARIO=analyst_degrade BACKEND_PORT=8014 VITE_PORT=5177 npx playwright test e2e/degrade.spec.js
MOCK_SCENARIO=truncated       BACKEND_PORT=8015 VITE_PORT=5178 npx playwright test e2e/truncated.spec.js
MOCK_SCENARIO=grounded        BACKEND_PORT=8016 VITE_PORT=5179 npx playwright test e2e/grounded.spec.js
MOCK_DELAY_MS=200             BACKEND_PORT=8017 VITE_PORT=5180 npx playwright test e2e/guard.spec.js
```

### Live (manual, needs a key)

Prerequisites: `OPENROUTER_API_KEY` in `.env` (gitignored), a network path to `openrouter.ai`,
and a cost cap you accept (`SESSION_COST_CAP_USD`, default 10 — the backend refuses every live
call once the process has spent it). Nothing below runs in CI or in the default `pytest` run.

```bash
uv run pytest -m live -rs tests/live                          # 9 budgeted checks; cumulative cost asserted < $0.50; skipped without a key
uv run python scripts/live_smoke.py [--record DIR] [--budget-usd 0.5]
uv run python scripts/record_fixtures.py --scenario <name> [--grounded] [--max-iterations N]
```

`live_smoke.py` exercises the catalog, one call per slot at the configured effort, the analyst's
strict-JSON extraction and one grounded call (exit 0/1/2/3 = ok / check failed / refused / budget
hit). `record_fixtures.py` records a real Send → Analyze → Fusion into
`data/recordings/scenarios/<name>` with the fixed anonymization map and writes a README skeleton;
replay it with `MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR=data/recordings MOCK_SCENARIO=<name> ./start.sh`.

## Stage 4 (live validation)

With `OPENROUTER_API_KEY` in `.env`: `scripts/stage4.sh` runs the live smoke test, the budgeted
`tests/live` suite and records a replayable real scenario under `data/recordings/<stamp>/`, all
under `SESSION_COST_CAP_USD`. It refuses to run without the key or with `MOCK_OPENROUTER=1`.
