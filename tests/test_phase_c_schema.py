"""Phase C — schema v0.3: schema_version, string mode, string agent_id."""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.db import (  # noqa: E402
    SCHEMA_VERSION,
    _init_schema,
    build_trip_filter,
    get_schema_version,
)
from backend.ingest import ingest_source_trips, resolve_epoch_anchor  # noqa: E402
from backend.sources_schema import SourcesFile  # noqa: E402


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


TRIPS_INT_MODE = {
    "label": "Bus",
    "source_id": "bus",
    "discovery": {"trips_glob": "trips.csv", "latest_only": False},
    "vehicle_key_template": "bus:{vehicle_id}",
    "mode_map": {"3": "Car", "0": "Walk"},
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
        },
    },
}


def test_schema_version_written_on_init(conn):
    assert get_schema_version(conn) == SCHEMA_VERSION
    assert SCHEMA_VERSION == "0.3"
    row = conn.execute(
        "SELECT value FROM viz_meta WHERE key = 'schema_version'"
    ).fetchone()
    assert row == ("0.3",)


def test_agent_id_and_mode_columns_exist(conn):
    trip_cols = {
        r[1] for r in conn.execute("PRAGMA table_info('trips')").fetchall()
    }
    wp_cols = {
        r[1] for r in conn.execute("PRAGMA table_info('waypoints')").fetchall()
    }
    assert "agent_id" in trip_cols and "mode" in trip_cols
    assert "agent_id" in wp_cols and "mode" in wp_cols
    # Compat mirrors / legacy kept.
    assert "vehicle_type" in trip_cols
    assert "vehicle_id" in trip_cols
    assert "transport_mode" in trip_cols


def test_ingest_writes_agent_id_and_derived_mode(conn, tmp_path):
    csv_path = tmp_path / "trips.csv"
    csv_path.write_text(
        "id,vehicle,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode\n"
        "1,veh-A,100,139.7,35.6,139.8,35.7,3\n"
        "2,42,200,139.7,35.6,139.8,35.7,0\n"
    )
    sf = _sources_file(TRIPS_INT_MODE)
    source = sf.sources["test-src"]
    n = ingest_source_trips(conn, csv_path, "test-src", source, resolve_epoch_anchor(sf))
    assert n == 2

    rows = conn.execute("""
        SELECT agent_id, vehicle_id, mode, transport_mode, vehicle_type, source_id
        FROM trips ORDER BY trip_id
    """).fetchall()
    assert rows[0][0] == "veh-A"
    assert isinstance(rows[0][1], int) and rows[0][1] > 0  # hash fallback
    assert rows[0][2] == "Car"
    assert rows[0][3] == 3
    assert rows[0][4] == "bus" and rows[0][5] == "bus"  # vehicle_type mirror

    assert rows[1][0] == "42"
    assert rows[1][1] == 42
    assert rows[1][2] == "Walk"
    assert rows[1][3] == 0


def test_ingest_string_mode_column(conn, tmp_path):
    csv_path = tmp_path / "trips_mode.csv"
    csv_path.write_text(
        "id,vehicle,starttime,start_lon,start_lat,end_lon,end_lat,mode\n"
        "1,alice,100,139.7,35.6,139.8,35.7,walk\n"
        "2,bob,200,139.7,35.6,139.8,35.7,rail\n"
    )
    cfg = {
        "label": "People",
        "source_id": "person",
        "discovery": {"trips_glob": "x.csv", "latest_only": False},
        "vehicle_key_template": "person:{vehicle_id}",
        "columns": {
            "trip_id_col": "id",
            "vehicle_id_col": "vehicle",
            "trips": {
                "starttime": {"csv": "starttime", "type": "int"},
                "start_lon": {"csv": "start_lon", "type": "double"},
                "start_lat": {"csv": "start_lat", "type": "double"},
                "end_lon": {"csv": "end_lon", "type": "double"},
                "end_lat": {"csv": "end_lat", "type": "double"},
                "mode": {"csv": "mode", "type": "varchar"},
            },
        },
    }
    sf = _sources_file(cfg)
    source = sf.sources["test-src"]
    n = ingest_source_trips(conn, csv_path, "test-src", source, resolve_epoch_anchor(sf))
    assert n == 2
    rows = conn.execute(
        "SELECT agent_id, mode, transport_mode FROM trips ORDER BY agent_id"
    ).fetchall()
    assert rows == [("alice", "walk", None), ("bob", "rail", None)]


def test_build_trip_filter_modes_prefer_string_over_ints():
    where = build_trip_filter(
        modes=["Walk", "Car"],
        transport_modes=[0, 3],
    )
    assert "mode IN ('Walk', 'Car')" in where
    assert "transport_mode" not in where

    where_ints = build_trip_filter(transport_modes=[0, 3])
    assert "transport_mode IN (0, 3)" in where_ints
