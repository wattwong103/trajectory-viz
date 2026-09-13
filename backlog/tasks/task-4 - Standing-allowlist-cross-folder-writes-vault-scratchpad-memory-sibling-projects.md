---
id: TASK-4
title: >-
  Standing allowlist: cross-folder writes (vault, scratchpad, memory, sibling
  projects)
status: In Progress
assignee: []
created_date: '2026-09-13 19:37'
labels:
  - standing
  - governance
dependencies: []
priority: low
ordinal: 4000
permittedExternalPaths:
  - /Users/north-mac/Dropbox
  - /private/tmp/claude-501
  - /Users/north-mac/.claude/projects
  - H:/Dropbox
  - D:/Dropbox
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Activated per clone by `sh .githooks/setup.sh`, which writes the untracked sentinel .worktrees/.active-task. Its permittedExternalPaths frontmatter is the only mechanism the ai-sdlc v0.20.1 Write/Edit hook offers for writes outside this repo. Keep status In Progress (backlog cleanup archives Done tasks; the hook only reads backlog/tasks/). Per-worktree sentinels written by the ai-sdlc execute pipeline take precedence, so pipeline tasks that write to the vault need these paths in their own frontmatter. PC owners: append the machine's Claude temp and ~/.claude/projects roots. Approved by the operator 2026-09-14.
<!-- SECTION:DESCRIPTION:END -->
