/**
 * Tests for POI sprite glyphs (poiSprites.ts).
 *
 * The glyph mapping is pure and fully testable; the atlas builder is
 * environment-guarded — jsdom's canvas has no 2d context, so it must return
 * null there (MapView keeps the dot layer in that case, which the browser
 * never hits because real canvases exist).
 */
import { describe, it, expect } from 'vitest';
import {
  poiGlyphFor, POI_DEFAULT_GLYPH, buildPoiIconAtlas,
} from '../poiSprites';
import type { PoiCategory } from '../types';

describe('poiGlyphFor', () => {
  it('maps demo categories (station/mall/park)', () => {
    expect(poiGlyphFor('station')).toBe('🚉');
    expect(poiGlyphFor('mall')).toBe('🛍');
    expect(poiGlyphFor('park')).toBe('🌳');
  });

  it('covers common OSM-style vocab, case-insensitively', () => {
    expect(poiGlyphFor('Railway Station')).toBe('🚉');
    expect(poiGlyphFor('convenience_store')).toBe('🛍');
    expect(poiGlyphFor('Cafe')).toBe('🍴');
    expect(poiGlyphFor('hospital')).toBe('⚕');
  });

  it('falls back to a pin for unknown categories', () => {
    expect(poiGlyphFor('volcano')).toBe(POI_DEFAULT_GLYPH);
    expect(poiGlyphFor('')).toBe(POI_DEFAULT_GLYPH);
  });
});

describe('buildPoiIconAtlas', () => {
  const cat = (category: string): PoiCategory => ({
    category, count: 1, color: null, label: null, source_key: 'k',
  });

  it('returns null without a canvas 2d context (jsdom)', () => {
    // jsdom's HTMLCanvasElement.getContext returns null — the exact
    // contract MapView's dot fallback depends on.
    expect(buildPoiIconAtlas([cat('station')], {})).toBeNull();
  });

  it('returns null for an empty category set even with canvas', () => {
    expect(buildPoiIconAtlas([], {})).toBeNull();
  });
});
