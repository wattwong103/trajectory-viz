"""
Temporal analysis — hourly departure distributions and peak detection.

Queries the trips table grouped by hour to produce histograms suitable
for Recharts BarChart rendering in the frontend.
"""

from fastapi import APIRouter, Query
from typing import Optional
from ..db import get_connection, build_trip_filter
import traceback

router = APIRouter()


def _safe_query(conn, sql):
    """Execute query with graceful empty-table handling."""
    try:
        return conn.execute(sql).fetchall()
    except Exception as e:
        print(f"[temporal] Query error: {e}")
        return []


@router.get("/analysis/temporal/departures")
async def hourly_departures(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Hourly trip departure distribution (0-23h histogram).

    Returns data shaped for Recharts:
    [{"hour": 0, "truck": 1234, "taxi": 5678, "total": 6912}, ...]
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

    rows = _safe_query(conn, f"""
        SELECT dep_hour, vehicle_type, COUNT(*) as cnt
        FROM trips
        {where}
        GROUP BY dep_hour, vehicle_type
        ORDER BY dep_hour
    """)

    # Pivot into per-hour records with truck/taxi columns
    hours: dict[int, dict] = {}
    for h in range(24):
        hours[h] = {"hour": h, "truck": 0, "taxi": 0, "total": 0}

    for dep_hour, vtype, cnt in rows:
        if dep_hour is not None and 0 <= dep_hour <= 23:
            hours[dep_hour][vtype] = cnt
            hours[dep_hour]["total"] += cnt

    return list(hours.values())


@router.get("/analysis/temporal/peaks")
async def detect_peaks(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Detect peak hours (hours where volume > mean + 0.5*std).

    Simple statistical peak detection — no scipy dependency needed.
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
        SELECT dep_hour, COUNT(*) as cnt
        FROM trips
        {where}
        GROUP BY dep_hour
        ORDER BY dep_hour
    """).fetchall()

    if not rows:
        return {"peaks": [], "mean": 0, "std": 0}

    counts = [r[1] for r in rows]
    n = len(counts)
    mean = sum(counts) / n
    variance = sum((c - mean) ** 2 for c in counts) / n
    std = variance ** 0.5
    threshold = mean + 0.5 * std

    peaks = [
        {"hour": rows[i][0], "count": rows[i][1]}
        for i in range(n)
        if rows[i][1] > threshold
    ]

    return {
        "peaks": peaks,
        "mean": round(mean, 1),
        "std": round(std, 1),
        "threshold": round(threshold, 1),
    }


@router.get("/analysis/temporal/duration")
async def trip_duration_distribution(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    bin_minutes: int = Query(10, ge=1, le=60),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Trip distance distribution binned by distance_km.

    Returns histogram data for Recharts.
    """
    conn = get_connection()

    extra = ["distance_km IS NOT NULL", "distance_km > 0"]
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra)

    rows = conn.execute(f"""
        SELECT
            FLOOR(distance_km / {bin_minutes}) * {bin_minutes} AS dist_bin,
            COUNT(*) AS cnt,
            vehicle_type
        FROM trips
        {where}
        GROUP BY dist_bin, vehicle_type
        ORDER BY dist_bin
    """).fetchall()

    return [
        {"distance_km": r[0], "count": r[1], "vehicle_type": r[2]}
        for r in rows
    ]


# F1 derived-metric distributions (Phase 2 Step 2.2b).
# `metric` selects one of the three derived columns; the SQL bins on equal
# widths between (min, max) of the populated rows. NULL-valued rows (e.g.
# detour_ratio NULL for very-short trips, speed_avg_kmh NULL for trips without
# waypoints) are excluded — they aren't meaningful histogram entries.
_F1_METRIC_COLUMNS = {
    "speed_avg_kmh": "km/h",
    "dwell_minutes": "minutes",
    "detour_ratio":  "ratio",
}


@router.get("/analysis/temporal/metrics-distribution")
async def metrics_distribution(
    metric: str = Query(
        "speed_avg_kmh",
        pattern="^(speed_avg_kmh|dwell_minutes|detour_ratio)$",
        description="Which F1 metric to histogram.",
    ),
    bins: int = Query(20, ge=5, le=100,
                      description="Number of equal-width histogram bins."),
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
):
    """Histogram of one F1 derived metric (speed_avg_kmh | dwell_minutes | detour_ratio).

    Returns Recharts-ready bins:
      [{ "bin_lower": <float>, "bin_upper": <float>, "count": <int> }, ...]
    plus min/max summary stats for axis labels.
    """
    conn = get_connection()

    # Build the per-source filter (city, sim_day, goods, hour); we add the
    # `metric IS NOT NULL` guard so the bin range is computed from real data.
    extra: list[str] = [f"{metric} IS NOT NULL"]
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra)

    # Range query first — needed to compute equal-width bins.
    bounds = conn.execute(f"""
        SELECT MIN({metric}) AS lo, MAX({metric}) AS hi, COUNT(*) AS n
        FROM trips {where}
    """).fetchone()
    lo, hi, total = bounds
    if total == 0 or lo is None or hi is None or lo == hi:
        return {
            "metric": metric,
            "unit": _F1_METRIC_COLUMNS[metric],
            "bin_count": 0,
            "min": lo,
            "max": hi,
            "total_rows": total,
            "histogram": [],
        }

    # Histogram via FLOOR((value - lo) / bin_width). Edge case: the max value
    # would land in bin == bins (one past the last), so we clip with LEAST.
    bin_width = (hi - lo) / bins
    rows = conn.execute(f"""
        SELECT
            LEAST(
                CAST(FLOOR(({metric} - {lo}) / {bin_width}) AS INTEGER),
                {bins - 1}
            ) AS bin_idx,
            COUNT(*) AS cnt
        FROM trips
        {where}
        GROUP BY bin_idx
        ORDER BY bin_idx
    """).fetchall()

    # Densify: include zero-count bins so the chart x-axis is continuous.
    by_idx = {int(r[0]): int(r[1]) for r in rows}
    histogram = [
        {
            "bin_lower": lo + i * bin_width,
            "bin_upper": lo + (i + 1) * bin_width,
            "count":     by_idx.get(i, 0),
        }
        for i in range(bins)
    ]
    return {
        "metric": metric,
        "unit": _F1_METRIC_COLUMNS[metric],
        "bin_count": bins,
        "min": lo,
        "max": hi,
        "total_rows": total,
        "histogram": histogram,
    }
