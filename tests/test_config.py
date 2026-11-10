"""backend.config resolution behaviour that CI depends on.

The PFLOW_HOME resolver is lazy and only caches a *successful* resolution.
When the env var points at a missing directory and no other candidate exists
(the CI case), every call raises — so the dangling-env warning must be printed
once per process, not once per call. Regression for TASK-2:
test_filter_options_warns_on_uncovered_source asserted empty stdout on a
second request and got a second copy of the warning.

Candidates, in order: PFLOW_HOME, the nearest folder above this repo that
holds output/viz/ (the repo sits nested in the PFLOW workspace), then
~/Dropbox/PFLOW. Every test points the repo root and HOME into tmp_path, so no
real Dropbox folder is ever consulted.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import backend.config as config


@pytest.fixture
def isolated_resolver(monkeypatch, tmp_path):
    """Empty cache, no PFLOW_HOME, and HOME and the repo root moved into tmp_path.

    Nothing under tmp_path holds the workspace marker yet; each test adds what
    it needs.
    """
    monkeypatch.setattr(config, "_pflow_home", None)
    monkeypatch.setattr(config, "_pflow_home_env_warned", False)
    monkeypatch.delenv("PFLOW_HOME", raising=False)
    monkeypatch.delenv("PFLOW_VIZ_DB", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty-home")
    monkeypatch.setattr(config, "_REPO_ROOT", tmp_path / "unmarked" / "trajectory-viz")
    return tmp_path


@pytest.fixture
def unresolvable_pflow_home(isolated_resolver, monkeypatch):
    """PFLOW_HOME set to a missing dir; no workspace marker and no fallback either."""
    monkeypatch.setenv("PFLOW_HOME", str(isolated_resolver / "does-not-exist"))
    return isolated_resolver


def _make_workspace(root: Path) -> Path:
    """Create a PFLOW-like folder (it holds output/viz/) and return the repo nested in it."""
    (root / "output" / "viz").mkdir(parents=True)
    repo = root / "trajectory-viz"
    repo.mkdir()
    return repo


def test_suite_never_finds_a_real_workspace_from_the_repo():
    # tests/conftest.py points _REPO_ROOT at an unmarked folder, so tests that
    # reach get_pflow_home() indirectly (stats, POI and zone routes through
    # load_sources_merged) cannot read a developer's real output/viz/.
    assert config._find_enclosing_workspace(config._REPO_ROOT) is None


def test_dangling_pflow_home_warns_once_per_process(unresolvable_pflow_home, capsys):
    for _ in range(3):
        with pytest.raises(FileNotFoundError):
            config.get_pflow_home()
    out = capsys.readouterr().out
    assert out.count("[WARN] PFLOW_HOME=") == 1
    assert "does-not-exist" in out


def test_dangling_pflow_home_still_falls_back_when_possible(unresolvable_pflow_home, monkeypatch, capsys):
    fallback = unresolvable_pflow_home / "home" / "Dropbox" / "PFLOW"
    fallback.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: unresolvable_pflow_home / "home")

    assert config.get_pflow_home() == fallback
    assert config.get_pflow_home() == fallback  # cached
    assert capsys.readouterr().out.count("[WARN] PFLOW_HOME=") == 1


def test_repo_parent_with_marker_is_the_workspace(isolated_resolver, monkeypatch, capsys):
    workspace = isolated_resolver / "PFLOW"
    monkeypatch.setattr(config, "_REPO_ROOT", _make_workspace(workspace))

    assert config.get_pflow_home() == workspace
    assert capsys.readouterr().out == ""  # no PFLOW_HOME, so nothing to warn about


def test_repo_parent_without_marker_is_skipped(isolated_resolver, monkeypatch):
    # A sibling Pseudo-PFLOW/ is not enough: only output/viz/ marks the workspace.
    unmarked = isolated_resolver / "PFLOW"
    (unmarked / "Pseudo-PFLOW").mkdir(parents=True)
    repo = unmarked / "trajectory-viz"
    repo.mkdir()
    monkeypatch.setattr(config, "_REPO_ROOT", repo)
    fallback = isolated_resolver / "home" / "Dropbox" / "PFLOW"
    fallback.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: isolated_resolver / "home")

    assert config.get_pflow_home() == fallback


def test_unmarked_repo_parent_without_fallback_raises(isolated_resolver):
    with pytest.raises(FileNotFoundError):
        config.get_pflow_home()


def test_worktree_finds_the_workspace_above_it(isolated_resolver, monkeypatch):
    # trajectory-viz/.worktrees/<name>/ : the repo's own parent is .worktrees/.
    workspace = isolated_resolver / "PFLOW"
    worktree = _make_workspace(workspace) / ".worktrees" / "chore-x"
    worktree.mkdir(parents=True)
    monkeypatch.setattr(config, "_REPO_ROOT", worktree)

    assert config.get_pflow_home() == workspace


def test_nearest_marked_folder_wins(isolated_resolver, monkeypatch):
    (isolated_resolver / "output" / "viz").mkdir(parents=True)  # an outer marked folder
    workspace = isolated_resolver / "PFLOW"
    monkeypatch.setattr(config, "_REPO_ROOT", _make_workspace(workspace))

    assert config.get_pflow_home() == workspace


def test_pflow_home_env_beats_the_workspace(isolated_resolver, monkeypatch):
    monkeypatch.setattr(config, "_REPO_ROOT", _make_workspace(isolated_resolver / "PFLOW"))
    env_home = isolated_resolver / "env-home"
    env_home.mkdir()
    monkeypatch.setenv("PFLOW_HOME", str(env_home))

    assert config.get_pflow_home() == env_home


def test_dangling_pflow_home_falls_back_to_the_workspace(unresolvable_pflow_home, monkeypatch, capsys):
    workspace = unresolvable_pflow_home / "PFLOW"
    monkeypatch.setattr(config, "_REPO_ROOT", _make_workspace(workspace))

    assert config.get_pflow_home() == workspace
    assert capsys.readouterr().out.count("[WARN] PFLOW_HOME=") == 1


def test_standalone_db_never_consults_the_workspace(isolated_resolver, monkeypatch):
    monkeypatch.setattr(config, "_REPO_ROOT", _make_workspace(isolated_resolver / "PFLOW"))
    db = isolated_resolver / "standalone" / "viz.duckdb"
    monkeypatch.setenv("PFLOW_VIZ_DB", str(db))

    assert config.get_viz_db_path() == db
    assert config._pflow_home is None  # the resolver never ran
