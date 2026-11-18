/**
 * MapView — DeckGL + MapLibre map with animated trajectory rendering.
 *
 * Orchestrator: props, viewState, autofit, visibleTrajs filtering, color
 * helpers, and memoized calls into form-oriented builders under ./map/.
 *
 * Layers (assembled by builders):
 * 1. TripsLayer — animated trajectory paths (primary visualization)
 * 2. ScatterplotLayer — trip origin/destination points
 * 3. ArcLayer — OD flow arcs (Phase 2)
 * 4. HeatmapLayer — spatial density (Phase 2)
 * 5. ArcLayer — cluster representative arcs (Phase 3)
 * 6. TripsLayer — drill-down trajectories (bright yellow, map-click query)
 * 7. ScatterplotLayer — drill click-point ring marker
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import {
  FlyToInterpolator,
  WebMercatorViewport,
} from '@deck.gl/core';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Trajectory, TripPoint, SourceStyle, Poi, CompareGridCell, Zone } from '../types';
import type { ODFlow, DensityPoint, ClusterResult, LinkDensityItem, HourlyDensity } from '../api';
import type { LayerVisibility } from '../layerVisibility';
import { transportModeColor, transportModeLabel } from '../transportModes';
import { sourceFallbackColor } from '../sourceColors';
import { resolveTrailColor, type TrailColorInput } from '../attrColors';
import type { PoiIconAtlas } from '../poiSprites';
import type { Bbox } from '../utils/bbox';

import {
  NIGHT_LIGHTING, INITIAL_VIEW, MAP_STYLE,
} from './map/constants';
import { useBuildingsLayer } from './map/useBuildingsLayer';
import { buildLinkLayers } from './map/buildLinkLayers';
import { buildGroundOverlays } from './map/buildGroundOverlays';
import {
  buildChromeMid, buildChromeLate, buildChromeTop,
} from './map/buildChromeLayers';
import { buildAnimatedTrailLayers } from './map/buildTrailLayers';

interface MapViewProps {
  trajectories: Trajectory[];
  trips: TripPoint[];
  currentTime: number;
  trailLength: number;
  odFlows: ODFlow[];
  densityPoints: DensityPoint[];
  clusterResult: ClusterResult | null;
  cityCenter?: [number, number] | null;
  // First-load auto-fit (Phase 2 UX fix): frozen union bbox of the dataset,
  // computed once by App. MapView fits the camera to it exactly once, and
  // never if the user has already panned/zoomed.
  fitToBBox?: Bbox | null;
  linkDensityPoints?: LinkDensityItem[];
  /** A/B grid-diff cells (fleet comparison) — diverging delta overlay. */
  compareGridCells?: CompareGridCell[];
  compareGridCellDeg?: number;
  drillTrajectories: Trajectory[];
  drillPoint: [number, number] | null;
  // Sprint A1b: through-zone bbox rendered as a translucent yellow PolygonLayer
  zoneBBox?: { w: number; s: number; e: number; n: number } | null;
  // Phase 4: active pedestrianize-scenario bbox — red, distinct from the
  // yellow zone bbox (they can coexist)
  scenarioBBox?: { w: number; s: number; e: number; n: number } | null;
  layerVisibility: LayerVisibility;
  /**
   * Mega-sim LOD: render OD arcs for all visible trips (not only sources with
   * render.mode: arcs). Trails remain gated by layerVisibility.trajectories.
   */
  forceOdArcs?: boolean;
  // Phase 2A — agent selection & per-source rendering
  agentTrajectories?: Trajectory[];
  selectedAgents?: string[];
  sourceStyles?: SourceStyle[];
  // Phase 2B — pulse heatmap (24 pre-fetched hour buckets)
  pulseData?: HourlyDensity | null;
  // Footfall — walk-trip waypoint density points (empty = layer off/no data)
  footfallPoints?: DensityPoint[];
  // Phase 2C — building-source preference when the viewport doesn't resolve
  // one (Phase 3: viewport bbox now decides; this is the fallback)
  buildingsCity?: string;
  // Phase 3 — building height multiplier (FilterPanel slider, default 1)
  buildingExaggeration?: number;
  // Phase 1 / TV-30 — color scheme + per-source visibility
  colorBy?: 'source' | 'transportMode' | string;
  hiddenSources?: string[];
  /** MapLibre style URL (TV-30 basemap picker). Defaults to Dark Matter. */
  mapStyle?: string;
  // Universal-trajectory Phase 2 — POI context layer. `pois` is already
  // restricted to enabled categories by usePois; the color map is category →
  // [r,g,b] (YAML override or hash fallback, precomputed in App).
  pois?: Poi[];
  poiColorByCategory?: Record<string, [number, number, number]>;
  poiSourceLabels?: Record<string, string>;   // source_key → sources.yaml label
  /** Category-glyph sprite sheet (poiSprites.ts); null → dot fallback. */
  poiIconAtlas?: PoiIconAtlas | null;
  /** Static polygon layers (zones feature) — rendered under trajectories. */
  zones?: Zone[];
  /** Per-layer render hints (YAML color wins, hash fallback). */
  zoneStyleBySource?: Record<string, { label: string; color: [number, number, number] | null }>;
  onMapClick: (lon: number, lat: number) => void;
  // Sprint A1a: click a trajectory on the map → App's selectedTrajectory state
  onTrajectoryClick?: (trajectory: Trajectory) => void;
  /** Debounced after pan/zoom. Used to swap the city-wide sample for a bbox query. */
  onViewIdle?: (info: { zoom: number; bbox: { w: number; s: number; e: number; n: number } }) => void;
}

export const MapView: React.FC<MapViewProps> = ({
  trajectories, trips, currentTime, trailLength,
  odFlows, densityPoints, clusterResult, cityCenter,
  fitToBBox = null,
  linkDensityPoints,
  compareGridCells,
  compareGridCellDeg = 0.005,
  drillTrajectories, drillPoint,
  zoneBBox,
  scenarioBBox = null,
  layerVisibility,
  forceOdArcs = false,
  agentTrajectories = [],
  selectedAgents = [],
  sourceStyles = [],
  pulseData = null,
  footfallPoints = [],
  buildingsCity = 'tokyo',
  buildingExaggeration = 1,
  colorBy = 'source',
  hiddenSources = [],
  mapStyle = MAP_STYLE,
  pois = [],
  poiColorByCategory = {},
  poiSourceLabels = {},
  poiIconAtlas = null,
  zones = [],
  zoneStyleBySource = {},
  onMapClick,
  onTrajectoryClick,
  onViewIdle,
}) => {
  const [viewState, setViewState] = useState<any>(INITIAL_VIEW);

  // First-load auto-fit guards. `userInteractedRef` latches on the first REAL
  // gesture (drag/pan/zoom/rotate — not programmatic transitions, which deck
  // reports with inTransition instead), so a late-arriving stats response can
  // never yank the camera away from someone who already moved it.
  // `autoFitDoneRef` makes the fit strictly one-shot per mount.
  const userInteractedRef = useRef(false);
  const autoFitDoneRef = useRef(false);
  const onViewIdleRef = useRef(onViewIdle);
  onViewIdleRef.current = onViewIdle;

  // ── Phase 2C: 3D buildings ────────────────────────────────────────────
  // The buildings layer lives in its OWN memo, prepended below — an MVTLayer
  // owns a tile cache, and rebuilding it inside the animated layers memo
  // (which re-runs every RAF frame via currentTime) would thrash that cache.
  // Everything else stays in the main memo to preserve layer order exactly.
  const buildingsOn = !!layerVisibility.buildings;
  const { buildingsLayer } = useBuildingsLayer({
    buildingsOn,
    buildingsCity,
    buildingExaggeration,
    viewState,
  });

  // Per-source rendering hints keyed by source_id (Phase 2A).
  const styleBySource = useMemo(() => {
    const m: Record<string, SourceStyle> = {};
    for (const s of sourceStyles) m[s.source_id] = s;
    return m;
  }, [sourceStyles]);

  const colorFor = (vehicleType: string): [number, number, number] =>
    styleBySource[vehicleType]?.color ?? sourceFallbackColor(vehicleType);

  // Phase 1 / TV-30 — source | transport mode | lab attr color indirection.
  const trailColorFor = (
    vehicleType: string,
    transportMode?: number | null,
    attrs?: Partial<TrailColorInput>,
  ): [number, number, number] =>
    resolveTrailColor(
      colorBy,
      {
        vehicle_type: vehicleType,
        transport_mode: transportMode,
        goods_type: attrs?.goods_type,
        purpose: attrs?.purpose,
        taxi_id: attrs?.taxi_id,
        passenger_in: attrs?.passenger_in,
        cargo_loaded: attrs?.cargo_loaded,
        is_night_trip: attrs?.is_night_trip,
      },
      colorFor,
      transportModeColor,
    );

  // Phase 1 — per-source visibility (legend row toggles). Data-level filter,
  // not layer `visible`: sources share single layers.
  const hidden = useMemo(() => new Set(hiddenSources), [hiddenSources]);
  const visibleTrajs = useMemo(
    () => hidden.size > 0
      ? trajectories.filter(t => !hidden.has(t.metadata.vehicle_type))
      : trajectories,
    [trajectories, hidden],
  );
  const visibleTrips = useMemo(
    () => hidden.size > 0
      ? trips.filter(d => !hidden.has(d.vehicle_type))
      : trips,
    [trips, hidden],
  );

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

  // First-load auto-fit to the data bbox (Phase 2 UX fix). Datasets without a
  // city scope (cities: [], city_centers: {}) never trigger the cityCenter
  // fly-to above, so without this the map opens at the hardcoded wide-Tokyo
  // view and a Kichijōji-scale dataset renders as an invisible speck.
  //
  // Fires at most once (autoFitDoneRef), only before the first user gesture
  // (userInteractedRef), and yields to an explicit hash-restored city
  // selection (cityCenter non-null → that fly-to owns the camera instead).
  // Padding 60px; zoom capped at 15 so a degenerate/tiny bbox doesn't dive
  // to street level (fitBounds returns zoom=Infinity for a point bbox).
  //
  // The jump is INSTANT (transitionDuration: 0), not an animated transition:
  // this fires during initial page load — frequently while the tab is still
  // hidden (link opened in a background tab). deck.gl transitions run on
  // requestAnimationFrame, which is paused in hidden tabs, and the frozen
  // transition's start-state echo then clobbers the fitted camera in
  // onViewStateChange, leaving the map stuck at the default view forever.
  // An instant set is RAF-independent; the canvas simply paints the fitted
  // view on the next frame. transitionDuration: 0 also cancels any
  // transition bookkeeping inherited from prev (e.g. a prior fly-to).
  useEffect(() => {
    if (!fitToBBox || autoFitDoneRef.current || userInteractedRef.current) return;
    if (cityCenter) return;
    const vp = new WebMercatorViewport({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const fitted = vp.fitBounds(
      [
        [fitToBBox.min_lon, fitToBBox.min_lat],
        [fitToBBox.max_lon, fitToBBox.max_lat],
      ],
      { padding: 60 },
    );
    // deck.gl 9: fitBounds returns a fitted WebMercatorViewport, not a plain
    // {longitude, latitude, zoom} object — read the fields off the viewport.
    const { longitude, latitude, zoom } = fitted;
    // Non-finite center (shouldn't happen — unionBboxes validates) → don't
    // consume the one-shot; a later valid bbox may still apply.
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    autoFitDoneRef.current = true;
    setViewState((prev: any) => ({
      ...prev,
      longitude,
      latitude,
      zoom: Number.isFinite(zoom) ? Math.min(zoom, 15) : 15,
      transitionDuration: 0,
      transitionInterpolator: undefined,
    }));
  }, [fitToBBox, cityCenter]);

  // Viewport-idle callback for bbox sampling. Skip until the user has
  // actually panned/zoomed so the first-load auto-fit doesn't fire a query.
  useEffect(() => {
    if (!onViewIdleRef.current || !userInteractedRef.current) return;
    const handle = window.setTimeout(() => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const vp = new WebMercatorViewport({
        ...viewState, width, height,
      });
      const [w, n] = vp.unproject([0, 0]);
      const [e, s] = vp.unproject([width, height]);
      onViewIdleRef.current?.({
        zoom: viewState.zoom,
        bbox: { w, s, e, n },
      });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [viewState.longitude, viewState.latitude, viewState.zoom]);

  // Link-network PathLayer is static (no currentTime). Keep it out of the
  // per-RAF layers memo so playback doesn't rebuild hundreds of polylines.
  const linkLayers = useMemo(
    () => buildLinkLayers({
      layerVisibility,
      linkDensityPoints,
      colorBy,
      hidden,
      sourceStyles,
      colorFor,
    }),
    [layerVisibility.linkDensity, linkDensityPoints, colorBy, hidden, sourceStyles, styleBySource],
  );

  // Heatmaps / zones / compare / F3 overlays do not depend on currentTime.
  const groundOverlays = useMemo(
    () => buildGroundOverlays({
      layerVisibility,
      densityPoints,
      footfallPoints,
      zones,
      zoneStyleBySource,
      linkLayers,
      compareGridCells,
      compareGridCellDeg,
      visibleTrajs,
    }),
    [
      layerVisibility, densityPoints, footfallPoints, zones, zoneStyleBySource,
      linkLayers, compareGridCells, compareGridCellDeg, visibleTrajs,
    ],
  );

  const chromeMid = useMemo(
    () => buildChromeMid({
      layerVisibility,
      pois,
      poiIconAtlas,
      poiColorByCategory,
      visibleTrips,
    }),
    [layerVisibility, pois, poiIconAtlas, poiColorByCategory, visibleTrips],
  );

  const chromeLate = useMemo(
    () => buildChromeLate({
      layerVisibility,
      odFlows,
      clusterResult,
    }),
    [layerVisibility, odFlows, clusterResult],
  );

  const chromeTop = useMemo(
    () => buildChromeTop({
      drillPoint,
      zoneBBox,
      scenarioBBox,
    }),
    [drillPoint, zoneBBox, scenarioBBox],
  );

  const layers = useMemo(
    () => buildAnimatedTrailLayers({
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
    }),
    [
      visibleTrajs, visibleTrips, currentTime, trailLength,
      groundOverlays, chromeMid, chromeLate, chromeTop,
      drillTrajectories,
      layerVisibility,
      forceOdArcs,
      agentTrajectories, selectedAgents, styleBySource, sourceStyles,
      pulseData,
      colorBy, hidden,
    ],
  );

  return (
    <DeckGL
      viewState={viewState}
      onViewStateChange={(e: any) => {
        // Latch on genuine gestures only. Programmatic camera changes (deck
        // transition echoes, maplibre init echoes) arrive with
        // interactionState.inTransition / no gesture flags instead.
        const s = e.interactionState;
        if (s && (s.isDragging || s.isPanning || s.isZooming || s.isRotating)) {
          userInteractedRef.current = true;
        }
        setViewState(e.viewState);
      }}
      controller={true}
      // Phase 3 note: no preserveDrawingBuffer needed on DeckGL — deck.gl 9
      // defaults it to true (deviceProps.webgl); MapLibre needs it explicitly
      // (prop on <Map> below) for the composite PNG export.
      // buildingsLayer is memoized separately (tile cache) and sits at the
      // very bottom of the stack; deck.gl skips null entries.
      layers={[buildingsLayer, ...layers]}
      effects={buildingsOn ? [NIGHT_LIGHTING] : []}
      style={{ width: '100%', height: '100%' }}
      onClick={({ coordinate, object }: any) => {
        // If user clicked an existing object (tooltip shows), don't fire drill
        if (object) return;
        if (!coordinate) return;
        onMapClick(coordinate[0], coordinate[1]);
      }}
      getTooltip={({ object }: any) => {
        if (!object) return null;
        // POI tooltip (universal-trajectory Phase 2) — name (fallback '—'),
        // category, and the POI source's label from sources.yaml.
        if ('poi_id' in object) {
          const p = object as Poi;
          const srcLabel = poiSourceLabels[p.source_key] ?? p.source_key;
          return {
            text: `${p.name ?? '—'}\n${p.category ?? 'uncategorized'} · ${srcLabel}`,
          };
        }
        // Trip point tooltip
        if ('start_lon' in object) {
          const t = object as TripPoint;
          return {
            text: `${t.vehicle_type} #${t.vehicle_id}\n` +
              `${t.distance_km?.toFixed(1) ?? '?'} km` +
              (t.transport_mode !== undefined && t.transport_mode !== null
                ? `\n${transportModeLabel(t.transport_mode)}` : '') +
              (t.goods_type ? `\n${t.goods_type}` : '') +
              (t.city ? `\n${t.city}` : ''),
          };
        }
        // Link density tooltip
        if ('link_id' in object && 'waypoint_count' in object) {
          const grp = 'group' in object && object.group && object.group !== '_all'
            ? `\n${object.group}` : '';
          return {
            text: `Link #${object.link_id}${grp}\n${(object.waypoint_count as number).toLocaleString()} waypoints\n${(object.unique_vehicles as number).toLocaleString()} unique vehicles`,
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
        // Agent marker / population dot tooltip (Phase 2A)
        if ('vehicle_key' in object && 'position' in object) {
          return {
            text: 'timeLabel' in object
              ? `${object.vehicle_key} · ${object.timeLabel}`
              : `${object.vehicle_key}`,
          };
        }
        // Trajectory hover (Sprint A1a) — distinct shape: path + metadata
        if ('metadata' in object && 'path' in object && 'timestamps' in object) {
          const t = object as Trajectory;
          const segCount = t.segments?.length ?? 0;
          const tm = t.metadata.transport_mode;
          return {
            text:
              `${t.metadata.vehicle_type} ${t.metadata.vehicle_key}\n` +
              `trip ${t.metadata.trip_id}` +
              (tm !== undefined && tm !== null ? ` · ${transportModeLabel(tm)}` : '') +
              ` · ${t.path.length} waypoints${segCount ? ` · ${segCount} segments` : ''}\n` +
              `(click for details)`,
          };
        }
        return null;
      }}
    >
      <Map
        mapStyle={mapStyle}
        preserveDrawingBuffer
        onError={(e) => {
          // Invalid custom style URLs — surface via console; App toast reverts.
          console.warn('MapLibre style error', e);
        }}
      />
    </DeckGL>
  );
};
