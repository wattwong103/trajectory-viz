/**
 * useScenarioImpact — fetch what the active pedestrianize scenario removes
 * (excluded car trips + VKT), for the FilterPanel badge (Phase 4).
 *
 * Fires whenever the scenario or the major filter dims change; null when no
 * scenario is active.
 */

import { useState, useEffect } from 'react';
import type { FilterState } from '../types';
import { fetchScenarioImpact } from '../api';

export interface ScenarioImpact {
  excluded_trips: number;
  excluded_vkt_km: number;
}

export function useScenarioImpact(
  scenario: FilterState['scenario'],
  vehicleType?: string,
  city?: string,
  simulationDay?: number,
): ScenarioImpact | null {
  const [impact, setImpact] = useState<ScenarioImpact | null>(null);

  useEffect(() => {
    if (!scenario) {
      setImpact(null);
      return;
    }
    let cancelled = false;
    fetchScenarioImpact(scenario, vehicleType || undefined, city, simulationDay)
      .then(d => { if (!cancelled) setImpact(d); })
      .catch(e => {
        console.error('[useScenarioImpact]', e);
        if (!cancelled) setImpact(null);
      });
    return () => { cancelled = true; };
    // bbox serialized — object identity changes on every filter spread.
  }, [scenario && JSON.stringify(scenario.bbox), vehicleType, city, simulationDay]);

  return impact;
}
