# Review policy and working rules — trajectory-viz

Injected into every Claude Code session by the ai-sdlc plugin. Codex reads it via AGENTS.md.
The plugin's generic governance skill mentions `pnpm build/test/lint`; **this file wins** for this repo.

## Branch and merge rules
- Every change starts from a backlog task (`backlog task create ...`) with acceptance criteria.
- Work on `ai-sdlc/<task-id>-<slug>` or `chore/<slug>`. Never commit or push to `main`; `.githooks/` enforces this.
- Open a PR and stop. The human merges. Never `gh pr merge`, never close PRs or issues, never force-push.
- `.ai-sdlc/**` is operator-owned. Propose changes in the PR description, do not edit.
- Never commit agent scaffolding: `.claude/`, `.codex/`, `.grok/`, `.agents/`, `openspec/`, `AGENTS.md`, `.mcp.json`.
- Never commit data: `*.duckdb`, `output/`, `data/`, `graft/` are ignored and stay that way.

## Pre-commit checklist (run locally, fix before committing)
```bash
python -m pytest -q                      # backend (activate .venv-viz first)
ruff check .
cd frontend && npm test -- --run && npm run build
```
- Machine-specific paths (`H:/Dropbox`, `/Users/...`) go in env vars or `sources.*.yaml` comments, never in code.

## Review calibration
- Reviewers: report `{approved, findings[], summary}`. Minor style nits are not blocking.
- Cross-harness: if Claude implemented, Codex reviews (`codex review`), and vice versa.

## Session end
Write a handoff: `backlog doc create "handoff-YYYY-MM-DD-<harness>"` with goal, done, changed files, verify-next, open questions, who owns next.
