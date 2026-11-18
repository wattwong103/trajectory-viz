/**
 * Shared MapView constants — night lighting, palettes, initial camera, arc window.
 */

import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import { DataFilterExtension } from '@deck.gl/extensions';

// Night-scene lighting (Phase 2C): dim ambient + one directional from NW so
// extruded walls shade instead of rendering flat. Module-level — shared by
// every render, never rebuilt.
export const NIGHT_LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.35 }),
  directional: new DirectionalLight({
    color: [255, 255, 255],
    intensity: 0.9,
    direction: [-0.55, 0.75, -1],
  }),
});

// Night palette for the pulse heatmap (Phase 2B): deep blue → cyan → amber.
export const PULSE_COLOR_RANGE: [number, number, number][] = [
  [14, 18, 38], [22, 62, 110], [24, 130, 170],
  [60, 220, 255], [255, 190, 80], [255, 240, 180],
];

// Tokyo center — primary PFLOW data region
export const INITIAL_VIEW = {
  longitude: 139.76,
  latitude: 35.68,
  zoom: 9,
  pitch: 45,
  bearing: 0,
};

// Default basemap (TV-30 S5 — picker can override via MapView mapStyle prop).
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Color palette
export const COLORS = {
  truckTrail: [253, 128, 93] as [number, number, number],
  taxiTrail:  [23, 184, 190] as [number, number, number],
  origin:     [253, 128, 93, 160] as [number, number, number, number],
  dest:       [23, 184, 190, 160] as [number, number, number, number],
  arcSource:  [253, 128, 93] as [number, number, number],
  arcTarget:  [23, 184, 190] as [number, number, number],
  drillTrail: [255, 230, 100] as [number, number, number],
};

export const CLUSTER_COLORS: [number, number, number][] = [
  [253, 128, 93], [23, 184, 190], [43, 200, 80], [212, 160, 23],
  [155, 89, 182], [231, 76, 60], [52, 152, 219], [26, 188, 156],
  [243, 156, 18], [233, 30, 99],
];

// Time window (seconds each side of the clock) for arc-mode sources — trips
// departing within ±30 min of currentTime show as arcs.
export const ARC_WINDOW_SEC = 1800;
export const arcTimeFilter = new DataFilterExtension({ filterSize: 1 });
