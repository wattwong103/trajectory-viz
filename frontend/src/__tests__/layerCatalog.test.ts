/**
 * Tests for the layer catalog (grouping integrity + capability gating).
 *
 * The integrity test is the alarm: the catalog's keys must stay exactly in
 * sync with layerVisibility.ts DEFAULT_LAYER_VIS keys and MapView's
 * layerVisibility checks — a rename without updating both breaks toggles.
 */
import { describe, it, expect } from 'vitest';
import {
  LAYER_GROUPS, ALL_LAYER_KEYS, LAYER_PRESETS, visibleLayerGroups,
  hasWalkMode, hasCarMode, hasLabAttr,
  type LayerAvailabilityContext,
} from '../layerCatalog';
import { DEFAULT_LAYER_VIS } from '../layerVisibility';

const DEFAULT_LAYER_VIS_KEYS = Object.keys(DEFAULT_LAYER_VIS);

function ctx(overrides: Partial<LayerAvailabilityContext> = {}): LayerAvailabilityContext {
  return {
    hasTrajectories: true,
    transportModes: [0, 3],
    modeLabels: ['Walk', 'Car'],
    attrKeys: ['goods_type', 'fare_yen'],
    hasModes: true,
    hasDensityHourly: true,
    sourceModes: ['trails', 'arcs'],
    megaSim: false,
    simScale: null,
    pulseBuilt: true,
    pulseDetail: undefined,
    hasClusterResult: true,
    hasDrillResult: true,
    hasODFlows: true,
    hasDensity: true,
    hasLinkDensity: true,
    hasCompareGrid: true,
    hasFollowedAgents: true,
    hasPois: true,
    hasZones: true,
    ...overrides,
  };
}

describe('layer catalog integrity', () => {
  it('contains exactly the DEFAULT_LAYER_VIS keys, each once', () => {
    expect([...ALL_LAYER_KEYS].sort()).toEqual([...DEFAULT_LAYER_VIS_KEYS].sort());
    expect(new Set(ALL_LAYER_KEYS).size).toBe(ALL_LAYER_KEYS.length);
  });

  it('every group has at least one layer and a label', () => {
    for (const g of LAYER_GROUPS) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.layers.length).toBeGreaterThan(0);
    }
  });

  it('groups follow form taxonomy keys', () => {
    expect(LAYER_GROUPS.map(g => g.key)).toEqual([
      'core', 'analysis', 'scene', 'plugins',
    ]);
  });

  it('labels carry no internal jargon suffixes', () => {
    for (const key of ALL_LAYER_KEYS) {
      const def = LAYER_GROUPS.flatMap(g => g.layers).find(l => l.key === key)!;
      expect(def.label).not.toMatch(/\(F3\)|trip-only/i);
    }
  });
});

describe('mode / attr capability helpers', () => {
  it('detects walk via PFLOW int 0 or Walk label', () => {
    expect(hasWalkMode({ transportModes: [0], modeLabels: [] })).toBe(true);
    expect(hasWalkMode({ transportModes: [3], modeLabels: ['Walk'] })).toBe(true);
    expect(hasWalkMode({ transportModes: [2, 3], modeLabels: ['Bus', 'Car'] })).toBe(false);
  });

  it('detects car via PFLOW int 3 or Car/Drive labels', () => {
    expect(hasCarMode({ transportModes: [3], modeLabels: [] })).toBe(true);
    expect(hasCarMode({ transportModes: [], modeLabels: ['Drive'] })).toBe(true);
    expect(hasCarMode({ transportModes: [0, 1], modeLabels: ['Walk', 'Bike'] })).toBe(false);
  });

  it('gates lab attrs by attr_keys', () => {
    expect(hasLabAttr({ attrKeys: ['goods_type'] }, 'goods_type')).toBe(true);
    expect(hasLabAttr({ attrKeys: ['fare_yen'] }, 'goods_type')).toBe(false);
  });
});

describe('layer availability', () => {
  const reason = (key: string, c: LayerAvailabilityContext) =>
    LAYER_GROUPS.flatMap(g => g.layers).find(l => l.key === key)!
      .unavailableReason?.(c) ?? null;

  it('everything available in a fully-loaded dataset', () => {
    for (const key of ALL_LAYER_KEYS) {
      expect(reason(key, ctx())).toBeNull();
    }
  });

  it('footfall hidden without walk; disabled without trajectories', () => {
    const noWalk = ctx({ transportModes: [2, 3], modeLabels: ['Bus', 'Car'] });
    expect(hasWalkMode(noWalk)).toBe(false);
    expect(visibleLayerGroups(noWalk).some(g => g.key === 'plugins')).toBe(false);
    expect(reason('footfall', noWalk)).toBe('No walk trips in this dataset');

    expect(reason('footfall', ctx({ transportModes: [0], modeLabels: ['Walk'] }))).toBeNull();
    expect(reason('footfall', ctx({
      transportModes: [0], modeLabels: ['Walk'], hasTrajectories: false,
    }))).toBe('Footfall needs trajectory waypoints — this dataset is trips-only');
  });

  it('pulse uses capabilities.has_density_hourly with fix-it', () => {
    expect(reason('pulse', ctx({
      hasDensityHourly: false,
      pulseBuilt: false,
      pulseDetail: undefined,
    }))).toBe('Hourly-density aggregate not built — run: python -m backend.ingest --aggregates-only');

    const probed = ctx({
      hasDensityHourly: false,
      pulseBuilt: false,
      pulseDetail: 'API error: 409 Conflict — density_hourly not built at resolution 0.005 — run: python -m backend.ingest --aggregates-only',
    });
    expect(reason('pulse', probed))
      .toBe('Hourly density not built — python -m backend.ingest --aggregates-only');

    expect(reason('pulse', ctx({ hasDensityHourly: true, pulseBuilt: null }))).toBeNull();
    // Unknown capabilities + unknown probe → allow (avoid premature disable)
    expect(reason('pulse', ctx({ hasDensityHourly: null, pulseBuilt: null }))).toBeNull();
  });

  it('analysis overlays disabled until their result exists', () => {
    const empty = ctx({
      hasClusterResult: false, hasDrillResult: false, hasODFlows: false,
      hasDensity: false, hasLinkDensity: false,
    });
    expect(reason('clusters', empty)).toBe('Run clustering from the Analysis panel first');
    expect(reason('drill', empty)).toBe('Click the map to query an area first');
    expect(reason('odFlows', empty)).toBe('Generate OD flows from the Analysis panel first');
    expect(reason('density', empty)).toBe('Generate a density grid from the Analysis panel first');
    expect(reason('linkDensity', empty)).toBe('Run link-density from the Analysis panel first');
  });

  it('Network preset keeps origins and destinations (OD-only datasets)', () => {
    const vis = LAYER_PRESETS.network.visibility;
    expect(vis.origins).toBe(true);
    expect(vis.destinations).toBe(true);
    expect(vis.sourceArcs).toBe(true);
    expect(vis.linkDensity).toBe(true);
    expect(vis.trajectories).toBe(true);
  });

  it('trajectory-dependent layers disabled for trips-only datasets', () => {
    const noTraj = ctx({ hasTrajectories: false });
    expect(reason('trajectories', noTraj)).toBe('No trajectory data in this dataset');
    expect(reason('speedSegments', noTraj)).toBe('No trajectory data in this dataset');
    expect(reason('dwellMarkers', noTraj)).toBe('No trajectory data in this dataset');
    // Origins/destinations come from trips — still available
    expect(reason('origins', noTraj)).toBeNull();
    expect(reason('destinations', noTraj)).toBeNull();
  });

  it('scene layers reflect dataset shape', () => {
    expect(reason('sourceArcs', ctx({ sourceModes: ['trails', 'points'] })))
      .toBe('Only relevant for sources without waypoint data');
    expect(reason('sourceArcs', ctx({ sourceModes: ['trails', 'arcs'] }))).toBeNull();
    // Mega-sim unlocks OD arcs even when no source declares mode: arcs.
    expect(reason('sourceArcs', ctx({
      sourceModes: ['trails', 'points'],
      megaSim: true,
    }))).toBeNull();
    expect(reason('agents', ctx({ hasFollowedAgents: false })))
      .toBe('Follow agents from the Agents tab first');
    expect(reason('pois', ctx({ hasPois: false }))).toBe('No POI sources in this dataset');
    expect(reason('buildings', ctx({ hasPois: false }))).toBeNull();
  });

  it('Mega/Macro presets hide trails and enable arcs+pulse', () => {
    for (const id of ['mega', 'macro'] as const) {
      const vis = LAYER_PRESETS[id].visibility;
      expect(vis.trajectories).toBe(false);
      expect(vis.sourceArcs).toBe(true);
      expect(vis.pulse).toBe(true);
      expect(vis.origins).toBe(true);
      expect(vis.destinations).toBe(true);
    }
  });

  it('Micro preset keeps trails and leaves pulse off', () => {
    const vis = LAYER_PRESETS.micro.visibility;
    expect(vis.trajectories).toBe(true);
    expect(vis.pulse).toBe(false);
    expect(vis.agents).toBe(true);
  });

  it('pulse disable copy softens at micro and stresses aggregates at macro', () => {
    const missing = ctx({
      hasDensityHourly: false,
      pulseBuilt: false,
      simScale: 'micro',
    });
    expect(reason('pulse', missing)).toMatch(/optional at micro/i);

    const macroMissing = ctx({
      hasDensityHourly: false,
      pulseBuilt: false,
      megaSim: true,
      simScale: 'macro',
      sourceModes: ['trails'],
    });
    expect(reason('pulse', macroMissing)).toMatch(/Macro scale prefers pulse/i);
    expect(reason('sourceArcs', macroMissing)).toBeNull();
  });
});
