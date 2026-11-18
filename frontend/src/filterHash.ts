/**
 * URL hash codec for shareable dashboard links.
 *
 * Extracted from App so FilterState round-trips live in one module (and tests
 * import the real implementation instead of mirroring it).
 *
 * Form boundary: filters (universal-trajectory forms taxonomy).
 */

import type { FilterState } from './types';
import { MAX_AGENTS } from './components/AgentTab';

export const DEFAULT_FILTER: FilterState = {
  vehicleType: '', // empty = no source filter (all sources)
  minHour: 0,
  maxHour: 23,
};

/** Parse a finite-number query param; returns undefined if absent or NaN. */
export function numParam(params: URLSearchParams, key: string): number | undefined {
  const v = params.get(key);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function encodeHash(filter: FilterState): string {
  const parts: string[] = [];
  // TEMP: keep hash key `vt=` for shareable-URL stability (reads as source_id).
  // Rename to `sid=` in a later phase once bookmarks can migrate.
  if (filter.vehicleType) parts.push(`vt=${filter.vehicleType}`);
  if (filter.city) parts.push(`city=${encodeURIComponent(filter.city)}`);
  if (filter.simulationDay !== undefined) parts.push(`day=${filter.simulationDay}`);
  if (filter.minHour !== 0) parts.push(`minh=${filter.minHour}`);
  if (filter.maxHour !== 23) parts.push(`maxh=${filter.maxHour}`);
  if (filter.goodsType) parts.push(`gt=${encodeURIComponent(filter.goodsType)}`);
  // F1 advanced filters (Sprint A5): short keys keep the hash compact.
  if (filter.minSpeed !== undefined) parts.push(`ms=${filter.minSpeed}`);
  if (filter.maxSpeed !== undefined) parts.push(`xs=${filter.maxSpeed}`);
  if (filter.maxDwellMinutes !== undefined) parts.push(`xd=${filter.maxDwellMinutes}`);
  if (filter.minDetourRatio !== undefined) parts.push(`mr=${filter.minDetourRatio}`);
  if (filter.maxDetourRatio !== undefined) parts.push(`xr=${filter.maxDetourRatio}`);
  // Phase 1/C — mode selection + color scheme (tm= ints, ml= labels, cb)
  if (filter.modeLabels?.length) {
    parts.push(`ml=${filter.modeLabels.map(encodeURIComponent).join(',')}`);
  } else if (filter.transportModes?.length) {
    parts.push(`tm=${filter.transportModes.join(',')}`);
  }
  if (filter.colorBy === 'transportMode') parts.push('cb=tm');
  // Phase 4 — scenario: sc=p:{w},{s},{e},{n}
  if (filter.scenario) {
    const b = filter.scenario.bbox;
    parts.push(`sc=p:${b.w},${b.s},${b.e},${b.n}`);
  }
  return parts.join('&');
}

/** sc= value: 'p:' + four finite floats (w,s,e,n) with w<e, s<n. */
export function decodeScenario(params: URLSearchParams): FilterState['scenario'] {
  const sc = params.get('sc');
  if (!sc || !sc.startsWith('p:')) return undefined;
  const nums = sc.slice(2).split(',').map(Number);
  if (nums.length !== 4 || nums.some(v => !Number.isFinite(v))) return undefined;
  const [w, s, e, n] = nums;
  if (w >= e || s >= n) return undefined;
  return { type: 'pedestrianize', bbox: { w, s, e, n } };
}

// tm= value: comma-separated small ints, capped at 16 entries (mirrors the
// backend TripFilters pattern ^\d{1,2}(,\d{1,2}){0,15}$).
const TM_RE = /^\d{1,2}(,\d{1,2}){0,15}$/;
// ml= value: comma-separated mode labels (Phase C canonical string modes).
const ML_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-]{0,31}(,[A-Za-z0-9][A-Za-z0-9 _\-]{0,31}){0,15}$/;

export function decodeTransportModes(params: URLSearchParams): number[] | undefined {
  const tm = params.get('tm');
  if (!tm || !TM_RE.test(tm)) return undefined;
  const modes = [...new Set(tm.split(',').map(Number))];
  return modes.length > 0 ? modes : undefined;
}

export function decodeModeLabels(params: URLSearchParams): string[] | undefined {
  const ml = params.get('ml');
  if (!ml) return undefined;
  const decoded = ml.split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean);
  if (!decoded.length) return undefined;
  // Re-join to validate the same pattern the backend accepts.
  if (!ML_RE.test(decoded.join(','))) return undefined;
  return [...new Set(decoded)];
}

export function decodeHash(hash: string): FilterState {
  if (!hash || hash === '#') return DEFAULT_FILTER;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const vt = params.get('vt');
  // Accept any v0.2 source_id (server validates via Pydantic pattern); '' = all.
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
    modeLabels: decodeModeLabels(params),
    colorBy: params.get('cb') === 'tm' ? 'transportMode' : undefined,
    scenario: decodeScenario(params),
  };
}

// ─── Hidden-sources hash encoding (Phase 1 legend toggles) ────────────────
const SOURCE_ID_RE = /^[a-z][a-z0-9_]*$/;

export function encodeHiddenSources(hidden: string[]): string {
  if (hidden.length === 0) return '';
  return `hs=${hidden.join(',')}`;
}

export function decodeHiddenSources(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const hs = new URLSearchParams(raw).get('hs');
  if (!hs) return [];
  return hs.split(',').map(s => s.trim()).filter(s => SOURCE_ID_RE.test(s));
}

// ─── Disabled-POI-categories hash encoding ────────────────────────────────
const POI_CATEGORY_RE = /^[A-Za-z0-9_ \-]{1,40}$/;

export function encodeDisabledPoiCategories(disabled: string[]): string {
  if (disabled.length === 0) return '';
  return `pc=${encodeURIComponent(disabled.join(','))}`;
}

export function decodeDisabledPoiCategories(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const pc = new URLSearchParams(raw).get('pc');
  if (!pc) return [];
  return pc.split(',').map(s => s.trim()).filter(s => POI_CATEGORY_RE.test(s));
}

// ─── Agent-selection hash encoding (Phase 2A) ─────────────────────────────
// Mirrors the backend's by-vehicle key validation (routers/trajectories.py).
const AGENT_KEY_RE = /^[a-z][a-z0-9_]*:[A-Za-z0-9_:.\-]{1,64}$/;

export function encodeAgents(agents: string[]): string {
  if (agents.length === 0) return '';
  return `ag=${encodeURIComponent(agents.join(','))}`;
}

export function decodeAgents(hash: string): string[] {
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
