/**
 * Trail / agents / pulse / source-arcs form — animated layer stack body.
 * Caller still wraps in useMemo with the same dependency arrays.
 */

import { TripsLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, ArcLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { Trajectory, TripPoint, SourceStyle } from '../../types';
import type { DensityPoint, HourlyDensity } from '../../api';
import type { LayerVisibility } from '../../layerVisibility';
import { agentHighlightColor } from '../../utils/agentColor';
import { positionAtTime, hourPhase } from '../../utils/interpolate';
import { COLORS, PULSE_COLOR_RANGE, ARC_WINDOW_SEC, arcTimeFilter } from './constants';

export interface BuildAnimatedTrailLayersArgs {
  layerVisibility: LayerVisibility;
  pulseData: HourlyDensity | null;
  currentTime: number;
  trailLength: number;
  groundOverlays: any[];
  chromeMid: any[];
  chromeLate: any[];
  chromeTop: any[];
  visibleTrajs: Trajectory[];
  visibleTrips: TripPoint[];
  styleBySource: Record<string, SourceStyle>;
  sourceStyles: SourceStyle[];
  selectedAgents: string[];
  colorBy: 'source' | 'transportMode' | string;
  trailColorFor: (
    vehicleType: string,
    transportMode?: number | null,
    attrs?: {
      goods_type?: string | null;
      purpose?: number | string | null;
      taxi_id?: string | number | null;
      passenger_in?: string | number | null;
      cargo_loaded?: string | number | null;
      is_night_trip?: string | number | boolean | null;
    },
  ) => [number, number, number];
  colorFor: (vehicleType: string) => [number, number, number];
  buildingsOn: boolean;
  onTrajectoryClick?: (trajectory: Trajectory) => void;
  forceOdArcs: boolean;
  drillTrajectories: Trajectory[];
  agentTrajectories: Trajectory[];
}

export function buildAnimatedTrailLayers({
  layerVisibility,
  pulseData,
  currentTime,
  trailLength,
  groundOverlays,
  chromeMid,
  chromeLate,
  chromeTop,
  visibleTrajs,
  visibleTrips,
  styleBySource,
  sourceStyles,
  selectedAgents,
  colorBy,
  trailColorFor,
  colorFor,
  buildingsOn,
  onTrajectoryClick,
  forceOdArcs,
  drillTrajectories,
  agentTrajectories,
}: BuildAnimatedTrailLayersArgs): any[] {
  const result: any[] = [];

  // Layer 0 (Phase 2B): pulse heatmap — two HeatmapLayers crossfading
  // between adjacent hour buckets. Between hour boundaries only the two
  // opacity values change per frame (GPU uniforms); the point arrays are
  // stable references from the single pre-fetched response, so the layers
  // re-aggregate just 24× per animation loop, not per frame.
  if (layerVisibility.pulse && pulseData && pulseData.global_max_weight > 0) {
    const { hour, nextHour, f } = hourPhase(currentTime);
    const norm = pulseData.global_max_weight;
    const common = {
      getPosition: (d: DensityPoint) => [d.lon, d.lat] as [number, number],
      getWeight: (d: DensityPoint) => d.weight / norm,
      radiusPixels: 40,
      colorRange: PULSE_COLOR_RANGE,
      intensity: 1.2,
      threshold: 0.02,
      aggregation: 'SUM' as const,
    };
    result.push(
      new HeatmapLayer({
        id: 'pulse-a',
        data: pulseData.hours[hour].points,
        opacity: 0.75 * (1 - f),
        ...common,
      }),
      new HeatmapLayer({
        id: 'pulse-b',
        data: pulseData.hours[nextHour].points,
        opacity: 0.75 * f,
        ...common,
      }),
    );
  }

  result.push(...groundOverlays);

  // Layer 3: Animated trajectories.
  // Phase 2A splits by render mode: 'points' sources (people) become moving
  // dots + a faint short trail; everything else stays a full TripsLayer
  // trail. When agents are followed, background layers dim to alpha 40.
  const dimmed = selectedAgents.length > 0;
  const trailTrajs = visibleTrajs.filter(
    t => styleBySource[t.metadata.vehicle_type]?.mode !== 'points',
  );
  const pointTrajs = visibleTrajs.filter(
    t => styleBySource[t.metadata.vehicle_type]?.mode === 'points',
  );

  if (layerVisibility.trajectories && trailTrajs.length > 0) {
    result.push(
      new TripsLayer<Trajectory>({
        id: 'trajectories',
        data: trailTrajs,
        getPath: (d: Trajectory) => d.path,
        getTimestamps: (d: Trajectory) => d.timestamps,
        getColor: (d: Trajectory) => {
          const c = trailColorFor(
            d.metadata.vehicle_type,
            d.metadata.transport_mode,
            d.metadata,
          );
          return dimmed ? [c[0], c[1], c[2], 40] : c;
        },
        updateTriggers: { getColor: [dimmed, sourceStyles, colorBy] },
        currentTime,
        trailLength,
        widthMinPixels: 2,
        opacity: 0.8,
        jointRounded: true,
        capRounded: true,
        // Phase 2C — trails glow through the extruded city instead of
        // being occluded (the night-grid look).
        parameters: buildingsOn ? { depthCompare: 'always' } : {},
        // Sprint A1a — clickable trail; lifts the trajectory to App state.
        pickable: !!onTrajectoryClick,
        onClick: (info: any) => {
          if (info && info.object && onTrajectoryClick) {
            onTrajectoryClick(info.object as Trajectory);
          }
        },
      }),
    );
  }

  // Layer 3a-2 (Phase 2A): 'points' sources — faint short trail + moving dot
  // at the interpolated position (people read as walkers, not streaks).
  if (layerVisibility.trajectories && pointTrajs.length > 0) {
    result.push(
      new TripsLayer<Trajectory>({
        id: 'population-trails',
        data: pointTrajs,
        getPath: (d: Trajectory) => d.path,
        getTimestamps: (d: Trajectory) => d.timestamps,
        getColor: (d: Trajectory) => {
          const c = trailColorFor(
            d.metadata.vehicle_type, d.metadata.transport_mode, d.metadata,
          );
          return [c[0], c[1], c[2], dimmed ? 20 : 80];
        },
        updateTriggers: { getColor: [dimmed, sourceStyles, colorBy] },
        currentTime,
        trailLength: Math.min(trailLength, 300),
        widthMinPixels: 1,
        opacity: 0.3,
        jointRounded: true,
        capRounded: true,
        parameters: buildingsOn ? { depthCompare: 'always' } : {},
      }),
    );
    type Dot = {
      position: [number, number]; vehicle_key: string; source: string;
      transport_mode?: number | null;
      meta: Trajectory['metadata'];
    };
    const dots: Dot[] = [];
    for (const t of pointTrajs) {
      const p = positionAtTime(t, currentTime);
      if (p) dots.push({
        position: p, vehicle_key: t.metadata.vehicle_key,
        source: t.metadata.vehicle_type, transport_mode: t.metadata.transport_mode,
        meta: t.metadata,
      });
    }
    if (dots.length > 0) {
      result.push(
        new ScatterplotLayer<Dot>({
          id: 'population-dots',
          data: dots,
          getPosition: (d) => d.position,
          getFillColor: (d) => {
            const c = trailColorFor(d.source, d.transport_mode, d.meta);
            return [c[0], c[1], c[2], dimmed ? 60 : 230];
          },
          getRadius: 25,
          radiusMinPixels: 2,
          radiusMaxPixels: 6,
          pickable: true,
        }),
      );
    }
  }

  result.push(...chromeMid);

  // Layer 3d (Phase 2A): time-windowed arcs for 'arcs' render-mode sources
  // (trip-only populations with no waypoints). Mega-sim LOD can force arcs
  // for every source when scale exceeds the threshold. DataFilterExtension
  // applies the ±30 min window as a GPU uniform — no per-frame data re-upload.
  if (layerVisibility.sourceArcs !== false) {
    const arcTrips = visibleTrips.filter(
      d => forceOdArcs || styleBySource[d.vehicle_type]?.mode === 'arcs',
    );
    if (arcTrips.length > 0) {
      result.push(
        new ArcLayer<TripPoint>({
          id: 'source-arcs',
          data: arcTrips,
          getSourcePosition: (d: TripPoint) => [d.start_lon, d.start_lat],
          getTargetPosition: (d: TripPoint) => [d.end_lon, d.end_lat],
          getSourceColor: (d: TripPoint) => {
            const c = trailColorFor(d.vehicle_type, d.transport_mode, {
              goods_type: d.goods_type,
            });
            return [c[0], c[1], c[2], dimmed ? 40 : 200];
          },
          getTargetColor: (d: TripPoint) => {
            const c = trailColorFor(d.vehicle_type, d.transport_mode, {
              goods_type: d.goods_type,
            });
            return [c[0], c[1], c[2], dimmed ? 20 : 90];
          },
          updateTriggers: {
            getSourceColor: [dimmed, sourceStyles, colorBy],
            getTargetColor: [dimmed, sourceStyles, colorBy],
          },
          getWidth: 2,
          widthMinPixels: 1,
          widthMaxPixels: 5,
          opacity: 0.7,
          // GPU time filter: uniform update per frame, zero re-upload.
          getFilterValue: (d: TripPoint) => d.starttime,
          filterRange: [currentTime - ARC_WINDOW_SEC, currentTime + ARC_WINDOW_SEC],
          extensions: [arcTimeFilter],
          pickable: true,
        } as any),
      );
    }
  }

  result.push(...chromeLate);

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
        parameters: buildingsOn ? { depthCompare: 'always' } : {},
      }),
    );
  }

  // Layer 6b (Phase 2A): followed-agent trails — full-day chain per agent,
  // bright highlight color by selection index, rendered above everything
  // that dims.
  if (layerVisibility.agents !== false && agentTrajectories.length > 0) {
    const agentColor = (d: Trajectory): [number, number, number] =>
      agentHighlightColor(
        d.metadata.vehicle_key, selectedAgents,
        { vehicle_type: d.metadata.vehicle_type, transport_mode: d.metadata.transport_mode },
        colorBy, colorFor,
      );
    result.push(
      new TripsLayer<Trajectory>({
        id: 'agent-trails',
        data: agentTrajectories,
        getPath: (d: Trajectory) => d.path,
        getTimestamps: (d: Trajectory) => d.timestamps,
        getColor: (d: Trajectory) => agentColor(d),
        updateTriggers: { getColor: [selectedAgents, colorBy, sourceStyles] },
        currentTime,
        trailLength,
        widthMinPixels: 4,
        opacity: 1.0,
        jointRounded: true,
        capRounded: true,
        parameters: buildingsOn ? { depthCompare: 'always' } : {},
      }),
    );
    // Moving marker at each agent's interpolated position.
    type Marker = {
      position: [number, number];
      vehicle_key: string;
      vehicle_type: string;
      transport_mode?: number | null;
      timeLabel: string;
    };
    const hh = String(Math.floor(currentTime / 3600)).padStart(2, '0');
    const mm = String(Math.floor((currentTime % 3600) / 60)).padStart(2, '0');
    const markers: Marker[] = [];
    for (const t of agentTrajectories) {
      const p = positionAtTime(t, currentTime);
      if (p) {
        markers.push({
          position: p,
          vehicle_key: t.metadata.vehicle_key,
          vehicle_type: t.metadata.vehicle_type,
          transport_mode: t.metadata.transport_mode,
          timeLabel: `${hh}:${mm}`,
        });
      }
    }
    if (markers.length > 0) {
      result.push(
        new ScatterplotLayer<Marker>({
          id: 'agent-markers',
          data: markers,
          getPosition: (d) => d.position,
          getFillColor: (d) => {
            const c = agentHighlightColor(
              d.vehicle_key, selectedAgents,
              { vehicle_type: d.vehicle_type, transport_mode: d.transport_mode },
              colorBy, colorFor,
            );
            return [c[0], c[1], c[2], 255];
          },
          updateTriggers: { getFillColor: [selectedAgents, colorBy, sourceStyles] },
          getRadius: 60,
          radiusMinPixels: 5,
          radiusMaxPixels: 14,
          stroked: true,
          getLineColor: [255, 255, 255, 230],
          lineWidthMinPixels: 2,
          pickable: true,
        }),
      );
    }
  }

  result.push(...chromeTop);

  return result;
}
