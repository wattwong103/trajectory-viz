/**
 * Layer catalog — the single source of truth for the FilterPanel's Layers
 * section: form-taxonomy grouping, display labels, and per-dataset
 * availability rules driven by Phase A `/api/stats/filter-options`
 * capabilities.
 *
 * Pure + dependency-free so the grouping and the availability logic are
 * unit-testable. Layer KEYS are load-bearing: they must stay identical to
 * App.tsx's DEFAULT_LAYER_VIS keys and MapView's layerVisibility checks —
 * the integrity test in __tests__/layerCatalog.test.ts enforces this.
 *
 * Availability rule: a layer whose prerequisites the current dataset can't
 * meet renders disabled with the reason as a tooltip (or is hidden entirely
 * for lab plugins), instead of being a silent no-op (or worse, a raw 409).
 */

/** Dataset + session context for form availability (Phase B). */
export interface LayerAvailabilityContext {
  /** capabilities.has_trajectories / stats.has_trajectories */
  hasTrajectories: boolean;
  /** transport_mode ints present in trips (PFLOW wire format) */
  transportModes: number[];
  /** Display labels aligned with modes[] from filter-options */
  modeLabels: string[];
  /** Lab attr columns with ≥1 non-null value (capabilities.attr_keys) */
  attrKeys: string[];
  /** capabilities.has_modes */
  hasModes: boolean;
  /**
   * capabilities.has_density_hourly — true/false once filter-options load;
   * null only before capabilities arrive (probe may still be pending).
   */
  hasDensityHourly: boolean | null;
  /** render modes declared by the dataset's sources ('arcs' = trip-only) */
  sourceModes: Array<'trails' | 'points' | 'arcs'>;
  /**
   * Pulse readiness: true = aggregate ready, false = missing (show fix-it),
   * null = not yet known. Prefer capabilities.has_density_hourly; probe
   * detail fills pulseDetail for the ingest command.
   */
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
  /**
   * Lab / plugin layers: omit from the panel when the dataset lacks the
   * required attrs/modes (hide-when-empty). Default = always show.
   */
  isVisible?: (ctx: LayerAvailabilityContext) => boolean;
}

export interface LayerGroup {
  key: string;
  label: string;
  defaultExpanded: boolean;
  layers: LayerDef[];
}

const PULSE_FIXIT = 'python -m backend.ingest --aggregates-only';

const needsTrajectories = (ctx: LayerAvailabilityContext) =>
  ctx.hasTrajectories ? null : 'No trajectory data in this dataset';

/** Walk trips: PFLOW mode 0, or a mode_map / default label matching Walk. */
export function hasWalkMode(ctx: Pick<LayerAvailabilityContext, 'transportModes' | 'modeLabels'>): boolean {
  if (ctx.transportModes.includes(0)) return true;
  return ctx.modeLabels.some(l => /^walk$/i.test(l.trim()));
}

/** Car trips for pedestrianize: PFLOW mode 3, or Car/Drive labels. */
export function hasCarMode(ctx: Pick<LayerAvailabilityContext, 'transportModes' | 'modeLabels'>): boolean {
  if (ctx.transportModes.includes(3)) return true;
  return ctx.modeLabels.some(l => /^(car|drive)$/i.test(l.trim()));
}

export function hasLabAttr(ctx: Pick<LayerAvailabilityContext, 'attrKeys'>, key: string): boolean {
  return ctx.attrKeys.includes(key);
}

function pulseUnavailable(ctx: LayerAvailabilityContext): string | null {
  // Prefer server capabilities; fall back to the one-shot probe.
  const missing =
    ctx.hasDensityHourly === false ||
    (ctx.hasDensityHourly !== true && ctx.pulseBuilt === false);
  if (!missing) return null;
  const m = ctx.pulseDetail?.match(/run:\s*(.+?)\s*$/);
  return m
    ? `Hourly density not built — ${m[1]}`
    : `Hourly-density aggregate not built — run: ${PULSE_FIXIT}`;
}

/**
 * Form taxonomy groups (plan §3):
 *   core     — trail + od-endpoints
 *   analysis — panel-driven overlays
 *   scene    — agents / arcs / pulse / buildings / context
 *   plugins  — lab-only (footfall); hidden when modes absent
 */
export const LAYER_GROUPS: LayerGroup[] = [
  {
    key: 'core',
    label: 'Core forms',
    defaultExpanded: true,
    layers: [
      { key: 'trajectories', label: 'Trajectories', unavailableReason: needsTrajectories },
      { key: 'origins', label: 'Origins' },
      { key: 'destinations', label: 'Destinations' },
    ],
  },
  {
    key: 'analysis',
    label: 'Analysis forms',
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
    label: 'Scene forms',
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
        unavailableReason: pulseUnavailable,
      },
      { key: 'buildings', label: '3D Buildings' },
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
  {
    key: 'plugins',
    label: 'Lab plugins',
    defaultExpanded: false,
    layers: [
      {
        key: 'footfall',
        label: 'Footfall (walk density)',
        // Hide entirely when the dataset has no walk mode (lab plugin).
        isVisible: hasWalkMode,
        unavailableReason: c => {
          if (!hasWalkMode(c)) return 'No walk trips in this dataset';
          if (!c.hasTrajectories) {
            return 'Footfall needs trajectory waypoints — this dataset is trips-only';
          }
          return null;
        },
      },
    ],
  },
];

/** Flat list of every layer key in the catalog (integrity checks, tests). */
export const ALL_LAYER_KEYS: string[] =
  LAYER_GROUPS.flatMap(g => g.layers.map(l => l.key));

/** Groups with at least one visible layer under the current capabilities. */
export function visibleLayerGroups(ctx: LayerAvailabilityContext): LayerGroup[] {
  return LAYER_GROUPS
    .map(g => ({
      ...g,
      layers: g.layers.filter(l => l.isVisible?.(ctx) !== false),
    }))
    .filter(g => g.layers.length > 0);
}

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
