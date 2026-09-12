"""Trip sample / query endpoints."""


from fastapi import APIRouter, Depends, Query

from ..db import get_connection
from ..filters import TripFilters, trip_filters
from ..models import TripQuery, TripResponse

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
        "transport_mode": r[11],
    }


@router.get("/trips/sample", response_model=TripResponse)
async def sample(
    n: int = Query(1000, ge=1, le=50000),
    f: TripFilters = Depends(trip_filters),
):
    """Random sample of trips — fast and cheap."""
    conn = get_connection()
    where = f.where()
    rows = conn.execute(f"""
        SELECT vehicle_id, trip_id, starttime, start_lon, start_lat,
               end_lon, end_lat, vehicle_type, distance_km, goods_type, city,
               transport_mode
        FROM trips {where}
        USING SAMPLE {n} ROWS
    """).fetchall()
    trips = [_row_to_trip(r) for r in rows]
    return {"trips": trips, "count": len(trips), "total_matching": None}


@router.get("/trips/vehicles")
async def search_vehicles(
    q: str | None = Query(
        None, min_length=1, max_length=80,
        description="vehicle_key prefix, e.g. 'taxi:tokyo:4'. Omit to list top vehicles.",
    ),
    f: TripFilters = Depends(trip_filters),
    limit: int = Query(50, ge=1, le=200),
):
    """Agent search (Phase 2A) — vehicles matching a vehicle_key prefix.

    Powers the Agents tab search box. `q` is free user typing, so it is bound
    as a SQL parameter (prefix LIKE), unlike the regex-guarded filters that go
    through build_trip_filter.
    """
    conn = get_connection()
    where = f.where()
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
    # Shared dims (hours, goods, F1) come from TripFilters.where();
    # only the trip-query-specific zone conditions are added here.
    extra: list[str] = []
    if q.origin_zone:
        extra.append(f"origin_zone = '{q.origin_zone}'")
    if q.dest_zone:
        extra.append(f"dest_zone = '{q.dest_zone}'")

    where = q.where(extra=extra)

    rows = conn.execute(f"""
        SELECT vehicle_id, trip_id, starttime, start_lon, start_lat,
               end_lon, end_lat, vehicle_type, distance_km, goods_type, city,
               transport_mode
        FROM trips {where}
        LIMIT {int(q.limit)}
    """).fetchall()
    trips = [_row_to_trip(r) for r in rows]
    return {"trips": trips, "count": len(trips), "total_matching": None}
