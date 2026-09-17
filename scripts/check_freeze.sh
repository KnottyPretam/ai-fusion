#!/usr/bin/env bash
# Usage: scripts/check_freeze.sh <branch> <owned-prefix>... ['!<excluded-prefix>' ...]
#        scripts/check_freeze.sh --list
#   e.g. scripts/check_freeze.sh worktree-w1 backend/llm/ '!backend/llm/fixtures/scenarios/' backend/routers/models.py tests/llm/
#        scripts/check_freeze.sh electron-main desktop/main/ desktop/test/unit/main/ desktop/test/app/app.spec.js
#        echo desktop/protocol/bridge-v1.json | grep -Eq "$(scripts/check_freeze.sh --list)" && echo frozen
# Fails if <branch> (relative to its merge-base with main) touched a frozen path or a path outside
# the given ownership prefixes. A '!prefix' carves an exclusion out of an earlier positive prefix.
# '--list' (first argument) prints the frozen-path regex (extended, anchored at ^) and exits 0 so
# other tooling can test a path against the same rule. Run by the integrator before every merge.
#
# Frozen since contract-v1: the shared backend/frontend/tests files, docs/, this script, start.sh,
# README.md, PLAN.md, CLAUDE.md, .env.example, .gitignore.
# Frozen since S4 (desktop pivot, docs/desktop-contract.md §8): desktop/{package.json,package-lock.json,
# playwright.config.js}, desktop/preload/renderer.cjs, desktop/protocol/, frontend/src/{DesktopApp.jsx,
# DesktopApp.css,desktop-smoke.test.jsx}, backend/llm/bridge_protocol.py. Integrator-only by ownership
# (not by this regex): scripts/desktop_dev.sh, scripts/desktop.sh, desktop/preload/site.cjs stubs etc.
# — see the ownership table in the plan and the "previously untouched but now owned" list in CLAUDE.md.
set -euo pipefail
frozen='^(backend/(schemas|config|main|sse|api_errors)\.py|backend/[a-z_]+/__init__\.py|pyproject\.toml|uv\.lock|\.python-version|frontend/(package\.json|package-lock\.json|vite\.config\.js|index\.html|playwright\.config\.js)|frontend/src/(App\.jsx|main\.jsx|index\.css|App\.css|test-setup\.js|smoke\.test\.jsx)|frontend/src/(state|api)/|tests/conftest\.py|tests/helpers\.py|tests/test_schemas\.py|tests/test_smoke\.py|tests/test_config\.py|tests/test_prompts\.py|tests/test_session_route\.py|docs/|scripts/check_freeze\.sh|start\.sh|README\.md|PLAN\.md|CLAUDE\.md|\.env\.example|\.gitignore|desktop/(package\.json|package-lock\.json|playwright\.config\.js)|desktop/preload/renderer\.cjs|desktop/protocol/|frontend/src/(DesktopApp\.jsx|DesktopApp\.css|desktop-smoke\.test\.jsx)|backend/llm/bridge_protocol\.py)'
if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "$frozen"
  exit 0
fi
if [ $# -lt 1 ]; then
  echo "usage: scripts/check_freeze.sh <branch> <owned-prefix>... ['!<excluded-prefix>' ...]  |  scripts/check_freeze.sh --list" >&2
  exit 2
fi
branch="$1"; shift
base=$(git merge-base main "$branch")
changed=$(git diff --name-only "$base" "$branch")
rc=0; n=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  n=$((n+1))
  if echo "$f" | grep -Eq "$frozen"; then echo "FROZEN FILE TOUCHED: $f"; rc=1; continue; fi
  ok=0
  for p in "$@"; do
    case "$p" in
      !*) case "$f" in "${p#!}"*) ok=0;; esac;;
      *)  case "$f" in "$p"*) ok=1;; esac;;
    esac
  done
  [ "$ok" = 1 ] || { echo "OUTSIDE OWNERSHIP: $f"; rc=1; }
done <<< "$changed"
[ "$rc" = 0 ] && echo "freeze check OK for $branch ($n files)"
exit $rc
