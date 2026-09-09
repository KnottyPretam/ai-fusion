#!/usr/bin/env bash
# Stage 4 — live validation runbook (PLAN.md §8 Phase 0 AC, Phase 5 AC, R6). One command once
# ~/dev/ai-fusion/.env holds OPENROUTER_API_KEY. Spend is bounded by SESSION_COST_CAP_USD (10)
# and the per-step budgets below. Never run in CI.
#
#   scripts/stage4.sh            # run everything
#   scripts/stage4.sh --no-record  # skip the fixture recording step
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
if ! grep -qsE '^OPENROUTER_API_KEY=.+' .env; then
  echo "stage4: OPENROUTER_API_KEY missing from .env — create it with:" >&2
  echo "  printf 'OPENROUTER_API_KEY=sk-or-...\\n' > .env" >&2
  exit 2
fi
if [ "${MOCK_OPENROUTER:-0}" = "1" ]; then echo "stage4: unset MOCK_OPENROUTER for live runs" >&2; exit 2; fi
STAMP=$(date +%Y%m%d-%H%M%S)
REC=data/recordings/$STAMP
mkdir -p "$REC" docs/screenshots
echo "== 1/4 live smoke (scripts/live_smoke.py, budget \$0.50, recorded to $REC/smoke)"
uv run python scripts/live_smoke.py --budget-usd 0.5 --record "$REC/smoke" | tee "$REC/live_smoke.log"
echo "== 2/4 live test suite (tests/live, cumulative < \$0.50)"
uv run pytest -m live -rs tests/live -q 2>&1 | tee "$REC/pytest-live.log" | tail -5
if [ "${1:-}" != "--no-record" ]; then
  echo "== 3/4 record a real Send -> Analyze -> Fusion(2) scenario (budget \$2)"
  uv run python scripts/record_fixtures.py --scenario "live_$STAMP" --fixtures-dir "$REC" --max-iterations 2 --budget-usd 2 | tee "$REC/record.log"
  echo "   replay it: MOCK_OPENROUTER=1 MOCK_FIXTURES_DIR=$REC MOCK_SCENARIO=live_$STAMP ./start.sh"
fi
echo "== 4/4 session cost"
uv run python -c 'from backend.llm import metering; print(metering.session_cost_status())'
cat <<MSG
Next (manual): ./start.sh  then drive Send -> Analyze -> Fusion in the browser on a planted
disagreement prompt; screenshot to docs/screenshots/live-*.png; note the observed cost and the
streaming placement of web-search annotations in docs/openrouter-notes.md; tick the three
pending items in PLAN.md (R6, Phase 0 transcripts, Phase 5 grounded AC).
MSG
