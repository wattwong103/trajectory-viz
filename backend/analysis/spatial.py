"""
Spatial density analysis — hexagonal heatmaps and hotspot detection.

Uses coordinate grid aggregation (DuckDB-native, no h3 dependency required
for the basic version). H3 hexagonal indexing can be added later for
finer resolution.

Results feed DeckGL HeatmapLayer and HexagonLayer.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from ..db import get_connection
from ..filters import TripFilters, trip_filters

router = APIRouter()


@router.get("/analysis/spatial/density-hourly")
async def density_hourly(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    resolution: float = Query(0.005, ge=0.001, le=0.1,
                              description="Grid resolution in degrees (must match a built aggregate)"),
    max_cells_per_hour: int = Query(15000, ge=100, le=50000),
):
    """Hour-binned waypoint density for the animated pulse heatmap (Phase 2B).

    Returns all 24 hour buckets in one response — the frontend holds them and
    crossfades between adjacent hours as the time slider runs, never
    refetching during animation.

    Reads ONLY the precomputed density_hourly aggregate (built at ingest or
    via `python -m backend.ingest --aggregates-only`). It never falls back to
    GROUP-BYing the 233M-row waypoints table at request time — that would
    blow the 1s analysis budget — so an empty aggregate is a 409 with the fix.
    """
    conn = get_connection()

    built = conn.execute(
        "SELECT COUNT(*) FROM density_hourly WHERE resolution = ?", [float(resolution)]
    ).fetchone()[0]
    if built == 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"density_hourly not built at resolution {resolution} — run: "
                f"python -m backend.ingest --aggregates-only"
            ),
        )

    conds = ["resolution = ?"]
    params: list = [float(resolution)]
    if vehicle_type:
        conds.append("source_id = ?")
        params.append(vehicle_type)
    if city:
        conds.append("city = ?")
        params.append(city)
    where = " AND ".join(conds)

    # Cells can repeat across (source_id, city) when no filter is set —
    # re-aggregate, then keep the top-N per hour by weight.
    rows = conn.execute(f"""
        WITH filtered AS (
            SELECT hour, grid_lon, grid_lat, SUM(weight) AS weight
            FROM density_hourly
            WHERE {where}
            GROUP BY hour, grid_lon, grid_lat
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY hour ORDER BY weight DESC
            ) AS rn
            FROM filtered
        )
        SELECT hour, grid_lon, grid_lat, weight
        FROM ranked
        WHERE rn <= ?
        ORDER BY hour, weight DESC
    """, params + [int(max_cells_per_hour)]).fetchall()

    total = conn.execute(f"""
        SELECT COUNT(*) FROM (
            SELECT 1 FROM density_hourly WHERE {where}
            GROUP BY hour, grid_lon, grid_lat
        )
    """, params).fetchone()[0]

    hours: list[dict] = [{"hour": h, "points": []} for h in range(24)]
    global_max = 0
    for hour, lon, lat, weight in rows:
        hours[int(hour)]["points"].append({"lon": lon, "lat": lat, "weight": weight})
        if weight > global_max:
            global_max = weight

    return {
        "resolution_deg": resolution,
        "global_max_weight": global_max,
        "hours": hours,
        "total_cells": total,
        "truncated": len(rows) < total,
    }


@router.get("/analysis/spatial/density-grid")
async def density_grid(
    resolution: float = Query(0.01, ge=0.001, le=0.1,
                              description="Grid cell size in degrees (~0.01=1km)"),
    point_type: str = Query("origin", pattern="^(origin|destination|both)$"),
    f: TripFilters = Depends(trip_filters),
):
    """Grid-based spatial density of trip origins, destinations, or both.

    Returns [{lon, lat, weight}, ...] for DeckGL HeatmapLayer.
    Resolution 0.01° ≈ 1km at Japan's latitude.
    """
    conn = get_connection()
    where = f.where()

    queries = []
    if point_type in ("origin", "both"):
        queries.append(f"""
            SELECT
                ROUND(start_lon / {resolution}) * {resolution} AS lon,
                ROUND(start_lat / {resolution}) * {resolution} AS lat,
                COUNT(*) AS weight
            FROM trips {where}
            GROUP BY lon, lat
        """)

    if point_type in ("destination", "both"):
        queries.append(f"""
            SELECT
                ROUND(end_lon / {resolution}) * {resolution} AS lon,
                ROUND(end_lat / {resolution}) * {resolution} AS lat,
                COUNT(*) AS weight
            FROM trips {where}
            GROUP BY lon, lat
        """)

    if len(queries) == 2:
        # Union and re-aggregate
        combined = f"""
            SELECT lon, lat, SUM(weight) AS weight FROM (
                ({queries[0]}) UNION ALL ({queries[1]})
            ) GROUP BY lon, lat
            ORDER BY weight DESC
            LIMIT 5000
        """
    else:
        combined = queries[0] + " ORDER BY weight DESC LIMIT 5000"

    rows = conn.execute(combined).fetchall()

    return {
        "points": [
            {"lon": r[0], "lat": r[1], "weight": r[2]}
            for r in rows
        ],
        "count": len(rows),
        "resolution_deg": resolution,
    }


@router.get("/analysis/spatial/waypoint-density")
async def waypoint_density(
    resolution: float = Query(0.005, ge=0.001, le=0.05,
                              description="Grid cell size in degrees (~0.005=500m)"),
    limit: int = Query(5000, ge=100, le=20000),
    f: TripFilters = Depends(trip_filters),
):
    """Waypoint spatial density — where vehicles actually travel (not just OD).

    Higher resolution than trip-level density since waypoints are denser.
    Requires trajectory data to be ingested.
    """
    conn = get_connection()

    trip_where = f.where()

    # INVARIANT: transport_mode is per-TRIP. With a mode filter set, per-vehicle
    # scoping over-selects (one walk trip drags in the vehicle's car waypoints
    # too), so switch to trip-granular (vehicle_key, trip_id) scoping. The
    # vehicle_key path stays for the common no-mode case (identical to before).
    if trip_where and f.transport_mode_list():
        waypoint_where = f"WHERE (vehicle_key, trip_id) IN (SELECT vehicle_key, trip_id FROM trips {trip_where})"
    elif trip_where:
        waypoint_where = f"WHERE vehicle_key IN (SELECT DISTINCT vehicle_key FROM trips {trip_where})"
    else:
        waypoint_where = ""

    rows = conn.execute(f"""
        SELECT
            ROUND(lon / {resolution}) * {resolution} AS grid_lon,
            ROUND(lat / {resolution}) * {resolution} AS grid_lat,
            COUNT(*) AS weight
        FROM waypoints
        {waypoint_where}
        GROUP BY grid_lon, grid_lat
        ORDER BY weight DESC
        LIMIT {limit}
    """).fetchall()

    return {
        "points": [
            {"lon": r[0], "lat": r[1], "weight": r[2]}
            for r in rows
        ],
        "count": len(rows),
        "resolution_deg": resolution,
    }


@router.get("/analysis/spatial/link-density")
async def link_density(
    top_n: int = Query(500, ge=10, le=5000),
    min_waypoints: int = Query(50, ge=1, le=10000,
                               description="Skip links with fewer than this many waypoints"),
    f: TripFilters = Depends(trip_filters),
):
    """DRM link-level waypoint density.

    Aggregates waypoints by `link_id` to reveal which road segments the
    generated trajectories actually traverse. Used to validate that the
    routing model threads trajectories through realistic arterials rather
    than random shortcuts.

    Returns each top link with its waypoint count, unique-vehicle count,
    unique-trip count, and a centroid (AVG lon/lat) for map placement.

    `min_waypoints` filters out sparse links so the top-N list highlights
    consistently-used corridors rather than outliers.
    """
    conn = get_connection()

    trip_where = f.where()
    # Same trip-granular scoping rule as waypoint-density (see comment there).
    if trip_where and f.transport_mode_list():
        waypoint_scope = f"AND (vehicle_key, trip_id) IN (SELECT vehicle_key, trip_id FROM trips {trip_where})"
    elif trip_where:
        waypoint_scope = f"AND vehicle_key IN (SELECT DISTINCT vehicle_key FROM trips {trip_where})"
    else:
        waypoint_scope = ""

    # Note: no COUNT DISTINCT on (vehicle_id, trip_id) — that composite is
    # ~30-60s on 289M truck waypoints. unique_vehicles alone is almost as
    # informative for the hypothesis-validation use case.
    rows = conn.execute(f"""
        SELECT
            link_id,
            COUNT(*)                    AS waypoint_count,
            COUNT(DISTINCT vehicle_key) AS unique_vehicles,
            AVG(lon)                    AS centroid_lon,
            AVG(lat)                    AS centroid_lat
        FROM waypoints
        WHERE link_id IS NOT NULL
          AND link_id != ''
          {waypoint_scope}
        GROUP BY link_id
        HAVING COUNT(*) >= {min_waypoints}
        ORDER BY waypoint_count DESC
        LIMIT {top_n}
    """).fetchall()

    # Total distinct links in the scoped set — context for the top-N selection
    total_links = conn.execute(f"""
        SELECT COUNT(DISTINCT link_id)
        FROM waypoints
        WHERE link_id IS NOT NULL AND link_id != ''
          {waypoint_scope}
    """).fetchone()[0]

    return {
        "links": [
            {
                "link_id": r[0],
                "waypoint_count": r[1],
                "unique_vehicles": r[2],
                "centroid": [round(r[3], 6), round(r[4], 6)],
            }
            for r in rows
        ],
        "count": len(rows),
        "total_links": total_links,
    }


@router.get("/analysis/spatial/hotspots")
async def hotspots(
    point_type: str = Query("origin", pattern="^(origin|destination)$"),
    top_n: int = Query(20, ge=5, le=100),
    f: TripFilters = Depends(trip_filters),
):
    """Top-N densest locations (hotspots).

    Returns the grid cells with the highest trip concentration.
    """
    conn = get_connection()

    if point_type == "origin":
        lon_col, lat_col = "start_lon", "start_lat"
    else:
        lon_col, lat_col = "end_lon", "end_lat"

    where = f.where(extra=[f"{lon_col} IS NOT NULL"])

    rows = conn.execute(f"""
        SELECT
            ROUND({lon_col} * 100) / 100 AS lon,
            ROUND({lat_col} * 100) / 100 AS lat,
            COUNT(*) AS volume,
            COUNT(DISTINCT vehicle_key) AS unique_vehicles
        FROM trips
        {where}
        GROUP BY lon, lat
        ORDER BY volume DESC
        LIMIT {top_n}
    """).fetchall()

    return [
        {
            "lon": r[0], "lat": r[1],
            "volume": r[2], "unique_vehicles": r[3],
            "rank": i + 1,
        }
        for i, r in enumerate(rows)
    ]
