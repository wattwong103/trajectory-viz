"""
Ingestion CLI — loads PFLOW trip and trajectory CSVs into DuckDB.

Scans the output/ directory for the latest simulation runs and imports them.
Handles both trips-only mode (no trajectories yet) and full mode.

Usage:
    python -m viz.backend.ingest [--pflow-home PATH] [--db-path PATH] [--output-root PATH] [--reset]

CSV column formats parsed (from Java writers):
    Truck trips:  id,sim_day,starttime,start_lon,start_lat,end_lon,end_lat,
                  transport_mode,purpose,occupation,cargo_loaded,truck_id,distance_km,
                  cargo_weight_tons,goods_type,vehicle_size,capacity_tons,status,starttime_h
    Taxi trips:   id,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,purpose,
                  occupation,passenger_in,taxi_id,distance_km,fare_yen,is_night_trip,
                  starttime_h,simulation_day
    Truck traj:   truck_id,trip_id,unix_time_ms,datetime,lon,lat,transport_mode,purpose,
                  goods_type,vehicle_size,link_id
    Taxi traj:    taxi_id,trip_id,unix_time_ms,datetime,lon,lat,transport_mode,purpose,
                  passenger_in,fare_yen,is_night_trip,link_id
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path
from glob import glob

# Allow running as `python -m backend.ingest` from trajectory-viz/
# OR as `python -m viz.backend.ingest` from PFLOW root (if symlinked)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import get_pflow_home, get_viz_db_path, get_output_root
from backend.db import get_connection, reset_db


def find_latest_run(base_dir: Path) -> Path | None:
    """Find the most recent run_YYYYMMDD_HHMMSS directory."""
    if not base_dir.is_dir():
        return None
    runs = sorted(base_dir.glob("run_*"), reverse=True)
    return runs[0] if runs else None


def find_trip_files(output_dir: Path) -> list[tuple[Path, str, str | None, Path]]:
    """Discover trip CSV files. Returns [(csv_path, vehicle_type, city, run_dir)].

    The run_dir is threaded so the validation.csv sibling can be located.
    """
    files: list[tuple[Path, str, str | None, Path]] = []

    # Truck trips
    truck_dir = output_dir / "trips" / "truck"
    latest = find_latest_run(truck_dir)
    if latest:
        csv = latest / "trips_pseudo_pflow.csv"
        if csv.is_file():
            files.append((csv, "truck", None, latest))

    # Taxi trips (per city)
    taxi_base = output_dir / "trips" / "taxi"
    if taxi_base.is_dir():
        for city_dir in sorted(taxi_base.iterdir()):
            if city_dir.is_dir() and not city_dir.name.startswith("."):
                latest = find_latest_run(city_dir)
                if latest:
                    csv = latest / "trips_pseudo_pflow.csv"
                    if csv.is_file():
                        files.append((csv, "taxi", city_dir.name, latest))

    return files


def find_trajectory_files(output_dir: Path) -> list[tuple[Path, str, str | None]]:
    """Discover trajectory CSV files. Returns [(path, vehicle_type, city_or_none)]."""
    files = []

    # Truck trajectories
    truck_traj = output_dir / "trajectory" / "truck"
    if truck_traj.is_dir():
        for csv in sorted(truck_traj.glob("trajectory_*.csv")):
            files.append((csv, "truck", None))

    # Taxi trajectories (per city)
    taxi_traj = output_dir / "trajectory" / "taxi"
    if taxi_traj.is_dir():
        for city_dir in sorted(taxi_traj.iterdir()):
            if city_dir.is_dir() and not city_dir.name.startswith("."):
                for csv in sorted(city_dir.glob("trajectory_*.csv")):
                    files.append((csv, "taxi", city_dir.name))

    return files


def ingest_truck_trips(conn, csv_path: Path) -> int:
    """Load truck trips CSV into the trips table.

    The real truck CSV schema (from TruckTripWriter):
        id, sim_day, starttime, start_lon, start_lat, end_lon, end_lat,
        transport_mode, purpose, occupation, cargo_loaded, truck_id,
        distance_km, cargo_weight_tons, goods_type, vehicle_size,
        capacity_tons, status, starttime_h

    Columns ignored (not in trips schema): cargo_weight_tons, capacity_tons,
    status, starttime_h, occupation. origin_zone/dest_zone are NULL — CSV
    doesn't include them.
    """
    before = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE vehicle_type='truck'"
    ).fetchone()[0]

    conn.execute(f"""
        INSERT INTO trips (
            vehicle_id, trip_id, starttime,
            start_lon, start_lat, end_lon, end_lat,
            transport_mode, purpose, vehicle_type,
            distance_km, dep_hour, simulation_day,
            goods_type, vehicle_size, cargo_loaded,
            origin_zone, dest_zone,
            fare_yen, is_night_trip, passenger_in, taxi_id, city,
            vehicle_key
        )
        SELECT
            truck_id                   AS vehicle_id,
            id                         AS trip_id,
            starttime,
            start_lon, start_lat, end_lon, end_lat,
            transport_mode,
            purpose,
            'truck'                    AS vehicle_type,
            distance_km,
            starttime // 3600          AS dep_hour,
            sim_day                    AS simulation_day,
            goods_type,
            vehicle_size,
            CASE WHEN cargo_loaded = 'true' THEN TRUE ELSE FALSE END AS cargo_loaded,
            NULL                       AS origin_zone,
            NULL                       AS dest_zone,
            NULL                       AS fare_yen,
            NULL                       AS is_night_trip,
            NULL                       AS passenger_in,
            NULL                       AS taxi_id,
            NULL                       AS city,
            'truck:' || truck_id       AS vehicle_key
        FROM read_csv('{csv_path.as_posix()}', header=true, auto_detect=true)
    """)

    after = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE vehicle_type='truck'"
    ).fetchone()[0]
    return after - before


def ingest_taxi_trips(conn, csv_path: Path, city: str) -> int:
    """Load taxi trips CSV into the trips table.

    Note: in taxi CSVs, `id` is the per-file trip sequence and `taxi_id` is
    the actual taxi agent. We use taxi_id as vehicle_id so fleet-utilization
    queries (trips-per-vehicle, unique_vehicles) give correct answers.
    vehicle_key is 'taxi:{city}:{taxi_id}' to disambiguate across cities.
    """
    before = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE vehicle_type='taxi' AND city = ?",
        [city],
    ).fetchone()[0]

    conn.execute(f"""
        INSERT INTO trips (
            vehicle_id, trip_id, starttime,
            start_lon, start_lat, end_lon, end_lat,
            transport_mode, purpose, vehicle_type,
            distance_km, dep_hour, simulation_day,
            goods_type, vehicle_size, cargo_loaded,
            origin_zone, dest_zone,
            fare_yen, is_night_trip, passenger_in, taxi_id, city,
            vehicle_key
        )
        SELECT
            taxi_id                                            AS vehicle_id,
            id                                                 AS trip_id,
            starttime,
            start_lon, start_lat, end_lon, end_lat,
            transport_mode,
            purpose,
            'taxi'                                             AS vehicle_type,
            distance_km,
            CAST(EXTRACT(HOUR FROM starttime_h) AS INTEGER)    AS dep_hour,
            simulation_day,
            NULL                                               AS goods_type,
            NULL                                               AS vehicle_size,
            NULL                                               AS cargo_loaded,
            NULL                                               AS origin_zone,
            NULL                                               AS dest_zone,
            fare_yen,
            CASE WHEN is_night_trip = 'true' THEN TRUE ELSE FALSE END AS is_night_trip,
            CASE WHEN passenger_in  = 'true' THEN TRUE ELSE FALSE END AS passenger_in,
            taxi_id,
            '{city}'                                           AS city,
            'taxi:{city}:' || taxi_id                          AS vehicle_key
        FROM read_csv('{csv_path.as_posix()}', header=true, auto_detect=true)
    """)

    after = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE vehicle_type='taxi' AND city = ?",
        [city],
    ).fetchone()[0]
    return after - before


def ingest_truck_trajectories(conn, csv_path: Path) -> int:
    """Load truck trajectory CSV into the waypoints table."""
    before = conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE vehicle_type='truck'"
    ).fetchone()[0]

    conn.execute(f"""
        INSERT INTO waypoints (
            vehicle_id, trip_id, unix_time_ms,
            lon, lat, link_id,
            vehicle_type, transport_mode, purpose,
            goods_type, vehicle_size,
            passenger_in, fare_yen, is_night_trip,
            vehicle_key
        )
        SELECT
            truck_id                   AS vehicle_id,
            trip_id,
            unix_time_ms,
            lon,
            lat,
            link_id,
            'truck'                    AS vehicle_type,
            transport_mode,
            purpose,
            goods_type,
            vehicle_size,
            NULL                       AS passenger_in,
            NULL                       AS fare_yen,
            NULL                       AS is_night_trip,
            'truck:' || truck_id       AS vehicle_key
        FROM read_csv(
            '{csv_path.as_posix()}',
            header=true, auto_detect=true,
            types={{'link_id': 'VARCHAR'}}
        )
    """)

    after = conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE vehicle_type='truck'"
    ).fetchone()[0]
    return after - before


def ingest_taxi_trajectories(conn, csv_path: Path, city: str) -> int:
    """Load taxi trajectory CSV into the waypoints table.

    The `city` argument is required so vehicle_key can be unique across
    Tokyo/Osaka/etc. where taxi_id ranges overlap.
    """
    before = conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE vehicle_type='taxi' AND vehicle_key LIKE ?",
        [f"taxi:{city}:%"],
    ).fetchone()[0]

    conn.execute(f"""
        INSERT INTO waypoints (
            vehicle_id, trip_id, unix_time_ms,
            lon, lat, link_id,
            vehicle_type, transport_mode, purpose,
            goods_type, vehicle_size,
            passenger_in, fare_yen, is_night_trip,
            vehicle_key
        )
        SELECT
            taxi_id                           AS vehicle_id,
            trip_id,
            unix_time_ms,
            lon,
            lat,
            link_id,
            'taxi'                            AS vehicle_type,
            transport_mode,
            purpose,
            NULL                              AS goods_type,
            NULL                              AS vehicle_size,
            passenger_in,
            fare_yen,
            is_night_trip,
            'taxi:{city}:' || taxi_id         AS vehicle_key
        FROM read_csv(
            '{csv_path.as_posix()}',
            header=true, auto_detect=true,
            types={{'link_id': 'VARCHAR'}}
        )
    """)

    after = conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE vehicle_type='taxi' AND vehicle_key LIKE ?",
        [f"taxi:{city}:%"],
    ).fetchone()[0]
    return after - before


def ingest_validation(conn, run_dir: Path, vehicle_type: str, city: str | None) -> int:
    """Load a validation.csv file into the validation_runs table.

    Idempotent — any existing rows for this run_id are cleared before re-loading.
    Missing validation.csv results in a warning + return 0 (not an error).
    """
    csv = run_dir / "validation.csv"
    if not csv.is_file():
        print(f"  [VAL] no validation.csv in {run_dir.name}, skipping")
        return 0

    run_id = f"{vehicle_type}/" + (f"{city}/" if city else "") + run_dir.name

    m = re.match(r"run_(\d{8})_(\d{6})", run_dir.name)
    if m:
        ts_sql = f"STRPTIME('{m.group(1)} {m.group(2)}', '%Y%m%d %H%M%S')"
    else:
        ts_sql = "NULL"
        print(f"  [VAL] WARN: could not parse timestamp from {run_dir.name}")

    conn.execute("DELETE FROM validation_runs WHERE run_id = ?", [run_id])

    city_sql = f"'{city}'" if city else "NULL"
    conn.execute(f"""
        INSERT INTO validation_runs (
            run_id, vehicle_type, city, run_timestamp,
            category, metric, actual, target, tolerance_pct, error_pct, status,
            ingested_at
        )
        SELECT
            '{run_id}'        AS run_id,
            '{vehicle_type}'  AS vehicle_type,
            {city_sql}        AS city,
            {ts_sql}          AS run_timestamp,
            category, metric, actual, target, tolerance_pct, error_pct, status,
            current_timestamp AS ingested_at
        FROM read_csv('{csv.as_posix()}', header=true, auto_detect=true)
    """)

    row = conn.execute(
        "SELECT COUNT(*) FROM validation_runs WHERE run_id = ?", [run_id]
    ).fetchone()
    return row[0] if row else 0


def main():
    parser = argparse.ArgumentParser(description="Ingest PFLOW outputs into DuckDB")
    parser.add_argument("--pflow-home", type=str, default=None,
                        help="Override PFLOW project root (monorepo mode)")
    parser.add_argument("--db-path", type=str, default=None,
                        help="Override DuckDB output path (sets PFLOW_VIZ_DB)")
    parser.add_argument("--output-root", type=str, default=None,
                        help="Override scan root for trips/trajectory subtrees (sets PFLOW_VIZ_OUTPUT_ROOT)")
    parser.add_argument("--reset", action="store_true",
                        help="Drop and recreate all tables before ingesting")
    args = parser.parse_args()

    # Apply CLI overrides to env before config functions are called
    if args.pflow_home:
        os.environ["PFLOW_HOME"] = args.pflow_home
    if args.db_path:
        os.environ["PFLOW_VIZ_DB"] = args.db_path
    if args.output_root:
        os.environ["PFLOW_VIZ_OUTPUT_ROOT"] = args.output_root

    db_path = get_viz_db_path()
    output_dir = get_output_root()

    print("=" * 64)
    print("  PFLOW VIZ -- Data Ingestion")
    print("=" * 64)
    # In standalone mode (PFLOW_VIZ_DB set), PFLOW_HOME is irrelevant.
    # In monorepo mode, print it as a diagnostic.
    if os.environ.get("PFLOW_VIZ_DB") or args.db_path:
        print(f"  DB path:     {db_path}")
        print(f"  Output root: {output_dir}")
    else:
        try:
            pflow_home = get_pflow_home()
            print(f"  (monorepo mode) PFLOW_HOME: {pflow_home}")
        except FileNotFoundError as e:
            print(f"  (monorepo mode) PFLOW_HOME: NOT FOUND — {e}")
        print(f"  DB path:     {db_path}")
        print(f"  Output root: {output_dir}")

    if not output_dir.is_dir():
        print(f"\n[WARN] Output directory does not exist: {output_dir}")
        print("[INFO] Creating empty database with schema only...")
        get_connection()
        print("[DONE] Empty database created.")
        return

    if args.reset:
        print("\n[RESET] Dropping all tables...")
        reset_db()

    conn = get_connection()
    total_trips = 0
    total_waypoints = 0
    total_validation = 0
    # (file_path, target_table, error_repr) — anything that errored during ingest.
    # Captured so the run surfaces failures loudly at the end and a non-zero exit
    # code can alert CI/scripts. Also persisted to ingest_log with row_count=-1.
    errors: list[tuple[str, str, str]] = []
    start = time.time()

    def _log_failure(csv_path: Path, table: str, exc: BaseException) -> None:
        msg = f"{type(exc).__name__}: {exc}"
        errors.append((str(csv_path), table, msg))
        try:
            conn.execute(
                "INSERT INTO ingest_log (file_path, table_name, row_count) VALUES (?, ?, ?)",
                [str(csv_path), table, -1],
            )
        except Exception:
            # Never let log-write failures mask the original error
            pass

    # ------- Trips + validation (co-located per run_dir) -------
    trip_files = find_trip_files(output_dir)
    if trip_files:
        print(f"\n[TRIPS] Found {len(trip_files)} trip file(s):")
        for csv_path, vtype, city, run_dir in trip_files:
            label = f"{vtype}" + (f"/{city}" if city else "")
            print(f"  [{label}] {csv_path.name}...", end=" ", flush=True)
            t = time.time()
            try:
                if vtype == "truck":
                    n = ingest_truck_trips(conn, csv_path)
                else:
                    n = ingest_taxi_trips(conn, csv_path, city)
                total_trips += n
                print(f"{n:,} trips ({time.time()-t:.1f}s)")
                conn.execute("""
                    INSERT INTO ingest_log (file_path, table_name, row_count)
                    VALUES (?, 'trips', ?)
                """, [str(csv_path), n])
            except Exception as e:
                print(f"ERROR: {type(e).__name__}: {e}")
                _log_failure(csv_path, "trips", e)
                continue

            # Validation from the same run_dir
            try:
                vn = ingest_validation(conn, run_dir, vtype, city)
                if vn > 0:
                    total_validation += vn
                    print(f"    [val] {vn} metrics")
            except Exception as e:
                print(f"    [val] ERROR: {type(e).__name__}: {e}")
                _log_failure(run_dir / "validation.csv", "validation_runs", e)
    else:
        print("\n[TRIPS] No trip files found in output/trips/")

    # ------- Trajectories (separate tree) -------
    traj_files = find_trajectory_files(output_dir)
    if traj_files:
        print(f"\n[TRAJ] Found {len(traj_files)} trajectory file(s):")
        for csv_path, vtype, city in traj_files:
            label = f"{vtype}" + (f"/{city}" if city else "")
            print(f"  [{label}] {csv_path.name}...", end=" ", flush=True)
            t = time.time()
            try:
                if vtype == "truck":
                    n = ingest_truck_trajectories(conn, csv_path)
                else:
                    n = ingest_taxi_trajectories(conn, csv_path, city)
                total_waypoints += n
                print(f"{n:,} waypoints ({time.time()-t:.1f}s)")
                conn.execute("""
                    INSERT INTO ingest_log (file_path, table_name, row_count)
                    VALUES (?, 'waypoints', ?)
                """, [str(csv_path), n])
            except Exception as e:
                print(f"ERROR: {type(e).__name__}: {e}")
                _log_failure(csv_path, "waypoints", e)
    else:
        print("\n[TRAJ] No trajectory files found in output/trajectory/")

    elapsed = time.time() - start
    print(f"\n{'=' * 64}")
    print(f"  Ingestion complete in {elapsed:.1f}s")
    print(f"  Trips:       {total_trips:>12,}")
    print(f"  Waypoints:   {total_waypoints:>12,}")
    print(f"  Validation:  {total_validation:>12,}")
    print(f"  Database:    {db_path}")
    print(f"  Size:        {db_path.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"{'=' * 64}")

    if errors:
        # Files that errored are recorded in ingest_log with row_count=-1 so a
        # later `SELECT file_path FROM ingest_log WHERE row_count < 0` will find
        # them without re-running ingest.
        print(f"\n[FAILED] {len(errors)} file(s) did not ingest:")
        for file_path, table, msg in errors:
            print(f"  [{table}] {file_path}")
            print(f"    {msg}")
        print(
            "\nFix the underlying issue then re-run with --reset (or delete the "
            "failed rows from ingest_log and re-run without --reset)."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
