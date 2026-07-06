"""Trip sample / query endpoints."""

from fastapi import APIRouter, Query
from typing import Optional

from ..db import get_connection, build_trip_filter
from ..models import TripQuery, TripResponse, TripPoint

router = APIRouter()


def _row_to_trip(r) -> dict:
    return {
        "vehicle_id":   r[0],
        "trip_id":      r[1],
        "starttime":    r[2],
        "start_lon":    r[3],
        "start_lat":    r[4],
        "end_lon":      r[5],
        "end_lat":      r[6],
        "vehicle_type": r[7],
        "distance_km":  r[8],
        "goods_type":   r[9],
        "city":         r[10],
    }


@router.get("/trips/sample", response_model=TripResponse)
async def sample(
    n: int = Query(1000, ge=1, le=50000),
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
):
    """Random sample of trips — fast and cheap."""
    conn = get_connection()
    where = build_trip_filter(vehicle_type, city, simulation_day)
    rows = conn.execute(f"""
        SELECT vehicle_id, trip_id, starttime, start_lon, start_lat,
               end_lon, end_lat, vehicle_type, distance_km, goods_type, city
        FROM trips {where}
        USING SAMPLE {n} ROWS
    """).fetchall()
    trips = [_row_to_trip(r) for r in rows]
    return {"trips": trips, "count": len(trips), "total_matching": None}


@router.get("/trips/vehicles")
async def search_vehicles(
    q: Optional[str] = Query(
        None, min_length=1, max_length=80,
        description="vehicle_key prefix, e.g. 'taxi:tokyo:4'. Omit to list top vehicles.",
    ),
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    """Agent search (Phase 2A) — vehicles matching a vehicle_key prefix.

    Powers the Agents tab search box. `q` is free user typing, so it is bound
    as a SQL parameter (prefix LIKE), unlike the regex-guarded filters that go
    through build_trip_filter.
    """
    conn = get_connection()
    where = build_trip_filter(vehicle_type, city, simulation_day)
    params: list = []
    if q:
        # Escape LIKE wildcards so 'truck:1%' matches literally, then append
        # the prefix wildcard ourselves.
        escaped = q.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        prefix_cond = r"vehicle_key LIKE ? || '%' ESCAPE '\'"
        where = f"{where} AND {prefix_cond}" if where else f"WHERE {prefix_cond}"
        params.append(escaped)
    params.append(int(limit))

    rows = conn.execute(f"""
        SELECT vehicle_key,
               ANY_VALUE(source_id)         AS source_id,
               COUNT(*)                     AS trip_count,
               MIN(starttime)               AS first_start,
               MAX(starttime)               AS last_end,
               ROUND(SUM(distance_km), 1)   AS total_km
        FROM trips {where}
        GROUP BY vehicle_key
        ORDER BY trip_count DESC, vehicle_key
        LIMIT ?
    """, params).fetchall()

    vehicles = [
        {
            "vehicle_key": r[0],
            "source_id":   r[1],
            "trip_count":  r[2],
            "first_start": r[3],
            "last_end":    r[4],
            "total_km":    r[5],
        }
        for r in rows
    ]
    return {"vehicles": vehicles, "count": len(vehicles)}


@router.post("/trips/query", response_model=TripResponse)
async def query(q: TripQuery):
    """Filtered trip query with optional hour/goods_type narrowing."""
    conn = get_connection()
    extra: list[str] = []
    if q.min_hour is not None:
        extra.append(f"dep_hour >= {int(q.min_hour)}")
    if q.max_hour is not None:
        extra.append(f"dep_hour <= {int(q.max_hour)}")
    if q.goods_type:
        extra.append(f"goods_type = '{q.goods_type}'")
    if q.origin_zone:
        extra.append(f"origin_zone = '{q.origin_zone}'")
    if q.dest_zone:
        extra.append(f"dest_zone = '{q.dest_zone}'")

    where = build_trip_filter(
        q.vehicle_type, q.city, q.simulation_day, extra=extra,
        min_speed=q.min_speed,
        max_speed=q.max_speed,
        max_dwell_minutes=q.max_dwell_minutes,
        min_detour_ratio=q.min_detour_ratio,
        max_detour_ratio=q.max_detour_ratio,
    )

    rows = conn.execute(f"""
        SELECT vehicle_id, trip_id, starttime, start_lon, start_lat,
               end_lon, end_lat, vehicle_type, distance_km, goods_type, city
        FROM trips {where}
        LIMIT {int(q.limit)}
    """).fetchall()
    trips = [_row_to_trip(r) for r in rows]
    return {"trips": trips, "count": len(trips), "total_matching": None}
