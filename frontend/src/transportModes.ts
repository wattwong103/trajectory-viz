/**
 * Transport-mode metadata — labels + colors for the PFLOW transport_mode ids.
 *
 * NAMING: "mode" alone is taken in this codebase (SourceStyle.mode = render
 * treatment 'trails'|'points'|'arcs'). Everything transport-mode-related uses
 * the full transportMode / transport_mode name.
 *
 * Public UI language is the **string label** (from filter-options `modes[]` /
 * sources.yaml `mode_map` / trips.mode). Phase C prefers `modes=` labels on
 * the wire; integer `transport_modes=` remains for PFLOW mode_code compat.
 * The value shown is always the TRIP's mode — waypoint modes are uniform per
 * source in router output and are never surfaced.
 */

import type { ModeOption } from './types';

export const TRANSPORT_MODE_META: Record<number, { label: string; color: [number, number, number] }> = {
  0: { label: 'Walk',  color: [43, 200, 80] },    // green
  1: { label: 'Bike',  color: [26, 188, 156] },   // teal-green
  2: { label: 'Bus',   color: [243, 156, 18] },   // orange
  3: { label: 'Car',   color: [231, 76, 60] },    // red
  4: { label: 'Train', color: [155, 89, 182] },   // purple
  8: { label: 'Taxi',  color: [23, 184, 190] },   // brand teal (matches taxi trail)
};

const UNKNOWN_COLOR: [number, number, number] = [128, 128, 128];

export function transportModeLabel(m?: number | null): string {
  if (m === undefined || m === null) return 'unknown mode';
  return TRANSPORT_MODE_META[m]?.label ?? `mode ${m}`;
}

export function transportModeColor(m?: number | null): [number, number, number] {
  if (m === undefined || m === null) return UNKNOWN_COLOR;
  return TRANSPORT_MODE_META[m]?.color ?? UNKNOWN_COLOR;
}

/**
 * Prefer labeled `modes[]` from filter-options; fall back to transport_modes
 * counts + default PFLOW labels. Chips submit string labels (and ints when
 * a PFLOW mode_code id is present).
 */
export function resolveModeOptions(
  modes?: ModeOption[] | null,
  transportModes?: Array<{ mode: number; count: number }> | null,
): ModeOption[] {
  if (modes && modes.length > 0) return modes;
  return (transportModes ?? []).map(({ mode, count }) => ({
    id: mode,
    label: transportModeLabel(mode),
    count,
  }));
}
