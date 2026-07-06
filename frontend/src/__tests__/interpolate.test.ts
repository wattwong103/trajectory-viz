/**
 * Unit tests for the trajectory time-interpolation helpers (Phase 2A).
 *
 * positionAtTime() drives the moving agent markers and person dots;
 * hourPhase() drives the Phase 2B pulse-heatmap crossfade. Both are pure
 * functions, tested directly.
 */
import { describe, it, expect } from 'vitest';
import { positionAtTime, hourPhase, DAY_SECONDS } from '../utils/interpolate';
import type { Trajectory } from '../types';

function traj(path: [number, number][], timestamps: number[]): Trajectory {
  return {
    id: 't',
    path,
    timestamps,
    metadata: {
      vehicle_type: 'taxi', vehicle_id: 1, vehicle_key: 'taxi:tokyo:1', trip_id: 1,
    },
  };
}

describe('positionAtTime', () => {
  const t = traj(
    [[139.70, 35.60], [139.72, 35.62], [139.80, 35.70]],
    [100, 200, 400],
  );

  it('returns null before departure and after arrival', () => {
    expect(positionAtTime(t, 99)).toBeNull();
    expect(positionAtTime(t, 401)).toBeNull();
  });

  it('returns exact waypoints at exact timestamps', () => {
    expect(positionAtTime(t, 100)).toEqual([139.70, 35.60]);
    expect(positionAtTime(t, 200)).toEqual([139.72, 35.62]);
    expect(positionAtTime(t, 400)).toEqual([139.80, 35.70]);
  });

  it('lerps midway between waypoints', () => {
    const p = positionAtTime(t, 150)!;   // halfway through segment 0
    expect(p[0]).toBeCloseTo(139.71, 10);
    expect(p[1]).toBeCloseTo(35.61, 10);
    const q = positionAtTime(t, 300)!;   // halfway through segment 1
    expect(q[0]).toBeCloseTo(139.76, 10);
    expect(q[1]).toBeCloseTo(35.66, 10);
  });

  it('returns null for degenerate trajectories', () => {
    expect(positionAtTime(traj([[139.7, 35.6]], [100]), 100)).toBeNull();
  });

  it('returns null on cross-midnight wrapped timestamps (no seam lerp)', () => {
    // mod-86400 wrap: departs 23:50 (85800), arrives 00:10 (600)
    const wrapped = traj([[139.7, 35.6], [139.8, 35.7]], [85800, 600]);
    expect(positionAtTime(wrapped, 86000)).toBeNull();
    expect(positionAtTime(wrapped, 300)).toBeNull();
  });

  it('does not lerp across duplicate timestamps', () => {
    const dup = traj([[139.7, 35.6], [139.8, 35.7]], [100, 100]);
    expect(positionAtTime(dup, 100)).toEqual([139.8, 35.7]);
  });
});

describe('hourPhase (pulse crossfade)', () => {
  it('extracts hour and fraction', () => {
    expect(hourPhase(0)).toEqual({ hour: 0, nextHour: 1, f: 0 });
    expect(hourPhase(3600 * 8 + 1800)).toEqual({ hour: 8, nextHour: 9, f: 0.5 });
  });

  it('wraps hour 23 to 0', () => {
    const p = hourPhase(3600 * 23 + 3599);
    expect(p.hour).toBe(23);
    expect(p.nextHour).toBe(0);
    expect(p.f).toBeCloseTo(3599 / 3600, 6);
  });

  it('normalizes times beyond one day', () => {
    expect(hourPhase(DAY_SECONDS + 3600).hour).toBe(1);
    expect(hourPhase(-3600).hour).toBe(23);
  });
});
