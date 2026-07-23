/**
 * Tests for uploadUtils — accepted-extension check and ingest-phase labels.
 */
import { describe, it, expect } from 'vitest';
import { isAcceptedFile, phaseLabel, ACCEPT_ATTR } from '../uploadUtils';

describe('isAcceptedFile', () => {
  it('accepts the backend extension set', () => {
    for (const n of ['a.csv', 'b.txt', 'c.json', 'd.geojson', 'e.gpx', 'f.ndjson', 'g.jsonl', 'h.parquet', 'i.pq']) {
      expect(isAcceptedFile(n), n).toBe(true);
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(isAcceptedFile('TRACK.GPX')).toBe(true);
    expect(isAcceptedFile('data.Parquet')).toBe(true);
  });

  it('rejects unknown or missing extensions', () => {
    expect(isAcceptedFile('notes.docx')).toBe(false);
    expect(isAcceptedFile('archive.zip')).toBe(false);
    expect(isAcceptedFile('noextension')).toBe(false);
    expect(isAcceptedFile('.gpxignore')).toBe(false);  // whole name is the extension
  });

  it('ACCEPT_ATTR covers every accepted extension', () => {
    for (const ext of ['.csv', '.txt', '.json', '.geojson', '.gpx', '.ndjson', '.jsonl', '.parquet', '.pq']) {
      expect(ACCEPT_ATTR).toContain(ext);
    }
  });
});

describe('phaseLabel', () => {
  it('null progress → queued', () => {
    expect(phaseLabel(null)).toBe('Queued…');
  });

  it('single-file uploads show no counter', () => {
    expect(phaseLabel({ phase: 'ingest', file: 'a.gpx', done_files: 0, total_files: 1 }))
      .toBe('Ingesting waypoints…');
  });

  it('multi-file uploads show the file counter', () => {
    expect(phaseLabel({ phase: 'ingest', file: 'b.gpx', done_files: 0, total_files: 2 }))
      .toBe('Ingesting waypoints… (file 1 of 2)');
    expect(phaseLabel({ phase: 'synthesize', file: 'b.gpx', done_files: 1, total_files: 2 }))
      .toBe('Synthesizing trips… (file 2 of 2)');
  });

  it('maps every phase to friendly text', () => {
    expect(phaseLabel({ phase: 'derived', file: null, done_files: 0, total_files: 1 }))
      .toBe('Computing derived metrics…');
    expect(phaseLabel({ phase: 'density', file: null, done_files: 0, total_files: 1 }))
      .toBe('Building density…');
    expect(phaseLabel({ phase: 'registry', file: null, done_files: 0, total_files: 1 }))
      .toBe('Updating registry…');
    expect(phaseLabel({ phase: 'done', file: null, done_files: 1, total_files: 1 }))
      .toBe('Finishing…');
  });

  it('counter clamps at total_files', () => {
    expect(phaseLabel({ phase: 'ingest', file: 'x', done_files: 5, total_files: 2 }))
      .toBe('Ingesting waypoints… (file 2 of 2)');
  });
});
