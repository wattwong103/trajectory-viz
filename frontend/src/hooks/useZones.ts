/**
 * useZones — polygon/zone layers for the map (zones feature).
 *
 * Zones + their style hints are fetched once on mount; zones are few (tens)
 * and static per DB, so there is deliberately no pagination or debouncing —
 * the layer toggles as a whole via the Layers panel. Failure degrades to
 * "no zone layer" exactly like usePois. `reload()` re-fetches both (called
 * after ingest/upload flows that may have added zone layers).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchZones, fetchZoneStyles } from '../api';
import type { Zone, ZoneStylesResponse } from '../types';

export function useZones() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [styles, setStyles] = useState<ZoneStylesResponse['styles']>({});
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [z, s] = await Promise.all([fetchZones(), fetchZoneStyles()]);
      if (!mounted.current) return;
      setZones(z.zones);
      setStyles(s.styles);
    } catch (e) {
      console.error('Zone fetch failed:', e);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { zones, styles, loading, reload };
}
