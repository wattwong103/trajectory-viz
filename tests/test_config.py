"""backend.config resolution behaviour that CI depends on.

The PFLOW_HOME resolver is lazy and only caches a *successful* resolution.
When the env var points at a missing directory and the ~/Dropbox/PFLOW
fallback is absent too (the CI case), every call raises — so the dangling-env
warning must be printed once per process, not once per call. Regression for
TASK-2: test_filter_options_warns_on_uncovered_source asserted empty stdout on
a second request and got a second copy of the warning.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import backend.config as config


@pytest.fixture
def unresolvable_pflow_home(monkeypatch, tmp_path):
    """PFLOW_HOME set to a missing dir, HOME moved so the fallback is missing too."""
    monkeypatch.setattr(config, "_pflow_home", None)
    monkeypatch.setattr(config, "_pflow_home_env_warned", False)
    monkeypatch.setenv("PFLOW_HOME", str(tmp_path / "does-not-exist"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty-home")
    return tmp_path


def test_dangling_pflow_home_warns_once_per_process(unresolvable_pflow_home, capsys):
    for _ in range(3):
        with pytest.raises(FileNotFoundError):
            config.get_pflow_home()
    out = capsys.readouterr().out
    assert out.count("[WARN] PFLOW_HOME=") == 1
    assert "does-not-exist" in out


def test_dangling_pflow_home_still_falls_back_when_possible(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(config, "_pflow_home", None)
    monkeypatch.setattr(config, "_pflow_home_env_warned", False)
    monkeypatch.setenv("PFLOW_HOME", str(tmp_path / "does-not-exist"))
    fallback = tmp_path / "home" / "Dropbox" / "PFLOW"
    fallback.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")

    assert config.get_pflow_home() == fallback
    assert config.get_pflow_home() == fallback  # cached
    assert capsys.readouterr().out.count("[WARN] PFLOW_HOME=") == 1
