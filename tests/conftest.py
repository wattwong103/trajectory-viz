"""Keep every test away from the real PFLOW workspace.

backend.config finds the workspace by walking up from this repo for a folder
that holds output/viz/. A developer checkout sits inside that workspace, so a
test that reaches get_pflow_home() indirectly (the stats, POI and zone routes
through sources_schema.load_sources_merged) would read the real output/viz/.
Each test therefore starts with the repo root pointed at an unmarked folder and
an empty resolver cache. Tests that need a workspace (tests/test_config.py)
patch config._REPO_ROOT themselves.
"""

from __future__ import annotations

import pytest

import backend.config as config


@pytest.fixture(autouse=True)
def _no_workspace_from_repo_location(monkeypatch, tmp_path_factory):
    unmarked_repo = tmp_path_factory.getbasetemp() / "unmarked" / "trajectory-viz"
    monkeypatch.setattr(config, "_REPO_ROOT", unmarked_repo)
    monkeypatch.setattr(config, "_pflow_home", None)
