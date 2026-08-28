/**
 * POI sprite glyphs — category → unicode glyph + runtime-built icon atlas
 * for MapView's POI IconLayer. Same contract as poiColors.ts: the mapping
 * here must agree with the FilterPanel chips (which stay color-only), so a
 * category's glyph and its chip always describe the same place.
 *
 * The atlas is drawn client-side on an offscreen canvas — no external image
 * assets, tinted per category color (YAML override → hash fallback via
 * poiColor). Environments without canvas 2d (jsdom) get null and MapView
 * falls back to the plain dot layer.
 */

import type { PoiCategory } from './types';

// Ordered: first matching rule wins. Keywords lowercase against the raw
// category string — covers the demo set (station/mall/park) plus the
// common OpenStreetMap-style amenity vocabularies.
const POI_GLYPH_RULES: Array<[RegExp, string]> = [
  [/station|rail|train|metro|subway|bus|transport|transit/, '🚉'],
  [/mall|shop|store|market|retail|department/, '🛍'],
  [/park|garden|green|forest|playground/, '🌳'],
  [/restaurant|food|ramen|soba|izakaya|cafe|coffee|bar|eatery/, '🍴'],
  [/school|university|college|kindergarten|library/, '🎓'],
  [/hospital|clinic|medical|pharmacy|health/, '⚕'],
  [/hotel|hostel|ryokan|inn/, '🛏'],
  [/bank|atm|post|office/, '🏦'],
  [/museum|art|gallery|theatre|theater|zoo|aquarium/, '🎭'],
  [/fuel|gas|charging/, '⛽'],
];

/** Fallback glyph when no rule matches — a filled pin, not a letter. */
export const POI_DEFAULT_GLYPH = '📍';

export function poiGlyphFor(category: string): string {
  const needle = category.toLowerCase();
  for (const [re, glyph] of POI_GLYPH_RULES) {
    if (re.test(needle)) return glyph;
  }
  return POI_DEFAULT_GLYPH;
}

export interface PoiIconAtlas {
  /** Data-URL PNG of the sprite sheet (IconLayer's `iconAtlas`). */
  url: string;
  /**
   * DeckGL `iconMapping`: category → cell geometry in the sheet. Kept as a
   * structural match for deck's IconMapping ({x,y,width,height} per icon)
   * so MapView can pass it straight through.
   */
  iconFor: Record<string, { x: number; y: number; width: number; height: number }>;
}

const CELL = 64;

/**
 * Draw the sprite sheet: one CELL×CELL cell per distinct category, glyph
 * centered on a translucent disc in the category's color. Returns null when
 * the environment has no usable canvas 2d context (e.g. jsdom without node-
 * canvas) — callers keep their dot fallback in that case.
 */
export function buildPoiIconAtlas(
  categories: PoiCategory[],
  colorByCategory: Record<string, [number, number, number]>,
): PoiIconAtlas | null {
  // Distinct categories only, stable order.
  const cats = [...new Set(categories.map(c => c.category))].sort();
  if (cats.length === 0) return null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.fillText !== 'function') return null;

  const columns = Math.min(cats.length, 16);
  const rows = Math.ceil(cats.length / columns);
  canvas.width = columns * CELL;
  canvas.height = rows * CELL;

  const iconFor: PoiIconAtlas['iconFor'] = {};
  cats.forEach((cat, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * CELL;
    const y = row * CELL;
    const c = colorByCategory[cat] ?? [200, 200, 200];

    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.35)`;
    ctx.beginPath();
    ctx.arc(x + CELL / 2, y + CELL / 2, CELL / 2 - 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '36px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(poiGlyphFor(cat), x + CELL / 2, y + CELL / 2 + 2);

    iconFor[cat] = { x, y, width: CELL, height: CELL };
  });

  return { url: canvas.toDataURL('image/png'), iconFor };
}
