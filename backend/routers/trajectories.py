"""
Trajectory query endpoints — sampling and spatial queries for animated visualization.

Response format is designed for direct consumption by DeckGL TripsLayer:
    path: [[lon, lat], ...]
    timestamps: [seconds_from_midnight, ...]

The unix_time_ms from the trajectory CSV is converted back to seconds-from-midnight
for the 24h animation loop (matching traj-mining's 86400-second cycle).
"""

from fastapi import APIRouter, Query
from typing import Optional

from ..db import get_connection, build_trip_filter
from ..models import (
    BBoxQuery, PointQuery,
    Trajectory, TrajectoryMetadata, TrajectoryResponse,
)

router = APIRouter()

# Base date anchor used in VehicleTrajectoryGenerator.java: 2020-10-01 00:00:00 JST
# = 1601478000 seconds since epoch (UTC+9)
BASE_EPOCH_SEC = 1601478000


def _rows_to_trajectories(rows: list, vehicle_type_hint: str | None = None) -> list[Trajectory]:
    """Group waypoint rows by (vehicle_id, trip_id) into Trajectory objects.

    Each row: (vehicle_id, trip_id, unix_time_ms, lon, lat, vehicle_type,
               transport_mode, purpose, goods_type, vehicle_size,
               passenger_in, fare_yen, vehicle_key)
    """
    # Group by (vehicle_id, trip_id)
    trips: dict[tuple, list] = {}
    for r in rows:
        key = (r[0], r[1])
        if key not in trips:
            trips[key] = []
        trips[key].append(r)

    result = []
    for (vid, tid), waypoints in trips.items():
        # Sort by timestamp
        waypoints.sort(key=lambda w: w[2])

        path = [[w[3], w[4]] for w in waypoints]
        # Convert unix_time_ms → seconds from midnight for 24h animation loop
        timestamps = [int((w[2] // 1000 - BASE_EPOCH_SEC) % 86400) for w in waypoints]

        vtype = waypoints[0][5] or vehicle_type_hint or "unknown"
        meta = TrajectoryMetadata(
            vehicle_type=vtype,
            vehicle_id=vid,
            vehicle_key=waypoints[0][12] or f"{vtype}:{vid}",
            trip_id=tid,
            goods_type=waypoints[0][8],
            vehicle_size=waypoints[0][9],
            passenger_in=waypoints[0][10],
            fare_yen=waypoints[0][11],
            purpose=waypoints[0][7],
        )
        result.append(Trajectory(
            id=f"{vtype}_{vid}_{tid}",
            path=path,
            timestamps=timestamps,
            metadata=meta,
        ))

    return result


# Column list used in all waypoint queries
_WAYPOINT_COLS = """
    vehicle_id, trip_id, unix_time_ms, lon, lat,
    vehicle_type, transport_mode, purpose,
    goods_type, vehicle_size, passenger_in, fare_yen, vehicle_key
"""


def _build_trip_vehicle_keys_subquery(
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


@router.get("/trajectories/sample")
async def sample_trajectories(
    n: int = Query(100, ge=1, le=5000),
    vehicle_type: Optional[str] = Query(None, pattern="^(truck|taxi)$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
):
    """Return n random trajectories (sampled by vehicle_id+trip_id).

    Uses a subquery to sample trip IDs first, then fetches all waypoints
    for those trips. This avoids returning fragmented partial trajectories.

    city and simulation_day are applied by filtering on trips.vehicle_id,
    since those columns live on trips (not waypoints).
    """
    conn = get_connection()

    vtype_filter = f"AND vehicle_type = '{vehicle_type}'" if vehicle_type else ""
    key_subq = _build_trip_vehicle_keys_subquery(vehicle_type, city, simulation_day)
    city_filter = f"AND vehicle_key IN {key_subq}" if key_subq else ""

    # Step 1: Sample distinct (vehicle_id, trip_id) pairs — filter then sample
    sampled = conn.execute(f"""
        SELECT vehicle_id, trip_id
        FROM (
            SELECT DISTINCT vehicle_id, trip_id
            FROM waypoints
            WHERE 1=1 {vtype_filter} {city_filter}
        )
        USING SAMPLE {n}
    """).fetchall()

    if not sampled:
        return TrajectoryResponse(trajectories=[], count=0)

    # Step 2: Fetch all waypoints for sampled trips
    pairs = ", ".join(f"({s[0]}, {s[1]})" for s in sampled)
    rows = conn.execute(f"""
        SELECT {_WAYPOINT_COLS}
        FROM waypoints
        WHERE (vehicle_id, trip_id) IN ({pairs})
        ORDER BY vehicle_id, trip_id, unix_time_ms
    """).fetchall()

    trajectories = _rows_to_trajectories(rows, vehicle_type)
    return TrajectoryResponse(trajectories=trajectories, count=len(trajectories))


@router.post("/trajectories/query-bbox")
async def query_trajectories_bbox(q: BBoxQuery):
    """Find trajectories with waypoints inside a bounding box.

    Spatial filtering: any trajectory with at least one waypoint in the bbox
    is returned in full (all its waypoints, not just those in the bbox).

    city and simulation_day are applied by filtering on trips.vehicle_id,
    since those columns live on trips (not waypoints).
    """
    conn = get_connection()

    vtype_filter = f"AND vehicle_type = '{q.vehicle_type}'" if q.vehicle_type else ""
    key_subq = _build_trip_vehicle_keys_subquery(q.vehicle_type, q.city, q.simulation_day)
    city_filter = f"AND vehicle_key IN {key_subq}" if key_subq else ""

    # Step 1: Find (vehicle_id, trip_id) pairs with waypoints in bbox
    matched = conn.execute(f"""
        SELECT DISTINCT vehicle_id, trip_id
        FROM waypoints
        WHERE lon BETWEEN {q.min_lon} AND {q.max_lon}
          AND lat BETWEEN {q.min_lat} AND {q.max_lat}
          {vtype_filter}
          {city_filter}
        LIMIT {q.limit}
    """).fetchall()

    if not matched:
        return TrajectoryResponse(trajectories=[], count=0)

    # Step 2: Fetch full trajectories
    pairs = ", ".join(f"({m[0]}, {m[1]})" for m in matched)
    rows = conn.execute(f"""
        SELECT {_WAYPOINT_COLS}
        FROM waypoints
        WHERE (vehicle_id, trip_id) IN ({pairs})
        ORDER BY vehicle_id, trip_id, unix_time_ms
    """).fetchall()

    trajectories = _rows_to_trajectories(rows, q.vehicle_type)
    return TrajectoryResponse(trajectories=trajectories, count=len(trajectories))


@router.post("/trajectories/query-point")
async def query_trajectories_point(q: PointQuery):
    """Find trajectories passing near a point (within radius_km).

    Uses a simple bounding-box pre-filter (~1 degree ≈ 111km at Japan's latitude),
    then exact Haversine distance check. Good enough for interactive querying.

    city and simulation_day are applied by filtering on trips.vehicle_id,
    since those columns live on trips (not waypoints).
    """
    conn = get_connection()

    # Approximate degree offset for the radius (conservative overestimate)
    deg_offset = q.radius_km / 80.0  # ~80km per degree at 35°N latitude

    vtype_filter = f"AND vehicle_type = '{q.vehicle_type}'" if q.vehicle_type else ""
    key_subq = _build_trip_vehicle_keys_subquery(q.vehicle_type, q.city, q.simulation_day)
    city_filter = f"AND vehicle_key IN {key_subq}" if key_subq else ""

    # Step 1: Find trips with waypoints in the approximate bbox
    matched = conn.execute(f"""
        SELECT DISTINCT vehicle_id, trip_id
        FROM waypoints
        WHERE lon BETWEEN {q.lon - deg_offset} AND {q.lon + deg_offset}
          AND lat BETWEEN {q.lat - deg_offset} AND {q.lat + deg_offset}
          {vtype_filter}
          {city_filter}
        LIMIT {q.limit}
    """).fetchall()

    if not matched:
        return TrajectoryResponse(trajectories=[], count=0)

    # Step 2: Fetch full trajectories
    pairs = ", ".join(f"({m[0]}, {m[1]})" for m in matched)
    rows = conn.execute(f"""
        SELECT {_WAYPOINT_COLS}
        FROM waypoints
        WHERE (vehicle_id, trip_id) IN ({pairs})
        ORDER BY vehicle_id, trip_id, unix_time_ms
    """).fetchall()

    trajectories = _rows_to_trajectories(rows, q.vehicle_type)
    return TrajectoryResponse(trajectories=trajectories, count=len(trajectories))


# ─── traj-mining compatibility endpoints ───────────────────────
# These mirror the original traj-mining API for drop-in compatibility

@router.get("/randomsample")
async def random_sample_compat(n: int = Query(500)):
    """traj-mining compatible endpoint: returns {path, timestamps} arrays."""
    conn = get_connection()

    sampled = conn.execute(f"""
        SELECT DISTINCT vehicle_id, trip_id
        FROM waypoints
        USING SAMPLE {n}
    """).fetchall()

    if not sampled:
        return []

    pairs = ", ".join(f"({s[0]}, {s[1]})" for s in sampled)
    rows = conn.execute(f"""
        SELECT vehicle_id, trip_id, unix_time_ms, lon, lat,
               vehicle_type, transport_mode, purpose,
               goods_type, vehicle_size, passenger_in, fare_yen, vehicle_key
        FROM waypoints
        WHERE (vehicle_id, trip_id) IN ({pairs})
        ORDER BY vehicle_id, trip_id, unix_time_ms
    """).fetchall()

    trajectories = _rows_to_trajectories(rows)
    # Return in traj-mining format: [{path: [...], timestamps: [...]}, ...]
    return [
        {"path": t.path, "timestamps": t.timestamps}
        for t in trajectories
    ]
