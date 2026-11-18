/**
 * Upload utilities — accepted-extension check, GeoJSON role suggestion, and
 * ingest-phase label formatting. Pure + dependency-free so unit-testable.
 */

import type {
  IngestJobProgress, IngestPhase, UploadOverlayRole,
} from './types';

// Mirrors backend/routers/ingest_api.py _ALLOWED_EXTENSIONS (+ '.json',
// which the backend special-cases). Used for pre-drop validation in the
// dropzone and for the file input's accept attribute.
export const ACCEPTED_EXTENSIONS = [
  '.csv', '.txt', '.json', '.geojson', '.gpx',
  '.ndjson', '.jsonl', '.parquet', '.pq',
];

export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',');

const TIME_PROPS = new Set([
  'time', 'timestamp', 'datetime', 'coordtimes', 'times',
]);

export function isAcceptedFile(name: string): boolean {
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  return ACCEPTED_EXTENSIONS.includes(name.slice(i).toLowerCase());
}

export function isGeoJsonUploadName(name: string): boolean {
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  const ext = name.slice(i).toLowerCase();
  return ext === '.geojson' || ext === '.json';
}

export interface GeoJsonRoleSuggestion {
  geometry_types: string[];
  property_keys: string[];
  suggested_role: UploadOverlayRole | null;
  options: UploadOverlayRole[];
}

/** Client-side GeoJSON role heuristic (mirrors backend suggest_geojson_role). */
export function suggestGeoJsonRoleFromDoc(doc: unknown): GeoJsonRoleSuggestion {
  const types = new Set<string>();
  const props = new Set<string>();
  const features = extractFeatures(doc);
  for (const f of features) {
    const g = (f as { geometry?: { type?: string } })?.geometry;
    if (g?.type) types.add(g.type);
    const p = (f as { properties?: Record<string, unknown> })?.properties;
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) props.add(k);
    }
  }
  const geometry_types = [...types].sort();
  const property_keys = [...props].sort();
  let suggested_role: UploadOverlayRole | null = null;
  let options: UploadOverlayRole[] = ['trajectories', 'pois', 'zones'];

  if (types.size === 0) {
    return { geometry_types, property_keys, suggested_role: null, options };
  }
  const zoneOnly = [...types].every(t => t === 'Polygon' || t === 'MultiPolygon');
  const pointOnly = [...types].every(t => t === 'Point');
  const hasLine = types.has('LineString');
  const hasZone = types.has('Polygon') || types.has('MultiPolygon');
  const hasPointOrLine = types.has('Point') || types.has('LineString');

  if (zoneOnly) {
    suggested_role = 'zones';
    options = ['zones'];
  } else if (hasZone && hasPointOrLine) {
    suggested_role = null;
    options = ['trajectories', 'pois', 'zones'];
  } else if (hasLine) {
    suggested_role = 'trajectories';
    options = ['trajectories'];
  } else if (pointOnly) {
    const lower = new Set([...props].map(k => k.toLowerCase()));
    const hasTime = [...TIME_PROPS].some(k => lower.has(k));
    suggested_role = hasTime ? 'trajectories' : 'pois';
    options = ['trajectories', 'pois'];
  }

  return { geometry_types, property_keys, suggested_role, options };
}

function extractFeatures(doc: unknown): unknown[] {
  if (!doc || typeof doc !== 'object') return [];
  const d = doc as { type?: string; features?: unknown[]; geometry?: unknown };
  if (d.type === 'FeatureCollection' && Array.isArray(d.features)) return d.features;
  if (d.type === 'Feature') return [doc];
  if (d.geometry || d.type === 'Point' || d.type === 'Polygon') return [doc];
  return [];
}

async function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(file);
  });
}

/** Read a small GeoJSON file in the browser for the overlay role chooser. */
export async function sniffGeoJsonFile(file: File): Promise<GeoJsonRoleSuggestion> {
  try {
    const chunk = typeof file.slice === 'function'
      ? file.slice(0, 2 * 1024 * 1024)
      : file;
    const text = await readFileText(chunk);
    return suggestGeoJsonRoleFromDoc(JSON.parse(text));
  } catch {
    return {
      geometry_types: [],
      property_keys: [],
      suggested_role: null,
      options: ['trajectories', 'pois', 'zones'],
    };
  }
}

const PHASE_TEXT: Record<IngestPhase, string> = {
  ingest: 'Ingesting waypoints',
  synthesize: 'Synthesizing trips',
  derived: 'Computing derived metrics',
  density: 'Building density',
  registry: 'Updating registry',
  done: 'Finishing',
};

/**
 * Status-card line for an in-flight ingest job, e.g.
 * "Ingesting waypoints… (file 1 of 2)". The file counter only appears for
 * multi-file uploads — a single "track.gpx" already names the file above.
 */
export function phaseLabel(progress: IngestJobProgress | null): string {
  if (!progress) return 'Queued…';
  const base = PHASE_TEXT[progress.phase] ?? 'Working';
  const counter = progress.total_files > 1
    ? ` (file ${Math.min(progress.done_files + 1, progress.total_files)} of ${progress.total_files})`
    : '';
  return `${base}…${counter}`;
}
