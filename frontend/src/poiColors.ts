/**
 * Deterministic per-POI-category fallback colors — the single implementation
 * of the category → color mapping that MapView's POI ScatterplotLayer and
 * FilterPanel's POI chips must agree on, so chips match map dots across
 * reloads (same discipline as sourceColors.ts).
 *
 * A `color` declared on the pois: block in sources.yaml (surfaced by
 * /api/pois/categories) always wins; categories without one get a stable
 * hash pick from the palette below.
 */

import { FALLBACK_PALETTE } from './sourceColors';
import type { PoiCategory } from './types';

// Same 31-based string hash as sourceColors.sourceFallbackColor — one hash
// family across the app keeps fallback colors visually consistent.
export function poiFallbackColor(category: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < category.length; i++) {
    h = (h * 31 + category.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

// YAML override wins; otherwise the deterministic hash fallback.
export function poiColor(
  cat: Pick<PoiCategory, 'category' | 'color'>,
): [number, number, number] {
  return cat.color ?? poiFallbackColor(cat.category);
}
