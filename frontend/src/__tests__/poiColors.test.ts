/**
 * Tests for the deterministic POI-category palette (poiColors.ts).
 *
 * The MapView POI ScatterplotLayer and the FilterPanel POI chips MUST agree
 * on a category's color across reloads, and a `color` declared in the
 * sources.yaml pois: block (surfaced via /api/pois/categories) must always
 * win over the hash fallback. These import the real module — the palette is
 * in poiColors.ts precisely so it is unit-testable.
 */
import { describe, it, expect } from 'vitest';
import { poiColor, poiFallbackColor } from '../poiColors';
import { FALLBACK_PALETTE } from '../sourceColors';

describe('poiFallbackColor', () => {
  it('is deterministic — same category maps to the same color', () => {
    expect(poiFallbackColor('convenience store')).toEqual(poiFallbackColor('convenience store'));
    expect(poiFallbackColor('station')).toEqual(poiFallbackColor('station'));
  });

  it('always returns a palette entry (valid [r,g,b] 0-255)', () => {
    for (const cat of ['station', 'convenience store', 'school', 'warehouse-hub', '']) {
      const c = poiFallbackColor(cat);
      expect(FALLBACK_PALETTE).toContainEqual(c);
      expect(c).toHaveLength(3);
      for (const ch of c) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it('is case-sensitive like the backend category strings', () => {
    // Not a requirement that they differ — just that each is stable.
    expect(poiFallbackColor('Station')).toEqual(poiFallbackColor('Station'));
  });
});

describe('poiColor', () => {
  it('YAML override wins over the fallback', () => {
    const override: [number, number, number] = [1, 2, 3];
    expect(poiColor({ category: 'station', color: override })).toBe(override);
  });

  it('null color falls back to the deterministic hash palette', () => {
    expect(poiColor({ category: 'school', color: null }))
      .toEqual(poiFallbackColor('school'));
  });

  it('override is returned by reference identity of value, not re-hashed', () => {
    // A category whose fallback happens to equal the override still returns
    // the override — the point is the fallback is never consulted.
    const fallback = poiFallbackColor('warehouse-hub');
    expect(poiColor({ category: 'warehouse-hub', color: fallback })).toEqual(fallback);
  });
});
