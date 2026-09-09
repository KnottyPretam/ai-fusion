# Triplex

A three-slot model council — **Claude / ChatGPT / Grok** via OpenRouter — with three separately
triggered features: **Send** (parallel, streamed, per-slot threads), **Analyze** (agreements and
divergences as strict JSON) and **Fusion** (an iterative defend/revise loop with a user-set
iteration cap; stalemate is a valid outcome). Bench instrument, not a product.

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

## Test

```bash
uv run pytest -q                                   # 1102 offline tests; outbound HTTP blocked
cd frontend && npm test && npm run build           # vitest (255) + production build
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
