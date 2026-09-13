---
id: TASK-3
title: >-
  Fix CI: Docker (build + smoke) job fails in image build (README.md missing for
  pip install -e .)
status: Done
assignee: []
created_date: '2026-09-13 19:30'
updated_date: '2026-09-13 20:42'
labels:
  - ci
dependencies: []
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Unmasked by TASK-2 (PR #3): the Docker job needs the backend job and had been skipped on every main run since 2026-08-28, so it never ran. First run fails in 'Build image': Dockerfile lines 42-44 copy only pyproject.toml and backend/__init__.py before 'pip install -e .', but pyproject declares readme = README.md, so hatchling raises 'OSError: Readme file does not exist: README.md' (and the editable-metadata hook error follows). Fix: COPY README.md alongside pyproject.toml (or drop the readme field for the image build), then confirm the smoke step passes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docker (build + smoke) job green on a PR and on main
<!-- AC:END -->
