#!/usr/bin/env bash
# Usage: scripts/check_freeze.sh <branch> <owned-path-prefix>...
# Fails if <branch> (relative to its merge-base with main) touched a frozen path or a path
# outside the given ownership prefixes. Run by the integrator before every merge.
set -euo pipefail
branch="$1"; shift
base=$(git merge-base main "$branch")
changed=$(git diff --name-only "$base" "$branch")
frozen='^(backend/(schemas|config|main|sse|api_errors)\.py|backend/[a-z_]+/__init__\.py|pyproject\.toml|uv\.lock|\.python-version|frontend/(package\.json|package-lock\.json|vite\.config\.js|index\.html|playwright\.config\.js)|frontend/src/(App\.jsx|main\.jsx|index\.css|App\.css|test-setup\.js)|frontend/src/(state|api)/|tests/conftest\.py|tests/test_schemas\.py|tests/test_smoke\.py|docs/|PLAN\.md|CLAUDE\.md)'
rc=0; n=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  n=$((n+1))
  if echo "$f" | grep -Eq "$frozen"; then echo "FROZEN FILE TOUCHED: $f"; rc=1; continue; fi
  ok=0
  for p in "$@"; do case "$f" in $p*) ok=1;; esac; done
  [ "$ok" = 1 ] || { echo "OUTSIDE OWNERSHIP: $f"; rc=1; }
done <<< "$changed"
[ "$rc" = 0 ] && echo "freeze check OK for $branch ($n files)"
exit $rc
