/**
 * useHourlyDensity — fetch + hold the 24-hour density grid for the pulse
 * heatmap (Phase 2B).
 *
 * Fetches once when the pulse layer first turns on (and when the source/city
 * filter changes while it is on). All 24 hour buckets arrive in one response;
 * animation never refetches — MapView crossfades between adjacent hours with
 * opacity uniforms.
 *
 * A 409 means the density_hourly aggregate hasn't been built yet; we surface
 * the backend's fix-it message ("run --aggregates-only") as `error`.
 */

import { useState, useEffect } from 'react';
import { fetchHourlyDensity, type HourlyDensity } from '../api';

export function useHourlyDensity(
  enabled: boolean,
  vehicleType?: string,
  city?: string,
) {
  const [data, setData] = useState<HourlyDensity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;          // keep stale data — re-toggling is instant
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHourlyDensity(vehicleType || undefined, city)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => {
        if (!cancelled) {
          setData(null);
          setError(String(e?.message ?? e));
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, vehicleType, city]);

  return { data, loading, error };
}
