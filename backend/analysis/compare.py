"""Fleet comparison (A/B) — fleet-comparison change.

Compares two fleets (sources) under otherwise-identical filters: fleet
summaries, mode-share deltas, hourly departure distributions, a shared-edge
distance histogram, and — when vehicle_id sets overlap — a matched-person
trip-count delta analysis (the GUFM-vs-PFLOW ground-truth workflow, where the
same persons appear as gufm:{pid} / pflow:{pid} vehicle_keys with shared
integer vehicle_ids).

Read-only; every query rides the canonical build_trip_filter via
TripFilters.where() exactly like temporal.py / trip_chains.py.
"""

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
    percentage points.
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


def _matched(conn, where_a: str, where_b: str, top_n: int) -> dict | None:
    """Matched-person trip-count delta analysis.

    Per-person trip counts via GROUP BY vehicle_id on each filtered set,
    FULL OUTER JOINed: a person present on one side only counts 0 trips on
    the other. Returns None when no vehicle_id appears in both fleets.
    Delta stats are computed over the UNION of persons (one-side-only
    persons included with 0 on the missing side); matched_persons counts
    only the intersection.
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
