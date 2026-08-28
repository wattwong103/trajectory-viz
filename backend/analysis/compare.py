"""Fleet comparison (A/B) — fleet-comparison change.

Compares two fleets (sources) under otherwise-identical filters: fleet
summaries, mode-share deltas, hourly departure distributions, a shared-edge
distance histogram, and — when vehicle_id sets overlap — a matched-person
trip-count delta analysis (the GUFM-vs-PFLOW ground-truth workflow, where the
same persons appear as gufm:{pid} / pflow:{pid} vehicle_keys with shared
integer vehicle_ids).

Significance: each mode share carries a two-proportion z-test p-value (is
the share shift larger than sampling noise?), and the matched-person deltas
carry a Wilcoxon signed-rank test over per-person trip counts (symmetric,
robust to the heavy tails typical of ABM outputs). Both are descriptive
aids for exploration — not a substitute for replication.

Read-only; every query rides the canonical build_trip_filter via
TripFilters.where() exactly like temporal.py / trip_chains.py.
"""

import math
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_connection
from ..filters import TripFilters, trip_filters

router = APIRouter()

# Distance histogram: 20 equal-width buckets spanning [0, combined max] where
# the combined max is MAX(distance_km) across BOTH filtered fleets (shared
# edges, so the overlay aligns). Trips with NULL distance are excluded; a trip
# at exactly the max lands in the last bucket (LEAST clip). Empty both sides
# → [] (no edges can be derived).
DISTANCE_HIST_BUCKETS = 20


def _fleet_summary(conn, where: str) -> dict:
    """Trips/vehicles/VKT/distance stats/time range for one filtered fleet.

    Empty-safe: counts are 0 and the distance/time aggregates are None when
    the fleet has no rows (averaging nothing is meaningless — the frontend
    renders '—' for nulls).
    """
    row = conn.execute(f"""
        SELECT
            COUNT(*)                        AS trips,
            COUNT(DISTINCT vehicle_key)     AS vehicles,
            SUM(distance_km)                AS vkt_km,
            AVG(distance_km)                AS avg_distance_km,
            MEDIAN(distance_km)             AS median_distance_km,
            MAX(distance_km)                AS max_distance_km,
            MIN(starttime)                  AS min_starttime,
            MAX(starttime)                  AS max_starttime
        FROM trips
        {where}
    """).fetchone()
    return {
        "trips": int(row[0]),
        "vehicles": int(row[1]),
        "vkt_km": round(float(row[2]), 3) if row[2] is not None else None,
        "avg_distance_km": round(float(row[3]), 3) if row[3] is not None else None,
        "median_distance_km": round(float(row[4]), 3) if row[4] is not None else None,
        "max_distance_km": round(float(row[5]), 3) if row[5] is not None else None,
        "min_starttime": int(row[6]) if row[6] is not None else None,
        "max_starttime": int(row[7]) if row[7] is not None else None,
    }


def _mode_counts(conn, where: str) -> dict[int, int]:
    """transport_mode → trip count for one fleet (NULL modes excluded)."""
    rows = conn.execute(f"""
        SELECT transport_mode, COUNT(*)
        FROM trips
        {where}
        GROUP BY transport_mode
    """).fetchall()
    return {int(r[0]): int(r[1]) for r in rows if r[0] is not None}


def _mode_shares(a: dict[int, int], b: dict[int, int]) -> list[dict]:
    """Unified per-mode share table over the union of modes.

    Shares are normalized within each fleet over its non-NULL-mode trips (so
    each fleet's shares sum to 1). delta_pp = (share_b - share_a) in
    percentage points. p_value = two-proportion z-test on the raw counts —
    is the share shift distinguishable from sampling noise.
    """
    total_a = sum(a.values())
    total_b = sum(b.values())
    out = []
    for mode in sorted(set(a) | set(b)):
        share_a = a.get(mode, 0) / total_a if total_a else 0.0
        share_b = b.get(mode, 0) / total_b if total_b else 0.0
        out.append({
            "mode": mode,
            "a_trips": a.get(mode, 0),
            "a_share": round(share_a, 4),
            "b_trips": b.get(mode, 0),
            "b_share": round(share_b, 4),
            "delta_pp": round((share_b - share_a) * 100, 2),
            "p_value": _two_proportion_pvalue(
                a.get(mode, 0), total_a, b.get(mode, 0), total_b
            ),
        })
    return out


def _hourly(conn, where: str) -> tuple[dict[int, int], int]:
    """dep_hour → trip count plus the out-of-range (not 0-23 / NULL) count.

    The 0-23 guard is load-bearing: real DBs carry stray dep_hour values
    (the GUFM DB has a dep_hour=-2 trip) that must not corrupt the buckets.
    """
    rows = conn.execute(f"""
        SELECT dep_hour, COUNT(*)
        FROM trips
        {where}
        GROUP BY dep_hour
    """).fetchall()
    buckets: dict[int, int] = {}
    out_of_range = 0
    for dep_hour, cnt in rows:
        if dep_hour is not None and 0 <= int(dep_hour) <= 23:
            buckets[int(dep_hour)] = int(cnt)
        else:
            out_of_range += int(cnt)
    return buckets, out_of_range


def _distance_hist(conn, where_a: str, where_b: str) -> list[dict]:
    """20-bucket distance histogram with shared edges (see module docstring)."""
    not_null = ["distance_km IS NOT NULL"]
    max_a = conn.execute(
        f"SELECT MAX(distance_km) FROM trips "
        f"{_and(where_a, not_null)}"
    ).fetchone()[0]
    max_b = conn.execute(
        f"SELECT MAX(distance_km) FROM trips "
        f"{_and(where_b, not_null)}"
    ).fetchone()[0]
    combined = max((m for m in (max_a, max_b) if m is not None), default=None)
    if combined is None or combined <= 0:
        return []

    width = float(combined) / DISTANCE_HIST_BUCKETS

    def _side(where: str) -> dict[int, int]:
        rows = conn.execute(f"""
            SELECT
                LEAST(
                    CAST(FLOOR(distance_km / {width}) AS INTEGER),
                    {DISTANCE_HIST_BUCKETS - 1}
                ) AS bucket,
                COUNT(*) AS cnt
            FROM trips
            {_and(where, not_null)}
            GROUP BY bucket
        """).fetchall()
        return {int(r[0]): int(r[1]) for r in rows}

    a, b = _side(where_a), _side(where_b)
    return [
        {
            "bucket_lo": round(i * width, 3),
            "bucket_hi": round((i + 1) * width, 3),
            "a": a.get(i, 0),
            "b": b.get(i, 0),
        }
        for i in range(DISTANCE_HIST_BUCKETS)
    ]


def _and(where: str, extra: list[str]) -> str:
    """Append extra conditions to a WHERE clause that may be empty."""
    if not extra:
        return where
    clause = " AND ".join(extra)
    if where:
        return f"{where} AND {clause}"
    return f"WHERE {clause}"


def _two_proportion_pvalue(x_a: int, n_a: int, x_b: int, n_b: int) -> float | None:
    """Two-sided two-proportion z-test p-value (pooled variance).

    H0: share_a == share_b. Returns None when either side has no
    non-NULL-mode trips (the statistic is undefined).
    """
    if n_a == 0 or n_b == 0:
        return None
    p_pool = (x_a + x_b) / (n_a + n_b)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n_a + 1 / n_b))
    if se == 0:
        return 1.0
    z = ((x_b / n_b) - (x_a / n_a)) / se
    # Two-sided: P(|Z| >= |z|) = erfc(|z| / sqrt(2)).
    return round(math.erfc(abs(z) / math.sqrt(2)), 4)


def _wilcoxon_signed_rank(pairs: list[tuple[int, int]]) -> dict | None:
    """Wilcoxon signed-rank test over per-person (trips_a, trips_b) pairs.

    Lazy scipy import (transitively guaranteed by scikit-learn, but not at
        module load). Nonparametric — appropriate for skewed ABM count data.
    Returns None when the test is undefined (too few non-zero differences).
    """
    if len(pairs) < 8:
        return None
    try:
        from scipy.stats import wilcoxon

        result = wilcoxon([b for _, b in pairs], [a for a, _ in pairs])
    except (ImportError, ValueError):
        # ValueError: all differences are zero (identical fleets) — no test.
        return None
    return {
        "statistic": round(float(result.statistic), 1),
        "p_value": round(float(result.pvalue), 6),
        "n_pairs": len(pairs),
    }


# Matched-person alignment: trips of a shared person are paired by rank
# (k-th earliest departure on each side) and scored 0..1 —
#   score = 1 − ½·(time_pen + dist_pen)
# where time_pen = min(|Δstart|, TIME_PENALTY_CAP_S)/TIME_PENALTY_CAP_S and
# dist_pen = |d_a−d_b| / max(d_a, d_b, DIST_PEN_FLOOR_KM) (0 when either
# distance is NULL). Unpaired surplus trips are NOT penalized here — the
# trip-count delta already reports that; the score measures how alike the
# trips a person does run actually are.
TIME_PENALTY_CAP_S = 4 * 3600
DIST_PEN_FLOOR_KM = 1.0
ALIGNMENT_HIST_BUCKETS = 10


def _matched(conn, where_a: str, where_b: str, top_n: int) -> dict | None:
    """Matched-person trip-count delta + per-trip alignment analysis.

    Per-person trip counts via GROUP BY vehicle_id on each filtered set,
    FULL OUTER JOINed: a person present on one side only counts 0 trips on
    the other. Returns None when no vehicle_id appears in both fleets.
    Delta stats are computed over the UNION of persons (one-side-only
    persons included with 0 on the missing side); matched_persons counts
    only the intersection. Alignment scores cover the intersection's
    rank-paired trips only (see ALIGNMENT comment above).
    """
    joined = f"""
        WITH pa AS (
            SELECT vehicle_id, COUNT(*) AS n FROM trips {where_a} GROUP BY vehicle_id
        ),
        pb AS (
            SELECT vehicle_id, COUNT(*) AS n FROM trips {where_b} GROUP BY vehicle_id
        )
        SELECT
            COALESCE(pa.vehicle_id, pb.vehicle_id) AS vehicle_id,
            COALESCE(pa.n, 0) AS trips_a,
            COALESCE(pb.n, 0) AS trips_b
        FROM pa FULL OUTER JOIN pb ON pa.vehicle_id = pb.vehicle_id
    """
    stats = conn.execute(f"""
        SELECT
            COUNT(*) FILTER (WHERE trips_a > 0 AND trips_b > 0) AS matched_persons,
            AVG(trips_b - trips_a)                              AS mean_delta,
            MEDIAN(trips_b - trips_a)                           AS median_delta,
            QUANTILE_CONT(ABS(trips_b - trips_a), 0.9)          AS p90_abs_delta,
            MAX(ABS(trips_b - trips_a))                         AS max_abs_delta
        FROM ({joined})
    """).fetchone()
    matched_persons = int(stats[0])
    if matched_persons == 0:
        return None

    pair_rows = conn.execute(f"""
        SELECT trips_a, trips_b FROM ({joined})
    """).fetchall()

    top_rows = conn.execute(f"""
        SELECT vehicle_id, trips_a, trips_b, trips_b - trips_a AS delta
        FROM ({joined})
        ORDER BY ABS(trips_b - trips_a) DESC, vehicle_id
        LIMIT {int(top_n)}
    """).fetchall()

    return {
        "matched_persons": matched_persons,
        "delta": {
            "mean": round(float(stats[1]), 3) if stats[1] is not None else None,
            "median": round(float(stats[2]), 3) if stats[2] is not None else None,
            "p90_abs": round(float(stats[3]), 3) if stats[3] is not None else None,
            "max_abs": int(stats[4]) if stats[4] is not None else None,
        },
        "significance": _wilcoxon_signed_rank(
            [(int(r[0]), int(r[1])) for r in pair_rows]
        ),
        "alignment": _alignment(conn, where_a, where_b),
        "top": [
            {
                "vehicle_id": int(r[0]),
                "trips_a": int(r[1]),
                "trips_b": int(r[2]),
                "delta": int(r[3]),
            }
            for r in top_rows
        ],
    }


def _alignment(conn, where_a: str, where_b: str) -> dict:
    """Rank-aligned per-trip similarity for shared persons.

    Both sides are numbered per vehicle by departure time; k-th trips are
    paired and scored (see TIME_PENALTY_CAP_S comment). Persons contribute
    their mean pair score; the response aggregates over persons and keeps a
    10-bucket histogram so the frontend can show the shape, not just the
    average.
    """
    pairs = f"""
        WITH ta AS (
            SELECT vehicle_id, starttime, distance_km,
                   ROW_NUMBER() OVER (
                       PARTITION BY vehicle_id ORDER BY starttime, trip_id
                   ) AS rn
            FROM trips {where_a}
        ),
        tb AS (
            SELECT vehicle_id, starttime, distance_km,
                   ROW_NUMBER() OVER (
                       PARTITION BY vehicle_id ORDER BY starttime, trip_id
                   ) AS rn
            FROM trips
            {_and(where_b, ["vehicle_id IN (SELECT vehicle_id FROM ta)"])}
        )
        SELECT
            ta.vehicle_id,
            ABS(tb.starttime - ta.starttime) AS dt_s,
            ta.distance_km AS dist_a,
            tb.distance_km AS dist_b
        FROM ta JOIN tb ON ta.vehicle_id = tb.vehicle_id AND ta.rn = tb.rn
    """
    scored = f"""
        SELECT
            vehicle_id,
            1.0 - 0.5 * (
                LEAST(dt_s, {TIME_PENALTY_CAP_S}) / {TIME_PENALTY_CAP_S}
                + CASE
                    WHEN dist_a IS NULL OR dist_b IS NULL THEN 0
                    ELSE ABS(dist_a - dist_b)
                         / GREATEST(dist_a, dist_b, {DIST_PEN_FLOOR_KM})
                  END
            ) AS score
        FROM ({pairs})
    """
    per_person = conn.execute(f"""
        SELECT AVG(score) AS person_score FROM ({scored}) GROUP BY vehicle_id
    """).fetchall()
    if not per_person:
        return {"persons": 0, "pairs": 0, "mean": None, "median": None,
                "histogram": []}

    n_pairs = conn.execute(f"SELECT COUNT(*) FROM ({pairs})").fetchone()[0]
    scores = [float(r[0]) for r in per_person]
    width = 1.0 / ALIGNMENT_HIST_BUCKETS
    hist = [0] * ALIGNMENT_HIST_BUCKETS
    for s in scores:
        hist[min(int(s / width), ALIGNMENT_HIST_BUCKETS - 1)] += 1
    return {
        "persons": len(scores),
        "pairs": int(n_pairs),
        "mean": round(sum(scores) / len(scores), 3),
        "median": round(sorted(scores)[len(scores) // 2], 3)
        if len(scores) % 2
        else round((sorted(scores)[len(scores) // 2 - 1]
                    + sorted(scores)[len(scores) // 2]) / 2, 3),
        "histogram": [
            {"lo": round(i * width, 2), "hi": round((i + 1) * width, 2),
             "count": c}
            for i, c in enumerate(hist)
        ],
    }


def compute_comparison(conn, f_a: TripFilters, f_b: TripFilters, top_n: int = 10) -> dict:
    """Self-contained A/B fleet comparison report (see module docstring).

    f_a/f_b share every TripFilters dimension except vehicle_type, which the
    router overrode with source_a/source_b — hours, F1 ranges, transport
    modes, and the scenario clause apply symmetrically to both fleets.
    """
    where_a, where_b = f_a.where(), f_b.where()

    fleet_a = _fleet_summary(conn, where_a)
    fleet_b = _fleet_summary(conn, where_b)

    hourly_a, oor_a = _hourly(conn, where_a)
    hourly_b, oor_b = _hourly(conn, where_b)

    # Matched-person analysis needs rows on both sides.
    matched = None
    if fleet_a["trips"] > 0 and fleet_b["trips"] > 0:
        matched = _matched(conn, where_a, where_b, top_n)
        if matched is not None:
            matched["trips_per_person_a"] = (
                round(fleet_a["trips"] / fleet_a["vehicles"], 3)
                if fleet_a["vehicles"] else None
            )
            matched["trips_per_person_b"] = (
                round(fleet_b["trips"] / fleet_b["vehicles"], 3)
                if fleet_b["vehicles"] else None
            )

    return {
        "source_a": f_a.vehicle_type,
        "source_b": f_b.vehicle_type,
        "fleet_a": fleet_a,
        "fleet_b": fleet_b,
        "mode_shares": _mode_shares(
            _mode_counts(conn, where_a), _mode_counts(conn, where_b)
        ),
        "hourly": [
            {"hour": h, "a": hourly_a.get(h, 0), "b": hourly_b.get(h, 0)}
            for h in range(24)
        ],
        "out_of_range": {"a": oor_a, "b": oor_b},
        "distance_hist": _distance_hist(conn, where_a, where_b),
        "matched": matched,
    }


@router.get("/analysis/compare")
async def compare_fleets(
    source_a: Annotated[str, Query(pattern="^[a-z][a-z0-9_]*$")],
    source_b: Annotated[str, Query(pattern="^[a-z][a-z0-9_]*$")],
    f: Annotated[TripFilters, Depends(trip_filters)],
    top_n: Annotated[int, Query(ge=1, le=50)] = 10,
):
    """A/B comparison of two fleets under identical filters.

    All shared TripFilters params are accepted via the dependency EXCEPT
    vehicle_type, which is overridden by source_a/source_b (a caller-supplied
    vehicle_type is ignored).
    """
    if source_a == source_b:
        raise HTTPException(
            status_code=422,
            detail="source_a and source_b must differ — comparing a fleet to itself is meaningless.",
        )
    f_a = f.model_copy(update={"vehicle_type": source_a})
    f_b = f.model_copy(update={"vehicle_type": source_b})
    return compute_comparison(get_connection(), f_a, f_b, top_n)


# Multi-fleet: 2–4 sources (the A/B endpoint stays the deep pairwise view).
MULTI_MAX_SOURCES = 4


@router.get("/analysis/compare-multi")
async def compare_multi_fleets(
    sources: Annotated[str, Query(
        pattern=r"^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*){1,3}$",
        description="Comma-separated source ids, 2–4 fleets",
    )],
    f: Annotated[TripFilters, Depends(trip_filters)],
):
    """N-way fleet comparison (2–4) under identical shared filters.

    The pairwise endpoint carries the deep machinery (matched persons,
    significance); this one is the at-a-glance N-fleet rollup: per-fleet
    summaries, hourly departure lines, and mode-share columns keyed by
    source_id. Duplicate ids → 422.
    """
    ids = [s for s in sources.split(",")]
    if len(set(ids)) != len(ids):
        raise HTTPException(
            status_code=422,
            detail="Duplicate sources in the comparison set — each fleet must differ.",
        )
    conn = get_connection()
    fleets: list[dict] = []
    hourly_counts: dict[str, dict[int, int]] = {}
    oor: dict[str, int] = {}
    mode_counts: dict[str, dict[int, int]] = {}
    totals: dict[str, int] = {}
    for sid in ids:
        fi = f.model_copy(update={"vehicle_type": sid})
        where = fi.where()
        summary = _fleet_summary(conn, where)
        summary["source_id"] = sid
        fleets.append(summary)
        hourly_counts[sid], oor[sid] = _hourly(conn, where)
        mode_counts[sid] = _mode_counts(conn, where)
        totals[sid] = sum(mode_counts[sid].values())

    modes = sorted(set().union(*(set(c) for c in mode_counts.values())))
    mode_shares = [
        {
            "mode": mode,
            **{
                sid: {
                    "trips": mode_counts[sid].get(mode, 0),
                    "share": round(
                        mode_counts[sid].get(mode, 0) / totals[sid], 4
                    ) if totals[sid] else 0.0,
                }
                for sid in ids
            },
        }
        for mode in modes
    ]
    return {
        "sources": ids,
        "fleets": fleets,
        "hourly": [
            {"hour": h, **{sid: hourly_counts[sid].get(h, 0) for sid in ids}}
            for h in range(24)
        ],
        "out_of_range": oor,
        "mode_shares": mode_shares,
    }


@router.get("/analysis/compare/grid")
async def compare_grid(
    source_a: Annotated[str, Query(pattern="^[a-z][a-z0-9_]*$")],
    source_b: Annotated[str, Query(pattern="^[a-z][a-z0-9_]*$")],
    f: Annotated[TripFilters, Depends(trip_filters)],
    cell_deg: Annotated[float, Query(ge=0.0005, le=1.0)] = 0.005,
):
    """Diverging A/B grid-diff over trip start points.

    An equirectangular grid at cell_deg resolution counts each fleet's
    filtered trips per cell; only cells touched by either fleet return.
    delta > 0 → B-heavier (blue on the map), < 0 → A-heavier. The frontend
    renders it as a scatterplot overlay sized to the cell footprint.
    """
    if source_a == source_b:
        raise HTTPException(
            status_code=422,
            detail="source_a and source_b must differ.",
        )
    conn = get_connection()
    where_a = f.model_copy(update={"vehicle_type": source_a}).where()
    where_b = f.model_copy(update={"vehicle_type": source_b}).where()
    size = float(cell_deg)
    rows = conn.execute(f"""
        WITH pts AS (
            SELECT start_lon, start_lat, 1 AS side_a FROM trips {where_a}
            UNION ALL
            SELECT start_lon, start_lat, 0 AS side_a FROM trips {where_b}
        ),
        cells AS (
            SELECT
                CAST(FLOOR(start_lon / {size}) AS INTEGER) AS ix,
                CAST(FLOOR(start_lat / {size}) AS INTEGER) AS iy,
                SUM(side_a) AS count_a,
                SUM(1 - side_a) AS count_b
            FROM pts
            WHERE start_lon IS NOT NULL AND start_lat IS NOT NULL
            GROUP BY ix, iy
        )
        SELECT
            (ix + 0.5) * {size} AS lon,
            (iy + 0.5) * {size} AS lat,
            count_a, count_b, count_b - count_a AS delta
        FROM cells
        ORDER BY ABS(count_b - count_a) DESC
    """).fetchall()
    return {
        "cell_deg": size,
        "cells": [
            {
                "lon": float(r[0]),
                "lat": float(r[1]),
                "count_a": int(r[2]),
                "count_b": int(r[3]),
                "delta": int(r[4]),
            }
            for r in rows
        ],
    }
