"""
Pydantic request/response models for the PFLOW Viz API.

Response formats are designed for direct consumption by DeckGL layers:
- TripsLayer expects {path: [[lon, lat], ...], timestamps: [t1, t2, ...]}
- ScatterplotLayer expects {position: [lon, lat], ...}
"""

from pydantic import BaseModel, Field
from typing import Optional


# ─── Request Models ────────────────────────────────────────────

class TripQuery(BaseModel):
    """Filter criteria for trip queries."""
    vehicle_type: Optional[str] = Field(None, pattern="^[a-z][a-z0-9_]*$")
    min_hour: Optional[int] = Field(None, ge=0, le=23)
    max_hour: Optional[int] = Field(None, ge=0, le=23)
    goods_type: Optional[str] = Field(None, pattern="^[a-z_]+$")
    city: Optional[str] = Field(None, pattern="^[a-z_]+$")
    simulation_day: Optional[int] = Field(None, ge=0)
    # Zone codes are alphanumeric + _/- (e.g. MFS01, PRF47, OSK30). The pattern
    # here is load-bearing: origin_zone/dest_zone are f-string'd into SQL at
    # routers/trips.py, so unvalidated input would be a SQL injection vector.
    origin_zone: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,32}$")
    dest_zone: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,32}$")
    # F1 derived-metric filters (Phase 2 Step 2.2)
    min_speed: Optional[float] = Field(None, ge=0, le=300,
                                       description="km/h, speed_avg_kmh >= this")
    max_speed: Optional[float] = Field(None, ge=0, le=300,
                                       description="km/h, speed_avg_kmh <= this")
    max_dwell_minutes: Optional[float] = Field(None, ge=0, le=10080,
                                               description="minutes; dwell_minutes <= this (heavy-utilization filter)")
    min_detour_ratio: Optional[float] = Field(None, ge=1.0, le=20.0,
                                              description="detour_ratio >= this (1.0 = straight line)")
    max_detour_ratio: Optional[float] = Field(None, ge=1.0, le=20.0,
                                              description="detour_ratio <= this")
    limit: int = Field(1000, ge=1, le=50000)


class BBoxQuery(BaseModel):
    """Bounding box spatial query for trajectories."""
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float
    vehicle_type: Optional[str] = Field(None, pattern="^[a-z][a-z0-9_]*$")
    city: Optional[str] = Field(None, pattern="^[a-z_]+$")
    simulation_day: Optional[int] = Field(None, ge=0)
    min_hour: Optional[int] = None
    max_hour: Optional[int] = None
    limit: int = Field(500, ge=1, le=5000)
    # Phase 2 Step 2.5 — opt into per-segment metrics (link_id/speed/dwell)
    include_segments: bool = False


class PointQuery(BaseModel):
    """Point proximity query — find trajectories near a point."""
    lon: float
    lat: float
    radius_km: float = Field(1.0, ge=0.1, le=50.0)
    vehicle_type: Optional[str] = Field(None, pattern="^[a-z][a-z0-9_]*$")
    city: Optional[str] = Field(None, pattern="^[a-z_]+$")
    simulation_day: Optional[int] = Field(None, ge=0)
    limit: int = Field(200, ge=1, le=5000)
    # Phase 2 Step 2.5 — opt into per-segment metrics
    include_segments: bool = False


# ─── Response Models ───────────────────────────────────────────

class TrajectoryMetadata(BaseModel):
    """Metadata attached to each trajectory for filtering/coloring in the UI."""
    vehicle_type: str
    vehicle_id: int
    vehicle_key: str
    trip_id: int
    goods_type: Optional[str] = None
    vehicle_size: Optional[str] = None
    passenger_in: Optional[str] = None
    fare_yen: Optional[float] = None
    purpose: Optional[int] = None


class TrajectorySegment(BaseModel):
    """Per-segment metrics between two consecutive waypoints (Phase 2 Step 2.5).

    A trajectory of N waypoints has N-1 segments. Returned only when the
    endpoint is called with `include_segments=true` — heavy payload otherwise.
    """
    link_id: Optional[str] = None         # DRM link the second waypoint sits on
    speed_kmh: Optional[float] = None     # haversine distance / dt; None if dt<=0
    dwell_sec: Optional[float] = None     # populated when speed < 1 km/h (idle marker)


class Trajectory(BaseModel):
    """Single trajectory in DeckGL TripsLayer format."""
    id: str                                     # "truck_12345_1" or "taxi_678_2"
    path: list[list[float]]                     # [[lon, lat], [lon, lat], ...]
    timestamps: list[int]                       # seconds from midnight (for 24h animation loop)
    metadata: TrajectoryMetadata
    # Phase 2 Step 2.5 — populated only when include_segments=true on the call.
    # len(segments) == len(path) - 1 when present.
    segments: Optional[list[TrajectorySegment]] = None


class TrajectoryResponse(BaseModel):
    """Paginated trajectory query response."""
    trajectories: list[Trajectory]
    count: int                                  # number returned
    total_matching: Optional[int] = None        # total matching the query (if computed)


class TripPoint(BaseModel):
    """Single trip O-D pair for ScatterplotLayer."""
    vehicle_id: int
    trip_id: int
    starttime: int
    start_lon: float
    start_lat: float
    end_lon: float
    end_lat: float
    vehicle_type: str
    distance_km: Optional[float] = None
    goods_type: Optional[str] = None
    city: Optional[str] = None


class TripResponse(BaseModel):
    """Paginated trip query response."""
    trips: list[TripPoint]
    count: int
    total_matching: Optional[int] = None


class StatsResponse(BaseModel):
    """Dataset summary statistics."""
    trips: dict
    waypoints: dict
    has_trajectories: bool
