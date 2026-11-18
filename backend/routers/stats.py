"""
Stats endpoint — dataset summary and derived insights for the frontend dashboard.
"""

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_connection, get_table_stats
from ..filters import (
    SCENARIO_EXCLUDED_MODE,
    TripFilters,
    scenario_pair_subquery,
    trip_filters,
)
from ..models import StatsResponse
from ..sources_schema import (
    default_sources_path,
    inspect_registry,
    load_sources_merged,
)

router = APIRouter()


@router.get("/stats", response_model=StatsResponse)
async def stats():
    """Return dataset summary: row counts, bounding boxes, vehicle type breakdowns."""
    from ..demo import EMPTY_DB_HINT

    s = get_table_stats()
    trip_count = s.get("trips", {}).get("row_count", 0) or 0
    return StatsResponse(
        trips=s.get("trips", {}),
        waypoints=s.get("waypoints", {}),
        has_trajectories=s.get("waypoints", {}).get("row_count", 0) > 0,
        empty_hint=EMPTY_DB_HINT if trip_count == 0 else None,
    )


@router.get("/stats/insights")
async def insights(
    f: TripFilters = Depends(trip_filters),
):
    """Compute derived insights from the trip dataset.

    Returns key metrics, peak patterns, and distribution summaries
    that turn raw data into actionable understanding.
    """
    conn = get_connection()

    # Scenario contingency (200ms budget): insights runs ~6 filtered queries,
    # and each would re-scan waypoints for the exclusion anti-join (~35ms per
    # scan on 10M waypoints). Materialize the excluded pair set ONCE per
    # request into a temp table and rewrite the clause against it. Safe on
    # the singleton connection: this handler has no awaits between queries,
    # so requests can't interleave mid-handler.
    if f.scenario:
        conn.execute(f"""
            CREATE OR REPLACE TEMP TABLE _scenario_excluded AS
            SELECT vehicle_key, trip_id FROM waypoints
            WHERE lon BETWEEN {float(f.sc_w)} AND {float(f.sc_e)}
              AND lat BETWEEN {float(f.sc_s)} AND {float(f.sc_n)}
        """)
        base = f.model_copy(update={
            "scenario": None, "sc_w": None, "sc_s": None, "sc_e": None, "sc_n": None,
        })
        where = base.where(extra=[
            f"NOT (transport_mode = {SCENARIO_EXCLUDED_MODE} AND "
            f"(vehicle_key, trip_id) IN (SELECT vehicle_key, trip_id FROM _scenario_excluded))"
        ])
    else:
        where = f.where()

    # Core metrics
    core = conn.execute(f"""
        SELECT
            COUNT(*)                          AS total_trips,
            COUNT(DISTINCT vehicle_key)       AS unique_vehicles,
            ROUND(AVG(distance_km), 2)        AS avg_distance_km,
            ROUND(MEDIAN(distance_km), 2)     AS median_distance_km,
            ROUND(MAX(distance_km), 1)        AS max_distance_km,
            ROUND(STDDEV(distance_km), 2)     AS stddev_distance_km,
            ROUND(AVG(distance_km) * COUNT(*), 0) AS total_vkt
        FROM trips {where}
    """).fetchone()

    # Trips per vehicle (fleet utilization)
    fleet = conn.execute(f"""
        SELECT
            ROUND(AVG(trip_cnt), 1) AS avg_trips_per_vehicle,
            MIN(trip_cnt) AS min_trips,
            MAX(trip_cnt) AS max_trips
        FROM (
            SELECT vehicle_key, COUNT(*) AS trip_cnt
            FROM trips {where}
            GROUP BY vehicle_key
        )
    """).fetchone()

    # Peak hour analysis
    peak = conn.execute(f"""
        WITH hourly AS (
            SELECT dep_hour, COUNT(*) AS cnt
            FROM trips {where}
            GROUP BY dep_hour
        )
        SELECT
            dep_hour AS peak_hour,
            cnt AS peak_count,
            ROUND(cnt * 100.0 / SUM(cnt) OVER (), 1) AS peak_pct
        FROM hourly
        ORDER BY cnt DESC
        LIMIT 1
    """).fetchone()

    off_peak = conn.execute(f"""
        WITH hourly AS (
            SELECT dep_hour, COUNT(*) AS cnt
            FROM trips {where}
            GROUP BY dep_hour
        )
        SELECT dep_hour AS off_peak_hour, cnt AS off_peak_count
        FROM hourly ORDER BY cnt ASC LIMIT 1
    """).fetchone()

    # Fare insights — emitted whenever any matching trip carries a fare_yen value.
    # Source-agnostic: in v0.1 this was hardcoded to vehicle_type='taxi'; the v0.2
    # filter `fare_yen IS NOT NULL` excludes truck rows (whose fare_yen is NULL) and
    # any future source that doesn't declare fare_yen in sources.yaml.
    fare_insights = None
    # The fare block deliberately drops goods_type (pre-refactor behavior:
    # it applied only the hour filters). model_copy preserves that exactly.
    fare_where = f.model_copy(update={"goods_type": None}).where(
        extra=["fare_yen IS NOT NULL"]
    )
    fare_row = conn.execute(f"""
        SELECT
            ROUND(AVG(fare_yen), 0)    AS avg_fare,
            ROUND(MEDIAN(fare_yen), 0) AS median_fare,
            ROUND(MAX(fare_yen), 0)    AS max_fare,
            ROUND(AVG(CASE WHEN is_night_trip THEN fare_yen END), 0) AS avg_night_fare,
            ROUND(AVG(CASE WHEN NOT is_night_trip THEN fare_yen END), 0) AS avg_day_fare,
            ROUND(SUM(CASE WHEN is_night_trip THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS night_pct
        FROM trips {fare_where}
    """).fetchone()
    if fare_row and fare_row[0] is not None:
        fare_insights = {
            "avg_fare_yen": int(fare_row[0]),
            "median_fare_yen": int(fare_row[1]),
            "max_fare_yen": int(fare_row[2]),
            "avg_night_fare_yen": int(fare_row[3]) if fare_row[3] else None,
            "avg_day_fare_yen": int(fare_row[4]) if fare_row[4] else None,
            "night_trip_pct": fare_row[5],
        }

    # Per-transport-mode breakdown (drives the FilterPanel mode chips/stats).
    # Cheap: indexed int GROUP BY under the same filter.
    mode_rows = conn.execute(f"""
        SELECT transport_mode, COUNT(*) AS cnt
        FROM trips {where}
        GROUP BY transport_mode
        ORDER BY transport_mode
    """).fetchall()
    by_transport_mode = {
        int(r[0]): r[1] for r in mode_rows if r[0] is not None
    }

    # Distance distribution buckets (for sparkline)
    dist_where = f.where(extra=["distance_km IS NOT NULL", "distance_km > 0"])
    dist_buckets = conn.execute(f"""
        SELECT
            FLOOR(distance_km / 2) * 2 AS bucket,
            COUNT(*) AS cnt
        FROM trips {dist_where}
        GROUP BY bucket
        ORDER BY bucket
        LIMIT 25
    """).fetchall()

    # Generate text insights
    text_insights = []
    if core[0] > 0:
        trips_per_vehicle = fleet[0] if fleet else 0
        text_insights.append(
            f"{core[1]:,} unique vehicles made {core[0]:,} trips "
            f"({trips_per_vehicle} trips/vehicle avg)"
        )
        text_insights.append(
            f"Average trip: {core[2]} km (median {core[3]} km, max {core[4]} km)"
        )
        text_insights.append(
            f"Total VKT: {core[6]:,.0f} km across the fleet"
        )
    if peak:
        ratio = round(peak[1] / off_peak[1], 1) if off_peak and off_peak[1] > 0 else 0
        text_insights.append(
            f"Peak hour: {peak[0]:02d}:00 ({peak[1]:,} trips, {peak[2]}% of daily total) "
            f"— {ratio}x the quietest hour ({off_peak[0]:02d}:00)"
        )
    if fare_insights:
        text_insights.append(
            f"Avg fare: ¥{fare_insights['avg_fare_yen']:,} "
            f"(night: ¥{fare_insights.get('avg_night_fare_yen', 'N/A'):,}, "
            f"day: ¥{fare_insights.get('avg_day_fare_yen', 'N/A'):,})"
        )
        text_insights.append(
            f"Night trips: {fare_insights['night_trip_pct']}% of all rides"
        )

    return {
        "core": {
            "total_trips": core[0],
            "unique_vehicles": core[1],
            "avg_distance_km": core[2],
            "median_distance_km": core[3],
            "max_distance_km": core[4],
            "stddev_distance_km": core[5],
            "total_vkt_km": core[6],
        },
        "fleet": {
            "avg_trips_per_vehicle": fleet[0],
            "min_trips": fleet[1],
            "max_trips": fleet[2],
        },
        "peak": {
            "peak_hour": peak[0] if peak else None,
            "peak_count": peak[1] if peak else 0,
            "peak_pct": peak[2] if peak else 0,
            "off_peak_hour": off_peak[0] if off_peak else None,
            "off_peak_count": off_peak[1] if off_peak else 0,
            "peak_to_offpeak_ratio": round(peak[1] / off_peak[1], 1) if peak and off_peak and off_peak[1] > 0 else 0,
        },
        "fare": fare_insights,
        "by_transport_mode": by_transport_mode,
        "distance_distribution": [
            {"bucket_km": r[0], "count": r[1]} for r in dist_buckets
        ],
        "text_insights": text_insights,
    }


@router.get("/stats/scenario-impact")
async def scenario_impact(f: TripFilters = Depends(trip_filters)):
    """What the pedestrianize scenario removes: excluded-trip count + VKT.

    Computed in INCLUSION form (count car trips entering the bbox) on the
    scenario-stripped filters — the exact complement of the exclusion clause
    every other endpoint applies, so `trips_without_scenario - trips_with ==
    excluded_trips` by construction.
    """
    if not f.scenario:
        raise HTTPException(
            status_code=400,
            detail="scenario=pedestrianize with sc_w/sc_s/sc_e/sc_n is required.",
        )
    base = f.model_copy(update={
        "scenario": None, "sc_w": None, "sc_s": None, "sc_e": None, "sc_n": None,
    })
    inclusion = (
        f"transport_mode = {SCENARIO_EXCLUDED_MODE} AND (vehicle_key, trip_id) IN "
        f"{scenario_pair_subquery(f.sc_w, f.sc_s, f.sc_e, f.sc_n)}"
    )
    conn = get_connection()
    row = conn.execute(f"""
        SELECT COUNT(*), COALESCE(SUM(distance_km), 0)
        FROM trips
        {base.where(extra=[inclusion])}
    """).fetchone()
    return {
        "excluded_trips": row[0],
        "excluded_vkt_km": round(row[1], 1),
        "excluded_mode": SCENARIO_EXCLUDED_MODE,
        "bbox": {"w": f.sc_w, "s": f.sc_s, "e": f.sc_e, "n": f.sc_n},
    }


@router.get("/stats/filter-options")
async def filter_options():
    """Return available values for every filter the UI exposes.

    Used by the frontend FilterPanel to populate dropdowns without
    hardcoding city names or simulation_day ranges.

    Phase A (universal forms): also returns `capabilities` (dataset form
    contract) and `modes` (id/label/count with labels from sources.yaml
    mode_map / default PFLOW labels). `vehicle_types` remains as a
    back-compat mirror of source ids — prefer `sources[].source_id`.
    """
    from ..mode_labels import label_for_mode

    conn = get_connection()

    vtypes = [r[0] for r in conn.execute(
        "SELECT DISTINCT vehicle_type FROM trips ORDER BY vehicle_type"
    ).fetchall()]

    city_rows = conn.execute("""
        SELECT city, AVG(start_lon) AS lon, AVG(start_lat) AS lat
        FROM trips
        WHERE city IS NOT NULL AND start_lon IS NOT NULL AND start_lat IS NOT NULL
        GROUP BY city
        ORDER BY city
    """).fetchall()
    cities = [r[0] for r in city_rows]
    city_centers = {r[0]: [round(r[1], 4), round(r[2], 4)] for r in city_rows}

    days = [r[0] for r in conn.execute(
        "SELECT DISTINCT simulation_day FROM trips ORDER BY simulation_day"
    ).fetchall()]

    goods_types = [r[0] for r in conn.execute(
        "SELECT DISTINCT goods_type FROM trips WHERE goods_type IS NOT NULL ORDER BY goods_type"
    ).fetchall()]

    # Transport modes present in the dataset, with counts — the FilterPanel
    # renders one chip per entry and needs no second call for the breakdown.
    # Phase C: prefer canonical string trips.mode; fall back to int codes.
    registry_mode_map = _registry_mode_map()
    string_mode_rows = conn.execute("""
        SELECT mode,
               ANY_VALUE(transport_mode) AS mode_code,
               COUNT(*) AS cnt
        FROM trips
        WHERE mode IS NOT NULL
        GROUP BY mode
        ORDER BY mode
    """).fetchall()
    int_mode_rows = conn.execute("""
        SELECT transport_mode, COUNT(*) FROM trips
        WHERE transport_mode IS NOT NULL
        GROUP BY transport_mode ORDER BY transport_mode
    """).fetchall()
    transport_modes = [
        {"mode": int(r[0]), "count": r[1]}
        for r in int_mode_rows
    ]

    if string_mode_rows:
        modes = [
            {
                "id": int(r[1]) if r[1] is not None else None,
                "label": str(r[0]),
                "count": r[2],
            }
            for r in string_mode_rows
        ]
    else:
        modes = [
            {
                "id": int(r[0]),
                "label": label_for_mode(int(r[0]), registry_mode_map),
                "count": r[1],
            }
            for r in int_mode_rows
        ]

    # Sprint B5 — per-source F1 metric availability so the frontend can disable
    # sliders that would silently filter to zero rows. Single grouped query.
    metrics_rows = conn.execute("""
        SELECT
            vehicle_type,
            COUNT(speed_avg_kmh) > 0 AS has_speed,
            COUNT(dwell_minutes) > 0 AS has_dwell,
            COUNT(detour_ratio)  > 0 AS has_detour
        FROM trips
        WHERE vehicle_type IS NOT NULL
        GROUP BY vehicle_type
    """).fetchall()
    metrics_available = {
        r[0]: {"speed": bool(r[1]), "dwell": bool(r[2]), "detour": bool(r[3])}
        for r in metrics_rows
    }

    sources = _source_styles(conn)
    capabilities = _dataset_capabilities(conn, transport_modes, goods_types)
    # TV-19 — schema/discovery/ingest problems for the UI (not console-only).
    registry = inspect_registry(conn)

    return {
        "vehicle_types": vtypes,
        "cities": cities,
        "city_centers": city_centers,
        "simulation_days": days,
        "goods_types": goods_types,
        "transport_modes": transport_modes,
        "modes": modes,
        "capabilities": capabilities,
        "metrics_available": metrics_available,
        "sources": sources,
        "registry": registry,
    }


def _registry_mode_map() -> dict[str, str]:
    """Merged mode_map from sources.yaml (empty when registry absent)."""
    from ..mode_labels import merge_mode_maps
    try:
        sources_file = load_sources_merged(default_sources_path())
    except Exception:
        return {}
    return merge_mode_maps([src.mode_map for src in sources_file.sources.values()])


def _scale_override_from_sources() -> str | None:
    """Optional top-level ``scale:`` from the active sources registry."""
    try:
        sources_file = load_sources_merged(default_sources_path())
    except Exception:
        return None
    return getattr(sources_file, "scale", None)


def _dataset_capabilities(conn, transport_modes: list, goods_types: list) -> dict:
    """Inferred dataset capabilities for form availability (Phase A/C + LOD).

    Lab attr columns stay sparse/nullable — listed in attr_keys only when
    at least one non-null value exists (hide-when-empty posture). No JSON
    attrs migration (Phase C locked decision).

    Simulation scale (TV-16): capabilities.scale ∈ {micro, meso, macro}
    from agent/waypoint estimates, with optional sources.yaml ``scale:``
    override. Macro aligns with mega-sim LOD (#18); mega_sim stays a
    boolean alias when scale is macro.
    """
    from ..db import get_schema_version
    from ..lod import lod_capability_block

    wp_count = conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0]
    trip_count = conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
    try:
        agent_count = conn.execute(
            "SELECT COUNT(DISTINCT vehicle_key) FROM trips"
        ).fetchone()[0]
    except Exception:
        agent_count = 0
    try:
        density_count = conn.execute("SELECT COUNT(*) FROM density_hourly").fetchone()[0]
    except Exception:
        density_count = 0
    try:
        string_mode_count = conn.execute(
            "SELECT COUNT(*) FROM trips WHERE mode IS NOT NULL"
        ).fetchone()[0]
    except Exception:
        string_mode_count = 0

    # Sparse lab columns — only advertise when populated.
    lab_cols = (
        "goods_type", "fare_yen", "taxi_id", "cargo_loaded",
        "passenger_in", "is_night_trip", "purpose",
    )
    attr_keys: list[str] = []
    for col in lab_cols:
        try:
            n = conn.execute(
                f"SELECT COUNT({col}) FROM trips WHERE {col} IS NOT NULL"
            ).fetchone()[0]
        except Exception:
            continue
        if n and n > 0:
            attr_keys.append(col)

    has_trips = trip_count > 0
    has_trajectories = wp_count > 0
    has_density_hourly = density_count > 0

    # Legs (PFLOW v3 / MATSim sub-trips) — advertise when any non-null leg_id.
    has_legs = False
    try:
        leg_n = conn.execute(
            "SELECT COUNT(leg_id) FROM trips WHERE leg_id IS NOT NULL"
        ).fetchone()[0]
        has_legs = bool(leg_n and leg_n > 0)
    except Exception:
        has_legs = False

    caps = {
        "has_trips": has_trips,
        "has_trajectories": has_trajectories,
        "has_density_hourly": has_density_hourly,
        "has_modes": len(transport_modes) > 0 or string_mode_count > 0,
        "has_legs": has_legs,
        "attr_keys": attr_keys,
        # agent_key is the public name for vehicle_key (physical rename deferred).
        "agent_key_column": "vehicle_key",
        "agent_id_column": "agent_id",
        "schema_version": get_schema_version(conn),
    }
    # Scale LOD (TV-16): micro/meso/macro + recommended forms / fix_its.
    caps.update(
        lod_capability_block(
            agent_count=agent_count or 0,
            trip_count=trip_count or 0,
            waypoint_count=wp_count or 0,
            has_density_hourly=has_density_hourly,
            has_trajectories=has_trajectories,
            has_trips=has_trips,
            scale_override=_scale_override_from_sources(),
        )
    )
    return caps


def _source_styles(conn) -> list[dict]:
    """Rendering hints per source (Phase 2A) — powers SourceLegend and the
    per-source layer split (trails/points/arcs) in MapView.

    Only sources that actually have ingested rows are listed. Degrades to []
    when sources.yaml is absent (Docker standalone mode ships only the DB).
    """
    try:
        sources_file = load_sources_merged(default_sources_path())
    except Exception:
        return []

    ingested = {r[0] for r in conn.execute(
        "SELECT DISTINCT source_id FROM trips WHERE source_id IS NOT NULL"
    ).fetchall()}
    with_waypoints = {r[0] for r in conn.execute(
        "SELECT DISTINCT source_id FROM waypoints WHERE source_id IS NOT NULL"
    ).fetchall()}

    # Upload sources can edit render.mode/color via PATCH (TV-30).
    try:
        from backend.config import uploads_registry_path
        from backend.upload_config import load_uploads_registry_ids
        upload_ids = load_uploads_registry_ids(uploads_registry_path())
    except Exception:
        upload_ids = set()

    styles = []
    covered = set()
    for key, src in sources_file.sources.items():
        if src.source_id not in ingested:
            continue
        covered.add(src.source_id)
        render = src.render
        styles.append({
            "source_key": key,
            "source_id": src.source_id,
            "label": src.label,
            "mode": render.mode if render else "trails",
            "color": list(render.color) if render and render.color else None,
            "has_waypoints": src.source_id in with_waypoints,
            "editable": src.source_id in upload_ids or key in upload_ids,
        })
    # Misconfiguration guard: ingested fleets with no registry entry render
    # with wrong labels/colors/modes (e.g. serving gufm.duckdb while
    # PFLOW_VIZ_SOURCES still points at the demo registry). Loud once per
    # process — the frontend degrades silently otherwise.
    uncovered = ingested - covered
    global _uncovered_warned
    if uncovered and not _uncovered_warned:
        _uncovered_warned = True
        print(
            f"[WARN] /api/stats/filter-options: ingested source_id(s) "
            f"{sorted(uncovered)} have no entry in the sources registry "
            f"({default_sources_path()}). Check PFLOW_VIZ_SOURCES — the map "
            f"will show these fleets without labels, colors, or render modes."
        )
    return styles


_uncovered_warned = False
