/**
 * Tests for the layer catalog (grouping integrity + availability rules).
 *
 * The integrity test is the alarm: the catalog's keys must stay exactly in
 * sync with App.tsx's DEFAULT_LAYER_VIS keys and MapView's layerVisibility
 * checks — a rename without updating all three breaks toggles silently.
 */
import { describe, it, expect } from 'vitest';
import {
  LAYER_GROUPS, ALL_LAYER_KEYS, LAYER_PRESETS, type LayerAvailabilityContext,
} from '../layerCatalog';

// Mirror of App.tsx's DEFAULT_LAYER_VIS keys. If you add/rename a layer,
// update both — this test failing is the prompt.
const DEFAULT_LAYER_VIS_KEYS = [
  'origins', 'destinations', 'trajectories', 'odFlows', 'density',
  'linkDensity', 'compareGrid', 'clusters', 'drill', 'speedSegments',
  'dwellMarkers', 'agents', 'sourceArcs', 'pulse', 'buildings', 'footfall',
  'pois', 'zones',
];

function ctx(overrides: Partial<LayerAvailabilityContext> = {}): LayerAvailabilityContext {
  return {
    hasTrajectories: true,
    transportModes: [0, 3],
    sourceModes: ['trails', 'arcs'],
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

  it('labels carry no internal jargon suffixes', () => {
    for (const key of ALL_LAYER_KEYS) {
      const def = LAYER_GROUPS.flatMap(g => g.layers).find(l => l.key === key)!;
      expect(def.label).not.toMatch(/\(F3\)|trip-only/i);
    }
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

  it('footfall disabled without walk trips', () => {
    expect(reason('footfall', ctx({ transportModes: [] }))).toBe('No walk trips in this dataset');
    expect(reason('footfall', ctx({ transportModes: [2, 3] }))).toBe('No walk trips in this dataset');
    expect(reason('footfall', ctx({ transportModes: [0] }))).toBeNull();
  });

  it('pulse disabled with the backend fix-it command when aggregate missing', () => {
    const c = ctx({
      pulseBuilt: false,
      pulseDetail: 'API error: 409 Conflict — density_hourly not built at resolution 0.005 — run: python -m backend.ingest --aggregates-only',
    });
    expect(reason('pulse', c)).toBe('Hourly density not built — python -m backend.ingest --aggregates-only');
    // No detail → generic reason; unknown probe (null) → still allowed
    expect(reason('pulse', ctx({ pulseBuilt: false, pulseDetail: undefined })))
      .toBe('Hourly-density aggregate not built for this dataset');
    expect(reason('pulse', ctx({ pulseBuilt: null }))).toBeNull();
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
    expect(reason('agents', ctx({ hasFollowedAgents: false })))
      .toBe('Follow agents from the Agents tab first');
    expect(reason('pois', ctx({ hasPois: false }))).toBe('No POI sources in this dataset');
    expect(reason('buildings', ctx({ hasPois: false }))).toBeNull();
  });
});
