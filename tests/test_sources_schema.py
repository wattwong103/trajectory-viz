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
    PoiConfig,
    RenderConfig,
    SourceConfig,
    SourcesFile,
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


# ── Universal-trajectory-support Phase 1 — schema extensions ──────

# A valid points-only source: no trips_glob, waypoints-only mapping.
POINTS_ONLY_SOURCE = {
    "label": "Couriers",
    "source_id": "courier",
    "discovery": {"trajectories_glob": "couriers/**/*.gpx"},
    "vehicle_key_template": "courier:{vehicle_id}",
    "columns": {
        "vehicle_id_col": "_trk_name",
        "waypoints": {
            "unix_time_ms": {"csv": "_time_ms", "type": "bigint"},
            "lon": {"csv": "_lon", "type": "double"},
            "lat": {"csv": "_lat", "type": "double"},
        },
    },
}


def _sources_file(source: dict, **top) -> dict:
    return {"version": 1, "sources": {"s": source}, **top}


@pytest.mark.parametrize(
    "glob_pattern, declared, ok",
    [
        ("t/*.csv", None, True),
        ("t/*.geojson", None, True),
        ("t/*.gpx", None, True),
        ("t/*.ndjson", None, True),
        ("t/*.jsonl", None, True),
        ("t/*.parquet", None, True),
        ("t/*.pq", None, True),
        ("t/*.json", None, False),       # ambiguous without explicit format
        ("t/*.json", "geojson", True),   # explicit format resolves it
        ("t/*.json", "ndjson", True),
    ],
)
def test_format_auto_detection_table(glob_pattern, declared, ok):
    discovery = {"trajectories_glob": glob_pattern}
    if declared:
        discovery["format"] = declared
    source = {**POINTS_ONLY_SOURCE, "discovery": discovery}
    if ok:
        SourcesFile.model_validate(_sources_file(source))
    else:
        with pytest.raises(ValidationError, match="ambiguous"):
            SourcesFile.model_validate(_sources_file(source))


def test_points_only_source_auto_populates_synthesis():
    sf = SourcesFile.model_validate(_sources_file(POINTS_ONLY_SOURCE))
    synth = sf.sources["s"].trips_synthesis
    assert synth is not None
    assert synth.strategy == "gap_split"
    assert synth.gap_minutes == 30.0


def test_synthesis_and_trips_glob_are_mutually_exclusive():
    source = {
        **POINTS_ONLY_SOURCE,
        "discovery": {
            "trips_glob": "t/*.csv",
            "trajectories_glob": "t/*.gpx",
        },
        "trips_synthesis": {"strategy": "single"},
        "columns": {
            **POINTS_ONLY_SOURCE["columns"],
            "trip_id_col": "id",
            "trips": {
                "starttime": {"csv": "starttime", "type": "int"},
                "start_lon": {"csv": "start_lon", "type": "double"},
                "start_lat": {"csv": "start_lat", "type": "double"},
                "end_lon": {"csv": "end_lon", "type": "double"},
                "end_lat": {"csv": "end_lat", "type": "double"},
            },
        },
    }
    with pytest.raises(ValidationError, match="mutually exclusive"):
        SourcesFile.model_validate(_sources_file(source))


def test_source_requires_at_least_one_glob():
    source = {**POINTS_ONLY_SOURCE, "discovery": {}}
    with pytest.raises(ValidationError, match="At least one of"):
        SourcesFile.model_validate(_sources_file(source))


def test_synthesis_skips_required_trip_columns():
    """Points-only sources need no trips column mapping at all."""
    sf = SourcesFile.model_validate(_sources_file(POINTS_ONLY_SOURCE))
    assert sf.sources["s"].columns.trips == {}
    assert sf.sources["s"].columns.trip_id_col is None


def test_trip_id_col_required_when_trips_glob_set():
    source = {
        **MINIMAL_SOURCE,
        "columns": {
            "vehicle_id_col": "veh_id",
            "trips": MINIMAL_SOURCE["columns"]["trips"],
        },
    }
    with pytest.raises(ValidationError, match="trip_id_col"):
        SourceConfig.model_validate(source)


def test_multi_anchor_rejected():
    a = {**POINTS_ONLY_SOURCE, "time": {"epoch_anchor": "2024-05-01T00:00:00+09:00"}}
    b = {**POINTS_ONLY_SOURCE, "time": {"epoch_anchor": "2024-06-01T00:00:00+09:00"}}
    with pytest.raises(ValidationError, match="epoch_anchor"):
        SourcesFile.model_validate({
            "version": 1, "sources": {"a": a, "b": b},
        })


def test_same_anchor_everywhere_accepted():
    anchor = "2024-05-01T00:00:00+09:00"
    a = {**POINTS_ONLY_SOURCE, "time": {"epoch_anchor": anchor}}
    sf = SourcesFile.model_validate({
        "version": 1, "sources": {"a": a}, "time": {"epoch_anchor": anchor},
    })
    assert sf.time.epoch_anchor == anchor


def test_naive_anchor_rejected():
    source = {**POINTS_ONLY_SOURCE, "time": {"epoch_anchor": "2024-05-01T00:00:00"}}
    with pytest.raises(ValidationError, match="timezone-aware"):
        SourcesFile.model_validate(_sources_file(source))


def test_bad_anchor_rejected():
    source = {**POINTS_ONLY_SOURCE, "time": {"epoch_anchor": "not-a-date"}}
    with pytest.raises(ValidationError, match="epoch_anchor"):
        SourcesFile.model_validate(_sources_file(source))


POI_BLOCK = {
    "label": "Stations",
    "glob": "pois/*.geojson",
    "color": [90, 120, 255],
    "columns": {
        "name": {"csv": "name", "type": "varchar"},
        "category": {"derived": "'station'"},
        "lon": {"csv": "_lon", "type": "double"},
        "lat": {"csv": "_lat", "type": "double"},
    },
}


def test_poi_block_valid():
    sf = SourcesFile.model_validate({
        "version": 1, "sources": {"s": POINTS_ONLY_SOURCE},
        "pois": {"stations": POI_BLOCK},
    })
    poi = sf.pois["stations"]
    assert poi.label == "Stations"
    assert poi.color == (90, 120, 255)
    assert poi.columns.name.csv == "name"


def test_poi_block_rejects_out_of_range_color():
    with pytest.raises(ValidationError, match="0-255"):
        PoiConfig.model_validate({**POI_BLOCK, "color": [256, 0, 0]})


def test_poi_block_json_ambiguity():
    with pytest.raises(ValidationError, match="ambiguous"):
        PoiConfig.model_validate({**POI_BLOCK, "glob": "pois/*.json"})
    # Explicit format resolves it.
    PoiConfig.model_validate({**POI_BLOCK, "glob": "pois/*.json", "format": "geojson"})


def test_poi_block_requires_lon_lat():
    with pytest.raises(ValidationError):
        PoiConfig.model_validate({
            **POI_BLOCK,
            "columns": {"name": {"csv": "name", "type": "varchar"}},
        })


def test_existing_repo_yamls_validate_unchanged():
    """Back-compat: the shipped v1 files must validate with no changes."""
    for name in ("sources.yaml", "sources.kichijoji.yaml"):
        path = PROJECT_ROOT / name
        if path.is_file():
            sources = load_sources(path)
            assert sources.version == 1
