"""
Ingestion CLI — loads ABM trip + trajectory CSVs into DuckDB.

Sources are declared in `sources.yaml` at the project root (see
`backend/sources_schema.py` for the full schema). Each source declares its own
glob patterns, column mapping, and vehicle_key template; this module reads
those declarations and builds dynamic INSERT...SELECT statements against
DuckDB's `read_csv()`.

Usage:
    python -m backend.ingest [--pflow-home PATH] [--db-path PATH]
                              [--output-root PATH] [--sources PATH] [--reset]

Result tables (see backend/db.py for full schema):
    trips           per-trip row, one source's columns.trips → these columns
    waypoints       per-waypoint row when trajectories_glob is set
    validation_runs per-metric row from each run's validation.csv
    ingest_log      one row per CSV ingested, row_count<0 on failure
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from glob import glob
from pathlib import Path
from typing import Optional

# Allow running as `python -m backend.ingest` from trajectory-viz/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import get_pflow_home, get_viz_db_path, get_output_root
from backend.db import get_connection, reset_db
from backend.sources_schema import (
    ColumnSpec,
    SourceConfig,
    SourcesFile,
    default_sources_path,
    load_sources,
)


# Map the YAML `type` field to DuckDB's CAST type names.
_DUCKDB_TYPE_MAP: dict[str, str] = {
    "int": "INTEGER",
    "bigint": "BIGINT",
    "double": "DOUBLE",
    "varchar": "VARCHAR",
    "bool": "BOOLEAN",
}

# Canonical column order for the `trips` INSERT. Implicit columns (handled
# directly by the ingester, not by source.columns.trips) are marked below.
# A source need not declare every column — anything not declared becomes NULL.
TRIP_COLUMNS: tuple[str, ...] = (
    "vehicle_id",      # implicit: CAST(columns.vehicle_id_col AS INTEGER)
    "trip_id",         # implicit: CAST(columns.trip_id_col AS BIGINT)
    "starttime",       # required (declared)
    "start_lon",       # required (declared)
    "start_lat",       # required (declared)
    "end_lon",         # required (declared)
    "end_lat",         # required (declared)
    "transport_mode",
    "purpose",
    "vehicle_type",    # implicit: source_id literal (back-compat alias)
    "distance_km",
    "dep_hour",
    "simulation_day",
    "goods_type",
    "vehicle_size",
    "cargo_loaded",
    "origin_zone",
    "dest_zone",
    "fare_yen",
    "is_night_trip",
    "passenger_in",
    "taxi_id",
    "city",            # implicit: scope_value or NULL
    "vehicle_key",     # implicit: built from vehicle_key_template
    "source_id",       # implicit: source_id literal
)

WAYPOINT_COLUMNS: tuple[str, ...] = (
    "vehicle_id",      # implicit
    "trip_id",         # implicit
    "unix_time_ms",    # required (declared)
    "lon",             # required (declared)
    "lat",             # required (declared)
    "link_id",
    "vehicle_type",    # implicit
    "transport_mode",
    "purpose",
    "goods_type",
    "vehicle_size",
    "passenger_in",
    "fare_yen",
    "is_night_trip",
    "vehicle_key",     # implicit
    "source_id",       # implicit
)


# --- Path discovery ----------------------------------------------------------


def find_latest_run(base_dir: Path) -> Optional[Path]:
    """Return the most-recent `run_*` subdirectory of `base_dir`, or None."""
    if not base_dir.is_dir():
        return None
    runs = sorted(
        (d for d in base_dir.iterdir() if d.is_dir() and d.name.startswith("run_")),
        key=lambda d: d.name,
        reverse=True,
    )
    return runs[0] if runs else None


def discover_csvs(
    glob_pattern: str,
    output_root: Path,
    latest_only: bool = True,
) -> list[Path]:
    """Resolve `glob_pattern` (relative to `output_root`) to CSV paths.

    If `latest_only` is True and the pattern contains `run_*`, the matches are
    grouped by their tree (the directory above the run_* segment) and only the
    latest run per group is returned. This mirrors the original `find_latest_run`
    behavior but works for any source's glob.
    """
    abs_pattern = str((output_root / glob_pattern).as_posix())
    matches = sorted(Path(p) for p in glob(abs_pattern, recursive=True))
    if not latest_only or "run_" not in glob_pattern:
        return matches

    # Group each match by the parent dir that contains its run_* segment.
    grouped: dict[Path, list[Path]] = {}
    for p in matches:
        parts = p.parts
        run_idx = next(
            (i for i, part in enumerate(parts) if part.startswith("run_")),
            None,
        )
        if run_idx is None:
            # Glob says run_* but this match doesn't have it — keep as own group
            grouped.setdefault(p.parent, []).append(p)
        else:
            # Group key = path up to (but not including) the run_* segment
            key = Path(*parts[:run_idx])
            grouped.setdefault(key, []).append(p)

    # Within each group, the lexicographic max of the run_YYYYMMDD_HHMMSS
    # segment is the latest.
    latest: list[Path] = []
    for paths in grouped.values():
        latest.append(max(paths, key=lambda p: str(p)))
    return sorted(latest)


# --- SQL builders ------------------------------------------------------------


def _sql_string_literal(value: str) -> str:
    """Quote a string for inline SQL. Doubles any embedded single quotes."""
    return "'" + value.replace("'", "''") + "'"


def _vehicle_key_sql(
    template: str,
    vehicle_id_col: str,
    scope_value: Optional[str],
) -> str:
    """Convert `vehicle_key_template` into a DuckDB || concat expression.

    Supported placeholders: `{vehicle_id}` (required), `{scope}` (required iff
    discovery.scope is set in sources.yaml — the schema validator enforces
    alignment).
    """
    out: list[str] = []
    i = 0
    while i < len(template):
        if template[i] == "{":
            end = template.index("}", i)
            placeholder = template[i + 1 : end]
            if placeholder == "vehicle_id":
                out.append(f'CAST("{vehicle_id_col}" AS VARCHAR)')
            elif placeholder == "scope":
                if scope_value is None:
                    # The schema validator should have caught this, but guard anyway.
                    raise ValueError(
                        f"vehicle_key_template {template!r} uses {{scope}} but "
                        f"no scope_value is configured."
                    )
                out.append(_sql_string_literal(scope_value))
            else:
                raise ValueError(
                    f"Unsupported placeholder {{{placeholder}}} in vehicle_key_template "
                    f"{template!r}. Supported: {{vehicle_id}}, {{scope}}."
                )
            i = end + 1
        else:
            j = template.find("{", i)
            if j == -1:
                j = len(template)
            out.append(_sql_string_literal(template[i:j]))
            i = j
    return " || ".join(out)


def _column_expr(db_col: str, spec: ColumnSpec) -> str:
    """Build one SELECT expression for a declared column spec."""
    if spec.derived is not None:
        return f"({spec.derived}) AS {db_col}"
    csv_col = spec.csv
    assert csv_col is not None  # schema validator guarantees one of {csv, derived}
    duck_type = _DUCKDB_TYPE_MAP[spec.type]  # type: ignore[index]
    if spec.transform is not None:
        # The `value` token is replaced with the CSV column reference; the
        # transform produces the final value, which is implicitly cast on
        # INSERT. We do NOT wrap in CAST to avoid double-casting boolean
        # coercions like `lower(value) = 'true'`.
        expr = spec.transform.replace("value", f'"{csv_col}"')
        return f"({expr}) AS {db_col}"
    return f'CAST("{csv_col}" AS {duck_type}) AS {db_col}'


def _select_clause(
    src: SourceConfig,
    scope_value: Optional[str],
    db_columns: tuple[str, ...],
    declared: dict[str, ColumnSpec],
) -> str:
    """Assemble the SELECT clause for one source's INSERT.

    Implicit columns (vehicle_id, trip_id, source_id, vehicle_type, vehicle_key,
    city) are constructed by this function. All other columns are pulled from
    `declared` or NULL-filled.
    """
    parts: list[str] = []
    # Trip CSVs carry the trip's primary key in src.columns.trip_id_col (often
    # named "id"). Waypoint CSVs carry the foreign-key reference to the trip
    # in a column literally called "trip_id". The two paths are asymmetric in
    # the v0.1 schema and we preserve that here.
    is_waypoints = db_columns is WAYPOINT_COLUMNS
    for col in db_columns:
        if col == "vehicle_id":
            parts.append(f'CAST("{src.columns.vehicle_id_col}" AS INTEGER) AS vehicle_id')
        elif col == "trip_id":
            trip_csv_col = "trip_id" if is_waypoints else src.columns.trip_id_col
            parts.append(f'CAST("{trip_csv_col}" AS BIGINT) AS trip_id')
        elif col == "source_id":
            parts.append(f"{_sql_string_literal(src.source_id)} AS source_id")
        elif col == "vehicle_type":
            # Back-compat alias for v0.1 queries. Same value as source_id.
            parts.append(f"{_sql_string_literal(src.source_id)} AS vehicle_type")
        elif col == "vehicle_key":
            expr = _vehicle_key_sql(
                src.vehicle_key_template, src.columns.vehicle_id_col, scope_value
            )
            parts.append(f"{expr} AS vehicle_key")
        elif col == "city":
            # Only present in trips table — handled below
            if scope_value is not None:
                parts.append(f"{_sql_string_literal(scope_value)} AS city")
            else:
                parts.append("NULL AS city")
        elif col in declared:
            parts.append(_column_expr(col, declared[col]))
        else:
            parts.append(f"NULL AS {col}")
    return ",\n            ".join(parts)


# --- Per-source ingest --------------------------------------------------------


def ingest_source_trips(
    conn,
    csv_path: Path,
    source_key: str,
    src: SourceConfig,
) -> int:
    """Ingest one source's trip CSV. Returns the number of rows inserted."""
    scope_value = src.discovery.scope.value if src.discovery.scope else None
    select_clause = _select_clause(src, scope_value, TRIP_COLUMNS, src.columns.trips)
    columns_list = ", ".join(TRIP_COLUMNS)

    sql = f"""
        INSERT INTO trips ({columns_list})
        SELECT
            {select_clause}
        FROM read_csv('{csv_path.as_posix()}', header=true, auto_detect=true)
    """

    before = conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
    conn.execute(sql)
    after = conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
    return after - before


def ingest_source_trajectories(
    conn,
    csv_path: Path,
    source_key: str,
    src: SourceConfig,
) -> int:
    """Ingest one source's trajectory CSV. Returns the number of rows inserted."""
    if src.columns.waypoints is None:
        return 0
    scope_value = src.discovery.scope.value if src.discovery.scope else None
    select_clause = _select_clause(src, scope_value, WAYPOINT_COLUMNS, src.columns.waypoints)
    columns_list = ", ".join(WAYPOINT_COLUMNS)

    sql = f"""
        INSERT INTO waypoints ({columns_list})
        SELECT
            {select_clause}
        FROM read_csv('{csv_path.as_posix()}', header=true, auto_detect=true)
    """

    before = conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0]
    conn.execute(sql)
    after = conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0]
    return after - before


def ingest_validation(
    conn,
    run_dir: Path,
    source_id: str,
    scope_value: Optional[str],
    validation_relative: str = "validation.csv",
) -> int:
    """Ingest a validation.csv from a `run_*` directory.

    Already generic — vehicle_type and city are parameters, not hardcoded.
    Idempotent: deletes existing rows for the constructed run_id before
    re-inserting.
    """
    csv = run_dir / validation_relative
    if not csv.is_file():
        return 0

    scope_part = f"/{scope_value}" if scope_value else ""
    run_id = f"{source_id}{scope_part}/{run_dir.name}"

    # Parse run_dir timestamp if it matches `run_YYYYMMDD_HHMMSS`.
    ts_str = run_dir.name.removeprefix("run_") if run_dir.name.startswith("run_") else ""
    if len(ts_str) == 15 and ts_str[8] == "_":
        run_timestamp_sql = f"strptime('{ts_str}', '%Y%m%d_%H%M%S')"
    else:
        run_timestamp_sql = "NULL"

    conn.execute("DELETE FROM validation_runs WHERE run_id = ?", [run_id])

    city_sql = _sql_string_literal(scope_value) if scope_value else "NULL"
    conn.execute(f"""
        INSERT INTO validation_runs (
            run_id, vehicle_type, city, run_timestamp,
            category, metric, actual, target, tolerance_pct, error_pct, status,
            ingested_at
        )
        SELECT
            {_sql_string_literal(run_id)} AS run_id,
            {_sql_string_literal(source_id)} AS vehicle_type,
            {city_sql} AS city,
            {run_timestamp_sql} AS run_timestamp,
            CAST(category AS VARCHAR),
            CAST(metric AS VARCHAR),
            CAST(actual AS DOUBLE),
            CAST(target AS DOUBLE),
            CAST(tolerance_pct AS DOUBLE),
            CAST(error_pct AS DOUBLE),
            CAST(status AS VARCHAR),
            current_timestamp AS ingested_at
        FROM read_csv('{csv.as_posix()}', header=true, auto_detect=true)
    """)
    row = conn.execute(
        "SELECT COUNT(*) FROM validation_runs WHERE run_id = ?", [run_id]
    ).fetchone()
    return row[0] if row else 0


# --- F1 derived metrics (Phase 2) -------------------------------------------


# Detour-ratio policy: ratio = distance_km / haversine(start, end).
# For very short trips (start ≈ end), GPS noise dominates and the ratio
# explodes (e.g. a 0.5 km trip with 0.05 km straight-line distance gives
# ratio=10.0, which doesn't reflect a real detour — just noise + circling).
# Below this haversine threshold in km, we return NULL rather than a noisy
# value. 0.1 km (100m) is roughly the GPS-noise scale; raise to be stricter
# or lower to keep more rows.
DETOUR_MIN_HAVERSINE_KM = 0.1


def compute_derived_metrics(conn) -> dict[str, int]:
    """Populate `trips.speed_avg_kmh`, `trips.dwell_minutes`, `trips.detour_ratio`.

    Runs after all CSVs are ingested. Idempotent — safe to re-run; existing
    values get overwritten with the new computation.

    Returns a dict of {metric_name: rows_populated} for logging.
    """
    counts: dict[str, int] = {}

    # ───── speed_avg_kmh ──────────────────────────────────────
    # Needs waypoint data: duration = (max - min unix_time_ms) / 1000 / 3600 hr.
    # NULL for trips without trajectories (no waypoints to derive duration).
    # DuckDB UPDATE...FROM is the analog of Postgres's UPDATE FROM clause.
    conn.execute("""
        CREATE OR REPLACE TEMPORARY TABLE _speed_calc AS
        SELECT
            vehicle_key,
            trip_id,
            (MAX(unix_time_ms) - MIN(unix_time_ms)) / 1000.0 / 3600.0 AS duration_hr
        FROM waypoints
        GROUP BY vehicle_key, trip_id
        HAVING duration_hr > 0
    """)
    conn.execute("""
        UPDATE trips
        SET speed_avg_kmh = trips.distance_km / _speed_calc.duration_hr
        FROM _speed_calc
        WHERE trips.vehicle_key = _speed_calc.vehicle_key
          AND trips.trip_id = _speed_calc.trip_id
          AND trips.distance_km IS NOT NULL
          AND trips.distance_km > 0
    """)
    conn.execute("DROP TABLE _speed_calc")
    counts["speed_avg_kmh"] = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE speed_avg_kmh IS NOT NULL"
    ).fetchone()[0]

    # ───── dwell_minutes ──────────────────────────────────────
    # LEAD(starttime) over (PARTITION BY vehicle_key ORDER BY starttime) gives
    # the next trip's start time; subtract current, convert to minutes.
    # Last trip of each vehicle has no successor → NULL.
    # `starttime` is seconds-from-midnight in v0.1 schema, so subtraction stays
    # within a single day. Caveat: if a vehicle's last sim_day-0 trip is at 23h
    # and its sim_day-1 first trip is at 02h, we'd compute negative dwell. The
    # PARTITION includes simulation_day for safety.
    conn.execute("""
        CREATE OR REPLACE TEMPORARY TABLE _dwell_calc AS
        SELECT
            vehicle_key,
            trip_id,
            simulation_day,
            (LEAD(starttime) OVER (
                PARTITION BY vehicle_key, simulation_day
                ORDER BY starttime
            ) - starttime) / 60.0 AS dwell_min
        FROM trips
    """)
    conn.execute("""
        UPDATE trips
        SET dwell_minutes = _dwell_calc.dwell_min
        FROM _dwell_calc
        WHERE trips.vehicle_key = _dwell_calc.vehicle_key
          AND trips.trip_id = _dwell_calc.trip_id
          AND COALESCE(trips.simulation_day, 0) = COALESCE(_dwell_calc.simulation_day, 0)
    """)
    conn.execute("DROP TABLE _dwell_calc")
    counts["dwell_minutes"] = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE dwell_minutes IS NOT NULL"
    ).fetchone()[0]

    # ───── detour_ratio ───────────────────────────────────────
    # Equirectangular approximation of OD distance (matches the formula used
    # in analysis/trip_chains.py for round-trip detection — keep consistent).
    # Detour ratio > 1.0 means the route was longer than the straight line.
    # NULLs are emitted when haversine < DETOUR_MIN_HAVERSINE_KM (see docstring).
    conn.execute(f"""
        UPDATE trips
        SET detour_ratio = CASE
            WHEN distance_km IS NULL OR distance_km <= 0 THEN NULL
            WHEN (
                111.32 * SQRT(
                    POWER(end_lon - start_lon, 2) * POWER(COS(RADIANS(start_lat)), 2) +
                    POWER(end_lat - start_lat, 2)
                )
            ) < {DETOUR_MIN_HAVERSINE_KM} THEN NULL
            ELSE distance_km / (
                111.32 * SQRT(
                    POWER(end_lon - start_lon, 2) * POWER(COS(RADIANS(start_lat)), 2) +
                    POWER(end_lat - start_lat, 2)
                )
            )
        END
    """)
    counts["detour_ratio"] = conn.execute(
        "SELECT COUNT(*) FROM trips WHERE detour_ratio IS NOT NULL"
    ).fetchone()[0]

    return counts


# --- Main orchestration ------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest ABM trip and trajectory CSVs into DuckDB"
    )
    parser.add_argument(
        "--pflow-home", type=str, default=None,
        help="Override PFLOW project root (monorepo mode).",
    )
    parser.add_argument(
        "--db-path", type=str, default=None,
        help="Override DuckDB output path (sets PFLOW_VIZ_DB).",
    )
    parser.add_argument(
        "--output-root", type=str, default=None,
        help="Override scan root for trips/trajectory subtrees (sets PFLOW_VIZ_OUTPUT_ROOT).",
    )
    parser.add_argument(
        "--sources", type=str, default=None,
        help="Path to sources.yaml (default: <project root>/sources.yaml or $PFLOW_VIZ_SOURCES).",
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="Drop and recreate all tables before ingesting.",
    )
    args = parser.parse_args()

    # Apply CLI overrides to env before config functions are called.
    if args.pflow_home:
        os.environ["PFLOW_HOME"] = args.pflow_home
    if args.db_path:
        os.environ["PFLOW_VIZ_DB"] = args.db_path
    if args.output_root:
        os.environ["PFLOW_VIZ_OUTPUT_ROOT"] = args.output_root

    sources_path = Path(args.sources) if args.sources else default_sources_path()
    sources = load_sources(sources_path)

    db_path = get_viz_db_path()
    output_dir = get_output_root()

    print("=" * 64)
    print("  trajectory-viz — Data Ingestion")
    print("=" * 64)
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
    print(f"  Sources:     {sources_path} ({len(sources.sources)} entries)")

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
    errors: list[tuple[str, str, str]] = []
    start = time.time()

    def _log_failure(file_path: Path, table: str, exc: BaseException) -> None:
        msg = f"{type(exc).__name__}: {exc}"
        errors.append((str(file_path), table, msg))
        try:
            conn.execute(
                "INSERT INTO ingest_log (file_path, table_name, row_count) VALUES (?, ?, ?)",
                [str(file_path), table, -1],
            )
        except Exception:
            pass  # never let log-write failures mask the original error

    # ------- Per-source ingest -------
    for source_key, src in sources.sources.items():
        scope = src.discovery.scope.value if src.discovery.scope else None
        label = f"{source_key} (source_id={src.source_id}" + (
            f", scope={scope})" if scope else ")"
        )
        print(f"\n[SOURCE] {label}")

        # Trips + co-located validation
        trip_csvs = discover_csvs(
            src.discovery.trips_glob, output_dir,
            latest_only=src.discovery.latest_only,
        )
        if not trip_csvs:
            print(f"  [TRIPS] no matches for glob: {src.discovery.trips_glob}")
        for csv_path in trip_csvs:
            print(f"  [trips] {csv_path}", end=" ... ", flush=True)
            t = time.time()
            try:
                n = ingest_source_trips(conn, csv_path, source_key, src)
                total_trips += n
                print(f"{n:,} rows ({time.time()-t:.1f}s)")
                conn.execute(
                    "INSERT INTO ingest_log (file_path, table_name, row_count) VALUES (?, 'trips', ?)",
                    [str(csv_path), n],
                )
            except Exception as e:
                print(f"ERROR: {type(e).__name__}: {e}")
                _log_failure(csv_path, "trips", e)
                continue

            # Validation co-located with trips CSV (one validation file per run dir)
            if src.discovery.validation_relative:
                try:
                    vn = ingest_validation(
                        conn, csv_path.parent, src.source_id, scope,
                        validation_relative=src.discovery.validation_relative,
                    )
                    if vn > 0:
                        total_validation += vn
                        print(f"    [val] {vn} metrics")
                except Exception as e:
                    print(f"    [val] ERROR: {type(e).__name__}: {e}")
                    _log_failure(csv_path.parent / src.discovery.validation_relative,
                                 "validation_runs", e)

        # Trajectories
        if src.discovery.trajectories_glob:
            traj_csvs = discover_csvs(
                src.discovery.trajectories_glob, output_dir,
                latest_only=src.discovery.latest_only,
            )
            if not traj_csvs:
                print(f"  [TRAJ] no matches for glob: {src.discovery.trajectories_glob}")
            for csv_path in traj_csvs:
                print(f"  [traj]  {csv_path}", end=" ... ", flush=True)
                t = time.time()
                try:
                    n = ingest_source_trajectories(conn, csv_path, source_key, src)
                    total_waypoints += n
                    print(f"{n:,} rows ({time.time()-t:.1f}s)")
                    conn.execute(
                        "INSERT INTO ingest_log (file_path, table_name, row_count) VALUES (?, 'waypoints', ?)",
                        [str(csv_path), n],
                    )
                except Exception as e:
                    print(f"ERROR: {type(e).__name__}: {e}")
                    _log_failure(csv_path, "waypoints", e)

    # ------- F1 derived metrics (post-ingest pass) -------
    derived_counts: dict[str, int] = {}
    if total_trips > 0:
        print(f"\n[DERIVED] Computing F1 metrics (speed_avg_kmh, dwell_minutes, detour_ratio)...")
        t = time.time()
        try:
            derived_counts = compute_derived_metrics(conn)
            print(f"[DERIVED]   speed_avg_kmh: {derived_counts['speed_avg_kmh']:,} rows populated")
            print(f"[DERIVED]   dwell_minutes: {derived_counts['dwell_minutes']:,} rows populated")
            print(f"[DERIVED]   detour_ratio:  {derived_counts['detour_ratio']:,} rows populated")
            print(f"[DERIVED] Done in {time.time()-t:.1f}s")
        except Exception as e:
            print(f"[DERIVED] ERROR: {type(e).__name__}: {e}")
            errors.append(("(compute_derived_metrics)", "trips", f"{type(e).__name__}: {e}"))

    elapsed = time.time() - start
    print(f"\n{'=' * 64}")
    print(f"  Ingestion complete in {elapsed:.1f}s")
    print(f"  Trips:       {total_trips:>12,}")
    print(f"  Waypoints:   {total_waypoints:>12,}")
    print(f"  Validation:  {total_validation:>12,}")
    print(f"  Database:    {db_path}")
    if db_path.is_file():
        print(f"  Size:        {db_path.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"{'=' * 64}")

    if errors:
        # Files that errored are also recorded in ingest_log with row_count=-1
        # so a later `SELECT file_path FROM ingest_log WHERE row_count < 0`
        # will find them without re-running ingest.
        print(f"\n[FAILED] {len(errors)} file(s) did not ingest:")
        for file_path, table, msg in errors:
            print(f"  [{table}] {file_path}")
            print(f"    {msg}")
        print(
            "\nFix the underlying issue then re-run with --reset (or delete "
            "the failed rows from ingest_log and re-run without --reset)."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
