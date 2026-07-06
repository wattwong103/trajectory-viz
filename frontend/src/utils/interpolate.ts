/**
 * Trajectory time-interpolation helpers (Phase 2A).
 *
 * positionAtTime() powers the moving agent markers and the person
 * "population dots": given a trajectory and the animation clock, it returns
 * the lon/lat the agent occupies at that instant, or null when the agent is
 * not travelling (before departure / after arrival).
 *
 * Timestamps arrive from the backend already wrapped to seconds-from-midnight
 * (mod 86400 — see routers/trajectories.py BASE_EPOCH_SEC). A trip that
 * crosses midnight therefore has a non-monotonic timestamp array; we treat
 * that seam as "not visible" rather than lerping across the wrap, which would
 * teleport the dot across the map.
 */

import type { Trajectory } from '../types';

/** Seconds in the 24h animation loop. */
export const DAY_SECONDS = 86400;

/**
 * Position of a trajectory's agent at animation time `t` (seconds from
 * midnight), linearly interpolated between the bracketing waypoints.
 * Returns null when t is outside [t0, tN] or the trajectory is degenerate.
 */
export function positionAtTime(
  traj: Trajectory,
  t: number,
): [number, number] | null {
  const ts = traj.timestamps;
  const path = traj.path;
  if (ts.length < 2 || path.length !== ts.length) return null;
  const t0 = ts[0];
  const tN = ts[ts.length - 1];
  // Cross-midnight wrap (tN < t0 after mod-86400): skip rather than lerp
  // across the seam. Pre-existing data quirk, documented in the plan.
  if (tN < t0) return null;
  if (t < t0 || t > tN) return null;

  // Binary search for the last index with ts[i] <= t.
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= ts.length - 1) return [path[path.length - 1][0], path[path.length - 1][1]];

  const tA = ts[lo];
  const tB = ts[lo + 1];
  if (tB <= tA) return [path[lo][0], path[lo][1]];  // duplicate timestamp — no lerp
  const f = (t - tA) / (tB - tA);
  const [xA, yA] = path[lo];
  const [xB, yB] = path[lo + 1];
  return [xA + (xB - xA) * f, yA + (yB - yA) * f];
}

/**
 * Crossfade phase for the pulse heatmap (Phase 2B, shared here so it is
 * unit-testable): which hour bucket is active and how far into it we are.
 */
export function hourPhase(currentTime: number): { hour: number; nextHour: number; f: number } {
  const t = ((currentTime % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const hour = Math.floor(t / 3600);
  return { hour, nextHour: (hour + 1) % 24, f: (t % 3600) / 3600 };
}
