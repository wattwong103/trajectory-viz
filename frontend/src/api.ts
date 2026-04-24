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
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
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
): Promise<InsightsResponse> {
  const params = new URLSearchParams();
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
  return fetchJson(`/api/stats/insights?${params}`);
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
): Promise<TripResponse> {
  const params = new URLSearchParams({ n: String(n) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  if (goodsType) params.set('goods_type', goodsType);
  if (minHour !== undefined) params.set('min_hour', String(minHour));
  if (maxHour !== undefined) params.set('max_hour', String(maxHour));
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
): Promise<TrajectoryResponse> {
  const params = new URLSearchParams({ n: String(n) });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
  return fetchJson(`/api/trajectories/sample?${params}`);
}

export async function queryTrajectoriesBBox(
  minLon: number, minLat: number,
  maxLon: number, maxLat: number,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  limit: number = 500,
): Promise<TrajectoryResponse> {
  return fetchJson('/api/trajectories/query-bbox', {
    method: 'POST',
    body: JSON.stringify({
      min_lon: minLon, min_lat: minLat,
      max_lon: maxLon, max_lat: maxLat,
      vehicle_type: vehicleType === 'all' ? null : vehicleType,
      city: city || null,
      simulation_day: simulationDay ?? null,
      limit,
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
): Promise<TrajectoryResponse> {
  return fetchJson('/api/trajectories/query-point', {
    method: 'POST',
    body: JSON.stringify({
      lon, lat,
      radius_km: radiusKm,
      vehicle_type: vehicleType === 'all' ? null : vehicleType,
      city: city || null,
      simulation_day: simulationDay ?? null,
      limit,
    }),
  });
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
  return fetchJson(`/api/analysis/spatial/density-grid?${params}`);
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
): Promise<{ points: DensityPoint[]; count: number; resolution_deg: number }> {
  const params = new URLSearchParams({
    resolution: String(resolution),
    limit: String(Math.max(100, limit)),
  });
  if (vehicleType && vehicleType !== 'all') params.set('vehicle_type', vehicleType);
  if (city) params.set('city', city);
  if (simulationDay !== undefined) params.set('simulation_day', String(simulationDay));
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
