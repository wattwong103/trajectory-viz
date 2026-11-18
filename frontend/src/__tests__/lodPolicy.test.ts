import { describe, it, expect } from 'vitest';
import {
  defaultVisibilityForScale,
  forceOdArcs,
  isMacroScale,
  isMegaSim,
  isMicroScale,
  marksLodOverride,
  megaDefaultVisibility,
  microDefaultVisibility,
  resolveSimScale,
  MACRO_AUTO_LAYER_VIS,
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
  it('resolves canonical scales and aliases', () => {
    expect(resolveSimScale(null)).toBe(null);
    expect(resolveSimScale(caps({ scale: 'micro' }))).toBe('micro');
    expect(resolveSimScale(caps({ scale: 'meso' }))).toBe('meso');
    expect(resolveSimScale(caps({ scale: 'macro' }))).toBe('macro');
    expect(resolveSimScale(caps({ scale: 'mega' }))).toBe('macro');
    expect(resolveSimScale(caps({ scale: 'standard' }))).toBe('meso');
    expect(resolveSimScale(caps({ mega_sim: true }))).toBe('macro');
  });

  it('detects mega_sim / scale=macro (and legacy mega)', () => {
    expect(isMegaSim(null)).toBe(false);
    expect(isMegaSim(caps())).toBe(false);
    expect(isMegaSim(caps({ mega_sim: true }))).toBe(true);
    expect(isMegaSim(caps({ scale: 'mega' }))).toBe(true);
    expect(isMegaSim(caps({ scale: 'macro' }))).toBe(true);
    expect(isMacroScale(caps({ scale: 'macro' }))).toBe(true);
    expect(isMicroScale(caps({ scale: 'micro' }))).toBe(true);
    expect(isMegaSim(caps({ scale: 'micro' }))).toBe(false);
  });

  it('macro default hides trails and enables arcs+pulse', () => {
    const vis = megaDefaultVisibility();
    expect(vis.trajectories).toBe(false);
    expect(vis.sourceArcs).toBe(true);
    expect(vis.pulse).toBe(true);
    expect(MEGA_AUTO_LAYER_VIS.trajectories).toBe(false);
    expect(MACRO_AUTO_LAYER_VIS).toEqual(MEGA_AUTO_LAYER_VIS);
    expect(defaultVisibilityForScale('macro')).toEqual(vis);
  });

  it('micro default keeps trails and does not force pulse', () => {
    const vis = microDefaultVisibility();
    expect(vis.trajectories).toBe(true);
    expect(vis.pulse).toBe(false);
    expect(vis.agents).toBe(true);
    expect(defaultVisibilityForScale('micro')).toEqual(vis);
    expect(defaultVisibilityForScale('meso')).toBeNull();
  });

  it('marks override when trails are re-enabled on macro', () => {
    expect(marksLodOverride({ trajectories: true }, 'trajectories', 'macro')).toBe(true);
    expect(marksLodOverride({ trajectories: false }, 'trajectories', 'macro')).toBe(false);
    expect(marksLodOverride({ trajectories: true })).toBe(true);
    expect(marksLodOverride({ trajectories: false, pulse: true })).toBe(false);
  });

  it('marks override when micro user enables mega-style pulse+trails-off', () => {
    expect(marksLodOverride({ pulse: true }, 'pulse', 'micro')).toBe(true);
    expect(marksLodOverride({ pulse: true, trajectories: false }, undefined, 'micro')).toBe(true);
    expect(marksLodOverride({ pulse: false, trajectories: true }, undefined, 'micro')).toBe(false);
  });

  it('forceOdArcs only when macro/mega', () => {
    expect(forceOdArcs(caps())).toBe(false);
    expect(forceOdArcs(caps({ scale: 'micro' }))).toBe(false);
    expect(forceOdArcs(caps({ mega_sim: true }))).toBe(true);
    expect(forceOdArcs(caps({ scale: 'macro' }))).toBe(true);
  });
});
