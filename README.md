# Triplex

A three-slot model council — **Claude / ChatGPT / Grok** via OpenRouter — with three separately
triggered features: **Send** (parallel, streamed, per-slot threads), **Analyze** (agreements and
divergences as strict JSON) and **Fusion** (an iterative defend/revise loop with a user-set
iteration cap; stalemate is a valid outcome). Bench instrument, not a product.

`PLAN.md` is the spec; `CLAUDE.md` has the technical notes; `docs/` holds the frozen contracts.

## Run

```bash
cp .env.example .env            # add OPENROUTER_API_KEY
uv sync && (cd frontend && npm ci)
./start.sh                      # backend :8001, frontend :5173
MOCK_OPENROUTER=1 MOCK_SCENARIO=planted_factual MOCK_DELAY_MS=20 ./start.sh   # offline demo
```

## Test

```bash
uv run pytest -q                       # offline: unit, feature, e2e, golden, fuzz, leak tests
cd frontend && npm test && npm run build && npx playwright test
uv run pytest -m live                  # manual live smoke test (needs the key; never in CI)
```
