---
id: doc-1
title: handoff-2026-09-14-claude
type: other
created_date: '2026-09-13 19:31'
---


## Goal
TASK-2: make the backend CI jobs green (test_filter_options_warns_on_uncovered_source failing on a PFLOW_HOME warning).

## Done
- Root cause: `backend.config.get_pflow_home()` caches only successes; in CI neither `PFLOW_HOME=/tmp/fake-pflow-home` nor `~/Dropbox/PFLOW` exists, so every call re-warned and the endpoint printed one warning per request.
- Fix: warn once per process (module flag `_pflow_home_env_warned`). Regression tests in `tests/test_config.py` (no-fallback and fallback cases).
- Checklist: 241 passed under CI-like env, 242 normal, ruff clean, vitest 120 passed.
- PR #3 opened by Claude Code; Codex reviewed independently (approved, no findings) and the verdict is posted on the PR.
- CI on PR #3: Backend py3.11 and py3.12 green, Frontend green, sources.yaml validation green.

## Files changed
`backend/config.py`, `tests/test_config.py`, this handoff, backlog TASK-2 (In Progress) and new TASK-4.

## Verify next
- Merge PR #3 (human). After merge, mark TASK-2 Done (its acceptance criterion is green on main).
- The Docker (build + smoke) job now runs for the first time and fails in the image build: TASK-4.
- Operator follow-up outside agent scope: `ci.yml` sets PFLOW_HOME to a path that never exists; a `mkdir -p` before pytest would match the comment's intent.

## Open questions
None for this task.

## Who owns next
Human: merge #3, decide on TASK-4 priority. Any harness: TASK-4 on a new branch.
