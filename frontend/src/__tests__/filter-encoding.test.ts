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
  transportModes?: number[];
  colorBy?: 'source' | 'transportMode';
  scenario?: { type: 'pedestrianize'; bbox: { w: number; s: number; e: number; n: number } };
};

const DEFAULT_FILTER: FilterState = {
  vehicleType: '',
  minHour: 0,
  maxHour: 23,
};

function numParam(params: URLSearchParams, key: string): number | undefined {
  const v = params.get(key);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function encodeHash(filter: FilterState): string {
  const parts: string[] = [];
  if (filter.vehicleType) parts.push(`vt=${filter.vehicleType}`);
  if (filter.city) parts.push(`city=${encodeURIComponent(filter.city)}`);
  if (filter.simulationDay !== undefined) parts.push(`day=${filter.simulationDay}`);
  if (filter.minHour !== 0) parts.push(`minh=${filter.minHour}`);
  if (filter.maxHour !== 23) parts.push(`maxh=${filter.maxHour}`);
  if (filter.goodsType) parts.push(`gt=${encodeURIComponent(filter.goodsType)}`);
  if (filter.minSpeed !== undefined) parts.push(`ms=${filter.minSpeed}`);
  if (filter.maxSpeed !== undefined) parts.push(`xs=${filter.maxSpeed}`);
  if (filter.maxDwellMinutes !== undefined) parts.push(`xd=${filter.maxDwellMinutes}`);
  if (filter.minDetourRatio !== undefined) parts.push(`mr=${filter.minDetourRatio}`);
  if (filter.maxDetourRatio !== undefined) parts.push(`xr=${filter.maxDetourRatio}`);
  if (filter.transportModes?.length) parts.push(`tm=${filter.transportModes.join(',')}`);
  if (filter.colorBy === 'transportMode') parts.push('cb=tm');
  if (filter.scenario) {
    const b = filter.scenario.bbox;
    parts.push(`sc=p:${b.w},${b.s},${b.e},${b.n}`);
  }
  return parts.join('&');
}

function decodeScenario(params: URLSearchParams): FilterState['scenario'] {
  const sc = params.get('sc');
  if (!sc || !sc.startsWith('p:')) return undefined;
  const nums = sc.slice(2).split(',').map(Number);
  if (nums.length !== 4 || nums.some(v => !Number.isFinite(v))) return undefined;
  const [w, s, e, n] = nums;
  if (w >= e || s >= n) return undefined;
  return { type: 'pedestrianize', bbox: { w, s, e, n } };
}

const TM_RE = /^\d{1,2}(,\d{1,2}){0,15}$/;

function decodeTransportModes(params: URLSearchParams): number[] | undefined {
  const tm = params.get('tm');
  if (!tm || !TM_RE.test(tm)) return undefined;
  const modes = [...new Set(tm.split(',').map(Number))];
  return modes.length > 0 ? modes : undefined;
}

function decodeHash(hash: string): FilterState {
  if (!hash || hash === '#') return DEFAULT_FILTER;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const vt = params.get('vt');
  return {
    vehicleType: (vt && /^[a-z][a-z0-9_]*$/.test(vt)) ? vt : '',
    city: params.get('city') ? decodeURIComponent(params.get('city')!) : undefined,
    simulationDay: numParam(params, 'day'),
    minHour: numParam(params, 'minh') ?? 0,
    maxHour: numParam(params, 'maxh') ?? 23,
    goodsType: params.get('gt') ? decodeURIComponent(params.get('gt')!) : undefined,
    minSpeed: numParam(params, 'ms'),
    maxSpeed: numParam(params, 'xs'),
    maxDwellMinutes: numParam(params, 'xd'),
    minDetourRatio: numParam(params, 'mr'),
    maxDetourRatio: numParam(params, 'xr'),
    transportModes: decodeTransportModes(params),
    colorBy: params.get('cb') === 'tm' ? 'transportMode' : undefined,
    scenario: decodeScenario(params),
  };
}

const SOURCE_ID_RE = /^[a-z][a-z0-9_]*$/;

function encodeHiddenSources(hidden: string[]): string {
  if (hidden.length === 0) return '';
  return `hs=${hidden.join(',')}`;
}

function decodeHiddenSources(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const hs = new URLSearchParams(raw).get('hs');
  if (!hs) return [];
  return hs.split(',').map(s => s.trim()).filter(s => SOURCE_ID_RE.test(s));
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
// Mirror of App.tsx's encodeAgents/decodeAgents (same convention as above:
// a shape change in App.tsx must break this test).

const MAX_AGENTS = 20;
const AGENT_KEY_RE = /^[a-z][a-z0-9_]*:[A-Za-z0-9_:.\-]{1,64}$/;

function encodeAgents(agents: string[]): string {
  if (agents.length === 0) return '';
  return `ag=${encodeURIComponent(agents.join(','))}`;
}

function decodeAgents(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const ag = new URLSearchParams(raw).get('ag');
  if (!ag) return [];
  return decodeURIComponent(ag)
    .split(',')
    .map(k => k.trim())
    .filter(k => AGENT_KEY_RE.test(k))
    .slice(0, MAX_AGENTS);
}

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
