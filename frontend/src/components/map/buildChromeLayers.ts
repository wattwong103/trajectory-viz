/**
 * Chrome layers — OD endpoints (mid), OD flows/clusters (late), bbox markers (top).
 */

import { ScatterplotLayer, ArcLayer, PolygonLayer, IconLayer } from '@deck.gl/layers';
import type { TripPoint, Poi } from '../../types';
import type { ODFlow, ClusterResult } from '../../api';
import type { LayerVisibility } from '../../layerVisibility';
import type { PoiIconAtlas } from '../../poiSprites';
import { poiFallbackColor } from '../../poiColors';
import { COLORS, CLUSTER_COLORS } from './constants';

export interface BuildChromeMidArgs {
  layerVisibility: LayerVisibility;
  pois: Poi[];
  poiIconAtlas: PoiIconAtlas | null;
  poiColorByCategory: Record<string, [number, number, number]>;
  visibleTrips: TripPoint[];
}

/** POIs + origins + destinations (od-endpoints form). */
export function buildChromeMid({
  layerVisibility,
  pois,
  poiIconAtlas,
  poiColorByCategory,
  visibleTrips,
}: BuildChromeMidArgs): any[] {
  const result: any[] = [];
  if (layerVisibility.pois && pois.length > 0) {
    if (poiIconAtlas) {
      result.push(
        new IconLayer<Poi>({
          id: 'pois',
          data: pois,
          getPosition: (d: Poi) => [d.lon, d.lat],
          getIcon: (d: Poi) => {
            const cat = d.category ?? '';
            if (cat in poiIconAtlas.iconFor) return cat;
            return Object.keys(poiIconAtlas.iconFor)[0] ?? '';
          },
          iconAtlas: poiIconAtlas.url,
          iconMapping: poiIconAtlas.iconFor,
          getSize: 22,
          sizeUnits: 'pixels',
          sizeMinPixels: 10,
          sizeMaxPixels: 34,
          opacity: 0.95,
          pickable: true,
          updateTriggers: { getIcon: [poiIconAtlas] },
        }),
      );
    } else {
      result.push(
        new ScatterplotLayer<Poi>({
          id: 'pois',
          data: pois,
          getPosition: (d: Poi) => [d.lon, d.lat],
          getFillColor: (d: Poi) => {
            const key = d.category ?? '';
            const c = poiColorByCategory[key] ?? poiFallbackColor(key);
            return [c[0], c[1], c[2], 230];
          },
          updateTriggers: { getFillColor: [poiColorByCategory] },
          getRadius: 60,
          radiusMinPixels: 2,
          radiusMaxPixels: 8,
          opacity: 0.85,
          stroked: true,
          getLineColor: [255, 255, 255, 90],
          lineWidthMinPixels: 1,
          pickable: true,
        }),
      );
    }
  }
  if (layerVisibility.origins && visibleTrips.length > 0) {
    result.push(
      new ScatterplotLayer<TripPoint>({
        id: 'origins',
        data: visibleTrips,
        getPosition: (d: TripPoint) => [d.start_lon, d.start_lat],
        getFillColor: COLORS.origin,
        getRadius: 80,
        radiusMinPixels: 1,
        radiusMaxPixels: 4,
        opacity: 0.4,
        pickable: true,
      }),
    );
  }
  if (layerVisibility.destinations && visibleTrips.length > 0) {
    result.push(
      new ScatterplotLayer<TripPoint>({
        id: 'destinations',
        data: visibleTrips,
        getPosition: (d: TripPoint) => [d.end_lon, d.end_lat],
        getFillColor: COLORS.dest,
        getRadius: 80,
        radiusMinPixels: 1,
        radiusMaxPixels: 4,
        opacity: 0.3,
        pickable: true,
      }),
    );
  }
  return result;
}

export interface BuildChromeLateArgs {
  layerVisibility: LayerVisibility;
  odFlows: ODFlow[];
  clusterResult: ClusterResult | null;
}

/** OD flow arcs + cluster arcs (od-flows/clusters). */
export function buildChromeLate({
  layerVisibility,
  odFlows,
  clusterResult,
}: BuildChromeLateArgs): any[] {
  const result: any[] = [];
  if (layerVisibility.odFlows && odFlows.length > 0) {
    result.push(
      new ArcLayer<ODFlow>({
        id: 'od-flows',
        data: odFlows,
        getSourcePosition: (d: ODFlow) => d.source,
        getTargetPosition: (d: ODFlow) => d.target,
        getSourceColor: COLORS.arcSource,
        getTargetColor: COLORS.arcTarget,
        getWidth: (d: ODFlow) => Math.max(1, Math.log2(d.volume)),
        widthMinPixels: 1,
        widthMaxPixels: 8,
        opacity: 0.6,
        pickable: true,
      }),
    );
  }
  if (layerVisibility.clusters && clusterResult && clusterResult.clusters.length > 0) {
    const clusterArcs = clusterResult.clusters.map(c => ({
      source: c.centroid.start,
      target: c.centroid.end,
      size: c.size,
      clusterId: c.cluster_id,
    }));
    result.push(
      new ArcLayer({
        id: 'cluster-arcs',
        data: clusterArcs,
        getSourcePosition: (d: any) => d.source,
        getTargetPosition: (d: any) => d.target,
        getSourceColor: (d: any) => CLUSTER_COLORS[d.clusterId % CLUSTER_COLORS.length],
        getTargetColor: (d: any) => CLUSTER_COLORS[d.clusterId % CLUSTER_COLORS.length],
        getWidth: (d: any) => Math.max(2, Math.log2(d.size) * 2),
        widthMinPixels: 2,
        widthMaxPixels: 12,
        opacity: 0.8,
        pickable: true,
      }),
    );
  }
  return result;
}

export interface BuildChromeTopArgs {
  drillPoint: [number, number] | null;
  zoneBBox?: { w: number; s: number; e: number; n: number } | null;
  scenarioBBox?: { w: number; s: number; e: number; n: number } | null;
}

/** Drill point, zone bbox, scenario bbox. */
export function buildChromeTop({
  drillPoint,
  zoneBBox,
  scenarioBBox,
}: BuildChromeTopArgs): any[] {
  const result: any[] = [];
  if (drillPoint) {
    result.push(
      new ScatterplotLayer({
        id: 'drill-point',
        data: [{ position: drillPoint }],
        getPosition: (d: any) => d.position,
        getFillColor: [0, 0, 0, 0],
        getLineColor: [255, 230, 100, 220],
        getRadius: 1000,
        radiusMinPixels: 8,
        radiusMaxPixels: 48,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 2,
      }),
    );
  }
  if (zoneBBox) {
    type Poly = { polygon: [number, number][] };
    const polygon: [number, number][] = [
      [zoneBBox.w, zoneBBox.s],
      [zoneBBox.e, zoneBBox.s],
      [zoneBBox.e, zoneBBox.n],
      [zoneBBox.w, zoneBBox.n],
      [zoneBBox.w, zoneBBox.s],
    ];
    result.push(
      new PolygonLayer<Poly>({
        id: 'zone-bbox',
        data: [{ polygon }],
        getPolygon: (d) => d.polygon,
        getFillColor: [255, 230, 100, 40],
        getLineColor: [255, 230, 100, 220],
        lineWidthMinPixels: 2,
        stroked: true,
        filled: true,
      }),
    );
  }
  if (scenarioBBox) {
    type Poly = { polygon: [number, number][] };
    const polygon: [number, number][] = [
      [scenarioBBox.w, scenarioBBox.s],
      [scenarioBBox.e, scenarioBBox.s],
      [scenarioBBox.e, scenarioBBox.n],
      [scenarioBBox.w, scenarioBBox.n],
      [scenarioBBox.w, scenarioBBox.s],
    ];
    result.push(
      new PolygonLayer<Poly>({
        id: 'scenario-bbox',
        data: [{ polygon }],
        getPolygon: (d) => d.polygon,
        getFillColor: [231, 76, 60, 25],
        getLineColor: [231, 76, 60, 230],
        lineWidthMinPixels: 2,
        stroked: true,
        filled: true,
      }),
    );
  }
  return result;
}
