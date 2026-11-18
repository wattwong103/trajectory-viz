"""Repository hygiene tests for git tracking, Docker context excludes, and path portability."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

FORBIDDEN_TRACKED_PREFIXES = (
    ".ai-sdlc/",
    "backlog/",
    ".claude/",
    ".codex/",
    ".grok/",
    ".agents/",
    ".venv",
    "graft/",
)
FORBIDDEN_TRACKED_EXACT = {
    ".coverage",
    ".mcp.json",
    "opencode.json",
    "AGENTS.md",
    "CLAUDE.md",
}
REQUIRED_DOCKERIGNORE_ENTRIES = {
    ".worktrees/",
    "graft/",
    "exports/",
    ".ai-sdlc/",
    "backlog/",
    "opencode.json",
    ".env",
    ".env.*",
    "**/.env.local",
}
MACHINE_PATH_RE = re.compile(r"(/Users/north-mac|[HD]:[/\\]Dropbox)", re.IGNORECASE)


def _git_lines(*args: str) -> list[str]:
    out = subprocess.check_output(
        ["git", "-c", f"core.excludesFile={os.devnull}", *args],
        cwd=REPO_ROOT,
        text=True,
        encoding="utf-8",
    )
    return [line for line in out.splitlines() if line]


def test_no_scaffolding_or_local_artifacts_tracked() -> None:
    tracked = _git_lines("ls-files")
    bad = [
        p
        for p in tracked
        if p in FORBIDDEN_TRACKED_EXACT or p.startswith(FORBIDDEN_TRACKED_PREFIXES)
    ]
    assert bad == [], f"Workspace/agent scaffolding or local artifacts tracked: {bad}"


def test_scaffolding_and_coverage_are_gitignored() -> None:
    for probe in (
        ".coverage",
        "opencode.json",
        ".ai-sdlc/review-policy.md",
        "backlog/config.yml",
    ):
        proc = subprocess.run(
            ["git", "-c", f"core.excludesFile={os.devnull}", "check-ignore", "-q", "--no-index", probe],
            cwd=REPO_ROOT,
            check=False,
        )
        assert proc.returncode == 0, f"{probe} must be matched by .gitignore"


def test_no_tracked_files_collide_with_gitignore() -> None:
    ignored_tracked = _git_lines("ls-files", "-i", "-c", "--exclude-standard")
    assert ignored_tracked == [], f"Tracked files collide with .gitignore: {ignored_tracked}"


def test_dockerignore_excludes_worktrees_caches_and_env_files() -> None:
    entries = {
        line.strip()
        for line in (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }
    missing = REQUIRED_DOCKERIGNORE_ENTRIES - entries
    assert not missing, f".dockerignore is missing required excludes: {sorted(missing)}"


def test_start_gufm_viz_bat_uses_script_relative_root() -> None:
    bat = (REPO_ROOT / "start-gufm-viz.bat").read_text(encoding="utf-8")
    assert "%~dp0" in bat, "start-gufm-viz.bat must resolve paths relative to %~dp0"
    assert not MACHINE_PATH_RE.search(bat), "start-gufm-viz.bat must not hardcode machine paths"


def test_no_machine_specific_paths_in_tracked_files() -> None:
    offenders: list[str] = []
    for rel in _git_lines("ls-files"):
        if rel == "tests/test_repo_hygiene.py":
            continue
        path = REPO_ROOT / rel
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            if MACHINE_PATH_RE.search(line):
                offenders.append(f"{rel}:{lineno}: {line.strip()}")
    assert offenders == [], f"Machine-specific paths found in tracked files: {offenders}"
