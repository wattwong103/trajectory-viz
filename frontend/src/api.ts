/**
 * API client for the PFLOW Viz backend.
 *
 * In dev mode, Vite proxies /api/* to localhost:9999 (see vite.config.ts).
 * In production, set VITE_API_BASE to the backend URL.
 */

import type {
  StatsResponse,
  InsightsResponse,
  TripResponse,
  TrajectoryResponse,
  FilterState,
  FilterOptions,
  MetricsDistribution,
  AgentInfo,
  PoiListResponse,
  PoiCategoriesResponse,
  UploadAccepted,
  IngestJob,
  CompareResponse,
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

// Backend TripFilters takes transport_modes as a comma-separated string
// (pattern ^\d{1,2}(,\d{1,2}){0,15}$) on GET and POST alike.
function transportModesParam(modes?: number[]): string | undefined {
  return modes && modes.length > 0 ? modes.join(',') : undefined;
}

// Pedestrianization scenario (Phase 4) — same field names on GET and POST.
type Scenario = FilterState['scenario'];

function appendScenarioParams(params: URLSearchParams, scenario?: Scenario): void {
  if (!scenario) return;
  params.set('scenario', scenario.type === 'pedestrianize' ? 'pedestrianize' : scenario.type);
  params.set('sc_w', String(scenario.bbox.w));
  params.set('sc_s', String(scenario.bbox.s));
  params.set('sc_e', String(scenario.bbox.e));
  params.set('sc_n', String(scenario.bbox.n));
}

function scenarioBody(scenario?: Scenario): Record<string, unknown> {
  if (!scenario) return {};
  return {
    scenario: 'pedestrianize',
    sc_w: scenario.bbox.w,
    sc_s: scenario.bbox.s,
    sc_e: scenario.bbox.e,
    sc_n: scenario.bbox.n,
  };
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    // Include FastAPI's `detail` when present — e.g. the 409 from
    // density-hourly tells the user exactly which command to run.
    let detail = '';
    try {
      const body = await res.json();
      if (body?.detail) detail = ` — ${body.detail}`;
    } catch { /* non-JSON error body */ }
    throw new Error(`API error: ${res.status} ${res.statusText}${detail}`);
  }
  return res.json();
}

// ─── Stats ─────────────────────────────────────────────

export async function fetchStats(): Promise<StatsResponse> {
  return fetchJson('/api/stats');
}

export async function fetchFilterOptions(): Promise<FilterOptions> {
  return fetchJson('/api/stats/filter-options');
}

// ─── Insights ─────────────────────────────────────────

export async function fetchInsights(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
  transportModes?: number[],
  scenario?: Scenario,
): Promise<InsightsResponse> {
  const params = new URLSearchParams();
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  const tm = transportModesParam(transportModes);
  if (tm) params.set('transport_modes', tm);
  appendScenarioParams(params, scenario);
  return fetchJson(`/api/stats/insights?${params}`);
}

// Phase 4 — what the pedestrianize scenario removes (count + VKT).
export async function fetchScenarioImpact(
  scenario: NonNullable<Scenario>,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
): Promise<{ excluded_trips: number; excluded_vkt_km: number }> {
  const params = new URLSearchParams();
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  appendScenarioParams(params, scenario);
  return fetchJson(`/api/stats/scenario-impact?${params}`);
}

// ─── Trips ─────────────────────────────────────────────

export async function fetchTripSample(
  n: number = 1000,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
  transportModes?: number[],
  scenario?: Scenario,
): Promise<TripResponse> {
  const params = new URLSearchParams({ n: String(n) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  const tm = transportModesParam(transportModes);
  if (tm) params.set('transport_modes', tm);
  appendScenarioParams(params, scenario);
  return fetchJson(`/api/trips/sample?${params}`);
}

export async function queryTrips(filter: FilterState, limit: number = 2000): Promise<TripResponse> {
  return fetchJson('/api/trips/query', {
    method: 'POST',
    body: JSON.stringify({
      vehicle_type: filter.vehicleType === 'all' ? null : filter.vehicleType,
      min_hour: filter.minHour,
      max_hour: filter.maxHour,
      goods_type: filter.goodsType || null,
      city: filter.city || null,
      simulation_day: filter.simulationDay ?? null,
      // F1 advanced filters (Phase 2 Step 2.2)
      min_speed: filter.minSpeed ?? null,
      max_speed: filter.maxSpeed ?? null,
      max_dwell_minutes: filter.maxDwellMinutes ?? null,
      min_detour_ratio: filter.minDetourRatio ?? null,
      max_detour_ratio: filter.maxDetourRatio ?? null,
      transport_modes: transportModesParam(filter.transportModes) ?? null,
      ...scenarioBody(filter.scenario),
      limit,
    }),
  });
}

// ─── Trajectories ──────────────────────────────────────

export async function fetchTrajectorySample(
  n: number = 100,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  includeSegments: boolean = false,
  transportModes?: number[],
  scenario?: Scenario,
): Promise<TrajectoryResponse> {
  const params = new URLSearchParams({ n: String(n) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (includeSegments) params.set('include_segments', 'true');
  const tm = transportModesParam(transportModes);
  if (tm) params.set('transport_modes', tm);
  appendScenarioParams(params, scenario);
  return fetchJson(`/api/trajectories/sample?${params}`);
}

export async function queryTrajectoriesBBox(
  minLon: number, minLat: number,
  maxLon: number, maxLat: number,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  limit: number = 500,
  includeSegments: boolean = false,
  transportModes?: number[],
  scenario?: Scenario,
): Promise<TrajectoryResponse> {
  return fetchJson('/api/trajectories/query-bbox', {
    method: 'POST',
    body: JSON.stringify({
      min_lon: minLon, min_lat: minLat,
      max_lon: maxLon, max_lat: maxLat,
      vehicle_type: vehicleType === 'all' ? null : vehicleType,
      city: city || null,
      simulation_day: simulationDay ?? null,
      transport_modes: transportModesParam(transportModes) ?? null,
      ...scenarioBody(scenario),
      limit,
      include_segments: includeSegments,
    }),
  });
}

export async function queryTrajectoriesPoint(
  lon: number, lat: number,
  radiusKm: number = 1.0,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  limit: number = 200,
  includeSegments: boolean = false,
  transportModes?: number[],
  scenario?: Scenario,
): Promise<TrajectoryResponse> {
  return fetchJson('/api/trajectories/query-point', {
    method: 'POST',
    body: JSON.stringify({
      lon, lat,
      radius_km: radiusKm,
      vehicle_type: vehicleType === 'all' ? null : vehicleType,
      city: city || null,
      simulation_day: simulationDay ?? null,
      transport_modes: transportModesParam(transportModes) ?? null,
      ...scenarioBody(scenario),
      limit,
      include_segments: includeSegments,
    }),
  });
}

// ─── Agent selection (Phase 2A) ────────────────────────

// Agent search — vehicles matching a vehicle_key prefix, for the Agents tab.
export async function fetchVehicles(
  q?: string,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  limit: number = 50,
): Promise<{ vehicles: AgentInfo[]; count: number }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set('q', q);
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  return fetchJson(`/api/trips/vehicles?${params}`);
}

// Full-day trajectory chain for the selected agents (max 20 keys server-side;
// the UI caps selection at 8).
export async function fetchTrajectoriesByVehicle(
  vehicleKeys: string[],
  simulationDay?: number,
  includeSegments: boolean = true,
): Promise<TrajectoryResponse> {
  const params = new URLSearchParams({
    vehicle_keys: vehicleKeys.join(','),
    include_segments: String(includeSegments),
  });
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  return fetchJson(`/api/trajectories/by-vehicle?${params}`);
}

// ─── Analysis (Phase 2) ───────────────────────────────

export interface HourlyData {
  hour: number;
  truck: number;
  taxi: number;
  total: number;
}

export async function fetchHourlyDepartures(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<HourlyData[]> {
  const params = new URLSearchParams();
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/temporal/departures?${params}`);
}

export interface ODFlow {
  source: [number, number];
  target: [number, number];
  volume: number;
  avg_distance_km: number | null;
}

export async function fetchODFlows(
  vehicleType?: string,
  topN: number = 50,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<{ flows: ODFlow[]; count: number }> {
  const params = new URLSearchParams({ top_n: String(topN) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/od-flows?${params}`);
}

export interface DensityPoint {
  lon: number;
  lat: number;
  weight: number;
}

export interface LinkDensityItem {
  link_id: string;
  waypoint_count: number;
  unique_vehicles: number;
  centroid: [number, number];
}

export async function fetchLinkDensity(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  topN: number = 500,
  minWaypoints: number = 50,
  goodsType?: string,
): Promise<{ links: LinkDensityItem[]; count: number; total_links: number }> {
  const params = new URLSearchParams({
    top_n: String(topN),
    min_waypoints: String(minWaypoints),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  return fetchJson(`/api/analysis/spatial/link-density?${params}`);
}

export async function fetchSpatialDensity(
  vehicleType?: string,
  pointType: string = 'origin',
  resolution: number = 0.01,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
  transportModes?: number[],
): Promise<{ points: DensityPoint[]; count: number }> {
  const params = new URLSearchParams({
    point_type: pointType,
    resolution: String(resolution),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  const tm = transportModesParam(transportModes);
  if (tm) params.set('transport_modes', tm);
  return fetchJson(`/api/analysis/spatial/density-grid?${params}`);
}

// ─── Pulse heatmap (Phase 2B) ─────────────────────────

export interface HourlyDensityBucket {
  hour: number;
  points: DensityPoint[];
}

export interface HourlyDensity {
  resolution_deg: number;
  global_max_weight: number;
  hours: HourlyDensityBucket[];   // exactly 24, indexed by hour
  total_cells: number;
  truncated: boolean;
}

// All 24 hour buckets in one call; the frontend crossfades locally.
// 409 = density_hourly aggregate not built (run ingest --aggregates-only).
export async function fetchHourlyDensity(
  vehicleType?: string,
  city?: string,
  resolution: number = 0.005,
  maxCellsPerHour: number = 15000,
): Promise<HourlyDensity> {
  const params = new URLSearchParams({
    resolution: String(resolution),
    max_cells_per_hour: String(maxCellsPerHour),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  return fetchJson(`/api/analysis/spatial/density-hourly?${params}`);
}

// ─── Mining (Phase 3) ─────────────────────────────────

export interface ClusterResult {
  algorithm: string;
  total_trips: number;
  num_clusters: number;
  noise_count: number;
  clusters: Array<{
    cluster_id: number;
    size: number;
    centroid: {
      start: [number, number];
      end: [number, number];
      avg_distance_km: number;
      avg_dep_hour: number;
    };
    representative: {
      vehicle_key: string;
      trip_id: number;
      start: [number, number];
      end: [number, number];
      distance_km: number;
      dep_hour: number;
      vehicle_type: string;
    };
  }>;
}

export async function runClustering(
  vehicleType?: string,
  sampleSize: number = 5000,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<ClusterResult> {
  const params = new URLSearchParams({ sample_size: String(sampleSize) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/clustering/run?${params}`, { method: 'POST' });
}

export async function fetchChainLengths(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<Array<{ chain_length: number; vehicle_count: number }>> {
  const params = new URLSearchParams();
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/trip-chains/length-distribution?${params}`);
}

// ─── Analysis (Phase 2 extensions) ───────────────────────

export async function fetchTemporalPeaks(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<{ peaks: Array<{ hour: number; count: number }>; mean: number; std: number; threshold: number }> {
  const params = new URLSearchParams();
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/temporal/peaks?${params}`);
}

export async function fetchDurationDistribution(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  binMinutes: number = 10,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<Array<{ distance_km: number; count: number; vehicle_type: string }>> {
  const params = new URLSearchParams({ bin_minutes: String(binMinutes) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/temporal/duration?${params}`);
}

export async function fetchSpatialHotspots(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  topN: number = 20,
  pointType: 'origin' | 'destination' = 'origin',
  goodsType?: string,
): Promise<Array<{ lon: number; lat: number; volume: number; unique_vehicles: number; rank: number }>> {
  const params = new URLSearchParams({ top_n: String(Math.max(5, topN)), point_type: pointType });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  return fetchJson(`/api/analysis/spatial/hotspots?${params}`);
}

export async function fetchWaypointDensity(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  resolution: number = 0.005,
  limit: number = 5000,
  transportModes?: number[],
): Promise<{ points: DensityPoint[]; count: number; resolution_deg: number }> {
  const params = new URLSearchParams({
    resolution: String(resolution),
    limit: String(Math.max(100, limit)),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  const tm = transportModesParam(transportModes);
  if (tm) params.set('transport_modes', tm);
  return fetchJson(`/api/analysis/spatial/waypoint-density?${params}`);
}

export async function fetchDwellTimes(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  sampleVehicles: number = 1000,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<Array<{ dwell_bin: string; count: number }>> {
  const params = new URLSearchParams({ sample_vehicles: String(sampleVehicles) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/trip-chains/dwell-times?${params}`);
}

export async function fetchRoundTrips(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  thresholdKm: number = 2.0,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<Array<{ trip_type: 'round_trip' | 'one_way'; vehicle_count: number; avg_trips_per_vehicle: number }>> {
  const params = new URLSearchParams({ threshold_km: String(thresholdKm) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/trip-chains/round-trips?${params}`);
}

// F1 derived-metric distribution (Phase 2 Step 2.2b).
// `metric` selects which derived column to histogram.
export async function fetchMetricsDistribution(
  metric: 'speed_avg_kmh' | 'dwell_minutes' | 'detour_ratio',
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  bins: number = 20,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<MetricsDistribution> {
  const params = new URLSearchParams({ metric, bins: String(bins) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/temporal/metrics-distribution?${params}`);
}

// F3 — Route-similarity clustering (Phase 2 Step 2.6).
// Clusters trajectories by Jaccard distance on their DRM link_id sets.
// Differs from /clustering/run (OD+distance features) in that it captures
// "shared infrastructure" rather than "similar trip shape".
export interface RouteCluster {
  cluster_id: number;
  size: number;
  representative: {
    vehicle_key: string;
    trip_id: number;
    link_count: number;
  };
  members: Array<{ vehicle_key: string; trip_id: number }>;
}

export interface RouteSimilarityResponse {
  algorithm: string;
  total_trips: number;
  num_clusters: number;
  noise_count: number;
  eps?: number;
  min_samples?: number;
  clusters: RouteCluster[];
  note?: string;
  error?: string;
}

export async function runRouteSimilarity(
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  sampleSize: number = 200,
  eps: number = 0.3,
  minSamples: number = 3,
): Promise<RouteSimilarityResponse> {
  const params = new URLSearchParams({
    sample_size: String(sampleSize),
    eps: String(eps),
    min_samples: String(minSamples),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  return fetchJson(`/api/analysis/clustering/route-similarity?${params}`, { method: 'POST' });
}

// F2 — Trips passing through a bbox (Phase 2 Step 2.3).
// Returns trips whose trajectories include at least one waypoint in the bbox.
// Response shape matches /api/trips/query so the dashboard's existing trip
// rendering can reuse the data without a new mapper.
export async function fetchTripsThroughZoneBBox(
  w: number, s: number, e: number, n: number,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  limit: number = 500,
): Promise<TripResponse & { bbox: { w: number; s: number; e: number; n: number } }> {
  const params = new URLSearchParams({
    w: String(w), s: String(s), e: String(e), n: String(n),
    limit: String(limit),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  return fetchJson(`/api/analysis/trip-chains/through-zone-bbox?${params}`);
}

// F2 — Multi-stop chains (Phase 2 Step 2.4).
// Returns per-vehicle trip sequences for vehicles with >= min_stops trips,
// sorted by chain length descending.
export interface MultiStopVehicle {
  vehicle_key: string;
  chain_length: number;
  trips: Array<{
    trip_id: number;
    starttime: number;
    start: [number, number];
    end: [number, number];
    distance_km: number | null;
    goods_type: string | null;
    seq: number;
  }>;
}

export async function fetchMultiStopChains(
  minStops: number = 3,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  goodsType?: string,
  limit: number = 100,
): Promise<{ vehicles: MultiStopVehicle[]; count: number }> {
  const params = new URLSearchParams({
    min_stops: String(minStops),
    limit: String(limit),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  return fetchJson(`/api/analysis/trip-chains/multi-stop?${params}`);
}

export async function fetchCommodityPatterns(
  city?: string,
  simulationDay?: number,
  topN: number = 20,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
): Promise<Array<{ sequence: string; vehicle_count: number; chain_length: number }>> {
  const params = new URLSearchParams({ top_n: String(Math.max(5, topN)) });
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/analysis/trip-chains/commodity-patterns?${params}`);
}

// ─── POIs (universal-trajectory-support Phase 2) ─────────
// POI filters are independent of TripFilters — no vehicle/city/day params.

export async function fetchPois(opts: {
  category?: string;
  bbox?: { w: number; s: number; e: number; n: number };
  sourceKey?: string;
  limit?: number;
} = {}): Promise<PoiListResponse> {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.sourceKey) params.set('source_key', opts.sourceKey);
  if (opts.bbox) {
    const b = opts.bbox;
    params.set('bbox', `${b.w},${b.s},${b.e},${b.n}`);
  }
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return fetchJson(`/api/pois${qs ? `?${qs}` : ''}`);
}

// One row per (source_key, category); color/label are null when the pois:
// block in sources.yaml doesn't declare them (frontend falls back to the
// deterministic hash palette in poiColors.ts).
export async function fetchPoiCategories(): Promise<PoiCategoriesResponse> {
  return fetchJson('/api/pois/categories');
}

// ─── Upload-and-go ingest ────────────────────────────────
// NOT fetchJson-based: the upload is multipart (the browser must set the
// Content-Type boundary itself) and the 422 detail is a {reasons[]} object,
// which fetchJson would flatten into a string.

export class UploadRejectedError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('\n'));
    this.name = 'UploadRejectedError';
    this.reasons = reasons;
  }
}

export async function uploadFiles(files: File[]): Promise<UploadAccepted> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch(`${API_BASE}/api/ingest/upload`, {
    method: 'POST',
    body: form,
  });
  if (res.status === 202) return res.json();
  if (res.status === 422) {
    let reasons: string[] | null = null;
    try {
      const body = await res.json();
      if (Array.isArray(body?.detail?.reasons)) {
        reasons = body.detail.reasons.map(String);
      } else if (typeof body?.detail === 'string') {
        reasons = [body.detail];
      }
    } catch { /* non-JSON error body */ }
    throw new UploadRejectedError(reasons ?? ['Upload rejected (422)']);
  }
  if (res.status === 413) {
    throw new Error('File too large — 200 MB upload cap.');
  }
  throw new Error(`API error: ${res.status} ${res.statusText}`);
}

export async function fetchIngestJob(jobId: string): Promise<IngestJob> {
  return fetchJson(`/api/ingest/jobs/${jobId}`);
}

// ─── Fleet comparison (fleet-comparison) ──────────────
// GET /api/analysis/compare — two sources under otherwise-identical shared
// filters. vehicle_type is deliberately NOT a parameter: the router ignores
// it and overrides with source_a/source_b.

export interface CompareFilters {
  city?: string;
  simulationDay?: number;
  goodsType?: string;
  minHour?: number;
  maxHour?: number;
  transportModes?: number[];
  scenario?: Scenario;
}

export async function fetchComparison(
  sourceA: string,
  sourceB: string,
  filters: CompareFilters = {},
  topN: number = 10,
): Promise<CompareResponse> {
  const params = new URLSearchParams({
    source_a: sourceA,
    source_b: sourceB,
    top_n: String(topN),
  });
  if (filters.city) params.set('city', filters.city);
  if (filters.simulationDay !== undefined) params.set('simulation_day', String(filters.simulationDay));
  if (filters.goodsType) params.set('goods_type', filters.goodsType);
  if (filters.minHour !== undefined) params.set('min_hour', String(filters.minHour));
  if (filters.maxHour !== undefined) params.set('max_hour', String(filters.maxHour));
  const tm = transportModesParam(filters.transportModes);
  if (tm) params.set('transport_modes', tm);
  appendScenarioParams(params, filters.scenario);
  return fetchJson(`/api/analysis/compare?${params}`);
}
