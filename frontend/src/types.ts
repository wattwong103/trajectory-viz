/**
 * TypeScript interfaces matching the FastAPI Pydantic models.
 * These define the contract between backend and frontend.
 */

// ─── API Response Types ──────────────────────────────────

export interface TrajectoryMetadata {
  vehicle_type: 'truck' | 'taxi';
  vehicle_id: number;
  vehicle_key: string;
  trip_id: number;
  goods_type?: string;
  vehicle_size?: string;
  passenger_in?: string;
  fare_yen?: number;
  purpose?: number;
}

export interface Trajectory {
  id: string;
  path: [number, number][];           // [lon, lat][]
  timestamps: number[];                // seconds from midnight
  metadata: TrajectoryMetadata;
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
  vehicle_type: 'truck' | 'taxi';
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

export interface FilterOptions {
  vehicle_types: string[];
  cities: string[];
  city_centers: Record<string, [number, number]>; // [lon, lat]
  simulation_days: number[];
  goods_types: string[];
}

// ─── Filter State ────────────────────────────────────────

export interface FilterState {
  vehicleType: 'truck' | 'taxi' | 'all';
  minHour: number;
  maxHour: number;
  goodsType?: string;
  city?: string;
  simulationDay?: number;
}

// ─── Animation State ─────────────────────────────────────

export interface AnimationState {
  currentTime: number;             // seconds from midnight (0-86399)
  speed: number;                   // multiplier (1 = real-time, 10 = default)
  playing: boolean;
  trailLength: number;             // seconds of visible trail
}
