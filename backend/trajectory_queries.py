"""
Shared trajectory SQL builders (Phase 2D refactor).

One implementation of the two-step waypoint sampling used by BOTH the
/api/trajectories endpoints (routers/trajectories.py) and the single-HTML
exporter (backend/export.py). Keeping these together means the export always
ships exactly what the interactive app would render.

Row shape (WAYPOINT_COLS order):
    (vehicle_id, trip_id, unix_time_ms, lon, lat, vehicle_type,
     transport_mode, purpose, goods_type, vehicle_size,
     passenger_in, fare_yen, vehicle_key, link_id)
"""

from __future__ import annotations

from typing import Optional

from .db import build_trip_filter

# Column list used in all waypoint queries.
# link_id (last) added in Phase 2 Step 2.5 for per-segment annotation.
WAYPOINT_COLS = """
    vehicle_id, trip_id, unix_time_ms, lon, lat,
    vehicle_type, transport_mode, purpose,
    goods_type, vehicle_size, passenger_in, fare_yen, vehicle_key, link_id
"""

# w.-qualified variant for queries that join trips, plus the trip's own
# transport_mode appended as index 14. The TRIP's mode is the authoritative
# one: waypoints.transport_mode (index 6) is uniform per source in router
# output (e.g. the taxi trajectory writer stamps 8 on every waypoint, even
# for walk trips), so it must never be used for filtering or display.
WAYPOINT_COLS_WITH_TRIP_MODE = """
    w.vehicle_id, w.trip_id, w.unix_time_ms, w.lon, w.lat,
    w.vehicle_type, w.transport_mode, w.purpose,
    w.goods_type, w.vehicle_size, w.passenger_in, w.fare_yen, w.vehicle_key, w.link_id,
    t.transport_mode
"""

# (vehicle_key, trip_id) is the globally-unique trip identity — vehicle_id
# collides both across taxi cities AND across source_ids (verified empirically
# on the kichijoji DB), so the join must never be on bare (vehicle_id, trip_id).
TRIPS_JOIN = (
    "LEFT JOIN trips t ON w.vehicle_key = t.vehicle_key AND w.trip_id = t.trip_id"
)


def build_trip_vehicle_keys_subquery(
    vehicle_type: Optional[str],
    city: Optional[str],
    simulation_day: Optional[int],
) -> Optional[str]:
    """Return a SQL subquery string for vehicle_keys from trips, or None if no filter needed.

    city and simulation_day live on the trips table only (not waypoints).
    Returns something like:
        (SELECT DISTINCT vehicle_key FROM trips WHERE city = 'tokyo' AND ...)
    or None if neither city nor simulation_day is set.

    Uses vehicle_key (not vehicle_id) because vehicle_id collides across taxi
    cities — Tokyo taxi_id=0 and Osaka taxi_id=0 map to distinct real fleets,
    whereas vehicle_key 'taxi:tokyo:0' vs 'taxi:osaka:0' are globally unique.
    """
    if not city and simulation_day is None:
        return None
    trip_where = build_trip_filter(vehicle_type, city, simulation_day)
    return f"(SELECT DISTINCT vehicle_key FROM trips {trip_where})"


def build_trip_pair_subquery(
    vehicle_type: Optional[str],
    city: Optional[str],
    simulation_day: Optional[int],
    transport_modes: Optional[list[int]] = None,
) -> Optional[str]:
    """(vehicle_key, trip_id) subquery for TRIP-granular waypoint scoping.

    REQUIRED whenever transport_modes is set: the per-vehicle
    build_trip_vehicle_keys_subquery over-selects — a vehicle with one
    matching trip would drag in ALL its trips. (vehicle_key, trip_id) is
    globally unique (bare vehicle_id collides across cities and source_ids)
    and both sides are indexed (idx_trips_vehicle_key, idx_waypoints_vehicle_key).

    Returns None when no filter dimension is set.
    """
    if not vehicle_type and not city and simulation_day is None and not transport_modes:
        return None
    trip_where = build_trip_filter(
        vehicle_type, city, simulation_day, transport_modes=transport_modes
    )
    return f"(SELECT vehicle_key, trip_id FROM trips {trip_where})"


def sample_waypoint_rows(
    conn,
    n: int,
    vehicle_type: Optional[str] = None,
    city: Optional[str] = None,
    simulation_day: Optional[int] = None,
    transport_modes: Optional[list[int]] = None,
) -> list:
    """Sample n random trajectories and return all their waypoint rows
    (WAYPOINT_COLS_WITH_TRIP_MODE shape — trip transport_mode at index 14),
    ordered for grouping.

    Two-step: sample distinct trip pairs first, then fetch every waypoint of
    the sampled trips — avoids returning fragmented partial trajectories.
    Caller inputs must already be pattern-validated (Pydantic) — values are
    inlined, matching build_trip_filter's contract.

    With transport_modes set, sampling switches from the per-vehicle
    vehicle_key subquery to the trip-granular (vehicle_key, trip_id) subquery
    (see build_trip_pair_subquery). The vehicle_key path is kept for the
    common no-mode case — identical behavior to before.
    """
    vtype_filter = f"AND vehicle_type = '{vehicle_type}'" if vehicle_type else ""
    if transport_modes:
        pair_subq = build_trip_pair_subquery(
            vehicle_type, city, simulation_day, transport_modes
        )
        scope_filter = f"AND (vehicle_key, trip_id) IN {pair_subq}"
    else:
        key_subq = build_trip_vehicle_keys_subquery(vehicle_type, city, simulation_day)
        scope_filter = f"AND vehicle_key IN {key_subq}" if key_subq else ""

    sampled = conn.execute(f"""
        SELECT vehicle_key, trip_id
        FROM (
            SELECT DISTINCT vehicle_key, trip_id
            FROM waypoints
            WHERE 1=1 {vtype_filter} {scope_filter}
        )
        USING SAMPLE {int(n)}
    """).fetchall()
    if not sampled:
        return []

    pairs = ", ".join(f"({_sql_str(s[0])}, {int(s[1])})" for s in sampled)
    return conn.execute(f"""
        SELECT {WAYPOINT_COLS_WITH_TRIP_MODE}
        FROM waypoints w {TRIPS_JOIN}
        WHERE (w.vehicle_key, w.trip_id) IN ({pairs})
        ORDER BY w.vehicle_id, w.trip_id, w.unix_time_ms
    """).fetchall()


def _sql_str(value: str) -> str:
    """Single-quote a VARCHAR for inline SQL, doubling embedded apostrophes."""
    return "'" + str(value).replace("'", "''") + "'"


def waypoint_rows_for_vehicles(
    conn,
    vehicle_keys: list[str],
    simulation_day: Optional[int] = None,
) -> list:
    """All waypoint rows for the given vehicle_keys (full-day chains).

    vehicle_key values may be user-typed — parameterized, never inlined.
    """
    if not vehicle_keys:
        return []
    placeholders = ", ".join("?" for _ in vehicle_keys)
    params: list = list(vehicle_keys)
    day_filter = ""
    if simulation_day is not None:
        day_filter = """
          AND w.vehicle_key IN (
              SELECT DISTINCT vehicle_key FROM trips WHERE simulation_day = ?
          )"""
        params.append(int(simulation_day))

    return conn.execute(f"""
        SELECT {WAYPOINT_COLS_WITH_TRIP_MODE}
        FROM waypoints w {TRIPS_JOIN}
        WHERE w.vehicle_key IN ({placeholders}) {day_filter}
        ORDER BY w.vehicle_key, w.trip_id, w.unix_time_ms
    """, params).fetchall()
