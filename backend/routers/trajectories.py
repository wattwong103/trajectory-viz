"""
Trajectory query endpoints — sampling and spatial queries for animated visualization.

Response format is designed for direct consumption by DeckGL TripsLayer:
    path: [[lon, lat], ...]
    timestamps: [seconds_from_midnight, ...]

The unix_time_ms from the trajectory CSV is converted back to seconds-from-midnight
for the 24h animation loop (matching traj-mining's 86400-second cycle).
"""

import math
import re

from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from ..db import get_connection, build_trip_filter
from ..models import (
    BBoxQuery, PointQuery,
    Trajectory, TrajectoryMetadata, TrajectoryResponse,
    TrajectorySegment,
)

router = APIRouter()

# Base date anchor used in VehicleTrajectoryGenerator.java: 2020-10-01 00:00:00 JST
# = 1601478000 seconds since epoch (UTC+9)
BASE_EPOCH_SEC = 1601478000

# Idle-speed threshold for F3 dwell markers. Same scale as DETOUR_MIN_HAVERSINE_KM
# in ingest.py — < 1 km/h means the vehicle moved less than the GPS-noise floor
# per second, treated as "stopped".
_F3_IDLE_KMH = 1.0


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Equirectangular approximation in km, matching the SQL formula in
    ingest.compute_derived_metrics and analysis/trip_chains.round_trip_analysis."""
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    mean_lat_rad = math.radians((lat1 + lat2) / 2)
    return 111.32 * math.sqrt((dlon * math.cos(mean_lat_rad)) ** 2 + dlat ** 2)


def _compute_segments(waypoints: list) -> list[TrajectorySegment]:
    """Per-segment metrics (Phase 2 Step 2.5).

    Each waypoint row is indexed as in _WAYPOINT_COLS:
        [2]=unix_time_ms, [3]=lon, [4]=lat, [13]=link_id.
    """
    segments: list[TrajectorySegment] = []
    for i in range(len(waypoints) - 1):
        w1, w2 = waypoints[i], waypoints[i + 1]
        dt_sec = (w2[2] - w1[2]) / 1000.0
        dist_km = _haversine_km(w1[3], w1[4], w2[3], w2[4])
        if dt_sec > 0:
            speed_kmh: Optional[float] = dist_km / (dt_sec / 3600.0)
        else:
            speed_kmh = None
        dwell_sec: Optional[float] = None
        if speed_kmh is not None and speed_kmh < _F3_IDLE_KMH:
            dwell_sec = dt_sec
        segments.append(TrajectorySegment(
            link_id=w2[13],
            speed_kmh=speed_kmh,
            dwell_sec=dwell_sec,
        ))
    return segments


def _rows_to_trajectories(
    rows: list,
    vehicle_type_hint: str | None = None,
    include_segments: bool = False,
) -> list[Trajectory]:
    """Group waypoint rows by (vehicle_id, trip_id) into Trajectory objects.

    Each row: (vehicle_id, trip_id, unix_time_ms, lon, lat, vehicle_type,
               transport_mode, purpose, goods_type, vehicle_size,
               passenger_in, fare_yen, vehicle_key, link_id)

    When `include_segments=True` (Phase 2 Step 2.5), each Trajectory carries a
    `segments` list of length len(path)-1 with per-segment speed + dwell. Off
    by default — segments roughly double the JSON payload size.
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
        segments = _compute_segments(waypoints) if include_segments else None
        result.append(Trajectory(
            id=f"{vtype}_{vid}_{tid}",
            path=path,
            timestamps=timestamps,
            metadata=meta,
            segments=segments,
        ))

    return result


# Column list used in all waypoint queries.
# link_id (last) added in Phase 2 Step 2.5 for per-segment annotation.
_WAYPOINT_COLS = """
    vehicle_id, trip_id, unix_time_ms, lon, lat,
    vehicle_type, transport_mode, purpose,
    goods_type, vehicle_size, passenger_in, fare_yen, vehicle_key, link_id
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
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    include_segments: bool = Query(False,
        description="Opt into per-segment link/speed/dwell (Phase 2 F3)"),
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

    trajectories = _rows_to_trajectories(rows, vehicle_type, include_segments=include_segments)
    return TrajectoryResponse(trajectories=trajectories, count=len(trajectories))


# Phase 2A — agent selection. vehicle_key format: '<source>:<rest>' where rest
# may itself contain ':' (scoped keys like 'taxi:tokyo:47').
_VEHICLE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*:[A-Za-z0-9_:.\-]{1,64}$")
_MAX_VEHICLE_KEYS = 20


@router.get("/trajectories/by-vehicle")
async def trajectories_by_vehicle(
    vehicle_keys: str = Query(
        ...,
        description=(
            "Comma-separated vehicle_key list (1-20 keys), e.g. "
            "'truck:1001,taxi:tokyo:47'. Returns every trip of each vehicle "
            "(the full-day chain) for agent-playback."
        ),
    ),
    simulation_day: Optional[int] = Query(None, ge=0),
    include_segments: bool = Query(True,
        description="Include per-segment link/speed/dwell (F3)"),
):
    """Return all trajectories for the requested vehicles (Phase 2A agent playback).

    Unlike sample/bbox queries this returns the *complete* daily trip chain per
    vehicle, so the frontend can animate one agent across its whole day.

    vehicle_key values are user-typed (agent search box) — this endpoint uses
    parameterized SQL, not the regex-guarded f-string pattern used elsewhere.
    """
    keys = [k.strip() for k in vehicle_keys.split(",") if k.strip()]
    if not keys or len(keys) > _MAX_VEHICLE_KEYS:
        raise HTTPException(
            status_code=422,
            detail=f"vehicle_keys must contain 1-{_MAX_VEHICLE_KEYS} keys, got {len(keys)}.",
        )
    for k in keys:
        if not _VEHICLE_KEY_RE.match(k):
            raise HTTPException(
                status_code=422,
                detail=f"Malformed vehicle_key: {k!r} (expected '<source>:<id>').",
            )

    conn = get_connection()

    placeholders = ", ".join("?" for _ in keys)
    params: list = list(keys)
    day_filter = ""
    if simulation_day is not None:
        # simulation_day lives on trips, not waypoints — intersect via trip keys.
        day_filter = """
          AND vehicle_key IN (
              SELECT DISTINCT vehicle_key FROM trips WHERE simulation_day = ?
          )"""
        params.append(int(simulation_day))

    rows = conn.execute(f"""
        SELECT {_WAYPOINT_COLS}
        FROM waypoints
        WHERE vehicle_key IN ({placeholders}) {day_filter}
        ORDER BY vehicle_key, trip_id, unix_time_ms
    """, params).fetchall()

    trajectories = _rows_to_trajectories(rows, include_segments=include_segments)
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

    trajectories = _rows_to_trajectories(rows, q.vehicle_type, include_segments=q.include_segments)
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

    trajectories = _rows_to_trajectories(rows, q.vehicle_type, include_segments=q.include_segments)
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
