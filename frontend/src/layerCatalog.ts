/**
 * Layer catalog — the single source of truth for the FilterPanel's Layers
 * section: grouping, display labels (de-jargoned), and per-dataset
 * availability rules.
 *
 * Pure + dependency-free so the grouping and the availability logic are
 * unit-testable. Layer KEYS are load-bearing: they must stay identical to
 * App.tsx's DEFAULT_LAYER_VIS keys and MapView's layerVisibility checks —
 * the integrity test in __tests__/layerCatalog.test.ts enforces this.
 *
 * Availability rule: a layer whose prerequisites the current dataset can't
 * meet renders disabled with the reason as a tooltip, instead of being a
 * silent no-op (or worse, a raw 409 toast).
 */

export interface LayerAvailabilityContext {
  /** stats.has_trajectories — trajectory sample exists (and includes segments) */
  hasTrajectories: boolean;
  /** transport mode ids present in trips (0 = walk) */
  transportModes: number[];
  /** render modes declared by the dataset's sources ('arcs' = trip-only) */
  sourceModes: Array<'trails' | 'points' | 'arcs'>;
  /** density-hourly probe: true = aggregate built, false = 409, null = not probed yet */
  pulseBuilt: boolean | null;
  /** backend 409 detail (contains the fix-it command after "run:") */
  pulseDetail?: string;
  /** overlay results produced this session (Analysis panel / map click) */
  hasClusterResult: boolean;
  hasDrillResult: boolean;
  /** zone/polygon layers declared in sources.yaml */
  hasZones: boolean;
  hasODFlows: boolean;
  hasDensity: boolean;
  hasLinkDensity: boolean;
  /** fleet-comparison grid-diff cells fetched from the ⇄ tab */
  hasCompareGrid: boolean;
  /** agents followed via the Agents tab */
  hasFollowedAgents: boolean;
  /** POI sources declared in sources.yaml */
  hasPois: boolean;
}

export interface LayerDef {
  key: string;
  label: string;
  /** Return the reason the layer is unavailable, or null when it applies. */
  unavailableReason?: (ctx: LayerAvailabilityContext) => string | null;
}

export interface LayerGroup {
  key: string;
  label: string;
  defaultExpanded: boolean;
  layers: LayerDef[];
}

const needsTrajectories = (ctx: LayerAvailabilityContext) =>
  ctx.hasTrajectories ? null : 'No trajectory data in this dataset';

export const LAYER_GROUPS: LayerGroup[] = [
  {
    key: 'core',
    label: 'Core',
    defaultExpanded: true,
    layers: [
      { key: 'trajectories', label: 'Trajectories', unavailableReason: needsTrajectories },
      { key: 'origins', label: 'Origins' },
      { key: 'destinations', label: 'Destinations' },
    ],
  },
  {
    key: 'analysis',
    label: 'Analysis overlays',
    defaultExpanded: false,
    layers: [
      {
        key: 'density', label: 'Heatmap',
        unavailableReason: c => c.hasDensity ? null : 'Generate a density grid from the Analysis panel first',
      },
      {
        key: 'odFlows', label: 'OD flows',
        unavailableReason: c => c.hasODFlows ? null : 'Generate OD flows from the Analysis panel first',
      },
      {
        key: 'linkDensity', label: 'Link density',
        unavailableReason: c => c.hasLinkDensity ? null : 'Run link-density from the Analysis panel first',
      },
      {
        key: 'compareGrid', label: 'Fleet diff grid',
        unavailableReason: c => c.hasCompareGrid ? null : 'Toggle "Show diff on map" from the ⇄ Compare tab first',
      },
      { key: 'speedSegments', label: 'Speed gradient', unavailableReason: needsTrajectories },
      { key: 'dwellMarkers', label: 'Dwell markers', unavailableReason: needsTrajectories },
      {
        key: 'clusters', label: 'Cluster arcs',
        unavailableReason: c => c.hasClusterResult ? null : 'Run clustering from the Analysis panel first',
      },
      {
        key: 'drill', label: 'Drill results',
        unavailableReason: c => c.hasDrillResult ? null : 'Click the map to query an area first',
      },
    ],
  },
  {
    key: 'scene',
    label: 'Scene',
    defaultExpanded: true,
    layers: [
      {
        key: 'agents', label: 'Agent highlights',
        unavailableReason: c => c.hasFollowedAgents ? null : 'Follow agents from the Agents tab first',
      },
      {
        key: 'sourceArcs', label: 'O-D arcs',
        unavailableReason: c =>
          c.sourceModes.includes('arcs') ? null : 'Only relevant for sources without waypoint data',
      },
      {
        key: 'pulse', label: 'Pulse (hourly density)',
        unavailableReason: c => {
          if (c.pulseBuilt !== false) return null;   // true or not-yet-probed → allow
          const m = c.pulseDetail?.match(/run:\s*(.+?)\s*$/);
          return m
            ? `Hourly density not built — ${m[1]}`
            : 'Hourly-density aggregate not built for this dataset';
        },
      },
      { key: 'buildings', label: '3D Buildings' },
      {
        key: 'footfall', label: 'Footfall (walk density)',
        unavailableReason: c =>
          c.transportModes.includes(0) ? null : 'No walk trips in this dataset',
      },
      {
        key: 'zones', label: 'Zones',
        unavailableReason: c => c.hasZones ? null : 'No zone layers in this dataset',
      },
      {
        key: 'pois', label: 'POIs',
        unavailableReason: c => c.hasPois ? null : 'No POI sources in this dataset',
      },
    ],
  },
];

/** Flat list of every layer key in the catalog (integrity checks, tests). */
export const ALL_LAYER_KEYS: string[] =
  LAYER_GROUPS.flatMap(g => g.layers.map(l => l.key));

export type LayerPresetId = 'trails' | 'network' | 'cinematic';

/** One-click layer recipes. Network keeps origins/destinations — some
 *  datasets are trips-only (no waypoints) and those layers ARE the map. */
export const LAYER_PRESETS: Record<LayerPresetId, {
  label: string;
  visibility: Record<string, boolean>;
}> = {
  trails: {
    label: 'Trails',
    visibility: {
      trajectories: true, origins: true, destinations: true,
      sourceArcs: true, agents: true, pois: true, zones: true,
      linkDensity: false, odFlows: false, density: false, pulse: false,
      buildings: false, footfall: false, speedSegments: false, dwellMarkers: false,
    },
  },
  network: {
    label: 'Network',
    visibility: {
      trajectories: true, origins: true, destinations: true,
      sourceArcs: true, odFlows: true, linkDensity: true, agents: true,
      pois: true, zones: true,
      density: false, pulse: false, buildings: false, footfall: false,
      speedSegments: false, dwellMarkers: false, clusters: false, compareGrid: false,
    },
  },
  cinematic: {
    label: 'Cinematic',
    visibility: {
      trajectories: true, agents: true, pulse: true, buildings: true,
      sourceArcs: true, pois: true, zones: true,
      origins: false, destinations: false,
      linkDensity: false, odFlows: false, density: false, footfall: false,
    },
  },
};
