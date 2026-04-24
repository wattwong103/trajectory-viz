/**
 * MapView — DeckGL + MapLibre map with animated trajectory rendering.
 *
 * Layers:
 * 1. TripsLayer — animated trajectory paths (primary visualization)
 * 2. ScatterplotLayer — trip origin/destination points
 * 3. ArcLayer — OD flow arcs (Phase 2)
 * 4. HeatmapLayer — spatial density (Phase 2)
 * 5. ArcLayer — cluster representative arcs (Phase 3)
 * 6. TripsLayer — drill-down trajectories (bright yellow, map-click query)
 * 7. ScatterplotLayer — drill click-point ring marker
 */

import React, { useState, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { FlyToInterpolator } from '@deck.gl/core';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, ArcLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Trajectory, TripPoint } from '../types';
import type { ODFlow, DensityPoint, ClusterResult, LinkDensityItem } from '../api';
import type { LayerVisibility } from '../App';

// Tokyo center — primary PFLOW data region
const INITIAL_VIEW = {
  longitude: 139.76,
  latitude: 35.68,
  zoom: 9,
  pitch: 45,
  bearing: 0,
};

// Free tile server (no API key required)
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Color palette
const COLORS = {
  truckTrail: [253, 128, 93] as [number, number, number],
  taxiTrail:  [23, 184, 190] as [number, number, number],
  origin:     [253, 128, 93, 160] as [number, number, number, number],
  dest:       [23, 184, 190, 160] as [number, number, number, number],
  arcSource:  [253, 128, 93] as [number, number, number],
  arcTarget:  [23, 184, 190] as [number, number, number],
  drillTrail: [255, 230, 100] as [number, number, number],
};

const CLUSTER_COLORS: [number, number, number][] = [
  [253, 128, 93], [23, 184, 190], [43, 200, 80], [212, 160, 23],
  [155, 89, 182], [231, 76, 60], [52, 152, 219], [26, 188, 156],
  [243, 156, 18], [233, 30, 99],
];

interface MapViewProps {
  trajectories: Trajectory[];
  trips: TripPoint[];
  currentTime: number;
  trailLength: number;
  odFlows: ODFlow[];
  densityPoints: DensityPoint[];
  clusterResult: ClusterResult | null;
  cityCenter?: [number, number] | null;
  linkDensityPoints?: LinkDensityItem[];
  drillTrajectories: Trajectory[];
  drillPoint: [number, number] | null;
  layerVisibility: LayerVisibility;
  onMapClick: (lon: number, lat: number) => void;
}

export const MapView: React.FC<MapViewProps> = ({
  trajectories, trips, currentTime, trailLength,
  odFlows, densityPoints, clusterResult, cityCenter,
  linkDensityPoints,
  drillTrajectories, drillPoint,
  layerVisibility,
  onMapClick,
}) => {
  const [viewState, setViewState] = useState<any>(INITIAL_VIEW);

  useEffect(() => {
    if (cityCenter) {
      setViewState((prev: any) => ({
        ...prev,
        longitude: cityCenter[0],
        latitude: cityCenter[1],
        zoom: 10,
        transitionDuration: 1500,
        transitionInterpolator: new FlyToInterpolator({ speed: 1.5, curve: 1.4 }),
      }));
    }
  }, [cityCenter]);

  const layers = useMemo(() => {
    const result: any[] = [];

    // Layer 1: Spatial density heatmap (below everything else)
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

    // Layer 2: Link density scatterplot (above heatmap, below trajectories)
    if (layerVisibility.linkDensity && linkDensityPoints && linkDensityPoints.length > 0) {
      const maxCount = Math.max(...linkDensityPoints.map(l => l.waypoint_count));
      result.push(
        new ScatterplotLayer<LinkDensityItem>({
          id: 'link-density',
          data: linkDensityPoints,
          getPosition: (d: LinkDensityItem) => d.centroid,
          getFillColor: (d: LinkDensityItem) => {
            const t = Math.log2(1 + d.waypoint_count) / Math.log2(1 + maxCount);
            return [
              Math.round(68 + t * (253 - 68)),
              Math.round(1 + t * (231 - 1)),
              Math.round(84 + t * (37 - 84)),
              200,
            ] as [number, number, number, number];
          },
          getRadius: (d: LinkDensityItem) => 30 + 20 * Math.log2(1 + d.waypoint_count),
          radiusMinPixels: 3,
          radiusMaxPixels: 20,
          stroked: false,
          pickable: true,
        }),
      );
    }

    // Layer 3: Animated trajectories
    if (layerVisibility.trajectories && trajectories.length > 0) {
      result.push(
        new TripsLayer<Trajectory>({
          id: 'trajectories',
          data: trajectories,
          getPath: (d: Trajectory) => d.path,
          getTimestamps: (d: Trajectory) => d.timestamps,
          getColor: (d: Trajectory) =>
            d.metadata.vehicle_type === 'truck' ? COLORS.truckTrail : COLORS.taxiTrail,
          currentTime,
          trailLength,
          widthMinPixels: 2,
          opacity: 0.8,
          jointRounded: true,
          capRounded: true,
        }),
      );
    }

    // Layer 3b: Trip origins
    if (layerVisibility.origins && trips.length > 0) {
      result.push(
        new ScatterplotLayer<TripPoint>({
          id: 'origins',
          data: trips,
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

    // Layer 3c: Trip destinations
    if (layerVisibility.destinations && trips.length > 0) {
      result.push(
        new ScatterplotLayer<TripPoint>({
          id: 'destinations',
          data: trips,
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

    // Layer 4: OD Flow arcs (Phase 2)
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

    // Layer 5: Cluster representative arcs (Phase 3)
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

    // Layer 6: Drill-down trajectories (bright yellow, map-click radius query)
    if (layerVisibility.drill && drillTrajectories.length > 0) {
      result.push(
        new TripsLayer<Trajectory>({
          id: 'drill-trajectories',
          data: drillTrajectories,
          getPath: (d: Trajectory) => d.path,
          getTimestamps: (d: Trajectory) => d.timestamps,
          getColor: () => COLORS.drillTrail,
          currentTime,
          trailLength,
          widthMinPixels: 3,
          opacity: 1.0,
          jointRounded: true,
          capRounded: true,
        }),
      );
    }

    // Layer 7: Drill click-point ring marker
    if (drillPoint) {
      result.push(
        new ScatterplotLayer({
          id: 'drill-point',
          data: [{ position: drillPoint }],
          getPosition: (d: any) => d.position,
          getFillColor: [0, 0, 0, 0],         // transparent fill (hollow)
          getLineColor: [255, 230, 100, 220],  // yellow ring
          getRadius: 1000,                     // ~1 km radius
          radiusMinPixels: 8,
          radiusMaxPixels: 48,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 2,
        }),
      );
    }

    return result;
  }, [
    trajectories, trips, currentTime, trailLength,
    odFlows, densityPoints, clusterResult, linkDensityPoints,
    drillTrajectories, drillPoint,
    layerVisibility,
  ]);

  return (
    <DeckGL
      viewState={viewState}
      onViewStateChange={(e: any) => setViewState(e.viewState)}
      controller={true}
      layers={layers}
      style={{ width: '100%', height: '100%' }}
      onClick={({ coordinate, object }: any) => {
        // If user clicked an existing object (tooltip shows), don't fire drill
        if (object) return;
        if (!coordinate) return;
        onMapClick(coordinate[0], coordinate[1]);
      }}
      getTooltip={({ object }: any) => {
        if (!object) return null;
        // Trip point tooltip
        if ('start_lon' in object) {
          const t = object as TripPoint;
          return {
            text: `${t.vehicle_type} #${t.vehicle_id}\n` +
              `${t.distance_km?.toFixed(1) ?? '?'} km` +
              (t.goods_type ? `\n${t.goods_type}` : '') +
              (t.city ? `\n${t.city}` : ''),
          };
        }
        // Link density tooltip
        if ('link_id' in object && 'waypoint_count' in object) {
          return {
            text: `Link #${object.link_id}\n${(object.waypoint_count as number).toLocaleString()} waypoints\n${(object.unique_vehicles as number).toLocaleString()} unique vehicles`,
          };
        }
        // OD flow tooltip
        if ('volume' in object && 'source' in object) {
          return {
            text: `Flow: ${object.volume.toLocaleString()} trips\n` +
              (object.avg_distance_km ? `Avg: ${object.avg_distance_km} km` : ''),
          };
        }
        // Cluster arc tooltip
        if ('clusterId' in object) {
          return {
            text: `Cluster ${object.clusterId}: ${object.size} trips`,
          };
        }
        return null;
      }}
    >
      <Map mapStyle={MAP_STYLE} />
    </DeckGL>
  );
};
