#!/bin/sh
# One-time per clone: enable the branch guard.
#   sh .githooks/setup.sh
# Idempotent. Works in Git Bash on Windows. Undo: git config --unset core.hooksPath
set -e
root=$(git rev-parse --show-toplevel); cd "$root"
git config core.hooksPath .githooks
echo "hooksPath: $(git config core.hooksPath)"
for h in .githooks/pre-commit .githooks/pre-push; do [ -x "$h" ] || { chmod 755 "$h" 2>/dev/null || true; }; done
echo "done"
