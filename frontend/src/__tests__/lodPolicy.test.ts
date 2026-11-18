import { describe, it, expect } from 'vitest';
import {
  forceOdArcs,
  isMegaSim,
  marksLodOverride,
  megaDefaultVisibility,
  MEGA_AUTO_LAYER_VIS,
} from '../lodPolicy';
import type { DatasetCapabilities } from '../types';

function caps(overrides: Partial<DatasetCapabilities> = {}): DatasetCapabilities {
  return {
    has_trips: true,
    has_trajectories: true,
    has_density_hourly: true,
    has_modes: true,
    attr_keys: [],
    agent_key_column: 'vehicle_key',
    ...overrides,
  };
}

describe('lodPolicy', () => {
  it('detects mega_sim / scale=mega', () => {
    expect(isMegaSim(null)).toBe(false);
    expect(isMegaSim(caps())).toBe(false);
    expect(isMegaSim(caps({ mega_sim: true }))).toBe(true);
    expect(isMegaSim(caps({ scale: 'mega' }))).toBe(true);
  });

  it('mega default hides trails and enables arcs+pulse', () => {
    const vis = megaDefaultVisibility();
    expect(vis.trajectories).toBe(false);
    expect(vis.sourceArcs).toBe(true);
    expect(vis.pulse).toBe(true);
    expect(MEGA_AUTO_LAYER_VIS.trajectories).toBe(false);
  });

  it('marks override when trails are re-enabled', () => {
    expect(marksLodOverride({ trajectories: true }, 'trajectories')).toBe(true);
    expect(marksLodOverride({ trajectories: false }, 'trajectories')).toBe(false);
    expect(marksLodOverride({ trajectories: true })).toBe(true);
    expect(marksLodOverride({ trajectories: false, pulse: true })).toBe(false);
  });

  it('forceOdArcs only when mega', () => {
    expect(forceOdArcs(caps())).toBe(false);
    expect(forceOdArcs(caps({ mega_sim: true }))).toBe(true);
  });
});
