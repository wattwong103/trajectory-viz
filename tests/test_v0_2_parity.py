"""
Step 1.7 — Migration parity tests for the v0.2 declarative-schema ingest.

Two layers:

1. **pytest unit tests** (run via `pytest tests/test_v0_2_parity.py -v`) — feed
   synthetic CSVs through `ingest_source_trips` / `ingest_source_trajectories`
   and assert the resulting rows have all the implicit columns populated
   correctly. This catches regressions in the SQL builders.

2. **Manual cross-version check** (run via
   `python -m tests.test_v0_2_parity --v1-db PATH --v2-db PATH`) — compares
   row counts and sample columns between a pre-v0.2 DuckDB file (created by
   the old hardcoded ingest) and a post-v0.2 file (created by the new
   declarative ingest). Use this to gate Phase 1 before merging.

Run order for the manual check:
    git checkout main
    python -m backend.ingest --reset
    cp output/viz/pflow.duckdb output/viz/pflow_v0_1.duckdb
    git checkout phase-1-foundation
    python -m backend.ingest --reset
    python -m tests.test_v0_2_parity \\
        --v1-db output/viz/pflow_v0_1.duckdb \\
        --v2-db output/viz/pflow.duckdb
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import duckdb
import pytest


# Make the project root importable when running pytest from anywhere.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.db import _init_schema  # noqa: E402
from backend.ingest import (  # noqa: E402
    compute_derived_metrics,
    ingest_source_trajectories,
    ingest_source_trips,
)
from backend.sources_schema import load_sources  # noqa: E402


# --- Fixtures ---------------------------------------------------------------


@pytest.fixture
def sources():
    return load_sources(PROJECT_ROOT / "sources.yaml")


@pytest.fixture
def conn():
    """Fresh in-memory DuckDB with full v0.2 schema."""
    c = duckdb.connect(":memory:")
    _init_schema(c)
    yield c
    c.close()


@pytest.fixture
def truck_csv(tmp_path: Path) -> Path:
    p = tmp_path / "truck_trips.csv"
    p.write_text(
        "id,sim_day,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,"
        "purpose,occupation,cargo_loaded,truck_id,distance_km,cargo_weight_tons,"
        "goods_type,vehicle_size,capacity_tons,status,starttime_h\n"
        "1,0,28800,139.60,35.60,139.70,35.70,1,1,2,true,1001,12.3,1.5,kibutsu,small,2.0,delivery,8\n"
        "2,0,36000,139.70,35.70,139.80,35.80,1,1,2,false,1002,8.7,0.0,kibutsu,small,2.0,empty,10\n"
        "3,1,18000,139.65,35.65,139.75,35.75,1,2,2,true,1001,5.2,0.8,nourinsuisanhin,medium,4.0,delivery,5\n"
    )
    return p


@pytest.fixture
def taxi_csv(tmp_path: Path) -> Path:
    p = tmp_path / "taxi_trips.csv"
    p.write_text(
        "id,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,purpose,"
        "occupation,passenger_in,taxi_id,distance_km,fare_yen,is_night_trip,"
        "starttime_h,simulation_day\n"
        "1,28800,139.7,35.7,139.8,35.8,4,2,1,true,47,5.4,820.0,false,2026-05-16 08:00:00,0\n"
        "2,72000,139.7,35.7,139.6,35.6,4,2,1,false,47,3.2,540.0,true,2026-05-16 20:00:00,0\n"
        "3,32400,139.65,35.66,139.78,35.71,4,2,1,true,99,7.1,1050.0,false,2026-05-16 09:00:00,0\n"
    )
    return p


@pytest.fixture
def truck_waypoints_csv(tmp_path: Path) -> Path:
    p = tmp_path / "truck_waypoints.csv"
    p.write_text(
        "truck_id,trip_id,unix_time_ms,datetime,lon,lat,transport_mode,purpose,"
        "goods_type,vehicle_size,link_id\n"
        "1001,1,1715817600000,2026-05-16T00:00:00,139.60,35.60,1,1,kibutsu,small,L1\n"
        "1001,1,1715817700000,2026-05-16T00:01:40,139.65,35.65,1,1,kibutsu,small,L2\n"
        "1001,1,1715817800000,2026-05-16T00:03:20,139.70,35.70,1,1,kibutsu,small,L3\n"
    )
    return p


# --- Unit tests: trips path -------------------------------------------------


def test_truck_trips_row_count(conn, sources, truck_csv):
    n = ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    assert n == 3


def test_truck_trips_source_id_populated(conn, sources, truck_csv):
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    rows = conn.execute(
        "SELECT DISTINCT source_id, vehicle_type FROM trips"
    ).fetchall()
    assert rows == [("truck", "truck")]


def test_truck_vehicle_key_template(conn, sources, truck_csv):
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    keys = sorted(r[0] for r in conn.execute("SELECT DISTINCT vehicle_key FROM trips").fetchall())
    assert keys == ["truck:1001", "truck:1002"]


def test_truck_city_is_null(conn, sources, truck_csv):
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    nulls = conn.execute("SELECT COUNT(*) FROM trips WHERE city IS NULL").fetchone()[0]
    assert nulls == 3


def test_truck_taxi_columns_are_null(conn, sources, truck_csv):
    """Taxi-only columns (fare_yen, is_night_trip, passenger_in) NULL on truck rows."""
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    row = conn.execute(
        "SELECT COUNT(*) FROM trips "
        "WHERE fare_yen IS NULL AND is_night_trip IS NULL AND passenger_in IS NULL AND taxi_id IS NULL"
    ).fetchone()
    assert row[0] == 3


def test_truck_cargo_loaded_bool_coercion(conn, sources, truck_csv):
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    rows = conn.execute(
        "SELECT trip_id, cargo_loaded FROM trips ORDER BY trip_id"
    ).fetchall()
    assert rows == [(1, True), (2, False), (3, True)]


def test_truck_dep_hour_derived(conn, sources, truck_csv):
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    rows = conn.execute(
        "SELECT trip_id, dep_hour FROM trips ORDER BY trip_id"
    ).fetchall()
    # starttime/3600: 28800→8, 36000→10, 18000→5
    assert rows == [(1, 8), (2, 10), (3, 5)]


def test_taxi_trips_scope_and_city(conn, sources, taxi_csv):
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    rows = conn.execute(
        "SELECT DISTINCT source_id, vehicle_type, city FROM trips"
    ).fetchall()
    assert rows == [("taxi", "taxi", "tokyo")]


def test_taxi_vehicle_key_includes_scope(conn, sources, taxi_csv):
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    keys = sorted(r[0] for r in conn.execute("SELECT DISTINCT vehicle_key FROM trips").fetchall())
    assert keys == ["taxi:tokyo:47", "taxi:tokyo:99"]


def test_taxi_id_back_compat_column(conn, sources, taxi_csv):
    """v0.1 always populated `taxi_id` for taxi rows; preserve this."""
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    rows = conn.execute("SELECT trip_id, taxi_id FROM trips ORDER BY trip_id").fetchall()
    assert rows == [(1, 47), (2, 47), (3, 99)]


def test_taxi_bool_coercions(conn, sources, taxi_csv):
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    rows = conn.execute(
        "SELECT trip_id, is_night_trip, passenger_in FROM trips ORDER BY trip_id"
    ).fetchall()
    assert rows == [
        (1, False, True),
        (2, True, False),
        (3, False, True),
    ]


def test_taxi_dep_hour_from_timestamp(conn, sources, taxi_csv):
    """Taxi `dep_hour` is derived from starttime_h timestamp string, not starttime int."""
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    rows = conn.execute("SELECT trip_id, dep_hour FROM trips ORDER BY trip_id").fetchall()
    assert rows == [(1, 8), (2, 20), (3, 9)]


def test_taxi_truck_columns_are_null(conn, sources, taxi_csv):
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    row = conn.execute(
        "SELECT COUNT(*) FROM trips "
        "WHERE goods_type IS NULL AND vehicle_size IS NULL AND cargo_loaded IS NULL "
        "AND origin_zone IS NULL AND dest_zone IS NULL"
    ).fetchone()
    assert row[0] == 3


def test_two_sources_share_table(conn, sources, truck_csv, taxi_csv):
    """Both sources insert into the same `trips` table without collisions."""
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])
    counts = conn.execute(
        "SELECT source_id, COUNT(*) FROM trips GROUP BY source_id ORDER BY source_id"
    ).fetchall()
    assert counts == [("taxi", 3), ("truck", 3)]


# --- Unit tests: waypoints path ---------------------------------------------


def test_truck_waypoints_ingest(conn, sources, truck_waypoints_csv):
    n = ingest_source_trajectories(
        conn, truck_waypoints_csv, "pflow-truck", sources.sources["pflow-truck"]
    )
    assert n == 3
    rows = conn.execute(
        "SELECT vehicle_id, trip_id, source_id, vehicle_type, vehicle_key, link_id "
        "FROM waypoints ORDER BY unix_time_ms"
    ).fetchall()
    assert all(r[2] == "truck" and r[3] == "truck" for r in rows)
    assert all(r[4] == "truck:1001" for r in rows)
    assert [r[5] for r in rows] == ["L1", "L2", "L3"]


def test_truck_waypoints_taxi_columns_null(conn, sources, truck_waypoints_csv):
    ingest_source_trajectories(
        conn, truck_waypoints_csv, "pflow-truck", sources.sources["pflow-truck"]
    )
    nulls = conn.execute(
        "SELECT COUNT(*) FROM waypoints "
        "WHERE fare_yen IS NULL AND passenger_in IS NULL AND is_night_trip IS NULL"
    ).fetchone()[0]
    assert nulls == 3


# --- F1 derived metrics (Phase 2 Step 2.1) ----------------------------------


@pytest.fixture
def dwell_truck_csv(tmp_path: Path) -> Path:
    """Two trips for truck #1001 on sim_day=0: 8:00 → 10:00 → 13:00.

    Expected dwell sequence (LEAD over starttime):
      trip 1 (8:00, 28800s) → next is 10:00 (36000s) → dwell = 7200s = 120 min
      trip 2 (10:00, 36000s) → next is 13:00 (46800s) → dwell = 10800s = 180 min
      trip 3 (13:00, 46800s) → no next → NULL
    Trip distances pick haversine values that are easy to verify:
      trip 1: distance 5 km, OD endpoints ~3.5 km apart → detour_ratio ≈ 1.43
      trip 2: distance 1 km, OD endpoints same → haversine 0 → detour_ratio NULL
      trip 3: distance 10 km, OD endpoints ~8 km apart → detour_ratio ≈ 1.25
    """
    p = tmp_path / "dwell_truck.csv"
    p.write_text(
        "id,sim_day,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,"
        "purpose,occupation,cargo_loaded,truck_id,distance_km,cargo_weight_tons,"
        "goods_type,vehicle_size,capacity_tons,status,starttime_h\n"
        # trip 1: starttime=28800 (8h), 5km route, ~3.5km OD
        "1,0,28800,139.60,35.60,139.638,35.60,1,1,2,true,1001,5.0,1.0,kibutsu,small,2.0,delivery,8\n"
        # trip 2: starttime=36000 (10h), 1km route, 0km OD (start==end → detour NULL)
        "2,0,36000,139.70,35.70,139.70,35.70,1,1,2,true,1001,1.0,0.5,kibutsu,small,2.0,delivery,10\n"
        # trip 3: starttime=46800 (13h), 10km route, ~8km OD
        "3,0,46800,139.65,35.65,139.738,35.65,1,1,2,true,1001,10.0,1.5,kibutsu,small,2.0,delivery,13\n"
    )
    return p


def test_dwell_minutes_via_window(conn, sources, dwell_truck_csv):
    ingest_source_trips(conn, dwell_truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    counts = compute_derived_metrics(conn)
    assert counts["dwell_minutes"] == 2  # last trip has no successor
    rows = conn.execute(
        "SELECT trip_id, dwell_minutes FROM trips ORDER BY trip_id"
    ).fetchall()
    # trip 1: (36000 - 28800) / 60 = 120 min
    # trip 2: (46800 - 36000) / 60 = 180 min
    # trip 3: NULL (no LEAD)
    assert rows == [(1, 120.0), (2, 180.0), (3, None)]


def test_detour_ratio_nulls_on_zero_haversine(conn, sources, dwell_truck_csv):
    ingest_source_trips(conn, dwell_truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    compute_derived_metrics(conn)
    rows = conn.execute(
        "SELECT trip_id, detour_ratio FROM trips ORDER BY trip_id"
    ).fetchall()
    # trip 2 has start == end → haversine 0 → DETOUR_MIN_HAVERSINE_KM filter NULLs it
    assert rows[1] == (2, None)
    # trips 1 and 3 should have detour_ratio > 1.0 (route is longer than OD straight line)
    assert rows[0][1] is not None and rows[0][1] > 1.0
    assert rows[2][1] is not None and rows[2][1] > 1.0


def test_detour_ratio_short_trip_nulled(conn, sources, tmp_path):
    """A trip with non-zero but < 100m haversine should also be NULLed (GPS-noise guard)."""
    p = tmp_path / "tiny.csv"
    p.write_text(
        "id,sim_day,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,"
        "purpose,occupation,cargo_loaded,truck_id,distance_km,cargo_weight_tons,"
        "goods_type,vehicle_size,capacity_tons,status,starttime_h\n"
        # ~50m haversine offset (~0.0005 deg latitude); 0.3 km route → ratio would be ~6.0
        "1,0,28800,139.60,35.60,139.60,35.6005,1,1,2,true,1001,0.3,0.0,kibutsu,small,2.0,delivery,8\n"
    )
    ingest_source_trips(conn, p, "pflow-truck", sources.sources["pflow-truck"])
    compute_derived_metrics(conn)
    row = conn.execute("SELECT detour_ratio FROM trips WHERE trip_id = 1").fetchone()
    assert row == (None,), f"Short trip should give NULL detour_ratio, got {row[0]}"


def test_speed_avg_kmh_from_waypoints(conn, sources, truck_csv, truck_waypoints_csv):
    """speed = distance_km / ((max_unix_ms - min_unix_ms)/1000/3600) — needs waypoints."""
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    ingest_source_trajectories(
        conn, truck_waypoints_csv, "pflow-truck", sources.sources["pflow-truck"]
    )
    compute_derived_metrics(conn)
    # truck_waypoints_csv has trip 1 with timestamps spanning 200_000 ms = 200 sec.
    # truck_csv trip 1 has distance_km = 12.3.
    # Expected speed = 12.3 / (200/3600) = 12.3 / 0.05556 = 221.4 km/h. Unrealistic
    # but mathematically correct for the synthetic data — the test asserts the
    # formula, not realism.
    row = conn.execute(
        "SELECT trip_id, speed_avg_kmh FROM trips WHERE trip_id = 1"
    ).fetchone()
    assert row[0] == 1
    assert row[1] is not None
    expected = 12.3 / (200 / 3600.0)
    assert abs(row[1] - expected) < 0.01, f"Got {row[1]}, expected ~{expected}"


def test_speed_null_when_no_waypoints(conn, sources, truck_csv):
    """Trips without waypoint data have NULL speed_avg_kmh (not estimable)."""
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    # No waypoints ingested
    compute_derived_metrics(conn)
    nulls = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE speed_avg_kmh IS NULL"
    ).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
    assert nulls == total


def test_derived_metrics_indexed(conn, sources, truck_csv):
    """The three F1 metric columns get indexes for filter scans."""
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    compute_derived_metrics(conn)
    idx_names = {
        r[0]
        for r in conn.execute(
            "SELECT index_name FROM duckdb_indexes() WHERE table_name='trips'"
        ).fetchall()
    }
    assert "idx_trips_speed" in idx_names
    assert "idx_trips_dwell" in idx_names
    assert "idx_trips_detour" in idx_names


# --- F3 segments (Phase 2 Step 2.5) -----------------------------------------


def test_segments_count_equals_waypoints_minus_one():
    """Each trajectory of N waypoints produces N-1 segments."""
    from backend.routers.trajectories import _compute_segments
    # Row format from _WAYPOINT_COLS: index 2=unix_time_ms, 3=lon, 4=lat, 13=link_id
    # (other indices not used by _compute_segments)
    wps = [
        (None, None, 1_000_000, 139.60, 35.60, None, None, None, None, None, None, None, None, "L1"),
        (None, None, 1_010_000, 139.61, 35.61, None, None, None, None, None, None, None, None, "L2"),
        (None, None, 1_020_000, 139.62, 35.62, None, None, None, None, None, None, None, None, "L3"),
    ]
    segments = _compute_segments(wps)
    assert len(segments) == 2
    assert segments[0].link_id == "L2"  # second waypoint of the pair owns the link
    assert segments[1].link_id == "L3"


def test_segments_speed_and_dwell_logic():
    """Fast segment → speed populated, dwell None. Slow segment → dwell populated."""
    from backend.routers.trajectories import _compute_segments
    # Segment 1: 10s apart, ~1.4 km haversine → ~500 km/h (synthetic, not physical)
    # Segment 2: 60s apart, ~0.001 km (~50m) → ~0.06 km/h → idle → dwell populated
    wps = [
        (None, None, 1_000_000, 139.60, 35.60, None, None, None, None, None, None, None, None, "L1"),
        (None, None, 1_010_000, 139.61, 35.61, None, None, None, None, None, None, None, None, "L2"),
        (None, None, 1_070_000, 139.61001, 35.61001, None, None, None, None, None, None, None, None, "L3"),
    ]
    segments = _compute_segments(wps)
    assert segments[0].speed_kmh is not None and segments[0].speed_kmh > 100
    assert segments[0].dwell_sec is None  # fast, not idle
    assert segments[1].speed_kmh is not None and segments[1].speed_kmh < 1.0
    assert segments[1].dwell_sec == 60.0  # idle for 60 seconds


def test_segments_optional_in_response(conn, sources, truck_csv, truck_waypoints_csv):
    """_rows_to_trajectories defaults to segments=None unless include_segments=True."""
    from backend.routers.trajectories import _rows_to_trajectories
    # Ingest then fetch waypoints in the same shape the router expects
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])
    ingest_source_trajectories(
        conn, truck_waypoints_csv, "pflow-truck", sources.sources["pflow-truck"]
    )
    rows = conn.execute("""
        SELECT vehicle_id, trip_id, unix_time_ms, lon, lat,
               vehicle_type, transport_mode, purpose,
               goods_type, vehicle_size, passenger_in, fare_yen, vehicle_key, link_id
        FROM waypoints ORDER BY vehicle_id, trip_id, unix_time_ms
    """).fetchall()
    no_seg = _rows_to_trajectories(rows)
    assert all(t.segments is None for t in no_seg)
    with_seg = _rows_to_trajectories(rows, include_segments=True)
    assert all(t.segments is not None for t in with_seg)
    # First trajectory has 3 waypoints → 2 segments
    assert len(with_seg[0].segments) == len(with_seg[0].path) - 1


# --- Manual cross-version parity --------------------------------------------


_PARITY_COLUMNS_TRIPS = [
    "vehicle_id", "trip_id", "starttime", "start_lon", "start_lat",
    "end_lon", "end_lat", "transport_mode", "purpose", "vehicle_type",
    "distance_km", "dep_hour", "simulation_day", "goods_type", "vehicle_size",
    "cargo_loaded", "fare_yen", "is_night_trip", "passenger_in", "taxi_id",
    "city", "vehicle_key",
]


def _compare_dbs(v1_path: Path, v2_path: Path) -> int:
    """Compare two DuckDB files. Returns exit code: 0=parity, 1=mismatch, 2=missing."""
    if not v1_path.is_file():
        print(f"[ERROR] v1 DB not found: {v1_path}", file=sys.stderr)
        return 2
    if not v2_path.is_file():
        print(f"[ERROR] v2 DB not found: {v2_path}", file=sys.stderr)
        return 2

    v1 = duckdb.connect(str(v1_path), read_only=True)
    v2 = duckdb.connect(str(v2_path), read_only=True)

    print(f"v1 DB: {v1_path}")
    print(f"v2 DB: {v2_path}")
    print()

    mismatches = 0

    # Row count by (vehicle_type, city, simulation_day)
    for table in ("trips", "waypoints"):
        print(f"--- {table} row counts by (vehicle_type, city, simulation_day) ---")
        group_cols = (
            "vehicle_type, city, simulation_day" if table == "trips" else "vehicle_type"
        )
        v1_rows = dict(
            (tuple(r[:-1]), r[-1])
            for r in v1.execute(
                f"SELECT {group_cols}, COUNT(*) FROM {table} GROUP BY {group_cols} ORDER BY {group_cols}"
            ).fetchall()
        )
        v2_rows = dict(
            (tuple(r[:-1]), r[-1])
            for r in v2.execute(
                f"SELECT {group_cols}, COUNT(*) FROM {table} GROUP BY {group_cols} ORDER BY {group_cols}"
            ).fetchall()
        )
        all_keys = set(v1_rows) | set(v2_rows)
        for key in sorted(all_keys, key=str):
            v1_n = v1_rows.get(key, 0)
            v2_n = v2_rows.get(key, 0)
            if v1_n == v2_n:
                print(f"  OK    {key}: {v1_n:,}")
            else:
                mismatches += 1
                print(f"  DIFF  {key}: v1={v1_n:,} v2={v2_n:,}  ({v2_n - v1_n:+,})")
        print()

    # Sample-row content comparison for trips (1000 rows by vehicle_key)
    print("--- trips sample (1000 rows by vehicle_key/trip_id) — column-by-column ---")
    cols = ", ".join(_PARITY_COLUMNS_TRIPS)
    sample_sql = (
        f"SELECT {cols} FROM trips ORDER BY vehicle_key, trip_id LIMIT 1000"
    )
    v1_sample = v1.execute(sample_sql).fetchall()
    v2_sample = v2.execute(sample_sql).fetchall()
    if v1_sample == v2_sample:
        print(f"  OK    {len(v1_sample)} rows byte-identical (modulo new source_id column)")
    else:
        mismatches += 1
        diff_count = sum(1 for a, b in zip(v1_sample, v2_sample) if a != b)
        print(f"  DIFF  {diff_count} of {min(len(v1_sample), len(v2_sample))} rows differ")
        for i, (a, b) in enumerate(zip(v1_sample, v2_sample)):
            if a != b:
                # Find the first column that differs
                for col_name, va, vb in zip(_PARITY_COLUMNS_TRIPS, a, b):
                    if va != vb:
                        print(f"    row {i} col {col_name}: v1={va!r} v2={vb!r}")
                        break
                if i >= 4:
                    print(f"    (... {diff_count - 5} more diffs)")
                    break

    v1.close()
    v2.close()
    print()
    if mismatches == 0:
        print("PARITY OK")
        return 0
    else:
        print(f"PARITY FAILED — {mismatches} mismatches")
        return 1


def _main_cli() -> None:
    parser = argparse.ArgumentParser(
        description="Compare v0.1 and v0.2 DuckDB ingests for migration parity."
    )
    parser.add_argument("--v1-db", required=True, type=Path)
    parser.add_argument("--v2-db", required=True, type=Path)
    args = parser.parse_args()
    sys.exit(_compare_dbs(args.v1_db, args.v2_db))


if __name__ == "__main__":
    _main_cli()
