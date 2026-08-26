/**
 * Deterministic per-source fallback colors — the single implementation of the
 * hash → palette pick that MapView, SourceLegend, and FilterPanel must agree
 * on so chips match trails across reloads.
 */

export const FALLBACK_PALETTE: [number, number, number][] = [
  [212, 160, 23], [43, 200, 80], [155, 89, 182], [231, 76, 60],
  [52, 152, 219], [26, 188, 156], [243, 156, 18], [233, 30, 99],
];

// Built-in v0.1 colors for the original two sources.
export const VEHICLE_TYPE_COLORS: Record<string, [number, number, number]> = {
  truck: [253, 128, 93],
  taxi:  [23, 184, 190],
};

export function sourceFallbackColor(sourceId: string): [number, number, number] {
  const known = VEHICLE_TYPE_COLORS[sourceId];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < sourceId.length; i++) {
    h = (h * 31 + sourceId.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}
