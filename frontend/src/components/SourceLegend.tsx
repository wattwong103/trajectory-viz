/**
 * SourceLegend — bottom-left legend mapping each ingested source to its
 * color + render-mode glyph (Phase 2A multi-population rendering).
 *
 * Phase 1 (transport mode) additions:
 * - Legend rows are click-to-toggle: clicking a source hides/shows that
 *   population on the map (App holds hiddenSources; hidden rows dim).
 * - When colorBy === 'transportMode', a transport-mode color key renders
 *   below the source rows (sources keep their glyphs; colors move to modes).
 *
 * TV-30: attr color-by key; zone overlay rows; lightweight style edit for
 * upload sources (mode + RGB).
 */

import React, { useState } from 'react';
import type { SourceStyle } from '../types';
import { sourceFallbackColor } from '../sourceColors';
import { TRANSPORT_MODE_META } from '../transportModes';
import { attrChipLabel } from '../attrColors';

const MODE_GLYPHS: Record<SourceStyle['mode'], string> = {
  trails: '〜',
  points: '●',
  arcs: '⌒',
};

export type AttrLegendEntry = {
  value: string;
  color: [number, number, number];
  overflow?: boolean;
};

export type ZoneLegendEntry = {
  source_key: string;
  label: string;
  color: [number, number, number];
  hidden?: boolean;
};

interface SourceLegendProps {
  sources: SourceStyle[];
  attribution?: string;
  colorBy?: 'source' | 'transportMode' | string;
  transportModes?: Array<{ mode: number; count: number }>;
  attrLegend?: AttrLegendEntry[];
  zoneLegend?: ZoneLegendEntry[];
  hiddenSources?: string[];
  onToggleSource?: (sourceId: string) => void;
  onToggleZone?: (sourceKey: string) => void;
  onPatchSourceStyle?: (
    sourceId: string,
    patch: { mode?: SourceStyle['mode']; color?: [number, number, number] },
  ) => Promise<void> | void;
}

export const SourceLegend: React.FC<SourceLegendProps> = ({
  sources, attribution,
  colorBy = 'source',
  transportModes = [],
  attrLegend = [],
  zoneLegend = [],
  hiddenSources = [],
  onToggleSource,
  onToggleZone,
  onPatchSourceStyle,
}) => {
  const transportModeKey = colorBy === 'transportMode' && transportModes.length > 0;
  const attrKey = colorBy !== 'source' && colorBy !== 'transportMode' && attrLegend.length > 0;
  const [editId, setEditId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<SourceStyle['mode']>('trails');
  const [editHex, setEditHex] = useState('#59a2f6');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  if (
    sources.length < 2 && !attribution && !transportModeKey && !attrKey
    && zoneLegend.length === 0
  ) return null;

  const hidden = new Set(hiddenSources);

  const openEdit = (s: SourceStyle, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!s.editable || !onPatchSourceStyle) return;
    const c = s.color ?? sourceFallbackColor(s.source_id);
    setEditId(s.source_id);
    setEditMode(s.mode);
    setEditHex(rgbToHex(c));
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editId || !onPatchSourceStyle) return;
    const rgb = hexToRgb(editHex);
    if (!rgb) {
      setEditError('Use a #RRGGBB color');
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      await onPatchSourceStyle(editId, { mode: editMode, color: rgb });
      setEditId(null);
    } catch (err) {
      setEditError(String((err as Error)?.message ?? err));
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <div style={styles.container}>
      {sources.length >= 2 && sources.map(s => {
        const c = s.color ?? sourceFallbackColor(s.source_id);
        const isHidden = hidden.has(s.source_id);
        return (
          <div
            key={s.source_key}
            style={{
              ...styles.row,
              ...(onToggleSource ? styles.clickableRow : {}),
              ...(isHidden ? styles.hiddenRow : {}),
            }}
            title={`${s.label} (${s.mode})${onToggleSource ? ' — click to toggle' : ''}`}
            onClick={onToggleSource ? () => onToggleSource(s.source_id) : undefined}
          >
            <span style={{
              ...styles.chip,
              background: isHidden ? 'transparent' : `rgb(${c[0]},${c[1]},${c[2]})`,
              border: isHidden ? `1px solid rgb(${c[0]},${c[1]},${c[2]})` : 'none',
            }} />
            <span style={styles.glyph}>{MODE_GLYPHS[s.mode]}</span>
            <span style={styles.label}>{s.label}</span>
            {s.editable && onPatchSourceStyle && (
              <button
                type="button"
                style={styles.editBtn}
                title="Edit color / render mode"
                onClick={e => openEdit(s, e)}
              >
                ✎
              </button>
            )}
          </div>
        );
      })}

      {editId && (
        <div style={styles.editPanel} onClick={e => e.stopPropagation()}>
          <div style={styles.editTitle}>Style · {editId}</div>
          <label style={styles.editLabel}>
            Mode
            <select
              value={editMode}
              disabled={editBusy}
              onChange={e => setEditMode(e.target.value as SourceStyle['mode'])}
              style={styles.editSelect}
            >
              <option value="trails">trails</option>
              <option value="points">points</option>
              <option value="arcs">arcs</option>
            </select>
          </label>
          <label style={styles.editLabel}>
            Color
            <input
              type="color"
              value={editHex}
              disabled={editBusy}
              onChange={e => setEditHex(e.target.value)}
              style={styles.editColor}
            />
          </label>
          {editError && <div style={styles.editError}>{editError}</div>}
          <div style={styles.editActions}>
            <button type="button" style={styles.editGhost} disabled={editBusy} onClick={() => setEditId(null)}>
              Cancel
            </button>
            <button type="button" style={styles.editPrimary} disabled={editBusy} onClick={() => void saveEdit()}>
              {editBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {transportModeKey && (
        <div style={sources.length >= 2 ? styles.modeSection : undefined}>
          {transportModes.map(({ mode }) => {
            const meta = TRANSPORT_MODE_META[mode];
            const c = meta?.color ?? [128, 128, 128];
            return (
              <div key={mode} style={styles.row}>
                <span style={{ ...styles.chip, background: `rgb(${c[0]},${c[1]},${c[2]})` }} />
                <span style={styles.label}>{meta?.label ?? `mode ${mode}`}</span>
              </div>
            );
          })}
        </div>
      )}

      {attrKey && (
        <div style={styles.modeSection}>
          <div style={styles.sectionLabel}>Color by {attrChipLabel(String(colorBy))}</div>
          {attrLegend.map(entry => (
            <div key={entry.value} style={{ ...styles.row, ...(entry.overflow ? styles.hiddenRow : {}) }}>
              <span style={{ ...styles.chip, background: `rgb(${entry.color[0]},${entry.color[1]},${entry.color[2]})` }} />
              <span style={styles.label}>{entry.value}</span>
            </div>
          ))}
        </div>
      )}

      {zoneLegend.length > 0 && (
        <div style={styles.modeSection}>
          <div style={styles.sectionLabel}>Zones</div>
          {zoneLegend.map(z => (
            <div
              key={z.source_key}
              style={{
                ...styles.row,
                ...(onToggleZone ? styles.clickableRow : {}),
                ...(z.hidden ? styles.hiddenRow : {}),
              }}
              title={onToggleZone ? 'Click to toggle zone layer' : z.label}
              onClick={onToggleZone ? () => onToggleZone(z.source_key) : undefined}
            >
              <span style={{
                ...styles.chip,
                background: z.hidden ? 'transparent' : `rgb(${z.color[0]},${z.color[1]},${z.color[2]})`,
                border: z.hidden
                  ? `1px solid rgb(${z.color[0]},${z.color[1]},${z.color[2]})`
                  : 'none',
              }} />
              <span style={styles.label}>{z.label}</span>
            </div>
          ))}
        </div>
      )}

      {attribution && (
        <div style={{ fontSize: 9, color: '#8a94a5', marginTop: 4, maxWidth: 220 }}>
          {attribution}
        </div>
      )}
    </div>
  );
};

function rgbToHex(c: [number, number, number]): string {
  return `#${c.map(n => n.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 96,
    left: 12,
    background: 'rgba(15, 18, 24, 0.85)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 11,
    color: '#ddd',
    zIndex: 5,
    backdropFilter: 'blur(4px)',
    maxWidth: 260,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 0',
    whiteSpace: 'nowrap',
  },
  clickableRow: { cursor: 'pointer' },
  hiddenRow: { opacity: 0.35 },
  modeSection: {
    marginTop: 6,
    paddingTop: 4,
    borderTop: '1px solid rgba(255,255,255,0.12)',
  },
  sectionLabel: {
    fontSize: 10,
    color: '#8a94a5',
    marginBottom: 2,
  },
  chip: {
    width: 10,
    height: 10,
    borderRadius: 2,
    flexShrink: 0,
  },
  glyph: {
    color: '#889',
    fontSize: 10,
    width: 12,
    textAlign: 'center',
  },
  label: { color: '#ccc' },
  editBtn: {
    marginLeft: 'auto',
    border: 'none',
    background: 'transparent',
    color: '#8a94a5',
    cursor: 'pointer',
    fontSize: 11,
    padding: '0 2px',
  },
  editPanel: {
    marginTop: 6,
    padding: 8,
    background: 'rgba(0,0,0,0.35)',
    borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.1)',
  },
  editTitle: { fontSize: 11, fontWeight: 600, marginBottom: 6, color: '#8ec8f0' },
  editLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    fontSize: 10,
    color: '#9aa3b2',
    marginBottom: 6,
  },
  editSelect: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.14)',
    color: '#e6e8ee',
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 11,
  },
  editColor: { width: 42, height: 24, border: 'none', background: 'transparent' },
  editError: { color: '#ef9a9a', fontSize: 10, marginBottom: 4 },
  editActions: { display: 'flex', justifyContent: 'flex-end', gap: 6 },
  editGhost: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#c5ccd8',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer',
  },
  editPrimary: {
    background: '#2b7bb8',
    border: '1px solid #3d8fc9',
    color: '#fff',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
  },
};
