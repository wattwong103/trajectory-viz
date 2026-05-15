"""
DuckDB connection manager and schema initialization.

Provides a singleton connection to the pflow.duckdb analytical database.
Schema mirrors the exact CSV column formats from TruckTrajectoryWriter.java
and TaxiTrajectoryWriter.java.
"""

import duckdb
from pathlib import Path
from .config import get_viz_db_path


_connection: duckdb.DuckDBPyConnection | None = None


def get_connection() -> duckdb.DuckDBPyConnection:
    """Get or create the DuckDB connection (singleton)."""
    global _connection
    if _connection is None:
        db_path = get_viz_db_path()
        _connection = duckdb.connect(str(db_path))
        _init_schema(_connection)
    return _connection


def _init_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Create tables if they don't exist yet."""

    conn.execute("""
        CREATE TABLE IF NOT EXISTS trips (
            vehicle_id    INTEGER NOT NULL,
            trip_id       BIGINT  NOT NULL,
            starttime     INTEGER NOT NULL,
            start_lon     DOUBLE  NOT NULL,
            start_lat     DOUBLE  NOT NULL,
            end_lon       DOUBLE  NOT NULL,
            end_lat       DOUBLE  NOT NULL,
            transport_mode INTEGER NOT NULL,
            purpose       INTEGER NOT NULL,
            vehicle_type  VARCHAR NOT NULL,
            distance_km   DOUBLE,
            dep_hour      INTEGER,
            simulation_day INTEGER DEFAULT 0,
            goods_type    VARCHAR,
            vehicle_size  VARCHAR,
            cargo_loaded  BOOLEAN,
            origin_zone   VARCHAR,
            dest_zone     VARCHAR,
            fare_yen      DOUBLE,
            is_night_trip BOOLEAN,
            passenger_in  BOOLEAN,
            taxi_id       INTEGER,
            city          VARCHAR,
            vehicle_key   VARCHAR NOT NULL
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS waypoints (
            vehicle_id     INTEGER NOT NULL,
            trip_id        BIGINT  NOT NULL,
            unix_time_ms   BIGINT  NOT NULL,
            lon            DOUBLE  NOT NULL,
            lat            DOUBLE  NOT NULL,
            link_id        VARCHAR,
            vehicle_type   VARCHAR NOT NULL,
            transport_mode INTEGER,
            purpose        INTEGER,
            goods_type     VARCHAR,
            vehicle_size   VARCHAR,
            passenger_in   VARCHAR,
            fare_yen       DOUBLE,
            is_night_trip  VARCHAR,
            vehicle_key    VARCHAR NOT NULL
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS validation_runs (
            run_id         VARCHAR NOT NULL,
            vehicle_type   VARCHAR NOT NULL,
            city           VARCHAR,
            run_timestamp  TIMESTAMP,
            category       VARCHAR NOT NULL,
            metric         VARCHAR NOT NULL,
            actual         DOUBLE,
            target         DOUBLE,
            tolerance_pct  DOUBLE,
            error_pct      DOUBLE,
            status         VARCHAR NOT NULL,
            ingested_at    TIMESTAMP DEFAULT current_timestamp
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS ingest_log (
            file_path   VARCHAR NOT NULL,
            table_name  VARCHAR NOT NULL,
            row_count   BIGINT  NOT NULL,
            ingested_at TIMESTAMP DEFAULT current_timestamp
        )
    """)

    # Indexes — without these, filter scans on 4.43M trips / 233M waypoints
    # become full table scans and blow past the p99 budgets (200ms/1s/500ms).
    # DuckDB uses ART for VARCHAR and min-max zone-maps for numeric cols.
    _index_statements = [
        # trips
        "CREATE INDEX IF NOT EXISTS idx_trips_vehicle_type ON trips(vehicle_type)",
        "CREATE INDEX IF NOT EXISTS idx_trips_vehicle_key  ON trips(vehicle_key)",
        "CREATE INDEX IF NOT EXISTS idx_trips_city_day     ON trips(city, simulation_day)",
        "CREATE INDEX IF NOT EXISTS idx_trips_dep_hour     ON trips(dep_hour)",
        "CREATE INDEX IF NOT EXISTS idx_trips_distance     ON trips(distance_km)",
        # waypoints
        "CREATE INDEX IF NOT EXISTS idx_waypoints_vehicle_key ON waypoints(vehicle_key)",
        "CREATE INDEX IF NOT EXISTS idx_waypoints_trip        ON waypoints(vehicle_id, trip_id)",
        "CREATE INDEX IF NOT EXISTS idx_waypoints_link_id     ON waypoints(link_id)",
        "CREATE INDEX IF NOT EXISTS idx_waypoints_lonlat      ON waypoints(lon, lat)",
        # validation
        "CREATE INDEX IF NOT EXISTS idx_validation_run_id ON validation_runs(run_id)",
    ]
    for stmt in _index_statements:
        conn.execute(stmt)


def reset_db() -> None:
    """Drop all tables and re-create schema. Used for re-ingestion."""
    conn = get_connection()
    conn.execute("DROP TABLE IF EXISTS waypoints")
    conn.execute("DROP TABLE IF EXISTS trips")
    conn.execute("DROP TABLE IF EXISTS validation_runs")
    conn.execute("DROP TABLE IF EXISTS ingest_log")
    _init_schema(conn)


def get_table_stats() -> dict:
    """Return row counts and basic stats for all tables."""
    conn = get_connection()
    stats = {}
    for table in ["trips", "waypoints"]:
        try:
            row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            stats[table] = {"row_count": row[0] if row else 0}
        except Exception:
            stats[table] = {"row_count": 0}

    # Add breakdowns
    if stats["trips"]["row_count"] > 0:
        rows = conn.execute("""
            SELECT vehicle_type, COUNT(*) as cnt,
                   MIN(start_lon) as min_lon, MAX(start_lon) as max_lon,
                   MIN(start_lat) as min_lat, MAX(start_lat) as max_lat,
                   MIN(starttime) as min_time, MAX(starttime) as max_time
            FROM trips GROUP BY vehicle_type
        """).fetchall()
        stats["trips"]["by_vehicle_type"] = {
            r[0]: {
                "count": r[1],
                "bbox": {"min_lon": r[2], "max_lon": r[3], "min_lat": r[4], "max_lat": r[5]},
                "time_range": {"min_sec": r[6], "max_sec": r[7]},
            }
            for r in rows
        }

    if stats["waypoints"]["row_count"] > 0:
        rows = conn.execute("""
            SELECT vehicle_type, COUNT(*) as cnt
            FROM waypoints GROUP BY vehicle_type
        """).fetchall()
        stats["waypoints"]["by_vehicle_type"] = {r[0]: r[1] for r in rows}

    return stats


from typing import Optional


def build_trip_filter(
    vehicle_type: Optional[str] = None,
    city: Optional[str] = None,
    simulation_day: Optional[int] = None,
    extra: Optional[list[str]] = None,
) -> str:
    """Build a SQL WHERE clause from common trip filters.

    Returns either an empty string or 'WHERE cond1 AND cond2 AND ...'.
    Values are used in raw SQL — callers MUST constrain inputs via Pydantic
    (e.g. vehicle_type pattern='^(truck|taxi)$', city pattern='^[a-z_]+$').

    Example:
        where = build_trip_filter(vehicle_type='taxi', city='tokyo')
        conn.execute(f'SELECT COUNT(*) FROM trips {where}')
    """
    conds: list[str] = []
    if vehicle_type:
        conds.append(f"vehicle_type = '{vehicle_type}'")
    if city:
        conds.append(f"city = '{city}'")
    if simulation_day is not None:
        conds.append(f"simulation_day = {int(simulation_day)}")
    if extra:
        conds.extend(extra)
    return ("WHERE " + " AND ".join(conds)) if conds else ""
