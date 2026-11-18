/**
 * EmptyState — centered overlay shown when /api/stats reports 0 trips
 * (universal-trajectory-support Phase 2).
 *
 * Rendered over the map only when loading has FINISHED and the trip count is
 * zero — App gates on `!loading && stats !== null`, so the normal loading
 * state (skeleton in FilterPanel) is untouched. Points first-time users at
 * upload-and-go first, then the seeded demo CLI path.
 *
 * Upload-and-go: the dashed area is a VISUAL affordance, not a second drop
 * implementation. Actual drop handling is global — UploadDropzone listens on
 * window (drag events bubble, so a file dropped on this card already works);
 * EmptyState deliberately adds no drag listeners of its own. Clicking the
 * area opens a file picker that feeds the SAME useUpload instance owned by
 * App (via onUploadFiles), because drag-and-drop alone is undiscoverable.
 * After a successful ingest, App's refetch swaps this overlay out as soon as
 * trips exist — no EmptyState-specific follow-up needed.
 */

import React, { useRef } from 'react';
import { ACCEPT_ATTR } from '../uploadUtils';

const DOCS_URL =
  'https://github.com/wattwong103/trajectory-viz/blob/main/docs/DATA_FORMATS.md';

interface EmptyStateProps {
  // Shared uploader owned by App (same instance as FilterPanel's Upload
  // button and the global dropzone). Optional so the overlay still renders
  // as a pure hint when no uploader is wired.
  onUploadFiles?: (files: File[]) => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onUploadFiles }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dropHint = (
    <>
      <div style={styles.dropTitle}>Drop a trajectory file here</div>
      <div style={styles.dropCaption}>
        .gpx, .geojson, .csv, .ndjson, .parquet — or click to browse
      </div>
    </>
  );

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.eyebrow}>First run</div>
        <div style={styles.heading}>No data yet</div>
        <div style={styles.body}>
          Upload a trajectory file to explore immediately, or load the seeded
          Kichijōji demo (couriers / buses / POIs).
        </div>

        {onUploadFiles ? (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={styles.dropAreaButton}
              title="Click to browse, or drop files anywhere on the page"
            >
              {dropHint}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
              style={{ display: 'none' }}
              onChange={e => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) onUploadFiles(files);
                e.target.value = '';   // allow re-picking the same file
              }}
            />
          </>
        ) : (
          <div style={styles.dropArea}>{dropHint}</div>
        )}

        <div style={styles.secondary}>
          <div style={styles.secondaryLabel}>Or seed the demo</div>
          <pre style={styles.command}>docker compose up --build</pre>
          <div style={styles.bodyTight}>
            Native:{' '}
            <code style={styles.code}>trajectory-viz-demo</code>
            {' · '}
            <code style={styles.code}>npm run dev</code>
            {' · '}
            or point <code style={styles.code}>sources.yaml</code> at your data.{' '}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              style={styles.link}
            >
              See the docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

const dropAreaBase: React.CSSProperties = {
  marginTop: 14,
  padding: '16px 20px',
  border: '2px dashed rgba(79, 195, 247, 0.55)',
  borderRadius: 10,
  background: 'rgba(79, 195, 247, 0.06)',
  textAlign: 'center',
  width: '100%',
};

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
    padding: '22px 26px',
    color: '#e0e0e0',
    backdropFilter: 'blur(8px)',
    textAlign: 'center',
    lineHeight: 1.55,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: '#6a7a8a',
    marginBottom: 6,
  },
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: '#4fc3f7',
    marginBottom: 8,
  },
  body: {
    fontSize: 13,
    color: '#bbb',
    marginBottom: 4,
  },
  bodyTight: {
    fontSize: 12,
    color: '#9aa3ad',
    lineHeight: 1.5,
  },
  secondary: {
    marginTop: 16,
    paddingTop: 14,
    borderTop: '1px solid rgba(255,255,255,0.08)',
    textAlign: 'left',
  },
  secondaryLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: '#6a7a8a',
    marginBottom: 6,
  },
  command: {
    margin: '0 0 8px',
    padding: '9px 12px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 6,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 12,
    color: '#ffe566',
    userSelect: 'all',
    whiteSpace: 'nowrap',
    overflowX: 'auto',
  },
  code: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 11,
    color: '#ffe566',
  },
  link: {
    color: '#4fc3f7',
  },
  dropArea: {
    ...dropAreaBase,
  },
  dropAreaButton: {
    ...dropAreaBase,
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
    display: 'block',
  },
  dropTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#4fc3f7',
    marginBottom: 4,
  },
  dropCaption: {
    fontSize: 11,
    color: '#8a94a5',
  },
};
