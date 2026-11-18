/**
 * Simulation-scale LOD policy (micro / meso / macro).
 *
 * Canonical wire: capabilities.scale ∈ {micro, meso, macro}.
 * Macro aligns with mega-sim LOD (#18): default arcs + pulse, hide trails.
 * Micro keeps fine trails + agents — never force arcs+pulse when N is small.
 * `mega_sim` / scale `"mega"` remain aliases for macro.
 */

import type { DatasetCapabilities, SimScale } from './types';

/** Layer keys whose visibility defines the macro / mega default composition. */
export const MACRO_AUTO_LAYER_VIS: Record<string, boolean> = {
  trajectories: false,
  sourceArcs: true,
  pulse: true,
  // Origins/destinations stay useful as OD context for arcs.
  origins: true,
  destinations: true,
};

/** @deprecated Prefer MACRO_AUTO_LAYER_VIS — kept for #18 call sites / tests. */
export const MEGA_AUTO_LAYER_VIS = MACRO_AUTO_LAYER_VIS;

/** Micro default: fine trails + agents; pulse off (never force arcs+pulse). */
export const MICRO_AUTO_LAYER_VIS: Record<string, boolean> = {
  trajectories: true,
  pulse: false,
  agents: true,
  origins: true,
  destinations: true,
};

export function resolveSimScale(
  caps: DatasetCapabilities | null | undefined,
): SimScale | null {
  if (!caps) return null;
  const raw = (caps.scale ?? '').toLowerCase();
  if (raw === 'micro' || raw === 'meso' || raw === 'macro') return raw;
  // Legacy aliases from #18 wire / YAML override.
  if (raw === 'mega' || caps.mega_sim === true) return 'macro';
  if (raw === 'standard') return 'meso';
  return null;
}

/** True for macro / mega aggregate-first LOD. */
export function isMegaSim(caps: DatasetCapabilities | null | undefined): boolean {
  const scale = resolveSimScale(caps);
  if (scale === 'macro') return true;
  if (!caps) return false;
  return caps.mega_sim === true;
}

export function isMicroScale(caps: DatasetCapabilities | null | undefined): boolean {
  return resolveSimScale(caps) === 'micro';
}

export function isMacroScale(caps: DatasetCapabilities | null | undefined): boolean {
  return resolveSimScale(caps) === 'macro';
}

/** Visibility patch applied once when macro capabilities first arrive. */
export function megaDefaultVisibility(): Record<string, boolean> {
  return { ...MACRO_AUTO_LAYER_VIS };
}

export function macroDefaultVisibility(): Record<string, boolean> {
  return megaDefaultVisibility();
}

/** Visibility patch for explicit micro (avoids inheriting a prior macro session). */
export function microDefaultVisibility(): Record<string, boolean> {
  return { ...MICRO_AUTO_LAYER_VIS };
}

/**
 * Default visibility patch for a resolved scale.
 * Meso returns null — keep DEFAULT_LAYER_VIS / user state.
 */
export function defaultVisibilityForScale(
  scale: SimScale | null,
): Record<string, boolean> | null {
  if (scale === 'macro') return macroDefaultVisibility();
  if (scale === 'micro') return microDefaultVisibility();
  return null;
}

/**
 * True when a user action should stick as an LOD override (stop auto-reapply).
 * Turning trails back on, or applying a Trails/Cinematic preset that wants
 * trajectories, counts as override (macro). Turning pulse/arcs on against
 * micro defaults also sticks.
 */
export function marksLodOverride(
  nextVis: Record<string, boolean>,
  key?: string,
  scale?: SimScale | null,
): boolean {
  const s = scale ?? null;
  if (s === 'macro' || s === null) {
    if (key === 'trajectories' && nextVis.trajectories === true) return true;
    if (key === undefined && nextVis.trajectories === true) return true;
  }
  if (s === 'micro') {
    // Turning pulse on (or applying a Macro/Mega preset) sticks as override.
    if (key === 'pulse' && nextVis.pulse === true) return true;
    if (key === undefined && nextVis.pulse === true && nextVis.trajectories === false) {
      return true;
    }
  }
  return false;
}

/** Whether OD arcs should render for all sources (not only mode: arcs). */
export function forceOdArcs(caps: DatasetCapabilities | null | undefined): boolean {
  return isMacroScale(caps) || isMegaSim(caps);
}
