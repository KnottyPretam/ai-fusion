#!/usr/bin/env bash
# Usage: scripts/check_freeze.sh <branch> <owned-prefix>... ['!<excluded-prefix>' ...]
#   e.g. scripts/check_freeze.sh worktree-w1 backend/llm/ '!backend/llm/fixtures/scenarios/' backend/routers/models.py tests/llm/
# Fails if <branch> (relative to its merge-base with main) touched a frozen path or a path outside
# the given ownership prefixes. A '!prefix' carves an exclusion out of an earlier positive prefix.
# Run by the integrator before every merge.
set -euo pipefail
branch="$1"; shift
base=$(git merge-base main "$branch")
changed=$(git diff --name-only "$base" "$branch")
frozen='^(backend/(schemas|config|main|sse|api_errors)\.py|backend/[a-z_]+/__init__\.py|pyproject\.toml|uv\.lock|\.python-version|frontend/(package\.json|package-lock\.json|vite\.config\.js|index\.html|playwright\.config\.js)|frontend/src/(App\.jsx|main\.jsx|index\.css|App\.css|test-setup\.js|smoke\.test\.jsx)|frontend/src/(state|api)/|tests/conftest\.py|tests/helpers\.py|tests/test_schemas\.py|tests/test_smoke\.py|tests/test_config\.py|tests/test_prompts\.py|tests/test_session_route\.py|docs/|scripts/check_freeze\.sh|start\.sh|README\.md|PLAN\.md|CLAUDE\.md|\.env\.example|\.gitignore)'
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
