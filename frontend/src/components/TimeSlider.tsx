/**
 * TimeSlider — 24-hour animation control with play/pause and speed adjustment.
 *
 * Displays current simulation time as HH:MM and provides:
 * - Play/pause toggle
 * - Time scrubber (0-86400 seconds)
 * - Speed control (1x to 600x)
 * - Trail length adjustment
 */

import React from 'react';

interface TimeSliderProps {
  currentTime: number;
  speed: number;
  playing: boolean;
  trailLength: number;
  onTogglePlay: () => void;
  onSetSpeed: (speed: number) => void;
  onSetTime: (time: number) => void;
  onSetTrailLength: (length: number) => void;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const TimeSlider: React.FC<TimeSliderProps> = ({
  currentTime, speed, playing, trailLength,
  onTogglePlay, onSetSpeed, onSetTime, onSetTrailLength,
}) => {
  return (
    <div style={styles.container}>
      <div style={styles.timeDisplay}>
        <span style={styles.clock}>{formatTime(currentTime)}</span>
        <span style={styles.label}>JST</span>
      </div>

      <div style={styles.controls}>
        <button onClick={onTogglePlay} style={styles.playBtn}>
          {playing ? '⏸' : '▶'}
        </button>

        <input
          type="range"
          min={0}
          max={86399}
          value={Math.floor(currentTime)}
          onChange={e => onSetTime(Number(e.target.value))}
          style={styles.slider}
          title="Scrub time"
        />
      </div>

      <div style={styles.row}>
        <label style={styles.smallLabel}>Speed: {speed}x</label>
        <input
          type="range"
          min={1}
          max={600}
          value={speed}
          onChange={e => onSetSpeed(Number(e.target.value))}
          style={styles.smallSlider}
        />
      </div>

      <div style={styles.row}>
        <label style={styles.smallLabel}>Trail: {Math.floor(trailLength / 60)}min</label>
        <input
          type="range"
          min={60}
          max={7200}
          step={60}
          value={trailLength}
          onChange={e => onSetTrailLength(Number(e.target.value))}
          style={styles.smallSlider}
        />
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(15, 15, 25, 0.92)',
    borderRadius: 12,
    padding: '12px 20px',
    color: '#e0e0e0',
    backdropFilter: 'blur(8px)',
    minWidth: 360,
    zIndex: 10,
  },
  timeDisplay: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    marginBottom: 6,
  },
  clock: {
    fontSize: 28,
    fontWeight: 700,
    fontFamily: 'monospace',
    color: '#4fc3f7',
  },
  label: {
    fontSize: 12,
    color: '#888',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  playBtn: {
    background: 'none',
    border: '1px solid #555',
    borderRadius: 6,
    color: '#fff',
    fontSize: 18,
    padding: '4px 10px',
    cursor: 'pointer',
  },
  slider: {
    flex: 1,
    accentColor: '#4fc3f7',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  smallLabel: {
    fontSize: 11,
    color: '#999',
    minWidth: 90,
  },
  smallSlider: {
    flex: 1,
    accentColor: '#666',
  },
};
