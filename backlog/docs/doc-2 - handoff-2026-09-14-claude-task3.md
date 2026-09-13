---
id: doc-2
title: handoff-2026-09-14-claude-task3
type: other
created_date: '2026-09-13 20:31'
---


## Goal
TASK-3: make the Docker (build + smoke) CI job green.

## Done
- Root cause: the Dockerfile deps layer copied only pyproject.toml and backend/__init__.py before `pip install -e .`, while pyproject declares `readme = "README.md"`; hatchling aborted with "Readme file does not exist".
- Fix: copy README.md alongside pyproject.toml in that layer; drop the later duplicate copy.
- Evidence: scratch venv with the old layer's file set fails with the same error; with README.md it builds and installs 0.2.0a1. No local Docker daemon in either harness.
- PR #5 opened by Claude Code; Codex reviewed independently (approved, no findings); verdict posted on the PR.
- CI on PR #5: Docker (build + smoke) = (build.

## Files changed
Dockerfile, backlog TASK-3 (In Progress), this handoff.

## Verify next
Merge PR #5 (human); then mark TASK-3 Done and confirm the Docker job stays green on main.

## Open questions
None.

## Who owns next
Human: merge. Any harness: next task from the board.

Status: DONE
