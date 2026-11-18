/**
 * Ground overlays — density/footfall heatmaps, zones, compare grid, speed, dwell.
 * Accepts linkLayers to concat (same order as original MapView groundOverlays).
 */

import { ScatterplotLayer, PathLayer, PolygonLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { Trajectory, CompareGridCell, Zone } from '../../types';
import type { DensityPoint } from '../../api';
import type { LayerVisibility } from '../../layerVisibility';
import { sourceFallbackColor } from '../../sourceColors';
import { speedToColor } from './colors';

export interface BuildGroundOverlaysArgs {
  layerVisibility: LayerVisibility;
  densityPoints: DensityPoint[];
  footfallPoints: DensityPoint[];
  zones: Zone[];
  zoneStyleBySource: Record<string, { label: string; color: [number, number, number] | null }>;
  linkLayers: any[];
  compareGridCells?: CompareGridCell[];
  compareGridCellDeg: number;
  visibleTrajs: Trajectory[];
}

export function buildGroundOverlays({
  layerVisibility,
  densityPoints,
  footfallPoints,
  zones,
  zoneStyleBySource,
  linkLayers,
  compareGridCells,
  compareGridCellDeg,
  visibleTrajs,
}: BuildGroundOverlaysArgs): any[] {
  const result: any[] = [];
  if (layerVisibility.density && densityPoints.length > 0) {
    result.push(
      new HeatmapLayer({
        id: 'density-heatmap',
        data: densityPoints,
        getPosition: (d: DensityPoint) => [d.lon, d.lat],
        getWeight: (d: DensityPoint) => d.weight,
        radiusPixels: 30,
        intensity: 1.5,
        threshold: 0.05,
        opacity: 0.6,
      }),
    );
  }
  if (layerVisibility.footfall && footfallPoints.length > 0) {
    result.push(
      new HeatmapLayer({
        id: 'footfall-heatmap',
        data: footfallPoints,
        getPosition: (d: DensityPoint) => [d.lon, d.lat],
        getWeight: (d: DensityPoint) => d.weight,
        radiusPixels: 25,
        colorRange: [
          [10, 30, 18], [18, 84, 38], [30, 140, 60],
          [43, 200, 80], [150, 235, 130], [235, 255, 220],
        ],
        intensity: 1.4,
        threshold: 0.03,
        opacity: 0.7,
      }),
    );
  }
  if (layerVisibility.zones && zones.length > 0) {
    const zoneBase = (z: Zone): [number, number, number] =>
      zoneStyleBySource[z.source_key]?.color ?? sourceFallbackColor(z.source_key);
    const zoneColor = (z: Zone): [number, number, number, number] => {
      const c = zoneBase(z);
      return [c[0], c[1], c[2], 40] as [number, number, number, number];
    };
    result.push(
      new PolygonLayer<Zone>({
        id: 'zones',
        data: zones,
        getPolygon: (d: Zone) => d.geometry.coordinates as number[][][],
        getFillColor: zoneColor,
        getLineColor: (d: Zone) => {
          const c = zoneBase(d);
          return [c[0], c[1], c[2], 160] as [number, number, number, number];
        },
        updateTriggers: { getFillColor: [zoneStyleBySource], getLineColor: [zoneStyleBySource] },
        getLineWidth: 1,
        lineWidthMinPixels: 1,
        lineWidthUnits: 'pixels',
        stroked: true,
        filled: true,
        wireframe: false,
        pickable: true,
        opacity: 0.6,
      }),
    );
  }
  result.push(...linkLayers);
  if (layerVisibility.compareGrid && compareGridCells && compareGridCells.length > 0) {
    const maxAbs = Math.max(...compareGridCells.map(c => Math.abs(c.delta)), 1);
    const radiusM = compareGridCellDeg * 111320 * 0.7;
    result.push(
      new ScatterplotLayer<CompareGridCell>({
        id: 'compare-grid-diff',
        data: compareGridCells,
        getPosition: (d: CompareGridCell) => [d.lon, d.lat],
        getFillColor: (d: CompareGridCell) => {
          const t = Math.abs(d.delta) / maxAbs;
          const base: [number, number, number] = d.delta > 0 ? [68, 170, 255] : [253, 128, 93];
          return [
            Math.round(base[0] * (0.45 + 0.55 * t)),
            Math.round(base[1] * (0.45 + 0.55 * t)),
            Math.round(base[2] * (0.45 + 0.55 * t)),
            Math.round(60 + 160 * t),
          ] as [number, number, number, number];
        },
        getRadius: radiusM,
        radiusMinPixels: 3,
        radiusMaxPixels: 26,
        stroked: false,
        pickable: true,
      }),
    );
  }
  if (layerVisibility.speedSegments && visibleTrajs.length > 0) {
    type SegPath = { path: [number, number][]; color: [number, number, number, number] };
    const segData: SegPath[] = [];
    for (const t of visibleTrajs) {
      if (!t.segments) continue;
      for (let i = 0; i < t.segments.length; i++) {
        segData.push({
          path: [t.path[i], t.path[i + 1]] as [number, number][],
          color: speedToColor(t.segments[i].speed_kmh),
        });
      }
    }
    if (segData.length > 0) {
      result.push(
        new PathLayer<SegPath>({
          id: 'speed-segments',
          data: segData,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: 1,
          widthMinPixels: 2,
          opacity: 0.6,
          jointRounded: true,
          capRounded: true,
        }),
      );
    }
  }
  if (layerVisibility.dwellMarkers && visibleTrajs.length > 0) {
    type Dwell = { position: [number, number]; dwell: number };
    const dwellPts: Dwell[] = [];
    for (const t of visibleTrajs) {
      if (!t.segments) continue;
      for (let i = 0; i < t.segments.length; i++) {
        const d = t.segments[i].dwell_sec;
        if (d !== null && d !== undefined && d > 60) {
          dwellPts.push({
            position: t.path[i + 1] as [number, number],
            dwell: d,
          });
        }
      }
    }
    if (dwellPts.length > 0) {
      result.push(
        new ScatterplotLayer<Dwell>({
          id: 'dwell-markers',
          data: dwellPts,
          getPosition: (d) => d.position,
          getFillColor: [255, 60, 60, 180],
          getRadius: (d) => 20 + 10 * Math.log2(1 + d.dwell / 60),
          radiusMinPixels: 3,
          radiusMaxPixels: 20,
          stroked: true,
          getLineColor: [255, 230, 100, 220],
          lineWidthMinPixels: 1,
          pickable: true,
        }),
      );
    }
  }
  return result;
}
