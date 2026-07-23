/**
 * EmptyState — centered overlay shown when /api/stats reports 0 trips
 * (universal-trajectory-support Phase 2).
 *
 * Rendered over the map only when loading has FINISHED and the trip count is
 * zero — App gates on `!loading && stats !== null`, so the normal loading
 * state (skeleton in FilterPanel) is untouched. Points first-time users at
 * the seeded demo, and existing users at their own sources.yaml.
 */

import React from 'react';

const DOCS_URL =
  'https://github.com/wattwong103/trajectory-viz/blob/main/docs/QUICKSTART.md';

export const EmptyState: React.FC = () => (
  <div style={styles.overlay}>
    <div style={styles.card}>
      <div style={styles.heading}>No data yet</div>
      <div style={styles.body}>
        Spin up the seeded demo dataset — GPX courier tracks, bus lines, and
        POIs — with a single command:
      </div>
      <pre style={styles.command}>trajectory-viz-demo --serve</pre>
      <div style={styles.body}>
        Or point <code style={styles.code}>sources.yaml</code> at your own
        data (CSV, GeoJSON, GPX, NDJSON, or Parquet) and re-run ingest.{' '}
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          style={styles.link}
        >
          See the docs
        </a>
        .
      </div>
    </div>
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Click-through: the map stays pannable behind the card.
    pointerEvents: 'none',
    zIndex: 8,
  },
  card: {
    pointerEvents: 'auto',
    maxWidth: 420,
    background: 'rgba(15, 15, 25, 0.92)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: '24px 28px',
    color: '#e0e0e0',
    backdropFilter: 'blur(8px)',
    textAlign: 'center',
    lineHeight: 1.6,
  },
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: '#4fc3f7',
    marginBottom: 10,
  },
  body: {
    fontSize: 13,
    color: '#bbb',
    marginBottom: 10,
  },
  command: {
    margin: '10px 0 14px',
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 6,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 13,
    color: '#ffe566',
    userSelect: 'all',           // one click selects the whole command
    whiteSpace: 'nowrap',
  },
  code: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 12,
    color: '#ffe566',
  },
  link: {
    color: '#4fc3f7',
  },
};
