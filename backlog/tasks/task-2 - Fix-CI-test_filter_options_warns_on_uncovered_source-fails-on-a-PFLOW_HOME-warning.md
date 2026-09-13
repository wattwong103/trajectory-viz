---
id: TASK-2
title: >-
  Fix CI: test_filter_options_warns_on_uncovered_source fails on a PFLOW_HOME
  warning
status: Done
assignee: []
created_date: '2026-09-13 18:42'
updated_date: '2026-09-13 19:37'
labels:
  - ci
dependencies: []
priority: medium
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pre-existing on main (red since 2026-08-28). tests/test_endpoints.py::test_filter_options_warns_on_uncovered_source asserts empty stdout but the app prints '[WARN] PFLOW_HOME=/tmp/fake-pflow-home does not exist, falling back to auto-detect'. Either silence the warning under the test fixture or assert on it explicitly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Backend (py3.11, py3.12) jobs green on main
<!-- AC:END -->
