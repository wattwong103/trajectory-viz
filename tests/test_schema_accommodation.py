"""Schema accommodation — mode_map packs, leg_id, adapters, example YAMLs."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import duckdb
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.db import _init_schema  # noqa: E402
from backend.ingest import ingest_source_trips, resolve_epoch_anchor  # noqa: E402
from backend.sources_schema import SourcesFile, load_sources  # noqa: E402

FIXTURES = PROJECT_ROOT / "tests" / "fixtures" / "adapters"
EXAMPLES = PROJECT_ROOT / "docs" / "examples"
SCRIPTS = PROJECT_ROOT / "scripts"


def _load_script(name: str):
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def conn():
    c = duckdb.connect(":memory:")
    _init_schema(c)
    yield c
    c.close()


def _sources_file(source: dict, **extra) -> SourcesFile:
    return SourcesFile.model_validate({
        "version": 1,
        "sources": {"test-src": source},
        **extra,
    })


# ── Example YAML packs validate ─────────────────────────────────────────

@pytest.mark.parametrize(
    "name",
    [
        "sources-matsim.yaml",
        "sources-sumo-fcd.yaml",
        "sources-od-arcs.yaml",
        "sources-phone-gps.yaml",
        "sources-joras-v3.yaml",
    ],
)
def test_example_yaml_validates(name):
    sf = load_sources(EXAMPLES / name)
    assert sf.version == 1
    assert len(sf.sources) >= 1


def test_registry_mode_maps_present():
    """PFLOW person/taxi/truck + GUFM packs declare mode_map."""
    root = load_sources(PROJECT_ROOT / "sources.yaml")
    assert root.sources["pflow-truck"].mode_map is not None
    assert root.sources["pflow-taxi-tokyo"].mode_map is not None
    assert root.sources["pflow-person-shopping"].mode_map is not None
    assert root.sources["pflow-person-shopping"].mode_map["0"] == "Walk"

    gufm = load_sources(PROJECT_ROOT / "sources.gufm.yaml")
    for key in ("gufm-gen", "pflow-gt"):
        assert gufm.sources[key].mode_map is not None
        assert "3" in gufm.sources[key].mode_map

    kj = load_sources(PROJECT_ROOT / "sources.kichijoji.yaml")
    for src in kj.sources.values():
        assert src.mode_map is not None


def test_joras_v3_maps_leg_id():
    sf = load_sources(EXAMPLES / "sources-joras-v3.yaml")
    truck = sf.sources["joras-truck-v3"]
    assert "leg_id" in truck.columns.trips
    assert truck.columns.trips["leg_id"].csv == "subtrip_no"
    assert "leg_id" in truck.columns.waypoints


# ── leg_id schema + ingest ──────────────────────────────────────────────

def test_leg_id_columns_exist(conn):
    trip_cols = {r[1] for r in conn.execute("PRAGMA table_info('trips')").fetchall()}
    wp_cols = {r[1] for r in conn.execute("PRAGMA table_info('waypoints')").fetchall()}
    assert "leg_id" in trip_cols
    assert "leg_id" in wp_cols


def test_ingest_writes_leg_id(conn, tmp_path):
    csv_path = tmp_path / "trips.csv"
    csv_path.write_text(
        "id,vehicle,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,subtrip_no\n"
        "1,alice,100,139.7,35.6,139.8,35.7,3,1\n"
        "2,alice,200,139.8,35.7,139.9,35.8,0,2\n"
    )
    cfg = {
        "label": "Person legs",
        "source_id": "person",
        "discovery": {"trips_glob": "x.csv", "latest_only": False},
        "vehicle_key_template": "person:{vehicle_id}",
        "mode_map": {"0": "Walk", "3": "Car"},
        "columns": {
            "trip_id_col": "id",
            "vehicle_id_col": "vehicle",
            "trips": {
                "starttime": {"csv": "starttime", "type": "int"},
                "start_lon": {"csv": "start_lon", "type": "double"},
                "start_lat": {"csv": "start_lat", "type": "double"},
                "end_lon": {"csv": "end_lon", "type": "double"},
                "end_lat": {"csv": "end_lat", "type": "double"},
                "transport_mode": {"csv": "transport_mode", "type": "int"},
                "leg_id": {"csv": "subtrip_no", "type": "int"},
            },
        },
    }
    sf = _sources_file(cfg)
    n = ingest_source_trips(
        conn, csv_path, "test-src", sf.sources["test-src"], resolve_epoch_anchor(sf)
    )
    assert n == 2
    rows = conn.execute(
        "SELECT agent_id, mode, leg_id FROM trips ORDER BY trip_id"
    ).fetchall()
    assert rows == [("alice", "Car", 1), ("alice", "Walk", 2)]


# ── Adapters ────────────────────────────────────────────────────────────

def test_matsim_events_to_csv(tmp_path):
    convert = _load_script("matsim_events_to_csv").convert

    out = tmp_path / "matsim_out"
    n_trips, n_geo = convert(
        FIXTURES / "matsim_events_tiny.xml",
        out,
        FIXTURES / "matsim_network_tiny.xml",
    )
    assert n_trips == 2
    assert n_geo >= 1
    trips_csv = (out / "trips_car.csv").read_text(encoding="utf-8")
    assert "person_id" in trips_csv
    assert "car" in trips_csv
    assert "walk" in trips_csv
    geo_csv = (out / "events_car_geo.csv").read_text(encoding="utf-8")
    assert "link_id" in geo_csv
    assert "139.7" in geo_csv  # network centroid roughly


def test_sumo_fcd_to_ndjson(tmp_path):
    convert = _load_script("sumo_fcd_to_ndjson").convert

    out = tmp_path / "fcd.ndjson"
    n = convert(FIXTURES / "sumo_fcd_tiny.xml", out, epoch_ms=1_000_000)
    assert n == 4  # 2 vehicles × 2 timesteps
    lines = out.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 4
    row = json.loads(lines[0])
    assert set(row) >= {"id", "time_ms", "x", "y", "mode", "type", "edge"}
    modes = {json.loads(line)["mode"] for line in lines}
    assert "Car" in modes and "Bus" in modes
    assert all(json.loads(line)["time_ms"] >= 1_000_000 for line in lines)
