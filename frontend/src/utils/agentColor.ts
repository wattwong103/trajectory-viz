/**
 * Followed-agent highlight color.
 *
 * ≤8 agents: follow-order palette so individuals are distinguishable.
 * >8 (a type cohort): color by source / transport mode so 20 trucks are
 * not 20 unrelated hues.
 */

import { sourceFallbackColor } from '../sourceColors';
import { transportModeColor } from '../transportModes';

export const AGENT_COLORS: [number, number, number][] = [
  [255, 230, 100], [0, 255, 200], [255, 105, 180], [130, 200, 255],
  [255, 160, 40], [190, 130, 255], [120, 255, 120], [255, 90, 90],
];

export const FOLLOW_ORDER_CAP = 8;

export function agentHighlightColor(
  key: string,
  selectedAgents: readonly string[],
  meta: { vehicle_type: string; transport_mode?: number | null },
  colorBy: 'source' | 'transportMode',
  colorFor: (sourceId: string) => [number, number, number] = sourceFallbackColor,
): [number, number, number] {
  if (selectedAgents.length > FOLLOW_ORDER_CAP) {
    return colorBy === 'transportMode'
      ? transportModeColor(meta.transport_mode)
      : colorFor(meta.vehicle_type);
  }
  const idx = selectedAgents.indexOf(key);
  return AGENT_COLORS[(idx >= 0 ? idx : 0) % AGENT_COLORS.length];
}

/** Chip color when we only have the vehicle_key (Agents tab). */
export function agentChipColor(
  key: string,
  index: number,
  selectedCount: number,
  colorBy: 'source' | 'transportMode' = 'source',
): [number, number, number] {
  if (selectedCount > FOLLOW_ORDER_CAP) {
    const source = key.split(':')[0] ?? key;
    return colorBy === 'transportMode'
      ? transportModeColor(null)
      : sourceFallbackColor(source);
  }
  return AGENT_COLORS[index % AGENT_COLORS.length];
}
