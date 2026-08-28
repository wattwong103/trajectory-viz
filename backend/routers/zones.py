"""
Zone (polygon layer) endpoints — the `zones:` block of sources.yaml.

Serves static polygon layers ingested from GeoJSON into the `zones` table.
Zone filters are independent of TripFilters — a zone layer is not a trip
source and shares none of the trip/waypoint filter dimensions.

Validation patterns on every query param are load-bearing: values are
f-string'd into SQL below (same discipline as filters.py / build_trip_filter).
"""

import json

from fastapi import APIRouter, HTTPException, Query

from ..db import get_connection, spatial_available
from ..models import Zone, ZoneListResponse

router = APIRouter()

_MAX_LIMIT = 20_000


def _zone_styles() -> dict[str, dict]:
    """source_key → {label, color} from sources.yaml's `zones:` block.

    Degrades to {} on any failure (missing/invalid sources.yaml) — the
    endpoint still serves raw geometry without render hints.
    """
    try:
        from ..sources_schema import default_sources_path, load_sources_merged

        sources = load_sources_merged(default_sources_path())
        return {
            key: {
                "label": cfg.label,
                "color": list(cfg.color) if cfg.color else None,
            }
            for key, cfg in (sources.zones or {}).items()
        }
    except Exception:
        return {}


@router.get("/zones", response_model=ZoneListResponse)
async def list_zones(
    source_key: str | None = Query(None, pattern=r"^[a-z][a-z0-9_\-]*$"),
    bbox: str | None = Query(
        None,
        pattern=r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$",
        description="Bounding box 'w,s,e,n' (lon/lat degrees); returns zones "
                    "whose precomputed bbox INTERSECTS it.",
    ),
    limit: int = Query(2000, ge=1, le=_MAX_LIMIT),
):
    """List zones, optionally filtered by layer (source_key) or bbox.

    Response shape: {zones: [{zone_id, source_key, name, category, bbox,
    geometry, props}], count}. `geometry` is the parsed GeoJSON geometry
    ({type, coordinates}); `bbox` is {w,s,e,n} computed at ingest.
    """
    conds: list[str] = []
    if source_key:
        conds.append(f"source_key = '{source_key}'")
    if bbox:
        w, s, e, n = (float(v) for v in bbox.split(","))
        if not (w < e and s < n):
            raise HTTPException(
                status_code=422,
                detail=f"bbox requires w < e and s < n, got {bbox!r}.",
            )
        conds.append(
            f"min_lon <= {e} AND max_lon >= {w} "
            f"AND min_lat <= {n} AND max_lat >= {s}"
        )
    where = ("WHERE " + " AND ".join(conds)) if conds else ""

    conn = get_connection()
    rows = conn.execute(f"""
        SELECT zone_id, source_key, name, category,
               min_lon, max_lon, min_lat, max_lat,
               geometry_json, props_json
        FROM zones
        {where}
        ORDER BY source_key, zone_id
        LIMIT {int(limit) + 1}
    """).fetchall()

    truncated = len(rows) > limit
    rows = rows[:limit]
    zones: list[Zone] = []
    for r in rows:
        try:
            geometry = json.loads(r[8])
        except (ValueError, TypeError):
            continue  # unparseable geometry can't render — skip, don't fail
        props: dict | None = None
        if r[9]:
            try:
                props = json.loads(r[9])
            except (ValueError, TypeError):
                props = None
        bbox_dict = (
            {"w": r[4], "s": r[6], "e": r[5], "n": r[7]}
            if r[4] is not None and r[7] is not None
            else None
        )
        zones.append(Zone(
            zone_id=r[0], source_key=r[1], name=r[2], category=r[3],
            bbox=bbox_dict, geometry=geometry, props=props,
        ))
    return ZoneListResponse(zones=zones, count=len(zones), truncated=truncated)


@router.get("/zones/styles")
async def zone_styles():
    """Layer render hints: source_key → {label, color} from sources.yaml."""
    return {"styles": _zone_styles()}


@router.get("/zones/contains")
async def zones_contains(
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
):
    """Zones containing a point — the point-in-polygon lookup.

    With PFLOW_VIZ_SPATIAL=1 (duckdb `spatial` loaded) this is an exact
    ST_Within over the stored GeoJSON geometry, holes included. Otherwise
    it degrades to bbox containment (`mode: "bbox"`) — an over-approximation
    that may include zones whose polygon misses the point.
    """
    conn = get_connection()
    if spatial_available():
        rows = conn.execute(f"""
            SELECT z.zone_id, z.source_key, z.name, z.category, z.geometry_json
            FROM (
                SELECT *, ST_Point({float(lon)}, {float(lat)}) AS pt,
                       ST_GeomFromGeoJSON(geometry_json) AS geom
                FROM zones
            ) AS z
            WHERE ST_Within(z.pt, z.geom)
            ORDER BY z.source_key, z.zone_id
        """).fetchall()
        mode = "spatial"
    else:
        rows = conn.execute(f"""
            SELECT zone_id, source_key, name, category, geometry_json
            FROM zones
            WHERE min_lon <= {float(lon)} AND max_lon >= {float(lon)}
              AND min_lat <= {float(lat)} AND max_lat >= {float(lat)}
            ORDER BY source_key, zone_id
        """).fetchall()
        mode = "bbox"

    return {
        "mode": mode,
        "point": {"lon": lon, "lat": lat},
        "zones": [
            {
                "zone_id": r[0], "source_key": r[1],
                "name": r[2], "category": r[3],
            }
            for r in rows
        ],
        "count": len(rows),
    }
