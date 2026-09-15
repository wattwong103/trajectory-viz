/**
 * Data fetching hook — loads trajectories and trips from the backend.
 *
 * Manages loading states and provides refetch capability when filters change.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Trajectory, TripPoint, StatsResponse, FilterState } from '../types';
import { fetchStats, fetchTrajectorySample, fetchTripSample } from '../api';

interface UseTrajectories {
  trajectories: Trajectory[];
  trips: TripPoint[];
  stats: StatsResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useTrajectories(filter: FilterState): UseTrajectories {
  const [trajectories, setTrajectories] = useState<Trajectory[]>([]);
  const [trips, setTrips] = useState<TripPoint[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch stats first to know what's available
      const s = await fetchStats();
      setStats(s);

      const vtype = filter.vehicleType === 'all' ? undefined : filter.vehicleType;
      const city = filter.city;
      const simulationDay = filter.simulationDay;
      const transportModes = filter.transportModes;
      const scenario = filter.scenario;

      // Always fetch trips (OD points) — they exist even without trajectory
      // generation. Hour/goods/F1 ride along so the map matches Analysis.
      if (s.trips.row_count > 0) {
        const tripRes = await fetchTripSample(
          2000, vtype, city, simulationDay,
          filter.goodsType, filter.minHour, filter.maxHour,
          transportModes, scenario,
          filter.minSpeed, filter.maxSpeed, filter.maxDwellMinutes,
          filter.minDetourRatio, filter.maxDetourRatio,
        );
        setTrips(tripRes.trips);
      }

      // Fetch trajectories only if available. include_segments=true populates
      // per-segment link_id + speed_kmh + dwell_sec on each Trajectory; needed
      // by the F3 speed-gradient and dwell-marker overlays. Sample cap 500
      // is the architecture budget for one render.
      if (s.has_trajectories) {
        const trajRes = await fetchTrajectorySample(
          500, vtype, city, simulationDay, true, transportModes, scenario,
          filter.goodsType, filter.minHour, filter.maxHour,
          filter.minSpeed, filter.maxSpeed, filter.maxDwellMinutes,
          filter.minDetourRatio, filter.maxDetourRatio,
        );
        setTrajectories(trajRes.trajectories);
      } else {
        setTrajectories([]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setError(msg);
      console.error('[useTrajectories]', msg);
    } finally {
      setLoading(false);
    }
    // Arrays/objects serialized to strings — identity changes per toggle.
  }, [filter.vehicleType, filter.city, filter.simulationDay,
      filter.goodsType, filter.minHour, filter.maxHour,
      filter.minSpeed, filter.maxSpeed, filter.maxDwellMinutes,
      filter.minDetourRatio, filter.maxDetourRatio,
      filter.transportModes?.join(','),
      filter.scenario && JSON.stringify(filter.scenario.bbox)]);

  useEffect(() => {
    load();
  }, [load]);

  return { trajectories, trips, stats, loading, error, refetch: load };
}
