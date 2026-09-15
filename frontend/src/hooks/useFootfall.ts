/**
 * useFootfall — fetch + hold the pedestrian footfall density grid (Phase 2).
 *
 * Footfall = waypoint density restricted to WALK trips (transport_mode 0),
 * at a finer grid (~200 m) than the generic heatmap — where pedestrians
 * actually travel, not just their trip endpoints.
 *
 * Fetches when the footfall layer first turns on (and when the filter
 * changes while it is on). If the dataset has no walk waypoints (e.g. a
 * trips-only people source, or truck/taxi-only DBs), falls back to walk-trip
 * OD density and reports `fallback: true` so the panel can label it honestly.
 */

import { useState, useEffect } from 'react';
import { fetchWaypointDensity, fetchSpatialDensity, type DensityPoint } from '../api';

const WALK_MODE = 0;
const FOOTFALL_RESOLUTION = 0.002;   // ~200 m grid
const FOOTFALL_LIMIT = 10000;

export function useFootfall(
  enabled: boolean,
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
  minHour?: number,
  maxHour?: number,
  goodsType?: string,
) {
  const [points, setPoints] = useState<DensityPoint[]>([]);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;          // keep stale data — re-toggling is instant
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWaypointDensity(
      vehicleType || undefined, city, simulationDay,
      FOOTFALL_RESOLUTION, FOOTFALL_LIMIT, [WALK_MODE],
      goodsType, minHour, maxHour,
    )
      .then(async d => {
        if (cancelled) return;
        if (d.points.length > 0) {
          setPoints(d.points);
          setFallback(false);
          return;
        }
        // No walk waypoints — degrade to walk-trip OD density (coarser source).
        const od = await fetchSpatialDensity(
          vehicleType || undefined, 'both', FOOTFALL_RESOLUTION, city,
          simulationDay, undefined, undefined, undefined, [WALK_MODE],
        );
        if (cancelled) return;
        setPoints(od.points);
        setFallback(true);
      })
      .catch(e => {
        if (!cancelled) {
          setPoints([]);
          setError(String(e?.message ?? e));
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, vehicleType, city, simulationDay, minHour, maxHour, goodsType]);

  return { points, fallback, loading, error };
}
