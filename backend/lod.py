"""Mega-sim LOD policy — scale thresholds, capability flags, ingest/query caps.

Survey §5–6 / preferences: when agent or waypoint estimates exceed the mega
threshold, default UX is arcs + pulse (hide trails); user may override.
Prefer trips + density_hourly / link aggregates over full trail dumps.
"""

from __future__ import annotations

from typing import Any

# Primary trigger: ~1M unique agents (survey / preferences).
MEGA_AGENT_THRESHOLD = 1_000_000
# Secondary trigger: raw waypoint rows that blow past trail-render budgets.
MEGA_WAYPOINT_THRESHOLD = 10_000_000

# Architecture render budget (ARCHITECTURE.md) — FE samples ≤500; API allows
# more for tooling, but mega-sim responses clamp to this cap.
TRAJECTORY_RENDER_CAP = 500
# Absolute API max (non-mega) — matches existing Query(le=5000).
TRAJECTORY_API_MAX = 5000

# Default ingest downsample when operators opt into mega-friendly loads.
DEFAULT_MAX_WAYPOINTS_PER_TRIP = 64

AGGREGATES_FIXIT = "python -m backend.ingest --aggregates-only"
WAYPOINT_SAMPLE_FIXIT = (
    "python -m backend.ingest --max-waypoints-per-trip=64 "
    "(or --waypoint-sample-frac=0.1 / --skip-waypoints)"
)


def is_mega_sim(
    agent_count: int,
    waypoint_count: int,
    *,
    agent_threshold: int | None = None,
    waypoint_threshold: int | None = None,
) -> bool:
    """True when either scale estimate crosses the mega threshold."""
    # Read module constants at call time so tests can monkeypatch thresholds.
    ath = MEGA_AGENT_THRESHOLD if agent_threshold is None else agent_threshold
    wth = MEGA_WAYPOINT_THRESHOLD if waypoint_threshold is None else waypoint_threshold
    return (
        int(agent_count) >= int(ath)
        or int(waypoint_count) >= int(wth)
    )


def scale_label(mega: bool) -> str:
    return "mega" if mega else "standard"


def trajectory_sample_cap(mega: bool) -> int:
    """Max trajectories returned by sample/bbox APIs for this scale."""
    return TRAJECTORY_RENDER_CAP if mega else TRAJECTORY_API_MAX


def clamp_trajectory_sample_n(n: int, mega: bool) -> tuple[int, bool]:
    """Return (clamped_n, was_capped)."""
    cap = trajectory_sample_cap(mega)
    n_int = max(1, int(n))
    if n_int > cap:
        return cap, True
    return n_int, False


def build_fix_its(
    *,
    mega: bool,
    has_density_hourly: bool,
    has_trajectories: bool,
    has_trips: bool,
) -> list[str]:
    """Actionable operator hints when scale or missing aggregates block forms."""
    tips: list[str] = []
    if mega and not has_density_hourly:
        tips.append(
            f"Mega-sim pulse needs density_hourly — run: {AGGREGATES_FIXIT}"
        )
    if mega and has_trajectories:
        tips.append(
            "Mega-sim trails are sampled at query time "
            f"(≤{TRAJECTORY_RENDER_CAP}); prefer trips + aggregates. "
            f"Thin at ingest: {WAYPOINT_SAMPLE_FIXIT}"
        )
    if mega and has_trips and not has_trajectories and not has_density_hourly:
        tips.append(
            "Trips-only mega-sim: enable arcs (render.mode: arcs) and build "
            f"pulse via {AGGREGATES_FIXIT} after loading mesh/link density "
            "or sampled waypoints for density_hourly."
        )
    if mega and not has_trips:
        tips.append(
            "Mega-sim needs trips (or synthesized trips) for OD arcs/filters."
        )
    return tips


def lod_capability_block(
    *,
    agent_count: int,
    trip_count: int,
    waypoint_count: int,
    has_density_hourly: bool,
    has_trajectories: bool,
    has_trips: bool,
    agent_threshold: int | None = None,
    waypoint_threshold: int | None = None,
) -> dict[str, Any]:
    """Scale + LOD fields merged into /api/stats/filter-options capabilities."""
    ath = MEGA_AGENT_THRESHOLD if agent_threshold is None else agent_threshold
    wth = MEGA_WAYPOINT_THRESHOLD if waypoint_threshold is None else waypoint_threshold
    mega = is_mega_sim(
        agent_count,
        waypoint_count,
        agent_threshold=ath,
        waypoint_threshold=wth,
    )
    fix_its = build_fix_its(
        mega=mega,
        has_density_hourly=has_density_hourly,
        has_trajectories=has_trajectories,
        has_trips=has_trips,
    )
    return {
        "agent_count": int(agent_count),
        "trip_count": int(trip_count),
        "waypoint_count": int(waypoint_count),
        "scale": scale_label(mega),
        "mega_sim": mega,
        # Default forms when mega: arcs + pulse; trails stay available via override.
        "recommended_default_forms": ["arcs", "pulse"] if mega else ["trails"],
        "trails_default": not mega,
        "lod": {
            "agent_threshold": int(ath),
            "waypoint_threshold": int(wth),
            "trajectory_sample_cap": trajectory_sample_cap(mega),
            "auto_forms": ["arcs", "pulse"] if mega else [],
            "trails_override_allowed": True,
        },
        "fix_its": fix_its,
    }


def downsample_waypoints_sql(
    select_clause: str,
    table_expr: str,
    columns_list: str,
    *,
    max_waypoints_per_trip: int | None = None,
    sample_frac: float | None = None,
) -> str:
    """Build INSERT…SELECT SQL that optionally downsamples waypoints.

    Sampling is applied after the column map so vehicle_key / trip_id /
    unix_time_ms aliases exist. Even spacing keeps path shape when capping
    per trip; sample_frac thins randomly across all rows.
    """
    if max_waypoints_per_trip is None and sample_frac is None:
        return f"""
        INSERT INTO waypoints ({columns_list})
        SELECT
            {select_clause}
        FROM {table_expr}
        """

    where_parts: list[str] = []
    if sample_frac is not None:
        frac = float(sample_frac)
        if not 0.0 < frac <= 1.0:
            raise ValueError("sample_frac must be in (0, 1]")
        # Deterministic-ish thin via hash of key+time so re-ingests are stable.
        where_parts.append(
            f"(abs(hash(CONCAT(CAST(vehicle_key AS VARCHAR), ':', "
            f"CAST(trip_id AS VARCHAR), ':', CAST(unix_time_ms AS VARCHAR)))) "
            f"% 1000000) < {int(frac * 1_000_000)}"
        )

    if max_waypoints_per_trip is not None:
        cap = max(1, int(max_waypoints_per_trip))
        # Keep roughly evenly spaced points: stride = ceil(n / cap).
        where_parts.append(
            f"((__wp_rn - 1) % GREATEST(1, CAST(CEIL(__wp_n::DOUBLE / {cap}) AS BIGINT))) = 0"
        )

    where_sql = " AND ".join(where_parts) if where_parts else "TRUE"
    return f"""
        INSERT INTO waypoints ({columns_list})
        SELECT {columns_list}
        FROM (
            SELECT
                {select_clause},
                ROW_NUMBER() OVER (
                    PARTITION BY vehicle_key, trip_id
                    ORDER BY unix_time_ms
                ) AS __wp_rn,
                COUNT(*) OVER (
                    PARTITION BY vehicle_key, trip_id
                ) AS __wp_n
            FROM {table_expr}
        ) sampled
        WHERE {where_sql}
        """
