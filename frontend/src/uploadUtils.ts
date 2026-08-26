/**
 * Upload utilities — accepted-extension check and ingest-phase label
 * formatting. Pure + dependency-free so both are unit-testable.
 */

import type { IngestJobProgress, IngestPhase } from './types';

// Mirrors backend/routers/ingest_api.py _ALLOWED_EXTENSIONS (+ '.json',
// which the backend special-cases). Used for pre-drop validation in the
// dropzone and for the file input's accept attribute.
export const ACCEPTED_EXTENSIONS = [
  '.csv', '.txt', '.json', '.geojson', '.gpx',
  '.ndjson', '.jsonl', '.parquet', '.pq',
];

export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',');

export function isAcceptedFile(name: string): boolean {
  const i = name.lastIndexOf('.');
  if (i < 0) return false;
  return ACCEPTED_EXTENSIONS.includes(name.slice(i).toLowerCase());
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
