/**
 * Tests for unionBboxes (src/utils/bbox.ts) — the pure math behind the
 * first-load auto-fit. Imports the real module.
 */
import { describe, it, expect } from 'vitest';
import { unionBboxes, type Bbox } from '../utils/bbox';

const KICHIJOJI_COURIERS: Bbox = { min_lon: 139.55, max_lon: 139.60, min_lat: 35.69, max_lat: 35.71 };
const KICHIJOJI_BUSES: Bbox = { min_lon: 139.57, max_lon: 139.62, min_lat: 35.70, max_lat: 35.72 };

describe('unionBboxes', () => {
  it('unions multiple bboxes into the enclosing extent', () => {
    expect(unionBboxes([KICHIJOJI_COURIERS, KICHIJOJI_BUSES])).toEqual({
      min_lon: 139.55, max_lon: 139.62, min_lat: 35.69, max_lat: 35.72,
    });
  });

  it('returns a copy of a single bbox (not the input reference)', () => {
    const out = unionBboxes([KICHIJOJI_COURIERS]);
    expect(out).toEqual(KICHIJOJI_COURIERS);
    expect(out).not.toBe(KICHIJOJI_COURIERS);
  });

  it('keeps a degenerate point bbox as that point', () => {
    const point: Bbox = { min_lon: 139.579, max_lon: 139.579, min_lat: 35.703, max_lat: 35.703 };
    expect(unionBboxes([point])).toEqual(point);
  });

  it('returns null for empty input', () => {
    expect(unionBboxes([])).toBeNull();
  });

  it('returns null when every entry is null/undefined', () => {
    expect(unionBboxes([null, undefined])).toBeNull();
  });

  it('skips non-finite entries instead of poisoning the union', () => {
    const nan: Bbox = { min_lon: NaN, max_lon: 1, min_lat: 0, max_lat: 1 };
    const inf: Bbox = { min_lon: 0, max_lon: Infinity, min_lat: 0, max_lat: 1 };
    expect(unionBboxes([nan, KICHIJOJI_BUSES, inf])).toEqual(KICHIJOJI_BUSES);
  });

  it('skips inverted corners (min > max)', () => {
    const inverted: Bbox = { min_lon: 139.62, max_lon: 139.55, min_lat: 35.69, max_lat: 35.71 };
    expect(unionBboxes([inverted, KICHIJOJI_COURIERS])).toEqual(KICHIJOJI_COURIERS);
    expect(unionBboxes([inverted])).toBeNull();
  });
});
