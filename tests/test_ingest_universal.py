"""Universal-trajectory-support Phase 1 — universal ingest tests.

Covers, against in-memory DuckDB instances (same monkeypatch-free pattern as
test_v0_2_parity.py):
  - GeoJSON end-to-end waypoint ingest + gap_split synthesis (a 25-minute
    hole with gap_minutes=20 must yield exactly 2 trips)
  - GPX ingest: +09:00 vs Z offsets land in the same anchor-relative bucket
  - Parquet ≡ CSV under an identical column mapping
  - String vehicle-id hash fallback (vehicle_key stays authoritative)
  - Epoch-anchor persistence: mixed-anchor re-ingest is a hard error
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.db import _init_schema, get_epoch_anchor  # noqa: E402
from backend.ingest import (  # noqa: E402
    ensure_epoch_anchor,
    ingest_source_trajectories,
    ingest_source_trips,
    resolve_epoch_anchor,
    synthesize_trips,
)
from backend.sources_schema import SourcesFile  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ANCHOR_ISO = "2024-05-01T00:00:00+09:00"


@pytest.fixture
def conn():
    c = duckdb.connect(":memory:")
    _init_schema(c)
    yield c
    c.close()


def _sources_file(source_dict: dict, **top) -> SourcesFile:
    return SourcesFile.model_validate({
        "version": 1,
        "sources": {"test-src": source_dict},
        **top,
    })


GEOJSON_SOURCE = {
    "label": "Buses",
    "source_id": "bus",
    "discovery": {
        "trajectories_glob": "lines.geojson",
        "latest_only": False,
    },
    "vehicle_key_template": "bus:{vehicle_id}",
    "trips_synthesis": {"strategy": "gap_split", "gap_minutes": 20},
    "time": {"coord_times_prop": "coordTimes", "epoch_anchor": ANCHOR_ISO},
    "columns": {
        "vehicle_id_col": "vehicle",
        "waypoints": {
            "unix_time_ms": {"csv": "_time_ms", "type": "bigint"},
            "lon": {"csv": "_lon", "type": "double"},
            "lat": {"csv": "_lat", "type": "double"},
        },
    },
}

GPX_SOURCE = {
    "label": "Runners",
    "source_id": "runner",
    "discovery": {
        "trajectories_glob": "track.gpx",
        "latest_only": False,
    },
    "vehicle_key_template": "runner:{vehicle_id}",
    "time": {"epoch_anchor": ANCHOR_ISO},
    "columns": {
        "vehicle_id_col": "_trk_name",
        "waypoints": {
            "unix_time_ms": {"csv": "_time_ms", "type": "bigint"},
            "lon": {"csv": "_lon", "type": "double"},
            "lat": {"csv": "_lat", "type": "double"},
        },
    },
}

NDJSON_SOURCE = {
    "label": "Fleet",
    "source_id": "fleet",
    "discovery": {
        "trajectories_glob": "pings.ndjson",
        "latest_only": False,
    },
    "vehicle_key_template": "fleet:{vehicle_id}",
    "time": {"epoch_anchor": ANCHOR_ISO},
    "columns": {
        "vehicle_id_col": "vehicle",
        "waypoints": {
            # ISO strings → epoch ms via derived SQL (TIMESTAMPTZ honors the
            # +09:00 offset). Staged ts is VARCHAR.
            "unix_time_ms": {
                "derived": 'CAST(epoch_ms(CAST("ts" AS TIMESTAMPTZ)) AS BIGINT)'
            },
            "lon": {"csv": "lon", "type": "double"},
            "lat": {"csv": "lat", "type": "double"},
        },
    },
}

TRIPS_SOURCE = {
    "label": "Trucks",
    "source_id": "truck",
    "discovery": {"trips_glob": "trips.csv", "latest_only": False},
    "vehicle_key_template": "truck:{vehicle_id}",
    "columns": {
        "trip_id_col": "id",
        "vehicle_id_col": "truck_id",
        "trips": {
            "starttime": {"csv": "starttime", "type": "int"},
            "start_lon": {"csv": "start_lon", "type": "double"},
            "start_lat": {"csv": "start_lat", "type": "double"},
            "end_lon": {"csv": "end_lon", "type": "double"},
            "end_lat": {"csv": "end_lat", "type": "double"},
            "simulation_day": {"csv": "sim_day", "type": "int"},
        },
    },
}

_TRIPS_CSV = (
    "id,sim_day,starttime,start_lon,start_lat,end_lon,end_lat,truck_id\n"
    "1,0,28800,139.60,35.60,139.65,35.62,1001\n"
    "2,0,36000,139.65,35.62,139.70,35.64,1002\n"
)


# --- GeoJSON end-to-end + gap_split synthesis -----------------------------------


def test_geojson_end_to_end_waypoints(conn):
    sf = _sources_file(GEOJSON_SOURCE)
    src = sf.sources["test-src"]
    anchor = resolve_epoch_anchor(sf)
    n = ingest_source_trajectories(
        conn, FIXTURES / "lines.geojson", "test-src", src, anchor
    )
    assert n == 9  # 3 + 2 + 4 coordinates
    rows = conn.execute(
        "SELECT DISTINCT vehicle_key FROM waypoints ORDER BY 1"
    ).fetchall()
    assert [r[0] for r in rows] == ["bus:bus-1", "bus:bus-2", "bus:courier-7"]


def test_gap_split_synthesizes_exactly_two_trips_for_25min_hole(conn):
    """courier-7 has pings at 08:00, 08:05, 08:30, 08:35 (+09:00). With
    gap_minutes=20 the 25-minute hole must split into exactly 2 trips."""
    sf = _sources_file(GEOJSON_SOURCE)
    src = sf.sources["test-src"]
    anchor = resolve_epoch_anchor(sf)
    ingest_source_trajectories(conn, FIXTURES / "lines.geojson", "test-src", src, anchor)
    n = synthesize_trips(conn, src, anchor)
    assert n == 4  # bus-1: 1, bus-2: 1, courier-7: 2

    counts = dict(conn.execute(
        "SELECT vehicle_key, COUNT(*) FROM trips GROUP BY vehicle_key"
    ).fetchall())
    assert counts == {"bus:bus-1": 1, "bus:bus-2": 1, "bus:courier-7": 2}

    # The second courier trip starts at the 08:30 ping (anchor-relative).
    trips = conn.execute("""
        SELECT trip_id, starttime, simulation_day, start_lon, end_lon
        FROM trips WHERE vehicle_key = 'bus:courier-7' ORDER BY trip_id
    """).fetchall()
    assert [t[0] for t in trips] == [1, 2]
    assert trips[0][1] == 8 * 3600          # 08:00 anchor-local
    assert trips[1][1] == 8 * 3600 + 30 * 60  # 08:30 anchor-local
    assert trips[0][2] == 0 and trips[1][2] == 0
    assert trips[0][3] == pytest.approx(139.730)  # first coord
    assert trips[0][4] == pytest.approx(139.731)  # trip 1 ends at 2nd coord
    assert trips[1][3] == pytest.approx(139.740)  # trip 2 starts at 3rd coord


def test_synthesis_backfills_waypoint_trip_ids(conn):
    """The (vehicle_key, trip_id) join identity must hold for synthesized
    sources: waypoints trip_id is backfilled with the same ordinals."""
    sf = _sources_file(GEOJSON_SOURCE)
    src = sf.sources["test-src"]
    anchor = resolve_epoch_anchor(sf)
    ingest_source_trajectories(conn, FIXTURES / "lines.geojson", "test-src", src, anchor)
    synthesize_trips(conn, src, anchor)
    orphaned = conn.execute("""
        SELECT COUNT(*) FROM waypoints w
        LEFT JOIN trips t ON w.vehicle_key = t.vehicle_key AND w.trip_id = t.trip_id
        WHERE w.source_id = 'bus' AND t.vehicle_key IS NULL
    """).fetchone()[0]
    assert orphaned == 0


def test_synthesis_day_and_single_strategies(conn):
    for strategy, expected in (("day", 1), ("single", 1)):
        cfg = {**GEOJSON_SOURCE, "trips_synthesis": {"strategy": strategy}}
        # Drop the per-coord 25-min gap relevance: bus-2's two pings share the
        # same feature time; day/single collapse each vehicle to one trip.
        c = duckdb.connect(":memory:")
        _init_schema(c)
        sf = _sources_file(cfg)
        src = sf.sources["test-src"]
        anchor = resolve_epoch_anchor(sf)
        ingest_source_trajectories(c, FIXTURES / "lines.geojson", "test-src", src, anchor)
        n = synthesize_trips(c, src, anchor)
        counts = dict(c.execute(
            "SELECT vehicle_key, COUNT(*) FROM trips GROUP BY vehicle_key"
        ).fetchall())
        assert counts["bus:courier-7"] == expected, strategy
        assert n == 3
        c.close()


# --- GPX anchor math --------------------------------------------------------------


def test_gpx_offsets_land_in_same_bucket(conn):
    """The Z-suffixed 08:00:00Z trkpt and the 17:00:00+09:00 trkpt are the
    same instant — identical unix_time_ms and identical anchor-relative
    starttime after synthesis."""
    sf = _sources_file(GPX_SOURCE)
    src = sf.sources["test-src"]
    anchor = resolve_epoch_anchor(sf)
    n = ingest_source_trajectories(conn, FIXTURES / "track.gpx", "test-src", src, anchor)
    assert n == 5

    rows = dict(conn.execute("""
        SELECT vehicle_key, MIN(unix_time_ms) FROM waypoints GROUP BY vehicle_key
    """).fetchall())
    assert rows["runner:morning-run"] == rows["runner:trk1"]

    n_trips = synthesize_trips(conn, src, anchor)
    # trk1 splits at its ~10h naive-time gap (default 30-min gap_split);
    # morning-run stays one trip.
    assert n_trips == 3
    starts = dict(conn.execute(
        "SELECT vehicle_key, starttime FROM trips WHERE trip_id = 1"
    ).fetchall())
    # The same instant (Z vs +09:00) lands in the same anchor-relative bucket:
    # 08:00:00Z is 17:00 at the +09:00 anchor → 61200 for both tracks.
    assert starts["runner:morning-run"] == starts["runner:trk1"] == 17 * 3600


# --- Parquet ≡ CSV ------------------------------------------------------------------


def test_parquet_matches_csv_same_mapping(conn, tmp_path):
    csv_path = tmp_path / "trips.csv"
    csv_path.write_text(_TRIPS_CSV)
    parquet_path = tmp_path / "trips.parquet"
    conn.execute(f"""
        COPY (SELECT * FROM read_csv('{csv_path.as_posix()}',
              header=true, auto_detect=true))
        TO '{parquet_path.as_posix()}' (FORMAT PARQUET)
    """)

    sf = _sources_file(TRIPS_SOURCE)
    src = sf.sources["test-src"]
    n_csv = ingest_source_trips(conn, csv_path, "test-src", src)

    c2 = duckdb.connect(":memory:")
    _init_schema(c2)
    n_pq = ingest_source_trips(c2, parquet_path, "test-src", src)

    assert n_csv == n_pq == 2
    cols = ("vehicle_id, trip_id, starttime, start_lon, start_lat, "
            "end_lon, end_lat, simulation_day, vehicle_key, source_id")
    csv_rows = conn.execute(f"SELECT {cols} FROM trips ORDER BY trip_id").fetchall()
    pq_rows = c2.execute(f"SELECT {cols} FROM trips ORDER BY trip_id").fetchall()
    assert csv_rows == pq_rows
    c2.close()


# --- String vehicle-id hash fallback -------------------------------------------------


def test_string_vehicle_id_hash_fallback(conn):
    sf = _sources_file(NDJSON_SOURCE)
    src = sf.sources["test-src"]
    anchor = resolve_epoch_anchor(sf)
    n = ingest_source_trajectories(conn, FIXTURES / "pings.ndjson", "test-src", src, anchor)
    assert n == 4

    rows = conn.execute("""
        SELECT vehicle_id, vehicle_key FROM waypoints ORDER BY vehicle_key
    """).fetchall()
    by_key = {r[1]: r[0] for r in rows}
    # Numeric string casts exactly as before (TRY_CAST path).
    assert by_key["fleet:42"] == 42
    # Non-numeric strings fall back to a deterministic positive int hash.
    assert isinstance(by_key["fleet:veh-A"], int)
    assert by_key["fleet:veh-A"] > 0
    assert by_key["fleet:veh-A"] != by_key["fleet:veh-B"]
    # vehicle_key stays the authoritative identity — string ids intact.
    assert set(by_key) == {"fleet:42", "fleet:veh-A", "fleet:veh-B"}
    # Same string → same hash (deterministic across re-ingest).
    assert conn.execute(
        "SELECT COUNT(DISTINCT vehicle_id) FROM waypoints "
        "WHERE vehicle_key = 'fleet:veh-A'"
    ).fetchone()[0] == 1


def test_epoch_anchor_placeholder_in_derived_sql(conn):
    """{epoch_anchor} in a derived ColumnSpec is substituted at ingest."""
    cfg = {
        **NDJSON_SOURCE,
        "columns": {
            "vehicle_id_col": "vehicle",
            "waypoints": {
                "unix_time_ms": {"csv": "battery", "type": "double"},  # unused col
                "lon": {"csv": "lon", "type": "double"},
                "lat": {"csv": "lat", "type": "double"},
                "transport_mode": {
                    "derived": "CAST(({epoch_anchor} - {epoch_anchor}) + 3 AS INTEGER)"
                },
            },
        },
    }
    sf = _sources_file(cfg)
    src = sf.sources["test-src"]
    anchor = resolve_epoch_anchor(sf)
    ingest_source_trajectories(conn, FIXTURES / "pings.ndjson", "test-src", src, anchor)
    modes = conn.execute(
        "SELECT DISTINCT transport_mode FROM waypoints"
    ).fetchall()
    assert modes == [(3,)]


# --- Epoch-anchor persistence -------------------------------------------------------


def test_resolve_epoch_anchor_top_level_wins():
    sf = _sources_file(GEOJSON_SOURCE, time={"epoch_anchor": ANCHOR_ISO})
    assert resolve_epoch_anchor(sf) == 1714489200


def test_resolve_epoch_anchor_default_is_base_epoch():
    sf = _sources_file(TRIPS_SOURCE)
    from backend.config import BASE_EPOCH_SEC

    assert resolve_epoch_anchor(sf) == BASE_EPOCH_SEC


def test_ensure_epoch_anchor_writes_then_reads(conn):
    ensure_epoch_anchor(conn, 1714489200)
    assert get_epoch_anchor(conn) == 1714489200
    # Re-ensuring the same anchor is a no-op.
    ensure_epoch_anchor(conn, 1714489200)


def test_mixed_anchor_ingest_is_hard_error(conn):
    ensure_epoch_anchor(conn, 1714489200)
    with pytest.raises(ValueError, match="Epoch-anchor mismatch"):
        ensure_epoch_anchor(conn, 1601478000)
