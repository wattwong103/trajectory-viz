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
