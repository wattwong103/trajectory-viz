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

import React, { useState, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import {
  FlyToInterpolator, AmbientLight, DirectionalLight, LightingEffect,
  WebMercatorViewport,
} from '@deck.gl/core';
import { TripsLayer, MVTLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, ArcLayer, PathLayer, PolygonLayer, IconLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import { DataFilterExtension } from '@deck.gl/extensions';

import type { Trajectory, TripPoint, SourceStyle, Poi, CompareGridCell, Zone } from '../types';
import type { ODFlow, DensityPoint, ClusterResult, LinkDensityItem, HourlyDensity } from '../api';
import { strokesFromLinks, type LinkStroke } from '../utils/linkNetwork';
import { agentHighlightColor } from '../utils/agentColor';
import type { LayerVisibility } from '../App';
import { positionAtTime, hourPhase } from '../utils/interpolate';
import {
  BUILDING_SOURCES, pickBuildingSource, heightRamp, decodePBLD,
  type DecodedBuilding,
} from '../buildings';
import { transportModeColor, transportModeLabel } from '../transportModes';
import { sourceFallbackColor } from '../sourceColors';
import { poiFallbackColor } from '../poiColors';
import type { PoiIconAtlas } from '../poiSprites';
import type { Bbox } from '../utils/bbox';

// Night-scene lighting (Phase 2C): dim ambient + one directional from NW so
// extruded walls shade instead of rendering flat. Module-level — shared by
// every render, never rebuilt.
const NIGHT_LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.35 }),
  directional: new DirectionalLight({
    color: [255, 255, 255],
    intensity: 0.9,
    direction: [-0.55, 0.75, -1],
  }),
});

// Night palette for the pulse heatmap (Phase 2B): deep blue → cyan → amber.
const PULSE_COLOR_RANGE: [number, number, number][] = [
  [14, 18, 38], [22, 62, 110], [24, 130, 170],
  [60, 220, 255], [255, 190, 80], [255, 240, 180],
];

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

// F3 speed gradient (Phase 2 Step 2.7) — maps per-segment speed_kmh to a color.
// Buckets: idle/slow/medium/fast/highway. Bucket edges chosen to make the
// gradient visible at typical PFLOW urban speeds (most segments fall 0-60).
function speedToColor(kmh: number | null | undefined): [number, number, number, number] {
  if (kmh === null || kmh === undefined) return [128, 128, 128, 180];  // gray for unknown
  if (kmh < 5)  return [231, 76,  60,  220];   // red — idle/jam
  if (kmh < 20) return [243, 156, 18,  200];   // orange — slow city
  if (kmh < 50) return [241, 196, 15,  200];   // yellow — typical
  if (kmh < 80) return [43,  200, 80,  200];   // green — fast city
  return            [52,  152, 219, 200];      // blue — highway
}


const CLUSTER_COLORS: [number, number, number][] = [
  [253, 128, 93], [23, 184, 190], [43, 200, 80], [212, 160, 23],
  [155, 89, 182], [231, 76, 60], [52, 152, 219], [26, 188, 156],
  [243, 156, 18], [233, 30, 99],
];

// Time window (seconds each side of the clock) for arc-mode sources — trips
// departing within ±30 min of currentTime show as arcs.
const ARC_WINDOW_SEC = 1800;
const arcTimeFilter = new DataFilterExtension({ filterSize: 1 });

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
  // Phase 1 (transport mode) — color scheme + per-source visibility
  colorBy?: 'source' | 'transportMode';
  hiddenSources?: string[];
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
  agentTrajectories = [],
  selectedAgents = [],
  sourceStyles = [],
  pulseData = null,
  footfallPoints = [],
  buildingsCity = 'tokyo',
  buildingExaggeration = 1,
  colorBy = 'source',
  hiddenSources = [],
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
  // Phase 3 — resolve the building source from the viewport center, not the
  // city dropdown (which stays as fallback preference). Quantized to ~0.005°
  // (~500 m) so panning doesn't re-resolve every frame — must stay finer
  // than the smallest registered bbox (kichijoji is ~0.023° wide; a 0.05°
  // grid would snap the center right past it).
  const qLon = Math.round(viewState.longitude * 200) / 200;
  const qLat = Math.round(viewState.latitude * 200) / 200;
  const buildingsKey = useMemo(
    () => pickBuildingSource(qLon, qLat, buildingsCity),
    [qLon, qLat, buildingsCity],
  );
  const buildingSource = BUILDING_SOURCES[buildingsKey] ?? null;
  // Decoded baked sets cached per URL — toggling layers or panning away and
  // back must not refetch/redecode. globalThis.Map: the bare name `Map` is
  // shadowed by the react-map-gl component import in this file.
  const bakedCache = useRef(new globalThis.Map<string, DecodedBuilding[]>());
  const [bakedBuildings, setBakedBuildings] = useState<DecodedBuilding[] | null>(null);

  useEffect(() => {
    if (!buildingsOn || !buildingSource || buildingSource.kind !== 'baked') return;
    const cached = bakedCache.current.get(buildingSource.url);
    if (cached) { setBakedBuildings(cached); return; }
    let cancelled = false;
    // cache: 'no-cache' revalidates with the server even if the HTTP cache
    // holds a "fresh" entry — rescues tabs that cached a bin under the old
    // immutable policy, and picks up re-bakes on reload thereafter.
    fetch(buildingSource.url, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`buildings fetch: ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        const decoded = decodePBLD(buf).buildings;
        bakedCache.current.set(buildingSource.url, decoded);
        if (!cancelled) setBakedBuildings(decoded);
      })
      .catch(e => console.error('Baked buildings load failed:', e));
    return () => { cancelled = true; };
  }, [buildingsOn, buildingSource]);

  const buildingsLayer = useMemo(() => {
    if (!buildingsOn || !buildingSource) return null;
    if (buildingSource.kind === 'mvt') {
      return new MVTLayer({
        id: 'buildings-3d',
        data: buildingSource.url,
        minZoom: buildingSource.minZoom,
        maxZoom: buildingSource.maxZoom,
        extruded: true,
        getElevation: (f: any) =>
          (f.properties?.[buildingSource.heightAttr] ?? 12) * buildingExaggeration,
        getFillColor: (f: any) => heightRamp(f.properties?.[buildingSource.heightAttr] ?? 12),
        updateTriggers: { getElevation: [buildingExaggeration] },
        opacity: 0.95,
        pickable: false,
        material: { ambient: 0.6, diffuse: 0.4, shininess: 40, specularColor: [30, 40, 60] },
      } as any);
    }
    if (!bakedBuildings) return null;
    return new PolygonLayer<DecodedBuilding>({
      id: 'buildings-3d',
      data: bakedBuildings,
      getPolygon: (d) => d.polygon,
      extruded: true,
      getElevation: (d) => d.height * buildingExaggeration,
      getFillColor: (d) => heightRamp(d.height),
      updateTriggers: { getElevation: [buildingExaggeration] },
      opacity: 0.95,
      stroked: false,
      pickable: false,
      material: { ambient: 0.6, diffuse: 0.4, shininess: 40, specularColor: [30, 40, 60] },
    });
  }, [buildingsOn, buildingSource, bakedBuildings, buildingExaggeration]);

  // Per-source rendering hints keyed by source_id (Phase 2A).
  const styleBySource = useMemo(() => {
    const m: Record<string, SourceStyle> = {};
    for (const s of sourceStyles) m[s.source_id] = s;
    return m;
  }, [sourceStyles]);

  const colorFor = (vehicleType: string): [number, number, number] =>
    styleBySource[vehicleType]?.color ?? sourceFallbackColor(vehicleType);

  // Phase 1 — single color indirection for data layers: per-source style, or
  // the TRIP's transport-mode color when colorBy === 'transportMode'.
  const trailColorFor = (
    vehicleType: string, transportMode?: number | null,
  ): [number, number, number] =>
    colorBy === 'transportMode' ? transportModeColor(transportMode) : colorFor(vehicleType);

  // Phase 1 — per-source visibility (legend row toggles). Data-level filter,
  // not layer `visible`: sources share single layers.
  const hidden = useMemo(() => new Set(hiddenSources), [hiddenSources]);

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
  const linkLayers = useMemo(() => {
    const result: any[] = [];
    if (layerVisibility.linkDensity && linkDensityPoints && linkDensityPoints.length > 0) {
      const { strokes, centroids } = strokesFromLinks(linkDensityPoints, {
        colorBy, hiddenSources: hidden, colorFor,
      });
      if (strokes.length > 0) {
        result.push(
          new PathLayer<LinkStroke>({
            id: 'link-network',
            data: strokes,
            getPath: (d) => d.path,
            getColor: (d) => d.color,
            getWidth: (d) => d.width,
            widthUnits: 'pixels',
            widthMinPixels: 1,
            widthMaxPixels: 8,
            jointRounded: true,
            capRounded: true,
            pickable: true,
            updateTriggers: { getColor: [colorBy, hidden, sourceStyles] },
          }),
        );
      }
      if (centroids.length > 0) {
        const maxCount = Math.max(...centroids.map(l => l.waypoint_count), 1);
        result.push(
          new ScatterplotLayer<LinkDensityItem>({
            id: 'link-density',
            data: centroids,
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
    }
    return result;
  }, [layerVisibility.linkDensity, linkDensityPoints, colorBy, hidden, sourceStyles, styleBySource]);

  // Heatmaps / zones / compare / F3 overlays do not depend on currentTime.
  const groundOverlays = useMemo(() => {
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
    if (layerVisibility.speedSegments && trajectories.length > 0) {
      type SegPath = { path: [number, number][]; color: [number, number, number, number] };
      const segData: SegPath[] = [];
      for (const t of trajectories) {
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
    if (layerVisibility.dwellMarkers && trajectories.length > 0) {
      type Dwell = { position: [number, number]; dwell: number };
      const dwellPts: Dwell[] = [];
      for (const t of trajectories) {
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
  }, [
    layerVisibility, densityPoints, footfallPoints, zones, zoneStyleBySource,
    linkLayers, compareGridCells, compareGridCellDeg, trajectories,
  ]);

  const layers = useMemo(() => {
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
    const visibleTrajs = hidden.size > 0
      ? trajectories.filter(t => !hidden.has(t.metadata.vehicle_type))
      : trajectories;
    const visibleTrips = hidden.size > 0
      ? trips.filter(d => !hidden.has(d.vehicle_type))
      : trips;
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
            const c = trailColorFor(d.metadata.vehicle_type, d.metadata.transport_mode);
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
            const c = trailColorFor(d.metadata.vehicle_type, d.metadata.transport_mode);
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
      };
      const dots: Dot[] = [];
      for (const t of pointTrajs) {
        const p = positionAtTime(t, currentTime);
        if (p) dots.push({
          position: p, vehicle_key: t.metadata.vehicle_key,
          source: t.metadata.vehicle_type, transport_mode: t.metadata.transport_mode,
        });
      }
      if (dots.length > 0) {
        result.push(
          new ScatterplotLayer<Dot>({
            id: 'population-dots',
            data: dots,
            getPosition: (d) => d.position,
            getFillColor: (d) => {
              const c = trailColorFor(d.source, d.transport_mode);
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

    // Layer 3a-3 (universal-trajectory Phase 2): POI context layer. Sits below
    // origins/destinations so trip endpoints stay visually dominant. Data is
    // pre-filtered to enabled categories by usePois; colors come from the
    // category map (YAML override → deterministic hash fallback). With a
    // sprite atlas (poiSprites.ts) each category renders its glyph; without
    // one (or in canvas-less environments) plain colored dots are kept.
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

    // Layer 3b: Trip origins
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

    // Layer 3c: Trip destinations
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

    // Layer 3d (Phase 2A): time-windowed arcs for 'arcs' render-mode sources
    // (trip-only populations with no waypoints). DataFilterExtension applies
    // the ±30 min window as a GPU uniform — no per-frame data re-upload.
    if (layerVisibility.sourceArcs !== false) {
      const arcTrips = visibleTrips.filter(
        d => styleBySource[d.vehicle_type]?.mode === 'arcs',
      );
      if (arcTrips.length > 0) {
        result.push(
          new ArcLayer<TripPoint>({
            id: 'source-arcs',
            data: arcTrips,
            getSourcePosition: (d: TripPoint) => [d.start_lon, d.start_lat],
            getTargetPosition: (d: TripPoint) => [d.end_lon, d.end_lat],
            getSourceColor: (d: TripPoint) => {
              const c = trailColorFor(d.vehicle_type, d.transport_mode);
              return [c[0], c[1], c[2], dimmed ? 40 : 200];
            },
            getTargetColor: (d: TripPoint) => {
              const c = trailColorFor(d.vehicle_type, d.transport_mode);
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

    // Layer 8: Through-zone bbox (Sprint A1b — F2 UI).
    // Translucent yellow rectangle showing the user's query bounds.
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
          getFillColor: [255, 230, 100, 40],   // translucent yellow fill
          getLineColor: [255, 230, 100, 220],
          lineWidthMinPixels: 2,
          stroked: true,
          filled: true,
        }),
      );
    }

    // Layer 9: Pedestrianize-scenario bbox (Phase 4) — red, so it reads as
    // "cars excluded here" and stays distinct from the yellow query zone.
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
  }, [
    trajectories, trips, currentTime, trailLength,
    odFlows, clusterResult, groundOverlays,
    drillTrajectories, drillPoint, zoneBBox, scenarioBBox,
    layerVisibility,
    agentTrajectories, selectedAgents, styleBySource, sourceStyles,
    pulseData,
    colorBy, hidden,
    pois, poiColorByCategory, poiIconAtlas, poiSourceLabels,
    zones, zoneStyleBySource,
  ]);

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
      <Map mapStyle={MAP_STYLE} preserveDrawingBuffer />
    </DeckGL>
  );
};
