/**
 * Layer visibility defaults shared by App, FilterPanel, and MapView.
 *
 * Keys align with layerCatalog / form taxonomy (trail, od, pulse, buildings, …).
 */

export type LayerVisibility = Record<string, boolean>;

export const DEFAULT_LAYER_VIS: LayerVisibility = {
  origins: true,
  destinations: true,
  trajectories: true,
  odFlows: true,
  density: true,
  linkDensity: true,
  clusters: true,
  drill: true,
  // Phase 2 Step 2.7 F3 layers — default off (overlap with the main trail).
  speedSegments: false,
  dwellMarkers: false,
  // Phase 2A — agent highlight trails + time-windowed arcs for arc-mode sources
  agents: true,
  sourceArcs: true,
  // Phase 2B — animated pulse heatmap (opt-in; needs the density_hourly aggregate)
  pulse: false,
  // Phase 2C — 3D buildings night scene (opt-in; keeps first paint fast)
  buildings: false,
  // Footfall — walk-trip waypoint density (opt-in; needs trajectory data)
  footfall: false,
  // Universal-trajectory Phase 2 — POI context layer (default on; hidden
  // automatically when the dataset declares no POI sources)
  pois: true,
  // Zones/polygon layers (default on; hidden automatically with no zone data)
  zones: true,
  // Fleet-comparison grid diff (opt-in; toggled from the ⇄ Compare tab)
  compareGrid: true,
};
