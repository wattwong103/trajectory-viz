"""
Shared trip-filter dependency — the single source of truth for the filter
dimensions every router accepts.

Before this module, the same (vehicle_type, city, simulation_day, goods_type,
min_hour, max_hour, F1-metric) parameter set was re-declared as Query params
and re-assembled into `extra` lists in seven router files. Adding one filter
dimension meant touching ~20 endpoint signatures. Now:

- `TripFilters` is the Pydantic model carrying every shared dimension.
  POST bodies subclass it (see models.TripQuery).
- `trip_filters()` is the FastAPI function dependency exposing the same
  fields as GET query params (identical names/patterns as before — the
  public API contract is unchanged). Use `f: TripFilters = Depends(trip_filters)`.
- `TripFilters.where()` builds the WHERE clause via db.build_trip_filter —
  the one canonical filter builder (see .claude/rules/trajectory-viz.md).

Adding a new shared filter dimension = one field here + one param in
trip_filters() + threading inside where(). Every migrated endpoint
(stats, trips, temporal, spatial, od-flows, clustering, trip-chains)
accepts it with no further changes.
"""

from typing import Optional

from fastapi import Query
from pydantic import BaseModel, Field, model_validator

from .db import build_trip_filter

# Phase 4 — pedestrianization scenario: the mode excluded from the interior
# zone. Single source of truth; the frontend labels it "car".
SCENARIO_EXCLUDED_MODE = 3


def scenario_pair_subquery(w: float, s: float, e: float, n: float) -> str:
    """(vehicle_key, trip_id) pairs whose trajectories enter the bbox.

    (vehicle_key, trip_id) — NOT bare vehicle_id, which collides across
    source_ids and taxi cities. Mode-agnostic on the waypoints side
    (INVARIANT: waypoint modes are uniform per source; the per-trip mode
    guard belongs on the trips side)."""
    return (
        f"(SELECT vehicle_key, trip_id FROM waypoints "
        f"WHERE lon BETWEEN {float(w)} AND {float(e)} "
        f"AND lat BETWEEN {float(s)} AND {float(n)})"
    )


def scenario_exclusion_clause(w: float, s: float, e: float, n: float) -> str:
    """Trips-side condition implementing the pedestrianize scenario:
    drop car trips whose routed path enters the interior bbox.

    The outer transport_mode guard spares every non-car trip the anti-join.
    Trips-only sources (no waypoints) are conservatively never excluded."""
    return (
        f"NOT (transport_mode = {SCENARIO_EXCLUDED_MODE} "
        f"AND (vehicle_key, trip_id) IN {scenario_pair_subquery(w, s, e, n)})"
    )


class ScenarioFields(BaseModel):
    """Pedestrianization-scenario fields (Phase 4), shared by TripFilters and
    the trajectory POST models. When scenario='pedestrianize' + a bbox, car
    trips entering the bbox are excluded query-time — every endpoint riding
    these fields reflects the scenario, which IS the before/after mechanism."""

    scenario: Optional[str] = Field(None, pattern="^pedestrianize$")
    sc_w: Optional[float] = Field(None, ge=-180, le=180)
    sc_s: Optional[float] = Field(None, ge=-90, le=90)
    sc_e: Optional[float] = Field(None, ge=-180, le=180)
    sc_n: Optional[float] = Field(None, ge=-90, le=90)

    @model_validator(mode="after")
    def _scenario_bbox_all_or_none(self):
        coords = (self.sc_w, self.sc_s, self.sc_e, self.sc_n)
        given = [c is not None for c in coords]
        if self.scenario and not all(given):
            raise ValueError("scenario requires all of sc_w, sc_s, sc_e, sc_n")
        if any(given) and not all(given):
            raise ValueError("sc_w/sc_s/sc_e/sc_n must be provided together")
        if all(given) and (self.sc_w >= self.sc_e or self.sc_s >= self.sc_n):
            raise ValueError("scenario bbox requires sc_w < sc_e and sc_s < sc_n")
        return self

    def scenario_clause(self) -> Optional[str]:
        """The trips-side exclusion condition, or None when scenario unset."""
        if not self.scenario:
            return None
        return scenario_exclusion_clause(self.sc_w, self.sc_s, self.sc_e, self.sc_n)


class TripFilters(ScenarioFields):
    """Every shared trip-filter dimension, with the same validation patterns
    the individual routers used. Patterns are load-bearing: values are
    f-string'd into SQL by build_trip_filter."""

    vehicle_type: Optional[str] = Field(None, pattern="^[a-z][a-z0-9_]*$")
    city: Optional[str] = Field(None, pattern="^[a-z_]+$")
    simulation_day: Optional[int] = Field(None, ge=0)
    goods_type: Optional[str] = Field(None, pattern="^[a-z_]+$")
    # Comma-separated PFLOW transport-mode ids, e.g. "0,3" (0=walk, 1=bike,
    # 2=bus, 3=car, 4=train; 8=taxi). String form (not list[int]) so GET query
    # params and POST bodies share one representation — mirrors the
    # /trajectories/by-vehicle comma-separated vehicle_keys contract.
    # INVARIANT: transport_mode is per-TRIP. It is filtered exclusively from
    # trips.transport_mode; waypoints.transport_mode is display-only garbage
    # for router-generated trajectories (uniform per source).
    transport_modes: Optional[str] = Field(None, pattern=r"^\d{1,2}(,\d{1,2}){0,15}$")
    min_hour: Optional[int] = Field(None, ge=0, le=23)
    max_hour: Optional[int] = Field(None, ge=0, le=23)
    # F1 derived-metric filters (Phase 2 Step 2.2)
    min_speed: Optional[float] = Field(None, ge=0, le=300)
    max_speed: Optional[float] = Field(None, ge=0, le=300)
    max_dwell_minutes: Optional[float] = Field(None, ge=0, le=10080)
    min_detour_ratio: Optional[float] = Field(None, ge=1.0, le=20.0)
    max_detour_ratio: Optional[float] = Field(None, ge=1.0, le=20.0)

    def transport_mode_list(self) -> Optional[list[int]]:
        """Parsed transport_modes, or None when unset. Pattern-validated ints."""
        if not self.transport_modes:
            return None
        return [int(m) for m in self.transport_modes.split(",")]

    def extra_conds(self) -> list[str]:
        """The hour/goods_type conditions every router used to hand-build.

        int()/pattern guards make these injection-safe (same discipline as
        build_trip_filter's own conditions)."""
        extra: list[str] = []
        if self.min_hour is not None:
            extra.append(f"dep_hour >= {int(self.min_hour)}")
        if self.max_hour is not None:
            extra.append(f"dep_hour <= {int(self.max_hour)}")
        if self.goods_type:
            extra.append(f"goods_type = '{self.goods_type}'")
        return extra

    def where(self, extra: Optional[list[str]] = None) -> str:
        """WHERE clause for the trips table ('' or 'WHERE a AND b AND ...').

        `extra` carries endpoint-specific conditions (zone equality,
        IS NOT NULL guards, ...) — validated by the caller."""
        conds = self.extra_conds() + (extra or [])
        sc = self.scenario_clause()
        if sc:
            conds.append(sc)
        return build_trip_filter(
            self.vehicle_type,
            self.city,
            self.simulation_day,
            extra=conds or None,
            transport_modes=self.transport_mode_list(),
            min_speed=self.min_speed,
            max_speed=self.max_speed,
            max_dwell_minutes=self.max_dwell_minutes,
            min_detour_ratio=self.min_detour_ratio,
            max_detour_ratio=self.max_detour_ratio,
        )


def trip_filters(
    vehicle_type: Optional[str] = Query(None, pattern="^[a-z][a-z0-9_]*$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    transport_modes: Optional[str] = Query(
        None, pattern=r"^\d{1,2}(,\d{1,2}){0,15}$",
        description="Comma-separated transport-mode ids, e.g. '0,3' (0=walk 1=bike 2=bus 3=car 4=train 8=taxi)"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
    min_speed: Optional[float] = Query(None, ge=0, le=300,
                                       description="km/h, speed_avg_kmh >= this"),
    max_speed: Optional[float] = Query(None, ge=0, le=300,
                                       description="km/h, speed_avg_kmh <= this"),
    max_dwell_minutes: Optional[float] = Query(None, ge=0, le=10080,
                                               description="minutes; dwell_minutes <= this"),
    min_detour_ratio: Optional[float] = Query(None, ge=1.0, le=20.0),
    max_detour_ratio: Optional[float] = Query(None, ge=1.0, le=20.0),
    scenario: Optional[str] = Query(
        None, pattern="^pedestrianize$",
        description="Query-time scenario: 'pedestrianize' excludes car trips entering the sc_* bbox"),
    sc_w: Optional[float] = Query(None, ge=-180, le=180),
    sc_s: Optional[float] = Query(None, ge=-90, le=90),
    sc_e: Optional[float] = Query(None, ge=-180, le=180),
    sc_n: Optional[float] = Query(None, ge=-90, le=90),
) -> TripFilters:
    """FastAPI dependency: shared filters as GET query params.

    A plain function dependency (not the 0.115+ Annotated-Query model form)
    so it behaves identically across FastAPI versions on all machines."""
    return TripFilters(
        vehicle_type=vehicle_type,
        city=city,
        simulation_day=simulation_day,
        goods_type=goods_type,
        transport_modes=transport_modes,
        min_hour=min_hour,
        max_hour=max_hour,
        min_speed=min_speed,
        max_speed=max_speed,
        max_dwell_minutes=max_dwell_minutes,
        min_detour_ratio=min_detour_ratio,
        max_detour_ratio=max_detour_ratio,
        scenario=scenario,
        sc_w=sc_w,
        sc_s=sc_s,
        sc_e=sc_e,
        sc_n=sc_n,
    )
