"""Phase 2A — sources.yaml render-block validation tests.

RenderConfig is the contract behind /api/stats/filter-options `sources[]`
(mode + color rendering hints). These tests pin the validation rules so a
typo'd sources.yaml fails at --validate time, not at render time.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.sources_schema import (  # noqa: E402
    RenderConfig,
    SourceConfig,
    load_sources,
)


MINIMAL_SOURCE = {
    "label": "Test",
    "source_id": "test",
    "discovery": {"trips_glob": "trips/test/*.csv"},
    "vehicle_key_template": "test:{vehicle_id}",
    "columns": {
        "trip_id_col": "id",
        "vehicle_id_col": "veh_id",
        "trips": {
            "starttime": {"csv": "starttime", "type": "int"},
            "start_lon": {"csv": "start_lon", "type": "double"},
            "start_lat": {"csv": "start_lat", "type": "double"},
            "end_lon":   {"csv": "end_lon",   "type": "double"},
            "end_lat":   {"csv": "end_lat",   "type": "double"},
        },
    },
}


def test_render_block_defaults():
    cfg = RenderConfig()
    assert cfg.mode == "trails"
    assert cfg.color is None


def test_render_block_valid_modes():
    for mode in ("trails", "points", "arcs"):
        assert RenderConfig(mode=mode).mode == mode


def test_render_block_rejects_bad_mode():
    with pytest.raises(ValidationError):
        RenderConfig(mode="sparkles")


def test_render_block_rejects_out_of_range_color():
    with pytest.raises(ValidationError):
        RenderConfig(color=(300, 0, 0))
    with pytest.raises(ValidationError):
        RenderConfig(color=(-1, 0, 0))


def test_render_block_rejects_extra_fields():
    with pytest.raises(ValidationError):
        RenderConfig(mode="trails", glow=True)


def test_source_without_render_is_valid():
    src = SourceConfig.model_validate(MINIMAL_SOURCE)
    assert src.render is None


def test_source_with_render_is_valid():
    src = SourceConfig.model_validate(
        {**MINIMAL_SOURCE, "render": {"mode": "points", "color": [43, 200, 80]}}
    )
    assert src.render is not None
    assert src.render.mode == "points"
    assert src.render.color == (43, 200, 80)


def test_repo_sources_yaml_declares_render_for_all_sources():
    """The shipped sources.yaml carries render hints on every source (2A)."""
    sources = load_sources(PROJECT_ROOT / "sources.yaml")
    for key, src in sources.sources.items():
        assert src.render is not None, f"{key} is missing a render block"
        assert src.render.color is not None, f"{key} render.color unset"
