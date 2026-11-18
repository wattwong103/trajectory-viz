/**
 * Smoke tests for filter state encoding/decoding (Phase 3 Step 3.3).
 *
 * The URL hash round-trip is load-bearing for shareable dashboard links.
 * Tests import the real codec from filterHash (extracted from App).
 */
import { describe, it, expect } from 'vitest';
import type { FilterState } from '../types';
import {
  DEFAULT_FILTER,
  encodeHash,
  decodeHash,
  encodeHiddenSources,
  decodeHiddenSources,
  encodeAgents,
  decodeAgents,
} from '../filterHash';
import { MAX_AGENTS } from '../components/AgentTab';

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

  // ── F1 advanced filters (Sprint A5) ────────────────────────────────────

  it('encodes only the F1 fields that are set', () => {
    expect(encodeHash({ ...DEFAULT_FILTER, minSpeed: 20 })).toBe('ms=20');
    expect(encodeHash({ ...DEFAULT_FILTER, maxSpeed: 60 })).toBe('xs=60');
    expect(encodeHash({ ...DEFAULT_FILTER, maxDwellMinutes: 30 })).toBe('xd=30');
    expect(encodeHash({ ...DEFAULT_FILTER, minDetourRatio: 1.2 })).toBe('mr=1.2');
    expect(encodeHash({ ...DEFAULT_FILTER, maxDetourRatio: 3 })).toBe('xr=3');
  });

  it('round-trips all F1 fields together', () => {
    const original: FilterState = {
      vehicleType: 'taxi',
      minHour: 0,
      maxHour: 23,
      minSpeed: 20,
      maxSpeed: 60,
      maxDwellMinutes: 45,
      minDetourRatio: 1.2,
      maxDetourRatio: 2.5,
    };
    const out = decodeHash(encodeHash(original));
    expect(out).toMatchObject(original);
  });

  it('F1 fields decode as undefined when absent', () => {
    const out = decodeHash('#vt=truck');
    expect(out.minSpeed).toBeUndefined();
    expect(out.maxSpeed).toBeUndefined();
    expect(out.maxDwellMinutes).toBeUndefined();
    expect(out.minDetourRatio).toBeUndefined();
    expect(out.maxDetourRatio).toBeUndefined();
  });

  it('decodes garbage F1 values as undefined (e.g. NaN)', () => {
    expect(decodeHash('#ms=abc').minSpeed).toBeUndefined();
    expect(decodeHash('#xr=not_a_number').maxDetourRatio).toBeUndefined();
  });

  it('encodes nothing when all filters are at default', () => {
    // simulationDay=undefined is the default; encode skips it.
    expect(encodeHash(DEFAULT_FILTER)).toBe('');
  });

  // ── Transport mode + color-by (Phase 1) ────────────────────────────────

  it('round-trips transport modes and colorBy', () => {
    const original: FilterState = {
      ...DEFAULT_FILTER,
      transportModes: [0, 3, 8],
      colorBy: 'transportMode',
    };
    const out = decodeHash(encodeHash(original));
    expect(out.transportModes).toEqual([0, 3, 8]);
    expect(out.colorBy).toBe('transportMode');
  });

  it('encodes tm/cb only when set', () => {
    expect(encodeHash({ ...DEFAULT_FILTER, transportModes: [0, 3] })).toBe('tm=0,3');
    expect(encodeHash({ ...DEFAULT_FILTER, transportModes: [] })).toBe('');
    expect(encodeHash({ ...DEFAULT_FILTER, colorBy: 'transportMode' })).toBe('cb=tm');
    expect(encodeHash({ ...DEFAULT_FILTER, colorBy: 'source' })).toBe('');
  });

  it('rejects malformed tm values', () => {
    expect(decodeHash('#tm=abc').transportModes).toBeUndefined();
    expect(decodeHash('#tm=0,x,3').transportModes).toBeUndefined();
    expect(decodeHash('#tm=999').transportModes).toBeUndefined();  // 3 digits
    expect(decodeHash('#tm=0;DROP').transportModes).toBeUndefined();
    // > 16 entries fails the pattern
    const many = Array.from({ length: 20 }, (_, i) => i).join(',');
    expect(decodeHash(`#tm=${many}`).transportModes).toBeUndefined();
  });

  it('dedupes repeated tm entries', () => {
    expect(decodeHash('#tm=0,0,3').transportModes).toEqual([0, 3]);
  });

  // ── Pedestrianize scenario (Phase 4) ───────────────────────────────────

  it('round-trips the scenario', () => {
    const original: FilterState = {
      ...DEFAULT_FILTER,
      scenario: { type: 'pedestrianize', bbox: { w: 139.575, s: 35.7, e: 139.585, n: 35.71 } },
    };
    const out = decodeHash(encodeHash(original));
    expect(out.scenario).toEqual(original.scenario);
  });

  it('rejects malformed sc values', () => {
    expect(decodeHash('#sc=p:1,2,3').scenario).toBeUndefined();          // 3 coords
    expect(decodeHash('#sc=p:a,b,c,d').scenario).toBeUndefined();        // NaN
    expect(decodeHash('#sc=p:140,36,139,35').scenario).toBeUndefined();  // w>=e, s>=n
    expect(decodeHash('#sc=x:139,35,140,36').scenario).toBeUndefined();  // unknown type
    expect(decodeHash('#vt=truck').scenario).toBeUndefined();            // absent
  });

  it('scenario coexists with other keys', () => {
    const hash = '#vt=taxi&tm=3&sc=p:139.5,35.6,139.6,35.7';
    const out = decodeHash(hash);
    expect(out.vehicleType).toBe('taxi');
    expect(out.transportModes).toEqual([3]);
    expect(out.scenario?.bbox.e).toBe(139.6);
  });
});

// ── Hidden-sources hash (Phase 1 legend toggles) ───────────────────────────

describe('hidden-sources hash encoding', () => {
  it('round-trips hidden sources', () => {
    expect(decodeHiddenSources('#' + encodeHiddenSources(['truck', 'people'])))
      .toEqual(['truck', 'people']);
  });

  it('encodes nothing for an empty list', () => {
    expect(encodeHiddenSources([])).toBe('');
  });

  it('drops malformed source_ids', () => {
    expect(decodeHiddenSources('#hs=truck,Taxi,1bad,ok_one'))
      .toEqual(['truck', 'ok_one']);
  });

  it('coexists with filter keys in the same hash', () => {
    const hash = '#vt=taxi&tm=8&hs=truck';
    expect(decodeHash(hash).vehicleType).toBe('taxi');
    expect(decodeHash(hash).transportModes).toEqual([8]);
    expect(decodeHiddenSources(hash)).toEqual(['truck']);
  });
});

// ── Agent-selection hash (Phase 2A) ────────────────────────────────────────

describe('agent-selection hash encoding (Phase 2A)', () => {
  it('round-trips a selection', () => {
    const agents = ['truck:1001', 'taxi:tokyo:47'];
    expect(decodeAgents('#' + encodeAgents(agents))).toEqual(agents);
  });

  it('encodes nothing for an empty selection', () => {
    expect(encodeAgents([])).toBe('');
  });

  it('coexists with filter keys in the same hash', () => {
    const hash = '#vt=taxi&' + encodeAgents(['taxi:tokyo:47']);
    expect(decodeHash(hash).vehicleType).toBe('taxi');
    expect(decodeAgents(hash)).toEqual(['taxi:tokyo:47']);
  });

  it('caps at MAX_AGENTS on decode', () => {
    const many = Array.from({ length: 25 }, (_, i) => `truck:${i}`);
    expect(decodeAgents('#' + encodeAgents(many))).toHaveLength(MAX_AGENTS);
  });

  it('drops malformed keys (defends against URL injection)', () => {
    const hash = '#ag=' + encodeURIComponent("truck:1001,'; DROP TABLE--,UPPER:1,taxi:tokyo:47");
    expect(decodeAgents(hash)).toEqual(['truck:1001', 'taxi:tokyo:47']);
  });

  it('decodes empty for hashes without ag=', () => {
    expect(decodeAgents('#vt=truck')).toEqual([]);
    expect(decodeAgents('')).toEqual([]);
  });
});
