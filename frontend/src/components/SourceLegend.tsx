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
 * Hidden when fewer than 2 sources have data (a single-source view needs no
 * legend). Colors come from sources.yaml render blocks via
 * /api/stats/filter-options; sources without a declared color show the same
 * hash-palette fallback MapView uses (shared impl in sourceColors.ts).
 */

import React from 'react';
import type { SourceStyle } from '../types';
import { sourceFallbackColor } from '../sourceColors';
import { TRANSPORT_MODE_META } from '../transportModes';

const MODE_GLYPHS: Record<SourceStyle['mode'], string> = {
  trails: '〜',
  points: '●',
  arcs: '⌒',
};

interface SourceLegendProps {
  sources: SourceStyle[];
  // Phase 2C — data-license line (e.g. PLATEAU CC-BY) shown while the
  // buildings layer is on. Attribution is a license requirement, so the
  // legend renders whenever it is set, even with < 2 sources.
  attribution?: string;
  // Phase 1 — transport-mode color key + per-source visibility toggles
  colorBy?: 'source' | 'transportMode';
  transportModes?: Array<{ mode: number; count: number }>;
  hiddenSources?: string[];
  onToggleSource?: (sourceId: string) => void;
}

export const SourceLegend: React.FC<SourceLegendProps> = ({
  sources, attribution,
  colorBy = 'source',
  transportModes = [],
  hiddenSources = [],
  onToggleSource,
}) => {
  const transportModeKey = colorBy === 'transportMode' && transportModes.length > 0;
  if (sources.length < 2 && !attribution && !transportModeKey) return null;

  const hidden = new Set(hiddenSources);

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
              // Hidden sources show an outlined chip instead of a filled one.
              background: isHidden ? 'transparent' : `rgb(${c[0]},${c[1]},${c[2]})`,
              border: isHidden ? `1px solid rgb(${c[0]},${c[1]},${c[2]})` : 'none',
            }} />
            <span style={styles.glyph}>{MODE_GLYPHS[s.mode]}</span>
            <span style={styles.label}>{s.label}</span>
          </div>
        );
      })}
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
      {attribution && (
        <div style={{ fontSize: 9, color: '#8a94a5', marginTop: 4, maxWidth: 220 }}>
          {attribution}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 96,           // clears the TimeSlider bar
    left: 12,
    background: 'rgba(15, 18, 24, 0.85)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 11,
    color: '#ddd',
    zIndex: 5,
    backdropFilter: 'blur(4px)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 0',
    whiteSpace: 'nowrap',
  },
  clickableRow: {
    cursor: 'pointer',
  },
  hiddenRow: {
    opacity: 0.35,
  },
  modeSection: {
    marginTop: 6,
    paddingTop: 4,
    borderTop: '1px solid rgba(255,255,255,0.12)',
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
  label: {
    color: '#ccc',
  },
};
