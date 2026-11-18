/**
 * Trajectory Viz — Main application component.
 *
 * Composes MapView, FilterPanel, TimeSlider, and AnalysisPanel into a
 * full-screen trajectory visualization dashboard.
 *
 * Data flow:
 *   FilterPanel → useTrajectories (API) → MapView (DeckGL)
 *   TimeSlider  → useAnimation (RAF)   → MapView.currentTime
 *   AnalysisPanel → analysis APIs       → MapView overlay layers
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { MapView } from './components/MapView';
import { FilterPanel } from './components/FilterPanel';
import { TimeSlider } from './components/TimeSlider';
import { AnalysisPanel } from './components/AnalysisPanel';
import { SourceLegend } from './components/SourceLegend';
import { EmptyState } from './components/EmptyState';
import { StatusBanner } from './components/StatusBanner';
import { PLATEAU_ATTRIBUTION } from './buildings';
import { useTrajectories } from './hooks/useTrajectories';
import { useAnimation } from './hooks/useAnimation';
import { useInsights } from './hooks/useInsights';
import { useHourlyDensity } from './hooks/useHourlyDensity';
import { useFootfall } from './hooks/useFootfall';
import { useScenarioImpact } from './hooks/useScenarioImpact';
import { usePois } from './hooks/usePois';
import { useZones } from './hooks/useZones';
import { useUpload } from './hooks/useUpload';
import { poiColor } from './poiColors';
import { buildPoiIconAtlas } from './poiSprites';
import { unionBboxes, type Bbox } from './utils/bbox';
import { UploadDropzone } from './components/UploadDropzone';
import { fetchFilterOptions, queryTrajectoriesPoint, queryTrajectoriesBBox, fetchTrajectoriesByVehicle, fetchHourlyDensity } from './api';
import { exportCompositePng } from './utils/exportPng';
import { friendlyFetchError } from './friendlyError';
import type { LayerAvailabilityContext } from './layerCatalog';
import {
  defaultVisibilityForScale,
  forceOdArcs,
  isMegaSim,
  isMicroScale,
  marksLodOverride,
  resolveSimScale,
} from './lodPolicy';
import { MAX_AGENTS } from './components/AgentTab';
import type { FilterState, FilterOptions, Trajectory, TripPoint, CompareGridResponse } from './types';
import type { ODFlow, DensityPoint, ClusterResult, LinkDensityItem } from './api';
import {
  DEFAULT_FILTER,
  encodeHash,
  decodeHash,
  encodeHiddenSources,
  decodeHiddenSources,
  encodeDisabledPoiCategories,
  decodeDisabledPoiCategories,
  encodeAgents,
  decodeAgents,
} from './filterHash';
import { DEFAULT_LAYER_VIS, type LayerVisibility } from './layerVisibility';

// Re-export for any legacy importers; prefer ./layerVisibility going forward.
export type { LayerVisibility };

export default function App() {
  // Initialise filter from URL hash on first load
  const [filter, setFilter] = useState<FilterState>(() => decodeHash(window.location.hash));
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  // Set when the filter-options fetch fails (backend down, DB missing, ...).
  // Renders the backend-error overlay instead of an eternal empty screen.
  const [filterOptionsError, setFilterOptionsError] = useState<string | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(DEFAULT_LAYER_VIS);
  // Scale LOD: macro → arcs+pulse once; micro → trails+agents (never mega
  // defaults). User toggle/preset that fights the scale default sticks as an
  // override for the rest of the session.
  const [lodUserOverride, setLodUserOverride] = useState(false);
  const [megaLodApplied, setMegaLodApplied] = useState(false);

  // Drill-down state (map-click radius query)
  const [drillTrajectories, setDrillTrajectories] = useState<Trajectory[]>([]);
  const [drillPoint, setDrillPoint] = useState<[number, number] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  // Selected-trajectory state (click a trajectory on the map → Detail tab).
  // Sprint A1a: surfaces the segments[] data F3 already attaches.
  const [selectedTrajectory, setSelectedTrajectory] = useState<Trajectory | null>(null);

  // Phase 2A — followed agents (vehicle_keys) + their full-day trajectory
  // chains. Selection is explicit user intent, so it survives filter changes;
  // only a simulation-day change refetches.
  const [selectedAgents, setSelectedAgents] = useState<string[]>(
    () => decodeAgents(window.location.hash),
  );
  const [agentTrajectories, setAgentTrajectories] = useState<Trajectory[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);

  // Phase 1 — per-source visibility toggles (legend rows click to hide).
  // Array (not Set) for stable React identity + trivial hash encoding.
  const [hiddenSources, setHiddenSources] = useState<string[]>(
    () => decodeHiddenSources(window.location.hash),
  );
  const toggleSource = useCallback((sourceId: string) => {
    setHiddenSources(prev =>
      prev.includes(sourceId) ? prev.filter(s => s !== sourceId) : [...prev, sourceId],
    );
  }, []);

  // Universal-trajectory Phase 2 — disabled POI categories ride the hash
  // under pc= (default = all enabled). usePois owns the live list and
  // reports changes back through onDisabledChange for hash persistence.
  const [disabledPoiCategories, setDisabledPoiCategories] = useState<string[]>(
    () => decodeDisabledPoiCategories(window.location.hash),
  );

  // Through-zone bbox state (Sprint A1b — F2 endpoint UI).
  // Once a query fires, App holds the bbox (rendered as yellow PolygonLayer
  // on the map) and the returned trip list (displayed in the Zone tab).
  const [zoneBBox, setZoneBBox] = useState<{ w: number; s: number; e: number; n: number } | null>(null);
  const [zoneTrips, setZoneTrips] = useState<TripPoint[]>([]);

  const reloadFilterOptions = useCallback(() => {
    fetchFilterOptions()
      .then(res => {
        setFilterOptions(res);
        setFilterOptionsError(null);
      })
      .catch(e => {
        console.error(e);
        setFilterOptionsError(friendlyFetchError(String(e?.message ?? e)).text);
      });
  }, []);

  useEffect(() => {
    reloadFilterOptions();
  }, [reloadFilterOptions]);

  // Scale LOD auto-switch (TV-16): macro → arcs+pulse; micro → trails+agents.
  useEffect(() => {
    const caps = filterOptions?.capabilities;
    if (lodUserOverride || megaLodApplied) return;
    const scale = resolveSimScale(caps);
    // Only auto-apply for micro/macro; meso keeps DEFAULT_LAYER_VIS.
    if (scale !== 'macro' && scale !== 'micro') return;
    // Micro with no capabilities yet — wait; also skip micro if caps missing.
    if (!caps) return;
    const patch = defaultVisibilityForScale(scale);
    if (!patch) return;
    setLayerVisibility(prev => ({ ...prev, ...patch }));
    setMegaLodApplied(true);
  }, [filterOptions, lodUserOverride, megaLodApplied]);

  // Pulse availability probe (one-time, tiny): distinguishes "hourly-density
  // aggregate not built" (toggle disabled with a fix-it tooltip) from a
  // genuine fetch failure. Probes the exact resolution the pulse layer uses.
  const [pulseProbe, setPulseProbe] = useState<{ built: boolean; detail?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchHourlyDensity(undefined, undefined, 0.005, 100)
      .then(() => { if (!cancelled) setPulseProbe({ built: true }); })
      .catch(e => {
        if (!cancelled) setPulseProbe({ built: false, detail: String(e?.message ?? e) });
      });
    return () => { cancelled = true; };
  }, []);

  // Sync filter + agent-selection + hidden-source + POI-category changes to URL hash
  useEffect(() => {
    const encoded = [
      encodeHash(filter),
      encodeAgents(selectedAgents),
      encodeHiddenSources(hiddenSources),
      encodeDisabledPoiCategories(disabledPoiCategories),
    ]
      .filter(Boolean)
      .join('&');
    const newHash = encoded ? '#' + encoded : ' ';
    window.history.replaceState(null, '', newHash || window.location.pathname);
  }, [filter, selectedAgents, hiddenSources, disabledPoiCategories]);

  // Fetch full-day trajectory chains for followed agents (Phase 2A).
  useEffect(() => {
    if (selectedAgents.length === 0) {
      setAgentTrajectories([]);
      return;
    }
    let cancelled = false;
    setAgentLoading(true);
    // includeStationary: followed agents with waypoint-less (zero-distance)
    // trips still render as stationary dots instead of vanishing.
    fetchTrajectoriesByVehicle(selectedAgents, filter.simulationDay, true, true)
      .then(res => { if (!cancelled) setAgentTrajectories(res.trajectories); })
      .catch(e => { console.error('Agent trajectory fetch failed:', e); })
      .finally(() => { if (!cancelled) setAgentLoading(false); });
    return () => { cancelled = true; };
  }, [selectedAgents, filter.simulationDay]);

  const {
    trajectories, trips, stats,
    loading, error, refetch,
  } = useTrajectories(filter);

  // Zoomed-in bbox sample (architecture budget 500). Null = use the city-wide
  // sample. Cleared when filters change so a stale viewport set can't linger.
  const [linkLoadNonce, setLinkLoadNonce] = useState(0);
  const [viewportTrajs, setViewportTrajs] = useState<Trajectory[] | null>(null);
  const VIEWPORT_ZOOM = 12;
  useEffect(() => { setViewportTrajs(null); }, [
    filter.vehicleType, filter.city, filter.simulationDay, filter.goodsType,
    filter.minHour, filter.maxHour,
    filter.minSpeed, filter.maxSpeed, filter.maxDwellMinutes,
    filter.minDetourRatio, filter.maxDetourRatio,
    filter.transportModes?.join(','),
    filter.scenario && JSON.stringify(filter.scenario.bbox),
  ]);
  const handleViewIdle = useCallback(async (
    info: { zoom: number; bbox: { w: number; s: number; e: number; n: number } },
  ) => {
    if (info.zoom < VIEWPORT_ZOOM) {
      setViewportTrajs(null);
      return;
    }
    const vtype = filter.vehicleType === 'all' ? undefined : filter.vehicleType;
    try {
      const res = await queryTrajectoriesBBox(
        info.bbox.w, info.bbox.s, info.bbox.e, info.bbox.n,
        vtype, filter.city, filter.simulationDay,
        500, true, filter.transportModes, filter.scenario,
        filter.goodsType, filter.minHour, filter.maxHour,
        filter.minSpeed, filter.maxSpeed, filter.maxDwellMinutes,
        filter.minDetourRatio, filter.maxDetourRatio,
      );
      setViewportTrajs(res.trajectories);
    } catch (e) {
      console.error('Viewport trajectory fetch failed:', e);
    }
  }, [filter]);
  const displayedTrajectories = viewportTrajs ?? trajectories;

  // First-load auto-fit (universal-trajectory Phase 2 UX fix): freeze the
  // union bbox across vehicle types from the FIRST stats response that
  // carries per-source bboxes. The lock ref guarantees this fires once per
  // page load — stats refetches on filter change must NOT re-fit the camera
  // (that's why the frozen value, not stats, goes to MapView).
  const [initialFitBBox, setInitialFitBBox] = useState<Bbox | null>(null);
  const fitBBoxLockedRef = useRef(false);
  useEffect(() => {
    if (fitBBoxLockedRef.current) return;
    const byType = stats?.trips?.by_vehicle_type;
    if (!byType) return;
    const bbox = unionBboxes(Object.values(byType).map(v => v.bbox));
    if (bbox) {
      fitBBoxLockedRef.current = true;
      setInitialFitBBox(bbox);
    }
  }, [stats]);

  const animation = useAnimation();

  // Zones/polygon layers — static per DB, fetched once on mount. Declared
  // here (above handleUploaded) so the upload-completion refetch can reload.
  const { zones, styles: zoneStyles, reload: reloadZones } = useZones();

  // Upload-and-go: on ingest completion, re-run exactly what Refresh does
  // (useTrajectories refetch) plus filter-options, so the new source appears
  // as a vehicle-type button + legend entry without a reload. Zones reload
  // too — an upload bundle may carry zone layers.
  const handleUploaded = useCallback(() => {
    refetch();
    reloadFilterOptions();
    void reloadZones();
  }, [refetch, reloadFilterOptions, reloadZones]);

  const uploader = useUpload({ onDone: handleUploaded });

  const hasData = (stats?.trips?.row_count ?? 0) > 0;
  const { insights, loading: insightsLoading, error: insightsError } = useInsights(
    filter.vehicleType, filter.city, filter.simulationDay, hasData,
    filter.goodsType, filter.minHour, filter.maxHour,
    filter.transportModes, filter.scenario,
  );

  // Phase 4 — scenario impact badge data (null when no scenario active)
  const scenarioImpact = useScenarioImpact(
    filter.scenario, filter.vehicleType, filter.city, filter.simulationDay,
  );

  // Scenario bbox is city-specific: a city switch clears it (other filter
  // changes keep it — it's a declared experiment). First-run guard so a
  // hash-restored scenario survives the mount ('' sentinel ≠ any real city,
  // and prev may legitimately be undefined = "All cities").
  const prevCityRef = useRef<string | undefined | ''>('');
  useEffect(() => {
    const prev = prevCityRef.current;
    prevCityRef.current = filter.city;
    if (prev === '' || prev === filter.city) return;
    setFilter(f => (f.scenario ? { ...f, scenario: undefined } : f));
  }, [filter.city]);

  const cityCenter: [number, number] | null =
    (filter.city && filterOptions?.city_centers[filter.city]) || null;

  // Phase 2B — pulse heatmap data (fetched once per filter change while on)
  const pulse = useHourlyDensity(
    !!layerVisibility.pulse, filter.vehicleType, filter.city,
    filter.minHour, filter.maxHour,
  );

  // Footfall — walk-trip waypoint density (fetched when the layer is on)
  const footfall = useFootfall(
    !!layerVisibility.footfall, filter.vehicleType, filter.city, filter.simulationDay,
    filter.minHour, filter.maxHour, filter.goodsType,
  );

  // Universal-trajectory Phase 2 — POI catalogue + points for the enabled
  // categories. Independent of the trip filter; category set is the only dim.
  const poi = usePois({
    initialDisabled: disabledPoiCategories,
    onDisabledChange: setDisabledPoiCategories,
  });

  // Category → color map (YAML color wins; deterministic hash fallback) and
  // POI source_key → label map for MapView dots + tooltips. Categories arrive
  // one row per (source_key, category) — first row wins for shared names.
  const poiColorByCategory = useMemo(() => {
    const m: Record<string, [number, number, number]> = {};
    for (const c of poi.categories) {
      if (!(c.category in m)) m[c.category] = poiColor(c);
    }
    return m;
  }, [poi.categories]);

  // Category-glyph sprite sheet for the map's POI IconLayer (null in
  // canvas-less environments → MapView keeps the dot fallback).
  const poiIconAtlas = useMemo(
    () => buildPoiIconAtlas(poi.categories, poiColorByCategory),
    [poi.categories, poiColorByCategory],
  );

  const poiSourceLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of poi.categories) {
      if (c.label && !(c.source_key in m)) m[c.source_key] = c.label;
    }
    return m;
  }, [poi.categories]);

  // Phase 2/3 overlay state
  const [odFlows, setODFlows] = useState<ODFlow[]>([]);
  const [densityPoints, setDensityPoints] = useState<DensityPoint[]>([]);
  const [clusterResult, setClusterResult] = useState<ClusterResult | null>(null);
  const [linkDensity, setLinkDensity] = useState<LinkDensityItem[]>([]);
  // Fleet-comparison grid-diff cells (⇄ tab toggle)
  const [compareGrid, setCompareGrid] = useState<CompareGridResponse | null>(null);

  const handleODFlows = useCallback((flows: ODFlow[]) => setODFlows(flows), []);
  const handleDensity = useCallback((pts: DensityPoint[]) => setDensityPoints(pts), []);
  const handleClusters = useCallback((res: ClusterResult | null) => setClusterResult(res), []);
  const handleLinkDensity = useCallback((links: LinkDensityItem[]) => setLinkDensity(links), []);
  const handleCompareGrid = useCallback(
    (grid: CompareGridResponse | null) => setCompareGrid(grid), []);

  // Fix 4: auto-clear on-demand overlays when major filter dimensions change
  useEffect(() => {
    setODFlows([]);
    setDensityPoints([]);
    setClusterResult(null);
    // link density auto-refetches from AnalysisPanel once the user has loaded it
    setDrillTrajectories([]);
    setDrillPoint(null);
    // Fleet-comparison grid diff is filter-scoped too
    setCompareGrid(null);
    // Sprint A1b: also clear zone results — they were filter-scoped
    setZoneBBox(null);
    setZoneTrips([]);
    // transportModes joined to a string — array identity changes per toggle.
  }, [filter.vehicleType, filter.city, filter.simulationDay, filter.goodsType,
      filter.transportModes?.join(',')]);

  // Map click handler — fires radius query on empty-map clicks
  const handleMapClick = useCallback(async (lon: number, lat: number) => {
    setDrillLoading(true);
    setDrillError(null);
    setDrillPoint([lon, lat]);
    try {
      const res = await queryTrajectoriesPoint(
        lon, lat, 1.0,
        filter.vehicleType,
        filter.city,
        filter.simulationDay,
        200,
        true,
        filter.transportModes,
        filter.scenario,
        filter.goodsType,
        filter.minHour,
        filter.maxHour,
        filter.minSpeed,
        filter.maxSpeed,
        filter.maxDwellMinutes,
        filter.minDetourRatio,
        filter.maxDetourRatio,
      );
      setDrillTrajectories(res.trajectories);
    } catch (e) {
      console.error('Drill query failed:', e);
      setDrillTrajectories([]);
      setDrillError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
    }
    setDrillLoading(false);
  }, [filter]);

  const clearDrill = useCallback(() => {
    setDrillTrajectories([]);
    setDrillPoint(null);
    setDrillError(null);
  }, []);

  const handleTrajectoryClick = useCallback((traj: Trajectory) => {
    setSelectedTrajectory(traj);
  }, []);

  // Phase 2A — agent follow/unfollow handlers (capped at MAX_AGENTS)
  const addAgent = useCallback((key: string) => {
    setSelectedAgents(prev =>
      prev.includes(key) || prev.length >= MAX_AGENTS ? prev : [...prev, key],
    );
  }, []);

  const removeAgent = useCallback((key: string) => {
    setSelectedAgents(prev => prev.filter(k => k !== key));
  }, []);

  const clearAgents = useCallback(() => setSelectedAgents([]), []);

  const clearSelectedTrajectory = useCallback(() => {
    setSelectedTrajectory(null);
  }, []);

  const handleZoneResult = useCallback(
    (bbox: { w: number; s: number; e: number; n: number }, trips: TripPoint[]) => {
      setZoneBBox(bbox);
      setZoneTrips(trips);
    },
    [],
  );

  const clearZone = useCallback(() => {
    setZoneBBox(null);
    setZoneTrips([]);
  }, []);

  // Phase 3 — building height exaggeration (render param, not a data filter:
  // lives outside FilterState/hash, like trailLength).
  const [buildingExaggeration, setBuildingExaggeration] = useState(1);

  // Screenshot handler — composites basemap + deck canvases (Phase 3).
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const handleScreenshot = useCallback(() => {
    if (!mapContainerRef.current) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportCompositePng(mapContainerRef.current, `pflow-viz-${timestamp}.png`);
  }, []);

  // Per-dataset layer availability for the FilterPanel's grouped toggles —
  // Phase B: seed from filter-options capabilities (+ session overlay state).
  const layerAvailability = useMemo<LayerAvailabilityContext>(() => {
    const caps = filterOptions?.capabilities;
    const labeled = filterOptions?.modes ?? [];
    // Phase C: modes[].id may be null for string-only datasets — drop nulls
    // for LayerAvailabilityContext.transportModes (number[] / PFLOW codes).
    const modeIds = labeled.length > 0
      ? labeled.map(m => m.id).filter((id): id is number => id != null)
      : (filterOptions?.transport_modes ?? []).map(m => m.mode);
    const hasDensityHourly = caps?.has_density_hourly ?? null;
    // Capabilities win when known; probe still supplies 409 fix-it detail.
    const pulseBuilt =
      hasDensityHourly === true ? true
        : hasDensityHourly === false ? false
          : (pulseProbe?.built ?? null);
    return {
      hasTrajectories: caps?.has_trajectories ?? stats?.has_trajectories ?? false,
      transportModes: modeIds,
      modeLabels: labeled.map(m => m.label),
      attrKeys: caps?.attr_keys ?? [],
      hasModes: caps?.has_modes ?? modeIds.length > 0,
      hasDensityHourly,
      sourceModes: (filterOptions?.sources ?? []).map(s => s.mode),
      megaSim: isMegaSim(caps),
      simScale: resolveSimScale(caps),
      pulseBuilt,
      pulseDetail: pulseProbe?.detail
        ?? (hasDensityHourly === false
          ? 'density_hourly not built — run: python -m backend.ingest --aggregates-only'
          : undefined),
      hasClusterResult: clusterResult !== null,
      hasDrillResult: drillTrajectories.length > 0,
      hasODFlows: odFlows.length > 0,
      hasDensity: densityPoints.length > 0,
      hasLinkDensity: linkDensity.length > 0,
      hasCompareGrid: compareGrid !== null && compareGrid.cells.length > 0,
      hasFollowedAgents: selectedAgents.length > 0,
      hasPois: poi.categories.length > 0,
      hasZones: zones.length > 0,
    };
  }, [
    stats, filterOptions, pulseProbe, clusterResult, drillTrajectories,
    odFlows, densityPoints, linkDensity, compareGrid, selectedAgents, poi.categories,
    zones,
  ]);

  return (
    <div ref={mapContainerRef} style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <MapView
        trajectories={displayedTrajectories}
        trips={trips}
        currentTime={animation.currentTime}
        trailLength={animation.trailLength}
        odFlows={odFlows}
        densityPoints={densityPoints}
        clusterResult={clusterResult}
        cityCenter={cityCenter}
        fitToBBox={initialFitBBox}
        linkDensityPoints={linkDensity}
        compareGridCells={compareGrid?.cells}
        compareGridCellDeg={compareGrid?.cell_deg}
        drillTrajectories={drillTrajectories}
        drillPoint={drillPoint}
        zoneBBox={zoneBBox}
        scenarioBBox={filter.scenario?.bbox ?? null}
        layerVisibility={layerVisibility}
        forceOdArcs={forceOdArcs(filterOptions?.capabilities)}
        agentTrajectories={agentTrajectories}
        selectedAgents={selectedAgents}
        sourceStyles={filterOptions?.sources ?? []}
        pulseData={pulse.data}
        footfallPoints={layerVisibility.footfall ? footfall.points : []}
        buildingsCity={filter.city || 'tokyo'}
        buildingExaggeration={buildingExaggeration}
        colorBy={filter.colorBy ?? 'source'}
        hiddenSources={hiddenSources}
        pois={poi.pois}
        poiColorByCategory={poiColorByCategory}
        poiIconAtlas={poiIconAtlas}
        zones={zones}
        zoneStyleBySource={zoneStyles}
        poiSourceLabels={poiSourceLabels}
        onMapClick={handleMapClick}
        onTrajectoryClick={handleTrajectoryClick}
        onViewIdle={handleViewIdle}
      />

      <SourceLegend
        sources={filterOptions?.sources ?? []}
        attribution={layerVisibility.buildings ? PLATEAU_ATTRIBUTION : undefined}
        colorBy={filter.colorBy ?? 'source'}
        transportModes={filterOptions?.transport_modes ?? []}
        hiddenSources={hiddenSources}
        onToggleSource={toggleSource}
      />

      {/* Universal-trajectory Phase 2 — only when loading FINISHED with zero
          trips; the FilterPanel skeleton covers the in-flight state. The drop
          area shares App's uploader; a successful ingest refetches stats and
          this overlay swaps itself out as soon as trips exist. */}
      {!loading && stats !== null && (stats.trips?.row_count ?? 0) === 0 && (
        <EmptyState onUploadFiles={uploader.upload} />
      )}

      {/* Backend unreachable (or DB missing) — filter-options failed, so no
          source list, stats, or trajectories can load. Shown instead of an
          eternal empty screen; Retry re-fires the fetch. */}
      {filterOptions === null && filterOptionsError !== null && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          background: 'rgba(20,20,30,0.95)', border: '1px solid #a55',
          borderRadius: 8, padding: '16px 20px', fontSize: 12, color: '#f0c0c0',
          zIndex: 10, maxWidth: 360, textAlign: 'center', lineHeight: 1.5,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
            {filterOptionsError}
          </div>
          <div style={{ color: '#999', marginBottom: 10 }}>
            The map, filters, and analysis all need the API. If you launched
            only the frontend, start the backend too (port 9999).
          </div>
          <button
            onClick={() => reloadFilterOptions()}
            style={{
              background: 'rgba(79,195,247,0.15)', color: '#4fc3f7',
              border: '1px solid rgba(79,195,247,0.4)', borderRadius: 4,
              padding: '5px 14px', fontSize: 12, cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Map-corner status stack (pulse / drill / footfall) */}
      {(() => {
        const banners: Array<{ key: string; message: string; tone: 'error' | 'warn'; onDismiss?: () => void }> = [];
        if (layerVisibility.pulse && pulse.error) {
          banners.push({ key: 'pulse', message: `Pulse layer unavailable: ${pulse.error}`, tone: 'error' });
        }
        if (drillError !== null) {
          banners.push({
            key: 'drill',
            message: `Area query failed: ${drillError}`,
            tone: 'error',
            onDismiss: () => setDrillError(null),
          });
        }
        if (layerVisibility.footfall && footfall.error) {
          banners.push({ key: 'footfall-err', message: `Footfall layer unavailable: ${footfall.error}`, tone: 'error' });
        } else if (layerVisibility.footfall && footfall.fallback) {
          banners.push({
            key: 'footfall-fb',
            message: 'Footfall: no walk waypoints — showing walk-trip OD density instead.',
            tone: 'warn',
          });
        }
        return banners.map((b, i) => (
          <StatusBanner
            key={b.key}
            message={b.message}
            tone={b.tone}
            stackIndex={i}
            onDismiss={b.onDismiss}
          />
        ));
      })()}

      <FilterPanel
        filter={filter}
        stats={stats}
        loading={loading}
        error={error}
        trajectoryCount={displayedTrajectories.length}
        tripCount={trips.length}
        filterOptions={filterOptions}
        drillTrajectories={drillTrajectories}
        drillPoint={drillPoint}
        drillLoading={drillLoading}
        layerVisibility={layerVisibility}
        layerAvailability={layerAvailability}
        buildingExaggeration={buildingExaggeration}
        scenarioImpact={scenarioImpact}
        poiCategories={poi.categories}
        enabledPoiCategories={poi.enabledCategories}
        onTogglePoiCategory={poi.toggleCategory}
        onSetAllPoiCategories={poi.setAll}
        onUploadFiles={uploader.upload}
        onChange={setFilter}
        onRefetch={refetch}
        onClearDrill={clearDrill}
        onLayerToggle={(key) => {
          setLayerVisibility(prev => {
            const next = { ...prev, [key]: !prev[key] };
            const scale = resolveSimScale(filterOptions?.capabilities);
            if (
              (isMegaSim(filterOptions?.capabilities) || isMicroScale(filterOptions?.capabilities))
              && marksLodOverride(next, key, scale)
            ) {
              setLodUserOverride(true);
            }
            return next;
          });
        }}
        onApplyPreset={(vis) => {
          const scale = resolveSimScale(filterOptions?.capabilities);
          if (
            (isMegaSim(filterOptions?.capabilities) || isMicroScale(filterOptions?.capabilities))
            && marksLodOverride(vis, undefined, scale)
          ) {
            setLodUserOverride(true);
          }
          setLayerVisibility(prev => ({ ...prev, ...vis }));
          if (vis.linkDensity) setLinkLoadNonce(n => n + 1);
        }}
        onBuildingExaggeration={setBuildingExaggeration}
        onScreenshot={handleScreenshot}
      />

      <AnalysisPanel
        vehicleType={filter.vehicleType}
        city={filter.city}
        simulationDay={filter.simulationDay}
        goodsType={filter.goodsType}
        minHour={filter.minHour}
        maxHour={filter.maxHour}
        hasData={hasData}
        insights={insights}
        insightsLoading={insightsLoading}
        insightsError={insightsError}
        onODFlows={handleODFlows}
        onDensity={handleDensity}
        onClusters={handleClusters}
        onLinkDensity={handleLinkDensity}
        onCompareGrid={handleCompareGrid}
        selectedTrajectory={selectedTrajectory}
        onClearSelectedTrajectory={clearSelectedTrajectory}
        zoneBBox={zoneBBox}
        zoneTrips={zoneTrips}
        onZoneResult={handleZoneResult}
        onClearZone={clearZone}
        scenarioActive={!!filter.scenario}
        onPedestrianize={(bbox) => setFilter(f => ({
          ...f, scenario: { type: 'pedestrianize', bbox },
        }))}
        onClearScenario={() => setFilter(f => ({ ...f, scenario: undefined }))}
        selectedAgents={selectedAgents}
        agentLoading={agentLoading}
        onAddAgent={addAgent}
        onRemoveAgent={removeAgent}
        onClearAgents={clearAgents}
        sources={filterOptions?.sources ?? []}
        transportModes={filter.transportModes}
        scenario={filter.scenario}
        minSpeed={filter.minSpeed}
        maxSpeed={filter.maxSpeed}
        maxDwellMinutes={filter.maxDwellMinutes}
        minDetourRatio={filter.minDetourRatio}
        maxDetourRatio={filter.maxDetourRatio}
        attrKeys={filterOptions?.capabilities?.attr_keys ?? []}
        modeLabels={(filterOptions?.modes ?? []).map(m => m.label)}
        datasetTransportModes={
          (() => {
            const fromModes = (filterOptions?.modes ?? [])
              .map(m => m.id)
              .filter((id): id is number => id != null);
            return fromModes.length > 0
              ? fromModes
              : (filterOptions?.transport_modes ?? []).map(m => m.mode);
          })()
        }
        colorBy={filter.colorBy ?? 'source'}
        linkLoadNonce={linkLoadNonce}
      />

      <TimeSlider
        currentTime={animation.currentTime}
        speed={animation.speed}
        playing={animation.playing}
        trailLength={animation.trailLength}
        onTogglePlay={animation.togglePlay}
        onSetSpeed={animation.setSpeed}
        onSetTime={animation.setTime}
        onSetTrailLength={animation.setTrailLength}
      />

      {/* Upload-and-go — global drop overlay, ingest status card, toasts */}
      <UploadDropzone uploader={uploader} />
    </div>
  );
}
