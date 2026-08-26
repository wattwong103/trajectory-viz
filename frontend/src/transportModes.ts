/**
 * Transport-mode metadata — labels + colors for the PFLOW transport_mode ids.
 *
 * NAMING: "mode" alone is taken in this codebase (SourceStyle.mode = render
 * treatment 'trails'|'points'|'arcs'). Everything transport-mode-related uses
 * the full transportMode / transport_mode name.
 *
 * The id space comes from Pseudo-PFLOW's mode-choice step (walk, bicycle,
 * bus, car, railway) plus the taxi ABM's 8. The value shown here is always
 * the TRIP's mode (trips.transport_mode) — waypoint modes are uniform per
 * source in router output and are never surfaced.
 */

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
