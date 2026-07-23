"""
POI endpoints (universal-trajectory-support Phase 1).

Serves static point-of-interest layers ingested from the `pois:` block of
sources.yaml into the `pois` table. POI filters are independent of
TripFilters — a POI layer is not a trip source and shares none of the
trip/waypoint filter dimensions.

Validation patterns on every query param are load-bearing: values are
f-string'd into SQL below (same discipline as filters.py / build_trip_filter).
"""

import json

from fastapi import APIRouter, HTTPException, Query

from ..db import get_connection
from ..models import (
    Poi,
    PoiCategoriesResponse,
    PoiCategory,
    PoiListResponse,
)

router = APIRouter()

_MAX_LIMIT = 100_000


def _poi_styles() -> dict[str, dict]:
    """source_key → {label, color} from sources.yaml's `pois:` block.

    Degrades to {} on any failure (missing/invalid sources.yaml) — the
    endpoints still serve raw categories without render hints, same as
    _source_styles elsewhere.
    """
    try:
        from ..sources_schema import default_sources_path, load_sources_merged

        sources = load_sources_merged(default_sources_path())
        return {
            key: {
                "label": cfg.label,
                "color": list(cfg.color) if cfg.color else None,
            }
            for key, cfg in (sources.pois or {}).items()
        }
    except Exception:
        return {}


@router.get("/pois", response_model=PoiListResponse)
async def list_pois(
    category: str | None = Query(None, pattern=r"^[A-Za-z0-9_ \-]{1,40}$"),
    source_key: str | None = Query(None, pattern=r"^[a-z][a-z0-9_\-]*$"),
    bbox: str | None = Query(
        None,
        pattern=r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$",
        description="Bounding box 'w,s,e,n' (lon/lat degrees).",
    ),
    limit: int = Query(20000, ge=1, le=_MAX_LIMIT),
):
    """List POIs, optionally filtered by category, layer (source_key), bbox.

    Response shape: {pois: [{poi_id, source_key, name, category, lon, lat,
    props}], count, truncated}. `props` is the parsed props_json dict (null
    for csv/parquet-ingested layers).
    """
    conds: list[str] = []
    if category:
        conds.append(f"category = '{category}'")
    if source_key:
        conds.append(f"source_key = '{source_key}'")
    if bbox:
        w, s, e, n = (float(v) for v in bbox.split(","))
        if not (w < e and s < n):
            raise HTTPException(
                status_code=422,
                detail=f"bbox requires w < e and s < n, got {bbox!r}.",
            )
        conds.append(f"lon BETWEEN {w} AND {e} AND lat BETWEEN {s} AND {n}")
    where = ("WHERE " + " AND ".join(conds)) if conds else ""

    conn = get_connection()
    # Fetch limit+1 rows so `truncated` is exact, then slice back to limit.
    rows = conn.execute(f"""
        SELECT poi_id, source_key, name, category, lon, lat, props_json
        FROM pois
        {where}
        ORDER BY source_key, poi_id
        LIMIT {int(limit) + 1}
    """).fetchall()

    truncated = len(rows) > limit
    rows = rows[:limit]
    pois = []
    for r in rows:
        props: dict | None = None
        if r[6]:
            try:
                props = json.loads(r[6])
            except (ValueError, TypeError):
                props = None
        pois.append(Poi(
            poi_id=r[0], source_key=r[1], name=r[2], category=r[3],
            lon=r[4], lat=r[5], props=props,
        ))
    return PoiListResponse(pois=pois, count=len(pois), truncated=truncated)


@router.get("/pois/categories", response_model=PoiCategoriesResponse)
async def poi_categories():
    """POI counts per (source_key, category), with the layer's label/color
    joined in from sources.yaml when available.

    Response shape: {categories: [{category, count, color, label,
    source_key}]}. `color`/`label` are null when sources.yaml is unavailable
    or the layer declares no color.
    """
    conn = get_connection()
    rows = conn.execute("""
        SELECT source_key, category, COUNT(*) AS cnt
        FROM pois
        GROUP BY source_key, category
        ORDER BY source_key, category
    """).fetchall()
    styles = _poi_styles()
    categories = [
        PoiCategory(
            category=r[1],
            count=r[2],
            color=styles.get(r[0], {}).get("color"),
            label=styles.get(r[0], {}).get("label"),
            source_key=r[0],
        )
        for r in rows
    ]
    return PoiCategoriesResponse(categories=categories)
