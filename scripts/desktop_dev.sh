#!/usr/bin/env bash
# scripts/desktop_dev.sh — run the Triplex desktop shell in dev mode (Stage 0/1: renderer only, no backend).
#
#   scripts/desktop_dev.sh              # Vite on :5184 + Electron (desktop/) in the foreground
#   DISPLAY=:1 scripts/desktop_dev.sh   # pick the X display; the script honours DISPLAY and never overrides it
#
# What it does: starts the Vite dev server from frontend/ on VITE_PORT=5184 with BACKEND_PORT=8021 (the
# /api proxy target — nothing listens there before Stage 2), waits for http://localhost:5184 (curl loop,
# at most 30 s), then runs `cd desktop && TRIPLEX_RENDERER_URL=http://localhost:5184 npx electron .` in
# the foreground. Vite is killed when Electron exits (EXIT/INT/TERM trap).
#
# Stage 2 makes Electron spawn the backend itself (desktop/main/backend.js: `.venv/bin/python -m backend.main`
# on :8021 with DATA_DIR=<userData>/data, TRIPLEX_DESKTOP=1 and a per-launch BRIDGE_TOKEN, `uv run` fallback,
# or attach to TRIPLEX_BACKEND_URL). scripts/desktop.sh (Stage 2) is the built variant: `VITE_BASE=/app/ npm run
# build` and the renderer served by that backend at http://127.0.0.1:8021/app/. This script stays backend-free.
#
# Every other TRIPLEX_* key (TRIPLEX_USER_DATA_DIR, TRIPLEX_SITES_JSON, TRIPLEX_GROK_SURFACE, TRIPLEX_SELECTORS_FILE,
# TRIPLEX_CHROMIUM_FLAGS, TRIPLEX_DISABLE_GPU, ...) passes through to Electron untouched — docs/desktop-contract.md §5.
# Prerequisites: `cd frontend && npm ci` and `cd desktop && npm ci` (the Electron binary; integrator's box only —
# worktree agents never run this script, never launch Electron and never start servers except the fake site on 5199).
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

export VITE_PORT="${VITE_PORT:-5184}"
export BACKEND_PORT="${BACKEND_PORT:-8021}"
renderer_url="http://localhost:${VITE_PORT}"

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "desktop_dev.sh: DISPLAY is not set (Electron needs a display, e.g. DISPLAY=:1)" >&2
  exit 2
fi
[ -d "$root/frontend/node_modules" ] || { echo "desktop_dev.sh: frontend/node_modules missing — run 'cd frontend && npm ci'" >&2; exit 2; }
[ -d "$root/desktop/node_modules/electron" ] || { echo "desktop_dev.sh: desktop/node_modules/electron missing — run 'cd desktop && npm ci'" >&2; exit 2; }

vite_pid=""
cleanup() {
  if [ -n "$vite_pid" ] && kill -0 "$vite_pid" 2>/dev/null; then
    echo "desktop_dev.sh: stopping Vite (pid $vite_pid)"
    # setsid gave Vite its own process group: kill npx + vite + esbuild together, then fall back to the pid.
    kill -- "-$vite_pid" 2>/dev/null || kill "$vite_pid" 2>/dev/null || true
    wait "$vite_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "desktop_dev.sh: starting Vite on ${renderer_url} (proxy /api -> http://127.0.0.1:${BACKEND_PORT})"
(cd "$root/frontend" && exec setsid npx vite --port "$VITE_PORT" --strictPort) &
vite_pid=$!

up=0
for _ in $(seq 1 60); do                      # 60 × 0.5 s = 30 s
  if curl -fsS -o /dev/null "${renderer_url}/"; then up=1; break; fi
  kill -0 "$vite_pid" 2>/dev/null || { echo "desktop_dev.sh: Vite exited before it became reachable" >&2; exit 1; }
  sleep 0.5
done
[ "$up" = 1 ] || { echo "desktop_dev.sh: ${renderer_url} not reachable after 30 s" >&2; exit 1; }

echo "desktop_dev.sh: launching Electron (DISPLAY=${DISPLAY:-unset}) with TRIPLEX_RENDERER_URL=${renderer_url}"
cd "$root/desktop"
TRIPLEX_RENDERER_URL="$renderer_url" npx electron .
