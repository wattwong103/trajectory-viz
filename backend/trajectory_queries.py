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


def sample_waypoint_rows(
    conn,
    n: int,
    vehicle_type: Optional[str] = None,
    city: Optional[str] = None,
    simulation_day: Optional[int] = None,
) -> list:
    """Sample n random (vehicle_id, trip_id) trajectories and return all their
    waypoint rows, ordered for grouping.

    Two-step: sample distinct trip pairs first, then fetch every waypoint of
    the sampled trips — avoids returning fragmented partial trajectories.
    Caller inputs must already be pattern-validated (Pydantic) — values are
    inlined, matching build_trip_filter's contract.
    """
    vtype_filter = f"AND vehicle_type = '{vehicle_type}'" if vehicle_type else ""
    key_subq = build_trip_vehicle_keys_subquery(vehicle_type, city, simulation_day)
    city_filter = f"AND vehicle_key IN {key_subq}" if key_subq else ""

    sampled = conn.execute(f"""
        SELECT vehicle_id, trip_id
        FROM (
            SELECT DISTINCT vehicle_id, trip_id
            FROM waypoints
            WHERE 1=1 {vtype_filter} {city_filter}
        )
        USING SAMPLE {int(n)}
    """).fetchall()
    if not sampled:
        return []

    pairs = ", ".join(f"({s[0]}, {s[1]})" for s in sampled)
    return conn.execute(f"""
        SELECT {WAYPOINT_COLS}
        FROM waypoints
        WHERE (vehicle_id, trip_id) IN ({pairs})
        ORDER BY vehicle_id, trip_id, unix_time_ms
    """).fetchall()


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
          AND vehicle_key IN (
              SELECT DISTINCT vehicle_key FROM trips WHERE simulation_day = ?
          )"""
        params.append(int(simulation_day))

    return conn.execute(f"""
        SELECT {WAYPOINT_COLS}
        FROM waypoints
        WHERE vehicle_key IN ({placeholders}) {day_filter}
        ORDER BY vehicle_key, trip_id, unix_time_ms
    """, params).fetchall()
