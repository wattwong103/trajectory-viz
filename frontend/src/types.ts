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

export interface FilterOptions {
  vehicle_types: string[];
  cities: string[];
  city_centers: Record<string, [number, number]>; // [lon, lat]
  simulation_days: number[];
  goods_types: string[];
  // Sprint B5 — `{source_id: {speed, dwell, detour}}`; absent for sources with no trips.
  metrics_available?: Record<string, MetricsAvailable>;
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
