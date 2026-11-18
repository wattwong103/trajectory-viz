/**
 * Mega-sim LOD policy (survey §5–6).
 *
 * When capabilities.mega_sim is true, default layer visibility switches to
 * arcs + pulse and hides trails. The user may override via layer toggles or
 * presets; once overridden, auto-apply does not fight them again this session.
 */

import type { DatasetCapabilities } from './types';

/** Layer keys whose visibility defines the mega default composition. */
export const MEGA_AUTO_LAYER_VIS: Record<string, boolean> = {
  trajectories: false,
  sourceArcs: true,
  pulse: true,
  // Origins/destinations stay useful as OD context for arcs.
  origins: true,
  destinations: true,
};

export function isMegaSim(caps: DatasetCapabilities | null | undefined): boolean {
  if (!caps) return false;
  if (caps.mega_sim === true || caps.scale === 'mega') return true;
  return false;
}

/** Visibility patch applied once when mega capabilities first arrive. */
export function megaDefaultVisibility(): Record<string, boolean> {
  return { ...MEGA_AUTO_LAYER_VIS };
}

/**
 * True when a user action should stick as an LOD override (stop auto-reapply).
 * Turning trails back on, or applying a Trails/Cinematic preset that wants
 * trajectories, counts as override.
 */
export function marksLodOverride(
  nextVis: Record<string, boolean>,
  key?: string,
): boolean {
  if (key === 'trajectories' && nextVis.trajectories === true) return true;
  if (key === undefined && nextVis.trajectories === true) return true;
  return false;
}

/** Whether OD arcs should render for all sources (not only mode: arcs). */
export function forceOdArcs(caps: DatasetCapabilities | null | undefined): boolean {
  return isMegaSim(caps);
}
