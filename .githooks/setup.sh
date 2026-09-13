#!/bin/sh
# One-time per clone: enable the branch guard and mark the standing external-write allowlist active.
#   sh .githooks/setup.sh
# Idempotent. Works in Git Bash on Windows. Undo: git config --unset core.hooksPath; rm -rf .worktrees
set -e
root=$(git rev-parse --show-toplevel); cd "$root"
git config core.hooksPath .githooks
echo "hooksPath: $(git config core.hooksPath)"
task=$(ls backlog/tasks 2>/dev/null | grep -i 'standing-allowlist' | head -1 || true)
if [ -n "$task" ]; then
  id=$(grep -m1 '^id:' "backlog/tasks/$task" | awk '{print $2}')
  mkdir -p .worktrees && printf '%s\n' "$id" > .worktrees/.active-task
  echo "active task sentinel: $id (.worktrees/.active-task, untracked)"
else
  echo "no standing allowlist task found under backlog/tasks; sentinel not written"
fi
for h in .githooks/pre-commit .githooks/pre-push; do [ -x "$h" ] || { chmod 755 "$h" 2>/dev/null || true; }; done
echo "done"
