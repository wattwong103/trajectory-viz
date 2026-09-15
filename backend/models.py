"""
Pydantic request/response models for the PFLOW Viz API.

Response formats are designed for direct consumption by DeckGL layers:
- TripsLayer expects {path: [[lon, lat], ...], timestamps: [t1, t2, ...]}
- ScatterplotLayer expects {position: [lon, lat], ...}
"""



from pydantic import BaseModel, Field

from .filters import ScenarioFields, TripFilters

# ─── Request Models ────────────────────────────────────────────

class TripQuery(TripFilters):
    """Filter criteria for trip queries.

    Inherits every shared dimension (vehicle_type, city, simulation_day,
    goods_type, min/max_hour, F1 metrics) from filters.TripFilters — same
    field names and validation patterns as before the Phase-0 refactor.
    Only the trip-query-specific fields live here."""
    # Zone codes are alphanumeric + _/- (e.g. MFS01, PRF47, OSK30). The pattern
    # here is load-bearing: origin_zone/dest_zone are f-string'd into SQL at
    # routers/trips.py, so unvalidated input would be a SQL injection vector.
    origin_zone: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{1,32}$")
    dest_zone: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{1,32}$")
    limit: int = Field(1000, ge=1, le=50000)


class BBoxQuery(TripFilters):
    """Bounding box spatial query for trajectories.

    Inherits shared TripFilters (hour/goods/F1/mode/scenario) so a zoomed-in
    viewport sample matches the rest of the map."""
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float
    limit: int = Field(500, ge=1, le=5000)
    # Phase 2 Step 2.5 — opt into per-segment metrics (link_id/speed/dwell)
    include_segments: bool = False


class PointQuery(ScenarioFields):
    """Point proximity query — find trajectories near a point.

    Inherits the pedestrianize-scenario fields (scenario, sc_*)."""
    lon: float
    lat: float
    radius_km: float = Field(1.0, ge=0.1, le=50.0)
    vehicle_type: str | None = Field(None, pattern="^[a-z][a-z0-9_]*$")
    city: str | None = Field(None, pattern="^[a-z_]+$")
    simulation_day: int | None = Field(None, ge=0)
    # Comma-separated transport-mode ids ("0,3") — trip-granular filter.
    transport_modes: str | None = Field(None, pattern=r"^\d{1,2}(,\d{1,2}){0,15}$")
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
    # The TRIP's transport mode (trips.transport_mode, joined at
    # (vehicle_key, trip_id)). NOT the waypoint's — router-generated waypoints
    # carry a uniform per-source value (taxi writer stamps 8 on everything),
    # verified empirically. 0=walk 1=bike 2=bus 3=car 4=train 8=taxi.
    transport_mode: int | None = None
    goods_type: str | None = None
    vehicle_size: str | None = None
    passenger_in: str | None = None
    fare_yen: float | None = None
    purpose: int | None = None


class TrajectorySegment(BaseModel):
    """Per-segment metrics between two consecutive waypoints (Phase 2 Step 2.5).

    A trajectory of N waypoints has N-1 segments. Returned only when the
    endpoint is called with `include_segments=true` — heavy payload otherwise.
    """
    link_id: str | None = None         # DRM link the second waypoint sits on
    speed_kmh: float | None = None     # haversine distance / dt; None if dt<=0
    dwell_sec: float | None = None     # populated when speed < 1 km/h (idle marker)


class Trajectory(BaseModel):
    """Single trajectory in DeckGL TripsLayer format."""
    id: str                                     # "truck_12345_1" or "taxi_678_2"
    path: list[list[float]]                     # [[lon, lat], [lon, lat], ...]
    timestamps: list[int]                       # seconds from midnight (for 24h animation loop)
    metadata: TrajectoryMetadata
    # Phase 2 Step 2.5 — populated only when include_segments=true on the call.
    # len(segments) == len(path) - 1 when present.
    segments: list[TrajectorySegment] | None = None


class TrajectoryResponse(BaseModel):
    """Paginated trajectory query response."""
    trajectories: list[Trajectory]
    count: int                                  # number returned
    total_matching: int | None = None        # total matching the query (if computed)


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
    distance_km: float | None = None
    goods_type: str | None = None
    city: str | None = None
    # 0=walk 1=bike 2=bus 3=car 4=train 8=taxi (trips.transport_mode)
    transport_mode: int | None = None


class TripResponse(BaseModel):
    """Paginated trip query response."""
    trips: list[TripPoint]
    count: int
    total_matching: int | None = None


class StatsResponse(BaseModel):
    """Dataset summary statistics."""
    trips: dict
    waypoints: dict
    has_trajectories: bool


# ─── POI Models (universal-trajectory-support Phase 1) ──────────

class Poi(BaseModel):
    """One point of interest for ScatterplotLayer."""
    poi_id: int
    source_key: str
    name: str | None = None
    category: str | None = None
    lon: float
    lat: float
    props: dict | None = None


class PoiListResponse(BaseModel):
    """POI query response. `truncated` is True when `limit` cut the result."""
    pois: list[Poi]
    count: int
    truncated: bool


class PoiCategory(BaseModel):
    """One POI category summary, with the layer's render hints joined in."""
    category: str | None = None
    count: int
    color: list[int] | None = None
    label: str | None = None
    source_key: str


class PoiCategoriesResponse(BaseModel):
    """POI category counts across all layers."""
    categories: list[PoiCategory]


class Zone(BaseModel):
    """One polygon zone for the map's PolygonLayer. `geometry` is a parsed
    GeoJSON geometry dict ({type: Polygon|MultiPolygon, coordinates}); bbox
    is precomputed at ingest for quick viewport prefilters."""
    zone_id: int
    source_key: str
    name: str | None = None
    category: str | None = None
    bbox: dict | None = None          # {w,s,e,n}
    geometry: dict
    props: dict | None = None


class ZoneListResponse(BaseModel):
    """Zone query response. `truncated` is True when `limit` cut the result."""
    zones: list[Zone]
    count: int
    truncated: bool = False
