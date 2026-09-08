#!/usr/bin/env bash
# Triplex dev launcher: backend (uv) + frontend (vite). Ctrl-C stops both.
#   MOCK_OPENROUTER=1 MOCK_SCENARIO=planted_factual MOCK_DELAY_MS=20 ./start.sh   # offline demo
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export PORT="${PORT:-${BACKEND_PORT:-8001}}"
export BACKEND_PORT="$PORT"
export VITE_PORT="${VITE_PORT:-5173}"
[ "${MOCK_OPENROUTER:-0}" = "1" ] && echo "[triplex] MOCK mode, scenario=${MOCK_SCENARIO:-planted_factual}"
uv run python -m backend.main &
BACK=$!
sleep 2
( cd frontend && npm run dev -- --port "$VITE_PORT" --strictPort ) &
FRONT=$!
trap 'kill $BACK $FRONT 2>/dev/null || true' INT TERM EXIT
echo "[triplex] backend  http://127.0.0.1:$BACKEND_PORT"
echo "[triplex] frontend http://localhost:$VITE_PORT"
wait
