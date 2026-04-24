"""
OD Flow analysis — zone-to-zone flow matrices and top-N pairs.

For truck data, uses the origin_zone and dest_zone columns directly.
For taxi data, derives approximate zones from coordinate grid cells.
Results feed DeckGL ArcLayer for flow visualization.
"""

from fastapi import APIRouter, Query
from typing import Optional
from ..db import get_connection, build_trip_filter

router = APIRouter()


@router.get("/analysis/od-flows")
async def od_flows(
    vehicle_type: Optional[str] = Query(None, pattern="^(truck|taxi)$"),
    top_n: int = Query(50, ge=5, le=500),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Top-N origin-destination flow pairs with coordinates.

    For trucks: uses zone-level OD (origin_zone, dest_zone).
    For taxis/all: uses 0.05-degree grid cells (~5km) as virtual zones.

    Returns ArcLayer-compatible format:
    [{"source": [lon, lat], "target": [lon, lat], "volume": N, ...}, ...]
    """
    conn = get_connection()

    extra = ["start_lon IS NOT NULL", "end_lon IS NOT NULL"]
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra)

    # Grid-based OD aggregation (works for both truck and taxi)
    # Round coordinates to 0.05° grid (~5km cells at Japan latitude)
    rows = conn.execute(f"""
        SELECT
            ROUND(start_lon * 20) / 20 AS o_lon,
            ROUND(start_lat * 20) / 20 AS o_lat,
            ROUND(end_lon * 20) / 20 AS d_lon,
            ROUND(end_lat * 20) / 20 AS d_lat,
            COUNT(*) AS volume,
            AVG(distance_km) AS avg_distance_km
        FROM trips
        {where}
        GROUP BY o_lon, o_lat, d_lon, d_lat
        HAVING COUNT(*) >= 5
        ORDER BY volume DESC
        LIMIT {top_n}
    """).fetchall()

    flows = [
        {
            "source": [r[0], r[1]],
            "target": [r[2], r[3]],
            "volume": r[4],
            "avg_distance_km": round(r[5], 1) if r[5] else None,
        }
        for r in rows
    ]

    return {"flows": flows, "count": len(flows)}


@router.get("/analysis/od-flows/zones")
async def od_flows_by_zone(
    vehicle_type: str = Query("truck", pattern="^(truck|taxi)$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    top_n: int = Query(50, ge=5, le=200),
):
    """Zone-level OD flows for trucks (uses origin_zone, dest_zone columns).

    Returns zone-pair volumes with centroid coordinates derived from
    the average of all trip starts/ends in that zone.
    """
    conn = get_connection()

    extra = ["origin_zone IS NOT NULL", "dest_zone IS NOT NULL"]
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra)

    rows = conn.execute(f"""
        SELECT
            origin_zone,
            dest_zone,
            COUNT(*) AS volume,
            AVG(start_lon) AS o_lon,
            AVG(start_lat) AS o_lat,
            AVG(end_lon) AS d_lon,
            AVG(end_lat) AS d_lat,
            AVG(distance_km) AS avg_distance_km
        FROM trips
        {where}
        GROUP BY origin_zone, dest_zone
        ORDER BY volume DESC
        LIMIT {top_n}
    """).fetchall()

    flows = [
        {
            "origin_zone": r[0],
            "dest_zone": r[1],
            "volume": r[2],
            "source": [r[3], r[4]],
            "target": [r[5], r[6]],
            "avg_distance_km": round(r[7], 1) if r[7] else None,
        }
        for r in rows
    ]

    return {"flows": flows, "count": len(flows)}
