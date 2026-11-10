"""Keep every test away from a real PFLOW workspace.

backend.config.get_pflow_home() tries PFLOW_HOME, then the nearest folder above
this repo that holds output/viz/, then ~/Dropbox/PFLOW. On a developer machine
any of the three can name the real workspace, and tests reach the resolver
indirectly: the stats, POI and zone routes go through
sources_schema.load_sources_merged, which reads output/viz/sources.uploads.yaml
next to the database. So:

- once per session, PFLOW_HOME and PFLOW_VIZ_DB inherited from the shell are
  dropped and Path.home() points at an empty folder (session scope, so module
  fixtures such as test_demo.py's demo_run can still set their own env);
- before each test, the repo root points at an unmarked folder and the resolver
  cache is emptied.

Tests that need other values (tests/test_config.py, test_upload.py) set them
with their own monkeypatch.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import backend.config as config


@pytest.fixture(autouse=True, scope="session")
def _no_pflow_locations_from_the_shell(tmp_path_factory):
    empty_home = tmp_path_factory.getbasetemp() / "empty-home"
    with pytest.MonkeyPatch.context() as mp:
        mp.delenv("PFLOW_HOME", raising=False)
        mp.delenv("PFLOW_VIZ_DB", raising=False)
        mp.setattr(Path, "home", classmethod(lambda cls: empty_home))
        yield


@pytest.fixture(autouse=True)
def _no_workspace_from_repo_location(monkeypatch, tmp_path_factory):
    unmarked_repo = tmp_path_factory.getbasetemp() / "unmarked" / "trajectory-viz"
    monkeypatch.setattr(config, "_REPO_ROOT", unmarked_repo)
    monkeypatch.setattr(config, "_pflow_home", None)
