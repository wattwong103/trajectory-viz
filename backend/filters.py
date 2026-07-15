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
from pydantic import BaseModel, Field

from .db import build_trip_filter


class TripFilters(BaseModel):
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
    )
