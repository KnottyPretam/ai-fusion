#!/usr/bin/env bash
# scripts/desktop.sh — run the Triplex desktop app in built mode (Stage 2+).
#
#   scripts/desktop.sh                 # build the renderer for /app/ and start Electron on DISPLAY
#   TRIPLEX_BACKEND_URL=http://127.0.0.1:8021 scripts/desktop.sh   # attach to a backend you started yourself
#
# What it does: `cd frontend && VITE_BASE=/app/ npm run build` (the renderer is served by the desktop
# backend at http://127.0.0.1:<TRIPLEX_BACKEND_PORT>/app/ from TRIPLEX_APP_DIR=frontend/dist), then
# `cd desktop && npx electron .`. From Stage 2 Electron spawns the backend itself (desktop/main/backend.js:
# `.venv/bin/python -m backend.main` on 8021 with DATA_DIR=<userData>/data, TRIPLEX_DESKTOP=1 and a
# per-launch BRIDGE_TOKEN) unless TRIPLEX_BACKEND_URL attaches to an external one. TRIPLEX_RENDERER_URL is
# deliberately left unset here (its default is the backend's /app/); scripts/desktop_dev.sh is the Vite variant.
# Every other TRIPLEX_* / OLLAMA_* key passes through untouched — see docs/desktop-contract.md §5.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "desktop.sh: DISPLAY is not set (Electron needs a display, e.g. DISPLAY=:1)" >&2
  exit 2
fi
[ -d "$root/frontend/node_modules" ] || { echo "desktop.sh: frontend/node_modules missing — run 'cd frontend && npm ci'" >&2; exit 2; }
[ -d "$root/desktop/node_modules/electron" ] || { echo "desktop.sh: desktop/node_modules/electron missing — run 'cd desktop && npm ci'" >&2; exit 2; }
[ -x "$root/.venv/bin/python" ] || [ -n "${TRIPLEX_BACKEND_URL:-}" ] || echo "desktop.sh: warning: .venv/bin/python missing (run 'uv sync'); Electron will fall back to 'uv run'" >&2

if [ "${TRIPLEX_SKIP_BUILD:-0}" != "1" ]; then
  echo "desktop.sh: building the renderer for /app/"
  ( cd frontend && VITE_BASE=/app/ npm run build --silent )
fi
export TRIPLEX_APP_DIR="${TRIPLEX_APP_DIR:-$root/frontend/dist}"
unset TRIPLEX_RENDERER_URL
echo "desktop.sh: launching Electron (DISPLAY=${DISPLAY:-wayland}) — renderer from TRIPLEX_APP_DIR=$TRIPLEX_APP_DIR"
cd desktop && exec npx electron .
