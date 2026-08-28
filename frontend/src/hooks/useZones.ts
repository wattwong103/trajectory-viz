/**
 * useZones — polygon/zone layers for the map (zones feature).
 *
 * Fetched once on mount; zones are few (tens) and static per DB, so there
 * is deliberately no pagination, debouncing, or category toggling here —
 * the layer toggles as a whole via the Layers panel. Failure degrades to
 * "no zone layer" exactly like usePois.
 */

import { useEffect, useState } from 'react';
import { fetchZones } from '../api';
import type { Zone } from '../types';

export function useZones() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchZones()
      .then(res => { if (!cancelled) setZones(res.zones); })
      .catch(e => console.error('Zone fetch failed:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { zones, loading };
}
