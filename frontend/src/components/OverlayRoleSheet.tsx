/**
 * OverlayRoleSheet — choose trajectories / POIs / zones for GeoJSON uploads,
 * with optional label + RGB color for overlay layers.
 */

import React, { useState } from 'react';
import type { UploadOverlayRole } from '../types';

export interface OverlayRoleDraft {
  filename: string;
  staged_name?: string;
  source_id?: string;
  geometry_types: string[];
  options: UploadOverlayRole[];
  role: UploadOverlayRole;
  label: string;
  color: string; // #rrggbb
}

interface OverlayRoleSheetProps {
  drafts: OverlayRoleDraft[];
  errorReasons?: string[];
  busy?: boolean;
  /** When true, confirm posts to confirm-overlay (staged). Else pre-upload. */
  staged?: boolean;
  onConfirm: (drafts: OverlayRoleDraft[]) => void;
  onCancel: () => void;
}

const ROLE_LABEL: Record<UploadOverlayRole, string> = {
  trajectories: 'Trajectories',
  pois: 'POIs',
  zones: 'Zones',
};

function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function draftColorRgb(draft: OverlayRoleDraft): [number, number, number] | undefined {
  if (draft.role === 'trajectories') return undefined;
  return parseHex(draft.color) ?? undefined;
}

export const OverlayRoleSheet: React.FC<OverlayRoleSheetProps> = ({
  drafts: initial,
  errorReasons = [],
  busy = false,
  staged = false,
  onConfirm,
  onCancel,
}) => {
  const [drafts, setDrafts] = useState(initial);
  const [localError, setLocalError] = useState<string | null>(null);

  const setField = <K extends keyof OverlayRoleDraft>(
    idx: number, key: K, value: OverlayRoleDraft[K],
  ) => {
    setDrafts(prev => prev.map((d, i) => (i === idx ? { ...d, [key]: value } : d)));
    setLocalError(null);
  };

  const handleConfirm = () => {
    for (const d of drafts) {
      if (!d.options.includes(d.role)) {
        setLocalError(`${d.filename}: role ${d.role} is not valid for this geometry`);
        return;
      }
      if (d.role !== 'trajectories' && d.color && !parseHex(d.color)) {
        setLocalError(`${d.filename}: color must be #rrggbb`);
        return;
      }
    }
    onConfirm(drafts);
  };

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Choose layer type">
      <div style={styles.sheet}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Add GeoJSON as…</div>
            <div style={styles.subtitle}>
              {staged
                ? 'Pick how to ingest each staged overlay layer.'
                : 'Trajectories, POIs, or study-area zones — optional label and color for overlays.'}
            </div>
          </div>
          <button type="button" onClick={onCancel} style={styles.close} disabled={busy}>✕</button>
        </div>

        {(errorReasons.length > 0 || localError) && (
          <div style={styles.reasons}>
            {localError && <div>{localError}</div>}
            {errorReasons.slice(0, 4).map((r, i) => <div key={i}>{r}</div>)}
          </div>
        )}

        {drafts.map((d, idx) => (
          <div key={d.staged_name || d.filename} style={styles.row}>
            <div style={styles.fileName}>{d.filename}</div>
            <div style={styles.geom}>
              Geometry: {d.geometry_types.join(', ') || 'unknown'}
            </div>
            <div style={styles.controls}>
              <label style={styles.label}>
                Role
                <select
                  value={d.role}
                  disabled={busy}
                  onChange={e => setField(idx, 'role', e.target.value as UploadOverlayRole)}
                  style={styles.select}
                >
                  {d.options.map(r => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
              </label>
              <label style={styles.label}>
                Label
                <input
                  value={d.label}
                  disabled={busy}
                  onChange={e => setField(idx, 'label', e.target.value)}
                  style={styles.input}
                />
              </label>
              {d.role !== 'trajectories' && (
                <label style={styles.label}>
                  Color
                  <input
                    type="color"
                    value={parseHex(d.color) ? (d.color.startsWith('#') ? d.color : `#${d.color}`) : '#78d28c'}
                    disabled={busy}
                    onChange={e => setField(idx, 'color', e.target.value)}
                    style={styles.color}
                  />
                </label>
              )}
            </div>
          </div>
        ))}

        <div style={styles.footer}>
          <button type="button" onClick={onCancel} style={styles.btnGhost} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} style={styles.btnPrimary} disabled={busy}>
            {busy ? 'Working…' : 'Confirm & upload'}
          </button>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0, background: 'rgba(8, 10, 16, 0.78)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 40, padding: 16,
  },
  sheet: {
    width: 'min(560px, 100%)', maxHeight: 'min(80vh, 720px)', overflow: 'auto',
    background: 'rgba(18, 20, 28, 0.97)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12, padding: '16px 18px 14px', color: '#e6e8ee',
  },
  header: { display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  title: { fontSize: 16, fontWeight: 700, color: '#8ec8f0' },
  subtitle: { fontSize: 12, color: '#9aa3b2', marginTop: 4, lineHeight: 1.45 },
  close: { border: 'none', background: 'transparent', color: '#9aa3b2', cursor: 'pointer' },
  reasons: {
    background: 'rgba(80, 24, 24, 0.45)', border: '1px solid rgba(239, 83, 80, 0.35)',
    borderRadius: 8, padding: '8px 10px', marginBottom: 12, fontSize: 11, color: '#ef9a9a',
  },
  row: {
    borderTop: '1px solid rgba(255,255,255,0.06)', padding: '10px 0',
  },
  fileName: { fontSize: 13, fontWeight: 600 },
  geom: { fontSize: 10, color: '#7d8796', marginBottom: 8 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#9aa3b2' },
  select: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
    color: '#e6e8ee', borderRadius: 6, padding: '4px 6px', fontSize: 12, minWidth: 130,
  },
  input: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
    color: '#e6e8ee', borderRadius: 6, padding: '6px 8px', fontSize: 12, minWidth: 120,
  },
  color: { width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' },
  footer: {
    display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, paddingTop: 10,
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  btnGhost: {
    background: 'transparent', border: '1px solid rgba(255,255,255,0.18)',
    color: '#c5ccd8', borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer',
  },
  btnPrimary: {
    background: '#2b7bb8', border: '1px solid #3d8fc9', color: '#fff',
    borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
};
