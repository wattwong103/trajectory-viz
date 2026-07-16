/**
 * Insights fetching hook — loads derived statistics from /api/stats/insights.
 *
 * Auto-fetches when data is available and re-fetches when vehicleType changes.
 */

import { useState, useEffect, useCallback } from 'react';
import type { InsightsResponse } from '../types';
import { fetchInsights } from '../api';

interface UseInsights {
  insights: InsightsResponse | null;
  loading: boolean;
  error: string | null;
}

export function useInsights(
  vehicleType: string,
  city: string | undefined,
  simulationDay: number | undefined,
  hasData: boolean,
  goodsType?: string,
  minHour?: number,
  maxHour?: number,
  transportModes?: number[],
): UseInsights {
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasData) return;
    setLoading(true);
    setError(null);
    try {
      const vtype = vehicleType === 'all' ? undefined : vehicleType;
      const data = await fetchInsights(
        vtype, city, simulationDay, goodsType, minHour, maxHour, transportModes,
      );
      setInsights(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load insights';
      setError(msg);
      console.error('[useInsights]', msg);
    } finally {
      setLoading(false);
    }
    // transportModes joined to a string — array identity changes per toggle.
  }, [vehicleType, city, simulationDay, hasData, goodsType, minHour, maxHour,
      transportModes?.join(',')]);

  useEffect(() => {
    load();
  }, [load]);

  return { insights, loading, error };
}
