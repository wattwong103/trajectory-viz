---
id: TASK-3
title: >-
  Fix CI: Docker (build + smoke) job fails in image build (README.md missing for
  pip install -e .)
status: To Do
assignee: []
created_date: '2026-09-13 19:30'
labels:
  - ci
dependencies: []
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Unmasked by TASK-2 (PR #3): the Docker job needs the backend job and had been skipped on every main run since 2026-08-28, so it never ran. First run fails in 'Build image': pip install -e . raises 'OSError: Readme file does not exist: README.md' (hatchling reads pyproject readme) plus 'hatchling.build has no attribute prepare_metadata_for_build_editable'. Likely the Dockerfile copies pyproject.toml before README.md, or pins an old hatchling. Fix the Dockerfile COPY order or pin hatchling, then confirm the smoke step passes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docker (build + smoke) job green on a PR and on main
<!-- AC:END -->
