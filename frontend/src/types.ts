/**
 * TypeScript interfaces matching the FastAPI Pydantic models.
 * These define the contract between backend and frontend.
 */

// ─── API Response Types ──────────────────────────────────

export interface TrajectoryMetadata {
  vehicle_type: string;          // source_id from sources.yaml (e.g. 'truck', 'taxi')
  vehicle_id: number;
  vehicle_key: string;
  trip_id: number;
  // The TRIP's transport mode (0=walk 1=bike 2=bus 3=car 4=train 8=taxi).
  // Never the waypoint's — see transportModes.ts.
  transport_mode?: number | null;
  goods_type?: string;
  vehicle_size?: string;
  passenger_in?: string;
  fare_yen?: number;
  purpose?: number;
}

// Per-segment metrics between consecutive waypoints (Phase 2 Step 2.5).
// Populated only when `include_segments=true` on the trajectory endpoint.
// A trajectory of N waypoints has N-1 segments.
export interface TrajectorySegment {
  link_id: string | null;       // DRM link of the second waypoint in the pair
  speed_kmh: number | null;     // haversine_km(w1, w2) / dt_hours; null if dt<=0
  dwell_sec: number | null;     // dt when speed < 1 km/h (idle marker)
}

export interface Trajectory {
  id: string;
  path: [number, number][];           // [lon, lat][]
  timestamps: number[];                // seconds from midnight
  metadata: TrajectoryMetadata;
  segments?: TrajectorySegment[] | null;  // F3 — opt-in via include_segments
}

export interface TrajectoryResponse {
  trajectories: Trajectory[];
  count: number;
  total_matching?: number;
}

export interface TripPoint {
  vehicle_id: number;
  vehicle_key?: string;
  trip_id: number;
  starttime: number;
  start_lon: number;
  start_lat: number;
  end_lon: number;
  end_lat: number;
  vehicle_type: string;          // source_id from sources.yaml (e.g. 'truck', 'taxi')
  distance_km?: number;
  goods_type?: string;
  city?: string;
  // 0=walk 1=bike 2=bus 3=car 4=train 8=taxi (trips.transport_mode)
  transport_mode?: number | null;
}

export interface TripResponse {
  trips: TripPoint[];
  count: number;
  total_matching?: number;
}

export interface VehicleTypeStats {
  count: number;
  bbox: { min_lon: number; max_lon: number; min_lat: number; max_lat: number };
  time_range: { min_sec: number; max_sec: number };
}

export interface StatsResponse {
  trips: {
    row_count: number;
    by_vehicle_type?: Record<string, VehicleTypeStats>;
  };
  waypoints: {
    row_count: number;
    by_vehicle_type?: Record<string, number>;
  };
  has_trajectories: boolean;
}

// ─── Insights Response ──────────────────────────────────

export interface InsightsResponse {
  core: {
    total_trips: number;
    unique_vehicles: number;
    avg_distance_km: number;
    median_distance_km: number;
    max_distance_km: number;
    stddev_distance_km: number;
    total_vkt_km: number;
  };
  fleet: {
    avg_trips_per_vehicle: number;
    min_trips: number;
    max_trips: number;
  };
  peak: {
    peak_hour: number | null;
    peak_count: number;
    peak_pct: number;
    off_peak_hour: number | null;
    off_peak_count: number;
    peak_to_offpeak_ratio: number;
  };
  fare: {
    avg_fare_yen: number;
    median_fare_yen: number;
    max_fare_yen: number;
    avg_night_fare_yen: number | null;
    avg_day_fare_yen: number | null;
    night_trip_pct: number;
  } | null;
  // Per-transport-mode trip counts under the current filter (keys are the
  // stringified mode ids — JSON object keys).
  by_transport_mode?: Record<string, number>;
  distance_distribution: Array<{ bucket_km: number; count: number }>;
  text_insights: string[];
}

// ─── Filter Options ──────────────────────────────────────

// Per-source F1-metric availability (Sprint B5).
// Used by FilterPanel to disable sliders that would silently filter to zero
// rows. Backend computes via COUNT(metric_col) > 0 per source.
export interface MetricsAvailable {
  speed: boolean;     // speed_avg_kmh populated (requires trajectory data)
  dwell: boolean;     // dwell_minutes populated (>= 2 trips per vehicle_key)
  detour: boolean;    // detour_ratio populated (haversine ≥ 0.1 km)
}

// Per-source rendering hints from sources.yaml render blocks (Phase 2A).
// mode picks the visual treatment in MapView: trails (TripsLayer),
// points (moving dots), arcs (time-windowed OD arcs for trip-only sources).
export interface SourceStyle {
  source_key: string;            // sources.yaml key, e.g. 'pflow-taxi-tokyo'
  source_id: string;             // short id matching trips.source_id
  label: string;
  mode: 'trails' | 'points' | 'arcs';
  color: [number, number, number] | null;  // null → hash-palette fallback
  has_waypoints: boolean;
}

export interface FilterOptions {
  vehicle_types: string[];
  cities: string[];
  city_centers: Record<string, [number, number]>; // [lon, lat]
  simulation_days: number[];
  goods_types: string[];
  // Sprint B5 — `{source_id: {speed, dwell, detour}}`; absent for sources with no trips.
  metrics_available?: Record<string, MetricsAvailable>;
  // Phase 2A — rendering hints; [] when sources.yaml is absent (standalone DB).
  sources?: SourceStyle[];
  // Phase 1 (transport mode) — modes present in trips + their counts, so the
  // FilterPanel chips + breakdown render without a second call.
  transport_modes?: Array<{ mode: number; count: number }>;
}

// ─── Upload-and-go ingest (frontend half) ───────────────
// Matches backend/routers/ingest_api.py: POST /api/ingest/upload (202) and
// GET /api/ingest/jobs/{job_id}. POI uploads are not part of the contract.

export interface UploadFileInfo {
  filename: string;
  source_id: string;
  format: string;
}

/** 202 response from POST /api/ingest/upload. */
export interface UploadAccepted {
  job_id: string;
  status: 'queued';
  files: UploadFileInfo[];
}

export type IngestPhase =
  'ingest' | 'synthesize' | 'derived' | 'density' | 'registry' | 'done';

export interface IngestJobProgress {
  phase: IngestPhase;
  file: string | null;
  done_files: number;
  total_files: number;
}

export interface IngestJobResultFile {
  filename: string;
  source_id: string;
  label: string;
  trips: number;
  waypoints: number;
  vehicles: number;
}

export interface IngestJobResult {
  trips: number;
  waypoints: number;
  source_ids: string[];
  files: IngestJobResultFile[];
}

export type IngestJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface IngestJob {
  job_id: string;
  status: IngestJobStatus;
  progress: IngestJobProgress | null;
  result: IngestJobResult | null;
  error: string | null;
  created_at: string;
}

// ─── POIs (universal-trajectory-support Phase 2) ─────────
// Static points of interest declared via the `pois:` block in sources.yaml.
// Independent of TripFilters — POIs render as a context layer, not trips.

export interface Poi {
  poi_id: number;
  source_key: string;              // key of the pois: block in sources.yaml
  name: string | null;
  category: string | null;
  lon: number;
  lat: number;
  props: Record<string, unknown> | null;  // parsed props_json (geojson/gpx sources)
}

export interface PoiCategory {
  category: string;
  count: number;
  color: [number, number, number] | null;  // null → hash-palette fallback (poiColors.ts)
  label: string | null;                    // POI source label from sources.yaml
  source_key: string;
}

export interface PoiListResponse {
  pois: Poi[];
  count: number;
  truncated: boolean;
}

export interface PoiCategoriesResponse {
  categories: PoiCategory[];      // one row per (source_key, category)
}

// ─── Agent selection (Phase 2A) ──────────────────────────

export interface AgentInfo {
  vehicle_key: string;
  source_id: string | null;
  trip_count: number;
  first_start: number;           // seconds from midnight of first departure
  last_end: number;              // seconds from midnight of last departure
  total_km: number | null;
}

// ─── Filter State ────────────────────────────────────────

export interface FilterState {
  vehicleType: string;            // source_id or '' for all

  minHour: number;
  maxHour: number;
  goodsType?: string;
  city?: string;
  simulationDay?: number;
  // F1 advanced filters (Phase 2 Step 2.2) — undefined = filter inactive
  minSpeed?: number;
  maxSpeed?: number;
  maxDwellMinutes?: number;
  minDetourRatio?: number;
  maxDetourRatio?: number;
  // Transport-mode multi-select (undefined/empty = all modes) + color scheme.
  // NAMING: "transportModes", never bare "mode" (taken by SourceStyle.mode).
  transportModes?: number[];
  colorBy?: 'source' | 'transportMode';
  // Pedestrianization scenario (Phase 4): query-time exclusion of car trips
  // whose trajectories enter the bbox. Every fetch carrying the filter
  // reflects it — that IS the before/after toggle.
  scenario?: { type: 'pedestrianize'; bbox: { w: number; s: number; e: number; n: number } };
}

// F1 metric distribution (Phase 2 Step 2.2b)
export interface MetricsDistribution {
  metric: 'speed_avg_kmh' | 'dwell_minutes' | 'detour_ratio';
  unit: string;                         // 'km/h' | 'minutes' | 'ratio'
  bin_count: number;
  min: number | null;
  max: number | null;
  total_rows: number;
  histogram: Array<{
    bin_lower: number;
    bin_upper: number;
    count: number;
  }>;
}

// ─── Animation State ─────────────────────────────────────

export interface AnimationState {
  currentTime: number;             // seconds from midnight (0-86399)
  speed: number;                   // multiplier (1 = real-time, 10 = default)
  playing: boolean;
  trailLength: number;             // seconds of visible trail
}
