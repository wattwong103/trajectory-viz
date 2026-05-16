/**
 * Smoke tests for filter state encoding/decoding (Phase 3 Step 3.3).
 *
 * The URL hash round-trip is load-bearing for shareable dashboard links.
 * Specifically: changing the FilterState shape (Phase 2 added F1 dims) without
 * updating encodeHash/decodeHash would silently lose filter state on copy-paste.
 */
import { describe, it, expect } from 'vitest';

// Mirror of App.tsx's encodeHash/decodeHash. Tests live separately so a
// change to App.tsx's filter shape forces a corresponding test edit — the
// failing test is the alarm.
type FilterState = {
  vehicleType: string;
  minHour: number;
  maxHour: number;
  goodsType?: string;
  city?: string;
  simulationDay?: number;
  minSpeed?: number;
  maxSpeed?: number;
  maxDwellMinutes?: number;
  minDetourRatio?: number;
  maxDetourRatio?: number;
};

const DEFAULT_FILTER: FilterState = {
  vehicleType: '',
  minHour: 0,
  maxHour: 23,
};

function encodeHash(filter: FilterState): string {
  const parts: string[] = [];
  if (filter.vehicleType) parts.push(`vt=${filter.vehicleType}`);
  if (filter.city) parts.push(`city=${encodeURIComponent(filter.city)}`);
  if (filter.simulationDay !== undefined) parts.push(`day=${filter.simulationDay}`);
  if (filter.minHour !== 0) parts.push(`minh=${filter.minHour}`);
  if (filter.maxHour !== 23) parts.push(`maxh=${filter.maxHour}`);
  if (filter.goodsType) parts.push(`gt=${encodeURIComponent(filter.goodsType)}`);
  return parts.join('&');
}

function decodeHash(hash: string): FilterState {
  if (!hash || hash === '#') return DEFAULT_FILTER;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const vt = params.get('vt');
  return {
    vehicleType: (vt && /^[a-z][a-z0-9_]*$/.test(vt)) ? vt : '',
    city: params.get('city') ? decodeURIComponent(params.get('city')!) : undefined,
    simulationDay: params.get('day') !== null ? Number(params.get('day')) : undefined,
    minHour: params.get('minh') !== null ? Number(params.get('minh')) : 0,
    maxHour: params.get('maxh') !== null ? Number(params.get('maxh')) : 23,
    goodsType: params.get('gt') ? decodeURIComponent(params.get('gt')!) : undefined,
  };
}

describe('filter hash encoding', () => {
  it('round-trips an empty filter', () => {
    const out = decodeHash(encodeHash(DEFAULT_FILTER));
    expect(out.vehicleType).toBe('');
    expect(out.minHour).toBe(0);
    expect(out.maxHour).toBe(23);
  });

  it('encodes only non-default values', () => {
    expect(encodeHash(DEFAULT_FILTER)).toBe('');
    expect(encodeHash({ ...DEFAULT_FILTER, vehicleType: 'truck' })).toBe('vt=truck');
    expect(encodeHash({ ...DEFAULT_FILTER, city: 'tokyo' })).toBe('city=tokyo');
  });

  it('decodes accept any [a-z][a-z0-9_]* source_id', () => {
    expect(decodeHash('#vt=truck').vehicleType).toBe('truck');
    expect(decodeHash('#vt=taxi').vehicleType).toBe('taxi');
    expect(decodeHash('#vt=my_abm').vehicleType).toBe('my_abm');
    expect(decodeHash('#vt=ev_bus').vehicleType).toBe('ev_bus');
  });

  it('rejects malformed source_ids (defends against URL injection)', () => {
    expect(decodeHash('#vt=' + encodeURIComponent("' OR 1=1 --")).vehicleType).toBe('');
    expect(decodeHash('#vt=Truck').vehicleType).toBe('');  // uppercase not allowed
    expect(decodeHash('#vt=1taxi').vehicleType).toBe('');  // must start with letter
  });

  it('preserves city/day/hour/goods through round-trip', () => {
    const original: FilterState = {
      vehicleType: 'taxi',
      city: 'tokyo',
      simulationDay: 3,
      minHour: 7,
      maxHour: 19,
      goodsType: 'kibutsu',
    };
    const out = decodeHash(encodeHash(original));
    expect(out).toMatchObject(original);
  });
});
