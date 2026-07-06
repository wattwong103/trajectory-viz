/**
 * SourceLegend — bottom-left legend mapping each ingested source to its
 * color + render-mode glyph (Phase 2A multi-population rendering).
 *
 * Hidden when fewer than 2 sources have data (a single-source view needs no
 * legend). Colors come from sources.yaml render blocks via
 * /api/stats/filter-options; sources without a declared color show the same
 * hash-palette fallback MapView uses.
 */

import React from 'react';
import type { SourceStyle } from '../types';

const MODE_GLYPHS: Record<SourceStyle['mode'], string> = {
  trails: '〜',
  points: '●',
  arcs: '⌒',
};

// Mirror of MapView's deterministic fallback so legend chips match trails.
const FALLBACK_PALETTE: [number, number, number][] = [
  [212, 160, 23], [43, 200, 80], [155, 89, 182], [231, 76, 60],
  [52, 152, 219], [26, 188, 156], [243, 156, 18], [233, 30, 99],
];
function fallbackColor(sourceId: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < sourceId.length; i++) h = (h * 31 + sourceId.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

interface SourceLegendProps {
  sources: SourceStyle[];
}

export const SourceLegend: React.FC<SourceLegendProps> = ({ sources }) => {
  if (sources.length < 2) return null;

  return (
    <div style={styles.container}>
      {sources.map(s => {
        const c = s.color ?? fallbackColor(s.source_id);
        return (
          <div key={s.source_key} style={styles.row} title={`${s.label} (${s.mode})`}>
            <span style={{ ...styles.chip, background: `rgb(${c[0]},${c[1]},${c[2]})` }} />
            <span style={styles.glyph}>{MODE_GLYPHS[s.mode]}</span>
            <span style={styles.label}>{s.label}</span>
          </div>
        );
      })}
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
