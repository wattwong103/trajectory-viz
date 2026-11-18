/**
 * Curated MapLibre basemap styles (TV-30 S5).
 *
 * Default stays Carto Dark Matter for demo brand continuity. Share via URL
 * hash (`bm=`); mirror last pick in localStorage for return visits.
 */

export const BASEMAP_STORAGE_KEY = 'trajectory-viz-basemap';

export type BasemapId = 'dark' | 'light' | 'voyager';

export interface BasemapOption {
  id: BasemapId;
  label: string;
  styleUrl: string;
}

export const BASEMAP_OPTIONS: BasemapOption[] = [
  {
    id: 'dark',
    label: 'Dark Matter',
    styleUrl: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
  {
    id: 'light',
    label: 'Positron',
    styleUrl: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  },
  {
    id: 'voyager',
    label: 'Voyager',
    styleUrl: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  },
];

export const DEFAULT_BASEMAP_ID: BasemapId = 'dark';

export type BasemapSelection =
  | { kind: 'preset'; id: BasemapId }
  | { kind: 'custom'; url: string };

export function styleUrlFor(sel: BasemapSelection): string {
  if (sel.kind === 'custom') return sel.url;
  return BASEMAP_OPTIONS.find(o => o.id === sel.id)?.styleUrl
    ?? BASEMAP_OPTIONS[0].styleUrl;
}

export function encodeBasemap(sel: BasemapSelection): string {
  if (sel.kind === 'custom') {
    return `bm=u:${encodeURIComponent(sel.url)}`;
  }
  if (sel.id === DEFAULT_BASEMAP_ID) return '';
  return `bm=${sel.id}`;
}

export function decodeBasemap(hash: string): BasemapSelection | null {
  if (!hash || hash === '#') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const bm = new URLSearchParams(raw).get('bm');
  if (!bm) return null;
  if (bm.startsWith('u:')) {
    const url = decodeURIComponent(bm.slice(2));
    if (isPlausibleStyleUrl(url)) return { kind: 'custom', url };
    return null;
  }
  if (BASEMAP_OPTIONS.some(o => o.id === bm)) {
    return { kind: 'preset', id: bm as BasemapId };
  }
  return null;
}

export function isPlausibleStyleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return u.pathname.endsWith('.json') || u.pathname.includes('style');
  } catch {
    return false;
  }
}

export function loadBasemapFromStorage(): BasemapSelection | null {
  try {
    const raw = localStorage.getItem(BASEMAP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BasemapSelection;
    if (parsed?.kind === 'preset' && BASEMAP_OPTIONS.some(o => o.id === parsed.id)) {
      return parsed;
    }
    if (parsed?.kind === 'custom' && typeof parsed.url === 'string'
      && isPlausibleStyleUrl(parsed.url)) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveBasemapToStorage(sel: BasemapSelection): void {
  try {
    localStorage.setItem(BASEMAP_STORAGE_KEY, JSON.stringify(sel));
  } catch {
    /* ignore quota / private mode */
  }
}

export function resolveInitialBasemap(hash: string): BasemapSelection {
  return decodeBasemap(hash)
    ?? loadBasemapFromStorage()
    ?? { kind: 'preset', id: DEFAULT_BASEMAP_ID };
}
