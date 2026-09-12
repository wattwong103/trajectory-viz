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

from .db import build_trip_filter, get_epoch_anchor

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
    vehicle_type: str | None,
    city: str | None,
    simulation_day: int | None,
) -> str | None:
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
    vehicle_type: str | None,
    city: str | None,
    simulation_day: int | None,
    transport_modes: list[int] | None = None,
    scenario_clause: str | None = None,
) -> str | None:
    """(vehicle_key, trip_id) subquery for TRIP-granular waypoint scoping.

    REQUIRED whenever transport_modes or a scenario is set: the per-vehicle
    build_trip_vehicle_keys_subquery over-selects — a vehicle with one
    matching trip would drag in ALL its trips. (vehicle_key, trip_id) is
    globally unique (bare vehicle_id collides across cities and source_ids)
    and both sides are indexed (idx_trips_vehicle_key, idx_waypoints_vehicle_key).

    `scenario_clause` is a prebuilt trips-side condition from
    filters.ScenarioFields.scenario_clause() (pedestrianize exclusion).

    Returns None when no filter dimension is set.
    """
    if (not vehicle_type and not city and simulation_day is None
            and not transport_modes and not scenario_clause):
        return None
    trip_where = build_trip_filter(
        vehicle_type, city, simulation_day,
        transport_modes=transport_modes,
        extra=[scenario_clause] if scenario_clause else None,
    )
    return f"(SELECT vehicle_key, trip_id FROM trips {trip_where})"


def sample_waypoint_rows(
    conn,
    n: int,
    vehicle_type: str | None = None,
    city: str | None = None,
    simulation_day: int | None = None,
    transport_modes: list[int] | None = None,
    scenario_clause: str | None = None,
) -> list:
    """Sample n random trajectories and return all their waypoint rows
    (WAYPOINT_COLS_WITH_TRIP_MODE shape — trip transport_mode at index 14),
    ordered for grouping.

    Two-step: sample distinct trip pairs first, then fetch every waypoint of
    the sampled trips — avoids returning fragmented partial trajectories.
    Caller inputs must already be pattern-validated (Pydantic) — values are
    inlined, matching build_trip_filter's contract.

    With transport_modes or a scenario set, sampling switches from the
    per-vehicle vehicle_key subquery to the trip-granular
    (vehicle_key, trip_id) subquery (see build_trip_pair_subquery) — both are
    per-TRIP conditions. The vehicle_key path is kept for the common
    unfiltered case — identical behavior to before.
    """
    vtype_filter = f"AND vehicle_type = '{vehicle_type}'" if vehicle_type else ""
    if transport_modes or scenario_clause:
        pair_subq = build_trip_pair_subquery(
            vehicle_type, city, simulation_day, transport_modes, scenario_clause
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
    simulation_day: int | None = None,
    include_stationary: bool = False,
) -> list:
    """All waypoint rows for the given vehicle_keys (full-day chains).

    vehicle_key values may be user-typed — parameterized, never inlined.

    With include_stationary=True, trips of the requested vehicles that have
    NO waypoints (e.g. zero-distance same-mesh hops — 91% of the GUFM fleet)
    are synthesized as stationary 2-point trajectories at the trip's OD
    start. Without this, following such an agent renders nothing at all.
    Off by default: sampling and export paths keep the waypoints-only
    contract their tests pin.
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

    rows = conn.execute(f"""
        SELECT {WAYPOINT_COLS_WITH_TRIP_MODE}
        FROM waypoints w {TRIPS_JOIN}
        WHERE w.vehicle_key IN ({placeholders}) {day_filter}
        ORDER BY w.vehicle_key, w.trip_id, w.unix_time_ms
    """, params).fetchall()
    if include_stationary:
        rows = rows + _stationary_rows_for_vehicles(
            conn, vehicle_keys, simulation_day
        )
    return rows


# A stationary trip renders as a 60-second dot at the OD start. 60 s is
# arbitrary but load-bearing in one case: it must not cross the mod-86400
# midnight seam (positionAtTime treats tN < t0 as "not visible"), so trips
# departing in the last minute of the day collapse to a single instant.
_STATIONARY_SPAN_S = 60


def _stationary_rows_for_vehicles(
    conn,
    vehicle_keys: list[str],
    simulation_day: int | None = None,
) -> list:
    """Pseudo-waypoint rows for waypoint-less trips (see include_stationary).

    Row shape matches WAYPOINT_COLS_WITH_TRIP_MODE exactly (link_id NULL,
    trip mode from the trips row). unix_time_ms is absolute epoch ms on the
    DB's anchor so _rows_to_trajectories' mod-86400 math applies unchanged.
    """
    placeholders = ", ".join("?" for _ in vehicle_keys)
    params: list = list(vehicle_keys)
    day_filter = ""
    if simulation_day is not None:
        day_filter = "AND t.simulation_day = ?"
        params.append(int(simulation_day))
    trips = conn.execute(f"""
        SELECT t.vehicle_id, t.trip_id, t.starttime,
               t.start_lon, t.start_lat, t.vehicle_type, t.transport_mode,
               t.purpose, t.goods_type, t.vehicle_size,
               CAST(t.passenger_in AS VARCHAR),
               t.fare_yen, t.vehicle_key
        FROM trips t
        WHERE t.vehicle_key IN ({placeholders}) {day_filter}
          AND NOT EXISTS (
              SELECT 1 FROM waypoints w
              WHERE w.vehicle_key = t.vehicle_key AND w.trip_id = t.trip_id
          )
    """, params).fetchall()

    anchor_sec = get_epoch_anchor(conn)
    rows: list = []
    for (vid, tid, starttime, lon, lat, vtype, mode, purpose, goods,
         vsize, pax_in, fare, vkey) in trips:
        t0 = int(starttime)
        # Collapse the span when it would cross midnight (see _STATIONARY_SPAN_S).
        span = 0 if (t0 % 86400) + _STATIONARY_SPAN_S >= 86400 else _STATIONARY_SPAN_S
        t0_ms = (anchor_sec + t0) * 1000
        t1_ms = t0_ms + span * 1000
        base = [vid, tid, None, lon, lat, vtype, mode, purpose, goods,
                vsize, pax_in, fare, vkey, None, mode]
        rows.append([*base[:2], t0_ms, *base[3:]])
        rows.append([*base[:2], t1_ms, *base[3:]])
    return rows
