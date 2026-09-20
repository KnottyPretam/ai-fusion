#!/usr/bin/env bash
# scripts/package.sh — build an installable Solomon's Judgment for THIS platform.
#
#   scripts/package.sh                 # every Linux target: AppImage, deb, pacman
#   scripts/package.sh --linux deb     # just one
#   scripts/package.sh --win           # Windows installer (needs Wine on Linux; CI uses a
#                                      # windows runner, see .github/workflows/build.yml)
#   PACKAGE_SKIP_BACKEND=1 scripts/package.sh   # reuse the frozen backend from a previous run
#
# Three stages, each of which can be run on its own (see BUILD.md):
#   1. the renderer   frontend/dist, built with VITE_BASE=/app/ because the backend serves it there
#   2. the backend    build/pyinstaller/backend, a frozen interpreter + the FastAPI app
#   3. the app        build/dist/*, electron-builder wrapping the shell around both
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ -d "$root/frontend/node_modules" ] || { echo "package.sh: run 'cd frontend && npm ci' first" >&2; exit 2; }
[ -d "$root/desktop/node_modules" ] || { echo "package.sh: run 'cd desktop && npm ci' first" >&2; exit 2; }
command -v uv >/dev/null 2>&1 || [ -x "$root/.venv/bin/python" ] || {
  echo "package.sh: needs uv (or a .venv) to freeze the backend — https://docs.astral.sh/uv/" >&2; exit 2; }

say "1/3  renderer (VITE_BASE=/app/)"
( cd frontend && VITE_BASE=/app/ npm run build --silent )

if [ "${PACKAGE_SKIP_BACKEND:-0}" = "1" ] && [ -d "$root/build/pyinstaller/backend" ]; then
  say "2/3  backend — reusing build/pyinstaller/backend (PACKAGE_SKIP_BACKEND=1)"
else
  say "2/3  backend (PyInstaller — this is the slow one)"
  uv run --group packaging pyinstaller --noconfirm \
    --distpath "$root/build/pyinstaller" --workpath "$root/build/pyinstaller-work" \
    "$root/packaging/backend.spec"
fi
# The whole point of the bundle: it must answer without a Python on PATH.
backend_exe="$root/build/pyinstaller/backend/triplex-backend"
[ -x "$backend_exe" ] || backend_exe="$backend_exe.exe"
[ -x "$backend_exe" ] || { echo "package.sh: the frozen backend is missing from build/pyinstaller/backend" >&2; exit 1; }

say "3/3  app (electron-builder)"
cd desktop && exec npx electron-builder "$@"
