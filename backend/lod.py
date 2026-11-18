"""Simulation-scale LOD policy — micro / meso / macro engine modes.

Canonical public contract: ``capabilities.scale`` ∈ {micro, meso, macro}.

- **micro** — building / block / event / evacuation: fine trails + agents;
  short windows; do **not** force arcs+pulse when N is small.
- **meso** — mid-scale ABM (classic PFLOW city packs): trails default.
- **macro** — city / region / nation: aggregate-first (OD arcs + pulse);
  trails sampled only. Aligns with the ≫1M-agent mega-sim LOD thresholds
  from #18; ``mega_sim`` remains a boolean alias when scale is macro.

Auto-detect from agent/waypoint estimates; ``sources.yaml`` top-level
``scale:`` overrides. Accepts legacy aliases ``mega``→macro and
``standard``→meso on override / wire.
"""

from __future__ import annotations

from typing import Any, Literal

# ── Canonical scale labels ───────────────────────────────────────────
SCALE_MICRO = "micro"
SCALE_MESO = "meso"
SCALE_MACRO = "macro"
SimScale = Literal["micro", "meso", "macro"]
CANONICAL_SCALES: frozenset[str] = frozenset({SCALE_MICRO, SCALE_MESO, SCALE_MACRO})

# Override / wire aliases (not emitted as capabilities.scale).
SCALE_ALIASES: dict[str, str] = {
    "mega": SCALE_MACRO,
    "standard": SCALE_MESO,
}

# Macro (= mega-sim) primary trigger: ~1M unique agents (survey / preferences).
MEGA_AGENT_THRESHOLD = 1_000_000
# Macro secondary trigger: raw waypoint rows that blow past trail budgets.
MEGA_WAYPOINT_THRESHOLD = 10_000_000

# Micro auto-detect upper bounds (exclusive). Evacuation / event / block sims
# sit well below these; mid-city ABMs land in meso.
MICRO_AGENT_MAX = 10_000
MICRO_WAYPOINT_MAX = 1_000_000

# Architecture render budget (ARCHITECTURE.md) — FE samples ≤500; API allows
# more for tooling, but macro responses clamp to this cap.
TRAJECTORY_RENDER_CAP = 500
# Absolute API max (non-macro) — matches existing Query(le=5000).
TRAJECTORY_API_MAX = 5000

# Default ingest downsample when operators opt into macro-friendly loads.
DEFAULT_MAX_WAYPOINTS_PER_TRIP = 64

AGGREGATES_FIXIT = "python -m backend.ingest --aggregates-only"
WAYPOINT_SAMPLE_FIXIT = (
    "python -m backend.ingest --max-waypoints-per-trip=64 "
    "(or --waypoint-sample-frac=0.1 / --skip-waypoints)"
)

# Default form sets per scale (UI + capabilities.recommended_default_forms).
DEFAULT_FORMS: dict[str, list[str]] = {
    SCALE_MICRO: ["trails", "agents"],
    SCALE_MESO: ["trails"],
    SCALE_MACRO: ["arcs", "pulse"],
}


def normalize_scale(value: str | None) -> SimScale | None:
    """Map a config/wire label to a canonical scale, or None if empty/unknown."""
    if value is None:
        return None
    raw = str(value).strip().lower()
    if not raw:
        return None
    if raw in CANONICAL_SCALES:
        return raw  # type: ignore[return-value]
    aliased = SCALE_ALIASES.get(raw)
    if aliased in CANONICAL_SCALES:
        return aliased  # type: ignore[return-value]
    raise ValueError(
        f"Unknown simulation scale {value!r}; expected one of "
        f"{sorted(CANONICAL_SCALES)} (aliases: {sorted(SCALE_ALIASES)})"
    )


def is_mega_sim(
    agent_count: int,
    waypoint_count: int,
    *,
    agent_threshold: int | None = None,
    waypoint_threshold: int | None = None,
) -> bool:
    """True when either estimate crosses the macro / mega-sim threshold."""
    # Read module constants at call time so tests can monkeypatch thresholds.
    ath = MEGA_AGENT_THRESHOLD if agent_threshold is None else agent_threshold
    wth = MEGA_WAYPOINT_THRESHOLD if waypoint_threshold is None else waypoint_threshold
    return (
        int(agent_count) >= int(ath)
        or int(waypoint_count) >= int(wth)
    )


def is_micro_scale(
    agent_count: int,
    waypoint_count: int,
    *,
    agent_max: int | None = None,
    waypoint_max: int | None = None,
) -> bool:
    """True when both estimates sit under the micro upper bounds."""
    amax = MICRO_AGENT_MAX if agent_max is None else agent_max
    wmax = MICRO_WAYPOINT_MAX if waypoint_max is None else waypoint_max
    return int(agent_count) < int(amax) and int(waypoint_count) < int(wmax)


def detect_scale(
    agent_count: int,
    waypoint_count: int,
    *,
    override: str | None = None,
    agent_threshold: int | None = None,
    waypoint_threshold: int | None = None,
    micro_agent_max: int | None = None,
    micro_waypoint_max: int | None = None,
) -> tuple[SimScale, str]:
    """Return ``(canonical_scale, source)`` where source is ``config``|``auto``.

    Override wins when set (after alias normalization). Otherwise macro if
    mega thresholds hit, else micro if under micro caps, else meso.
    """
    forced = normalize_scale(override)
    if forced is not None:
        return forced, "config"

    if is_mega_sim(
        agent_count,
        waypoint_count,
        agent_threshold=agent_threshold,
        waypoint_threshold=waypoint_threshold,
    ):
        return SCALE_MACRO, "auto"

    if is_micro_scale(
        agent_count,
        waypoint_count,
        agent_max=micro_agent_max,
        waypoint_max=micro_waypoint_max,
    ):
        return SCALE_MICRO, "auto"

    return SCALE_MESO, "auto"


def scale_label(mega: bool) -> str:
    """Back-compat helper — prefer :func:`detect_scale` for new call sites."""
    return SCALE_MACRO if mega else SCALE_MESO


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


def recommended_forms(scale: str) -> list[str]:
    return list(DEFAULT_FORMS.get(normalize_scale(scale) or SCALE_MESO, DEFAULT_FORMS[SCALE_MESO]))


def form_disable_reasons(
    scale: str,
    *,
    has_density_hourly: bool,
    has_trajectories: bool,
    has_trips: bool,
) -> dict[str, str]:
    """Human reasons a form is discouraged / gated at this scale.

    Empty when the form is available as a default or optional toggle.
    Consumed by capabilities + docs; UI may still allow override.
    """
    s = normalize_scale(scale) or SCALE_MESO
    reasons: dict[str, str] = {}
    if s == SCALE_MACRO:
        if not has_density_hourly:
            reasons["pulse"] = (
                f"Macro scale prefers pulse — build density_hourly: {AGGREGATES_FIXIT}"
            )
        if has_trajectories:
            reasons["trails"] = (
                "Macro scale samples trails only "
                f"(≤{TRAJECTORY_RENDER_CAP}); prefer arcs + aggregates"
            )
        if not has_trips:
            reasons["arcs"] = "Macro OD arcs need trips (or synthesized trips)"
    elif s == SCALE_MICRO:
        # Micro must not look like a mega/macro dataset: arcs+pulse are
        # optional, not required. Soft hints only when data is missing for
        # optional overlays — do not discourage trails.
        if not has_trajectories:
            reasons["trails"] = (
                "Micro trails need waypoint samples — ingest trajectories "
                "for evacuation/event playback"
            )
        if not has_density_hourly:
            reasons["pulse"] = (
                "Pulse is optional at micro scale — build density_hourly "
                f"only if you want hourly density: {AGGREGATES_FIXIT}"
            )
    else:  # meso
        if not has_trajectories and has_trips:
            reasons["trails"] = (
                "No waypoints — use arcs (render.mode: arcs) or ingest trajectories"
            )
        if not has_density_hourly:
            reasons["pulse"] = (
                f"Hourly density not built — run: {AGGREGATES_FIXIT}"
            )
    return reasons


def build_fix_its(
    *,
    mega: bool,
    has_density_hourly: bool,
    has_trajectories: bool,
    has_trips: bool,
    scale: str | None = None,
) -> list[str]:
    """Actionable operator hints when scale or missing aggregates block forms."""
    s = normalize_scale(scale) if scale else (SCALE_MACRO if mega else SCALE_MESO)
    if s is None:
        s = SCALE_MACRO if mega else SCALE_MESO
    tips: list[str] = []
    label = "Macro" if s == SCALE_MACRO else ("Micro" if s == SCALE_MICRO else "Meso")

    if s == SCALE_MACRO and not has_density_hourly:
        tips.append(
            f"{label}-scale pulse needs density_hourly — run: {AGGREGATES_FIXIT}"
        )
    if s == SCALE_MACRO and has_trajectories:
        tips.append(
            f"{label}-scale trails are sampled at query time "
            f"(≤{TRAJECTORY_RENDER_CAP}); prefer trips + aggregates. "
            f"Thin at ingest: {WAYPOINT_SAMPLE_FIXIT}"
        )
    if s == SCALE_MACRO and has_trips and not has_trajectories and not has_density_hourly:
        tips.append(
            f"Trips-only {label.lower()}: enable arcs (render.mode: arcs) and build "
            f"pulse via {AGGREGATES_FIXIT} after loading mesh/link density "
            "or sampled waypoints for density_hourly."
        )
    if s == SCALE_MACRO and not has_trips:
        tips.append(
            f"{label} scale needs trips (or synthesized trips) for OD arcs/filters."
        )
    if s == SCALE_MICRO and not has_trajectories:
        tips.append(
            "Micro-scale trails need waypoints — ingest fine trajectories "
            "for evacuation/event playback (do not skip-waypoints)."
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
    scale_override: str | None = None,
    agent_threshold: int | None = None,
    waypoint_threshold: int | None = None,
    micro_agent_max: int | None = None,
    micro_waypoint_max: int | None = None,
) -> dict[str, Any]:
    """Scale + LOD fields merged into /api/stats/filter-options capabilities."""
    ath = MEGA_AGENT_THRESHOLD if agent_threshold is None else agent_threshold
    wth = MEGA_WAYPOINT_THRESHOLD if waypoint_threshold is None else waypoint_threshold
    amax = MICRO_AGENT_MAX if micro_agent_max is None else micro_agent_max
    wmax = MICRO_WAYPOINT_MAX if micro_waypoint_max is None else micro_waypoint_max

    scale, scale_source = detect_scale(
        agent_count,
        waypoint_count,
        override=scale_override,
        agent_threshold=ath,
        waypoint_threshold=wth,
        micro_agent_max=amax,
        micro_waypoint_max=wmax,
    )
    mega = scale == SCALE_MACRO
    forms = recommended_forms(scale)
    disable = form_disable_reasons(
        scale,
        has_density_hourly=has_density_hourly,
        has_trajectories=has_trajectories,
        has_trips=has_trips,
    )
    fix_its = build_fix_its(
        mega=mega,
        has_density_hourly=has_density_hourly,
        has_trajectories=has_trajectories,
        has_trips=has_trips,
        scale=scale,
    )
    return {
        "agent_count": int(agent_count),
        "trip_count": int(trip_count),
        "waypoint_count": int(waypoint_count),
        # Canonical contract: micro | meso | macro
        "scale": scale,
        "scale_source": scale_source,
        # Compat with #18 wire + FE isMegaSim()
        "mega_sim": mega,
        "recommended_default_forms": forms,
        "trails_default": scale != SCALE_MACRO,
        "form_defaults": {
            "trails": scale != SCALE_MACRO,
            "arcs": scale == SCALE_MACRO,
            "pulse": scale == SCALE_MACRO,
            "agents": scale == SCALE_MICRO,
        },
        "form_disable_reasons": disable,
        "lod": {
            "agent_threshold": int(ath),
            "waypoint_threshold": int(wth),
            "micro_agent_max": int(amax),
            "micro_waypoint_max": int(wmax),
            "trajectory_sample_cap": trajectory_sample_cap(mega),
            "auto_forms": ["arcs", "pulse"] if mega else [],
            "trails_override_allowed": True,
            "aggregate_first": mega,
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
