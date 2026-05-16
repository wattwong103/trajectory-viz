"""
Trip chain analysis — multi-stop sequence patterns per vehicle.

Analyzes how vehicles chain multiple trips together in a day:
- Chain length distribution (stops per vehicle per day)
- Dwell time between consecutive trips
- Round-trip detection (return to origin)
- Commodity-specific patterns (truck only)
"""

from fastapi import APIRouter, Query
from typing import Optional
from ..db import get_connection, build_trip_filter

router = APIRouter()


@router.get("/analysis/trip-chains/length-distribution")
async def chain_length_distribution(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
    min_chain_length: Optional[int] = Query(
        None, ge=1, le=100,
        description="Only show vehicles with chain_length >= this (focus the long tail)",
    ),
):
    """Distribution of trips-per-vehicle (chain length).

    Returns histogram: [{chain_length: N, vehicle_count: M}, ...]
    A chain_length of 1 means single-trip vehicles; 5+ means busy routes.
    `min_chain_length` (Phase 2 Step 2.4) trims the head of the distribution
    so the histogram focuses on multi-stop vehicles.
    """
    conn = get_connection()

    extra = []
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra if extra else None)

    having = (
        f"HAVING COUNT(*) >= {int(min_chain_length)}"
        if min_chain_length is not None else ""
    )

    rows = conn.execute(f"""
        WITH vehicle_trips AS (
            SELECT vehicle_key, COUNT(*) AS chain_length
            FROM trips
            {where}
            GROUP BY vehicle_key
            {having}
        )
        SELECT chain_length, COUNT(*) AS vehicle_count
        FROM vehicle_trips
        GROUP BY chain_length
        ORDER BY chain_length
    """).fetchall()

    return [
        {"chain_length": r[0], "vehicle_count": r[1]}
        for r in rows
    ]


@router.get("/analysis/trip-chains/dwell-times")
async def dwell_time_analysis(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    sample_vehicles: int = Query(1000, ge=10, le=10000),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Dwell time between consecutive trips for the same vehicle.

    Dwell = next_trip_start - (current_trip_start + estimated_duration).
    Since we don't have exact end times, we estimate from distance/speed.

    Returns histogram of dwell time bins.
    """
    conn = get_connection()

    extra = []
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra if extra else None)
    where_and = where.replace('WHERE', 'AND', 1) if where else ''

    # Sample vehicles with 2+ trips
    rows = conn.execute(f"""
        WITH multi_trip_vehicles AS (
            SELECT vehicle_key
            FROM trips
            {where}
            GROUP BY vehicle_key
            HAVING COUNT(*) >= 2
            USING SAMPLE {sample_vehicles}
        ),
        ordered_trips AS (
            SELECT
                t.vehicle_key,
                t.starttime,
                t.distance_km,
                ROW_NUMBER() OVER (PARTITION BY t.vehicle_key ORDER BY t.starttime) AS trip_seq,
                LEAD(t.starttime) OVER (PARTITION BY t.vehicle_key ORDER BY t.starttime) AS next_start
            FROM trips t
            JOIN multi_trip_vehicles mv ON t.vehicle_key = mv.vehicle_key
            WHERE 1=1 {where_and}
        )
        SELECT
            CASE
                WHEN (next_start - starttime) < 600 THEN '0-10min'
                WHEN (next_start - starttime) < 1800 THEN '10-30min'
                WHEN (next_start - starttime) < 3600 THEN '30-60min'
                WHEN (next_start - starttime) < 7200 THEN '1-2hr'
                WHEN (next_start - starttime) < 14400 THEN '2-4hr'
                ELSE '4hr+'
            END AS dwell_bin,
            COUNT(*) AS count
        FROM ordered_trips
        WHERE next_start IS NOT NULL
        GROUP BY dwell_bin
        ORDER BY
            CASE dwell_bin
                WHEN '0-10min' THEN 1
                WHEN '10-30min' THEN 2
                WHEN '30-60min' THEN 3
                WHEN '1-2hr' THEN 4
                WHEN '2-4hr' THEN 5
                ELSE 6
            END
    """).fetchall()

    return [{"dwell_bin": r[0], "count": r[1]} for r in rows]


@router.get("/analysis/trip-chains/round-trips")
async def round_trip_analysis(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    threshold_km: float = Query(2.0, ge=0.5, le=10.0,
                                description="Max distance between first origin and last destination to count as round-trip"),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Detect round-trip vehicles (those returning near their starting point).

    A round trip means the vehicle's last destination is within threshold_km
    of its first origin. Common for delivery trucks and taxis.
    """
    conn = get_connection()

    extra = []
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra if extra else None)
    where_and = where.replace('WHERE', 'AND', 1) if where else ''

    # For each vehicle, compare first trip origin with last trip destination
    rows = conn.execute(f"""
        WITH first_last AS (
            SELECT
                vehicle_key,
                FIRST_VALUE(start_lon) OVER w AS first_lon,
                FIRST_VALUE(start_lat) OVER w AS first_lat,
                LAST_VALUE(end_lon) OVER w AS last_lon,
                LAST_VALUE(end_lat) OVER w AS last_lat,
                COUNT(*) OVER (PARTITION BY vehicle_key) AS trip_count
            FROM trips
            WHERE 1=1 {where_and}
            WINDOW w AS (
                PARTITION BY vehicle_key
                ORDER BY starttime
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            )
        ),
        distinct_vehicles AS (
            SELECT DISTINCT vehicle_key, first_lon, first_lat, last_lon, last_lat, trip_count
            FROM first_last
            WHERE trip_count >= 2
        )
        SELECT
            CASE
                WHEN (
                    111.32 * SQRT(
                        POWER(last_lon - first_lon, 2) * POWER(COS(RADIANS(first_lat)), 2) +
                        POWER(last_lat - first_lat, 2)
                    )
                ) < {threshold_km} THEN 'round_trip'
                ELSE 'one_way'
            END AS trip_type,
            COUNT(*) AS vehicle_count,
            AVG(trip_count) AS avg_trips_per_vehicle
        FROM distinct_vehicles
        GROUP BY trip_type
    """).fetchall()

    return [
        {
            "trip_type": r[0],
            "vehicle_count": r[1],
            "avg_trips_per_vehicle": round(r[2], 1),
        }
        for r in rows
    ]


@router.get("/analysis/trip-chains/commodity-patterns")
async def commodity_chain_patterns(
    vehicle_type: str = Query("truck", pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    top_n: int = Query(20, ge=5, le=100),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Most common commodity sequences for trucks.

    Shows which goods types are frequently carried in sequence by the same truck.
    E.g., "FOOD → FOOD → FOOD" (dedicated food trucks) vs "FOOD → RETAIL → FOOD" (mixed).
    """
    conn = get_connection()

    extra = ["goods_type IS NOT NULL"]
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra)

    rows = conn.execute(f"""
        WITH truck_sequences AS (
            SELECT
                vehicle_key,
                STRING_AGG(COALESCE(goods_type, 'UNKNOWN'), ' → '
                    ORDER BY starttime) AS sequence,
                COUNT(*) AS chain_length
            FROM trips
            {where}
            GROUP BY vehicle_key
            HAVING COUNT(*) >= 2
        )
        SELECT sequence, COUNT(*) AS vehicle_count, chain_length
        FROM truck_sequences
        GROUP BY sequence, chain_length
        ORDER BY vehicle_count DESC
        LIMIT {top_n}
    """).fetchall()

    return [
        {
            "sequence": r[0],
            "vehicle_count": r[1],
            "chain_length": r[2],
        }
        for r in rows
    ]


# F2 — Trip-chain through-zone (Phase 2 Step 2.3).
# Spatial filter on waypoints; return the matching trips. The inverse dataflow
# of /api/trips/query (which filters trips and looks up their waypoints).
@router.get("/analysis/trip-chains/through-zone-bbox")
async def trips_through_zone_bbox(
    w: float = Query(..., description="West (min lon)"),
    s: float = Query(..., description="South (min lat)"),
    e: float = Query(..., description="East (max lon)"),
    n: float = Query(..., description="North (max lat)"),
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    limit: int = Query(500, ge=1, le=5000),
):
    """Return trips whose trajectories pass through an axis-aligned bbox.

    Useful for "show me everything that went through Tokyo Station between 8-9am".
    Uses idx_waypoints_lonlat for the spatial filter and idx_trips_* for the
    trip-attribute filter.
    """
    conn = get_connection()
    if w >= e or s >= n:
        return {"trips": [], "count": 0, "total_matching": None,
                "error": "Bad bbox: require w<e and s<n"}

    trip_where = build_trip_filter(vehicle_type, city, simulation_day)
    and_or_where = "AND" if trip_where else "WHERE"

    # Composite IN: match trajectories.py:query-bbox pattern.
    rows = conn.execute(f"""
        SELECT vehicle_id, trip_id, starttime, start_lon, start_lat,
               end_lon, end_lat, vehicle_type, distance_km, goods_type, city
        FROM trips
        {trip_where}
        {and_or_where} (vehicle_id, trip_id) IN (
            SELECT DISTINCT vehicle_id, trip_id
            FROM waypoints
            WHERE lon BETWEEN {float(w)} AND {float(e)}
              AND lat BETWEEN {float(s)} AND {float(n)}
        )
        LIMIT {int(limit)}
    """).fetchall()

    return {
        "trips": [
            {
                "vehicle_id":   r[0], "trip_id":    r[1], "starttime":   r[2],
                "start_lon":    r[3], "start_lat":  r[4],
                "end_lon":      r[5], "end_lat":    r[6],
                "vehicle_type": r[7], "distance_km": r[8],
                "goods_type":   r[9], "city":       r[10],
            }
            for r in rows
        ],
        "count": len(rows),
        "total_matching": None,
        "bbox": {"w": w, "s": s, "e": e, "n": n},
    }


# F2 — Multi-stop chain detail (Phase 2 Step 2.4).
# Returns the actual trip sequence for vehicles with >= min_stops trips,
# so the dashboard can render "show me what truck #1001 actually did all day".
@router.get("/analysis/trip-chains/multi-stop")
async def multi_stop_chains(
    min_stops: int = Query(3, ge=2, le=50,
                           description="Minimum trips per vehicle to include"),
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    limit: int = Query(100, ge=1, le=1000,
                       description="Max vehicles returned (sorted by chain length desc)"),
):
    """List vehicles with >= min_stops trips, each with its full ordered trip list."""
    conn = get_connection()
    extra = []
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    trip_where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra if extra else None)

    # Two-stage query:
    # 1. Find the top-N vehicles by chain length matching the filter.
    # 2. Pull their ordered trip lists.
    rows = conn.execute(f"""
        WITH multi_trip_vehicles AS (
            SELECT vehicle_key, COUNT(*) AS chain_length
            FROM trips
            {trip_where}
            GROUP BY vehicle_key
            HAVING chain_length >= {int(min_stops)}
            ORDER BY chain_length DESC
            LIMIT {int(limit)}
        )
        SELECT
            t.vehicle_key,
            t.trip_id,
            t.starttime,
            t.start_lon, t.start_lat, t.end_lon, t.end_lat,
            t.distance_km,
            t.goods_type,
            m.chain_length,
            ROW_NUMBER() OVER (PARTITION BY t.vehicle_key ORDER BY t.starttime) AS seq
        FROM trips t
        JOIN multi_trip_vehicles m ON t.vehicle_key = m.vehicle_key
        {trip_where}
        ORDER BY m.chain_length DESC, t.vehicle_key, seq
    """).fetchall()

    by_vehicle: dict[str, dict] = {}
    for r in rows:
        key = r[0]
        if key not in by_vehicle:
            by_vehicle[key] = {
                "vehicle_key": key,
                "chain_length": r[9],
                "trips": [],
            }
        by_vehicle[key]["trips"].append({
            "trip_id":     r[1],
            "starttime":   r[2],
            "start":       [r[3], r[4]],
            "end":         [r[5], r[6]],
            "distance_km": r[7],
            "goods_type":  r[8],
            "seq":         r[10],
        })

    # Preserve chain_length-DESC order (dicts are insertion-ordered in Py3.7+).
    return {"vehicles": list(by_vehicle.values()), "count": len(by_vehicle)}
