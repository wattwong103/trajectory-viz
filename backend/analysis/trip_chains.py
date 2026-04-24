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
    vehicle_type: Optional[str] = Query(None, pattern="^(truck|taxi)$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Distribution of trips-per-vehicle (chain length).

    Returns histogram: [{chain_length: N, vehicle_count: M}, ...]
    A chain_length of 1 means single-trip vehicles; 5+ means busy routes.
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

    rows = conn.execute(f"""
        WITH vehicle_trips AS (
            SELECT vehicle_key, COUNT(*) AS chain_length
            FROM trips
            {where}
            GROUP BY vehicle_key
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
    vehicle_type: Optional[str] = Query(None, pattern="^(truck|taxi)$"),
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
    vehicle_type: Optional[str] = Query(None, pattern="^(truck|taxi)$"),
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
    vehicle_type: str = Query("truck", pattern="^(truck|taxi)$"),
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
