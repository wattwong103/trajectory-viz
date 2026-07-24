/**
 * PFLOW Viz — Main application component.
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
import { PLATEAU_ATTRIBUTION } from './buildings';
import { useTrajectories } from './hooks/useTrajectories';
import { useAnimation } from './hooks/useAnimation';
import { useInsights } from './hooks/useInsights';
import { useHourlyDensity } from './hooks/useHourlyDensity';
import { useFootfall } from './hooks/useFootfall';
import { useScenarioImpact } from './hooks/useScenarioImpact';
import { usePois } from './hooks/usePois';
import { useUpload } from './hooks/useUpload';
import { poiColor } from './poiColors';
import { unionBboxes, type Bbox } from './utils/bbox';
import { UploadDropzone } from './components/UploadDropzone';
import { fetchFilterOptions, queryTrajectoriesPoint, fetchTrajectoriesByVehicle, fetchHourlyDensity } from './api';
import { exportCompositePng } from './utils/exportPng';
import type { LayerAvailabilityContext } from './layerCatalog';
import type { FilterState, FilterOptions, Trajectory, TripPoint } from './types';
import type { ODFlow, DensityPoint, ClusterResult, LinkDensityItem } from './api';

const DEFAULT_FILTER: FilterState = {
  vehicleType: '',                // empty = no source filter (all sources)
  minHour: 0,
  maxHour: 23,
};

// ─── URL hash encoding/decoding ──────────────────────────

// Parse a finite-number query param; returns undefined if absent or NaN.
function numParam(params: URLSearchParams, key: string): number | undefined {
  const v = params.get(key);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function encodeHash(filter: FilterState): string {
  const parts: string[] = [];
  if (filter.vehicleType) parts.push(`vt=${filter.vehicleType}`);
  if (filter.city) parts.push(`city=${encodeURIComponent(filter.city)}`);
  if (filter.simulationDay !== undefined) parts.push(`day=${filter.simulationDay}`);
  if (filter.minHour !== 0) parts.push(`minh=${filter.minHour}`);
  if (filter.maxHour !== 23) parts.push(`maxh=${filter.maxHour}`);
  if (filter.goodsType) parts.push(`gt=${encodeURIComponent(filter.goodsType)}`);
  // F1 advanced filters (Sprint A5): short keys keep the hash compact.
  // Defaults are "undefined", so any defined value gets encoded.
  if (filter.minSpeed !== undefined) parts.push(`ms=${filter.minSpeed}`);
  if (filter.maxSpeed !== undefined) parts.push(`xs=${filter.maxSpeed}`);
  if (filter.maxDwellMinutes !== undefined) parts.push(`xd=${filter.maxDwellMinutes}`);
  if (filter.minDetourRatio !== undefined) parts.push(`mr=${filter.minDetourRatio}`);
  if (filter.maxDetourRatio !== undefined) parts.push(`xr=${filter.maxDetourRatio}`);
  // Phase 1 — transport-mode selection + color scheme (short keys tm/cb)
  if (filter.transportModes?.length) parts.push(`tm=${filter.transportModes.join(',')}`);
  if (filter.colorBy === 'transportMode') parts.push('cb=tm');
  // Phase 4 — scenario: sc=p:{w},{s},{e},{n}
  if (filter.scenario) {
    const b = filter.scenario.bbox;
    parts.push(`sc=p:${b.w},${b.s},${b.e},${b.n}`);
  }
  return parts.join('&');
}

// sc= value: 'p:' + four finite floats (w,s,e,n) with w<e, s<n.
function decodeScenario(params: URLSearchParams): FilterState['scenario'] {
  const sc = params.get('sc');
  if (!sc || !sc.startsWith('p:')) return undefined;
  const nums = sc.slice(2).split(',').map(Number);
  if (nums.length !== 4 || nums.some(v => !Number.isFinite(v))) return undefined;
  const [w, s, e, n] = nums;
  if (w >= e || s >= n) return undefined;
  return { type: 'pedestrianize', bbox: { w, s, e, n } };
}

// tm= value: comma-separated small ints, capped at 16 entries (mirrors the
// backend TripFilters pattern ^\d{1,2}(,\d{1,2}){0,15}$).
const TM_RE = /^\d{1,2}(,\d{1,2}){0,15}$/;

function decodeTransportModes(params: URLSearchParams): number[] | undefined {
  const tm = params.get('tm');
  if (!tm || !TM_RE.test(tm)) return undefined;
  const modes = [...new Set(tm.split(',').map(Number))];
  return modes.length > 0 ? modes : undefined;
}

function decodeHash(hash: string): FilterState {
  if (!hash || hash === '#') return DEFAULT_FILTER;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const vt = params.get('vt');
  // Accept any v0.2 source_id (server validates via Pydantic pattern); '' = all.
  return {
    vehicleType: (vt && /^[a-z][a-z0-9_]*$/.test(vt)) ? vt : '',
    city: params.get('city') ? decodeURIComponent(params.get('city')!) : undefined,
    simulationDay: numParam(params, 'day'),
    minHour: numParam(params, 'minh') ?? 0,
    maxHour: numParam(params, 'maxh') ?? 23,
    goodsType: params.get('gt') ? decodeURIComponent(params.get('gt')!) : undefined,
    // F1 advanced filters (Sprint A5)
    minSpeed: numParam(params, 'ms'),
    maxSpeed: numParam(params, 'xs'),
    maxDwellMinutes: numParam(params, 'xd'),
    minDetourRatio: numParam(params, 'mr'),
    maxDetourRatio: numParam(params, 'xr'),
    transportModes: decodeTransportModes(params),
    colorBy: params.get('cb') === 'tm' ? 'transportMode' : undefined,
    scenario: decodeScenario(params),
  };
}

// ─── Hidden-sources hash encoding (Phase 1 legend toggles) ────────────────
// Per-source visibility rides the hash under `hs=` so a pasted link restores
// which populations are hidden. Same source_id validation as vt=.

const SOURCE_ID_RE = /^[a-z][a-z0-9_]*$/;

function encodeHiddenSources(hidden: string[]): string {
  if (hidden.length === 0) return '';
  return `hs=${hidden.join(',')}`;
}

function decodeHiddenSources(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const hs = new URLSearchParams(raw).get('hs');
  if (!hs) return [];
  return hs.split(',').map(s => s.trim()).filter(s => SOURCE_ID_RE.test(s));
}

// ─── Disabled-POI-categories hash encoding (universal-trajectory Phase 2) ──
// `pc=` carries the DISABLED category list (default = all enabled), so clean
// URLs stay clean — same convention as hs= for hidden sources. Category names
// may contain spaces (backend pattern ^[A-Za-z0-9_ \-]{1,40}$), so the value
// is percent-encoded; URLSearchParams.get() applies the single decode on the
// way back (no double-decode — a literal '%' would throw).

const POI_CATEGORY_RE = /^[A-Za-z0-9_ \-]{1,40}$/;

function encodeDisabledPoiCategories(disabled: string[]): string {
  if (disabled.length === 0) return '';
  return `pc=${encodeURIComponent(disabled.join(','))}`;
}

function decodeDisabledPoiCategories(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const pc = new URLSearchParams(raw).get('pc');
  if (!pc) return [];
  return pc.split(',').map(s => s.trim()).filter(s => POI_CATEGORY_RE.test(s));
}

// ─── Agent-selection hash encoding (Phase 2A) ─────────────
// Followed agents ride the same URL hash as filters under the `ag=` key so a
// pasted link restores the whole scene. Kept separate from FilterState — the
// selection must survive filter changes without retriggering useTrajectories.

const MAX_AGENTS = 8;
// Mirrors the backend's by-vehicle key validation (routers/trajectories.py).
const AGENT_KEY_RE = /^[a-z][a-z0-9_]*:[A-Za-z0-9_:.\-]{1,64}$/;

function encodeAgents(agents: string[]): string {
  if (agents.length === 0) return '';
  return `ag=${encodeURIComponent(agents.join(','))}`;
}

function decodeAgents(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const ag = new URLSearchParams(raw).get('ag');
  if (!ag) return [];
  return decodeURIComponent(ag)
    .split(',')
    .map(k => k.trim())
    .filter(k => AGENT_KEY_RE.test(k))
    .slice(0, MAX_AGENTS);
}

// ─── Layer visibility defaults ────────────────────────────

export type LayerVisibility = Record<string, boolean>;

const DEFAULT_LAYER_VIS: LayerVisibility = {
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
};

export default function App() {
  // Initialise filter from URL hash on first load
  const [filter, setFilter] = useState<FilterState>(() => decodeHash(window.location.hash));
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(DEFAULT_LAYER_VIS);

  // Drill-down state (map-click radius query)
  const [drillTrajectories, setDrillTrajectories] = useState<Trajectory[]>([]);
  const [drillPoint, setDrillPoint] = useState<[number, number] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

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
    fetchFilterOptions().then(setFilterOptions).catch(console.error);
  }, []);

  useEffect(() => {
    reloadFilterOptions();
  }, [reloadFilterOptions]);

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
    fetchTrajectoriesByVehicle(selectedAgents, filter.simulationDay)
      .then(res => { if (!cancelled) setAgentTrajectories(res.trajectories); })
      .catch(e => { console.error('Agent trajectory fetch failed:', e); })
      .finally(() => { if (!cancelled) setAgentLoading(false); });
    return () => { cancelled = true; };
  }, [selectedAgents, filter.simulationDay]);

  const {
    trajectories, trips, stats,
    loading, error, refetch,
  } = useTrajectories(filter);

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

  // Upload-and-go: on ingest completion, re-run exactly what Refresh does
  // (useTrajectories refetch) plus filter-options, so the new source appears
  // as a vehicle-type button + legend entry without a reload.
  const handleUploaded = useCallback(() => {
    refetch();
    reloadFilterOptions();
  }, [refetch, reloadFilterOptions]);

  const uploader = useUpload({ onDone: handleUploaded });

  const hasData = (stats?.trips?.row_count ?? 0) > 0;
  const { insights, loading: insightsLoading } = useInsights(
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
  );

  // Footfall — walk-trip waypoint density (fetched when the layer is on)
  const footfall = useFootfall(
    !!layerVisibility.footfall, filter.vehicleType, filter.city, filter.simulationDay,
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

  const handleODFlows = useCallback((flows: ODFlow[]) => setODFlows(flows), []);
  const handleDensity = useCallback((pts: DensityPoint[]) => setDensityPoints(pts), []);
  const handleClusters = useCallback((res: ClusterResult | null) => setClusterResult(res), []);
  const handleLinkDensity = useCallback((links: LinkDensityItem[]) => setLinkDensity(links), []);

  // Fix 4: auto-clear on-demand overlays when major filter dimensions change
  useEffect(() => {
    setODFlows([]);
    setDensityPoints([]);
    setClusterResult(null);
    setLinkDensity([]);
    setDrillTrajectories([]);
    setDrillPoint(null);
    // Sprint A1b: also clear zone results — they were filter-scoped
    setZoneBBox(null);
    setZoneTrips([]);
    // transportModes joined to a string — array identity changes per toggle.
  }, [filter.vehicleType, filter.city, filter.simulationDay, filter.goodsType,
      filter.transportModes?.join(',')]);

  // Map click handler — fires radius query on empty-map clicks
  const handleMapClick = useCallback(async (lon: number, lat: number) => {
    setDrillLoading(true);
    setDrillPoint([lon, lat]);
    try {
      const res = await queryTrajectoriesPoint(
        lon, lat, 1.0,
        filter.vehicleType,
        filter.city,
        filter.simulationDay,
        200,
      );
      setDrillTrajectories(res.trajectories);
    } catch (e) {
      console.error('Drill query failed:', e);
      setDrillTrajectories([]);
    }
    setDrillLoading(false);
  }, [filter.vehicleType, filter.city, filter.simulationDay]);

  const clearDrill = useCallback(() => {
    setDrillTrajectories([]);
    setDrillPoint(null);
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
  // everything the catalog needs, from state App already holds.
  const layerAvailability = useMemo<LayerAvailabilityContext>(() => ({
    hasTrajectories: stats?.has_trajectories ?? false,
    transportModes: (filterOptions?.transport_modes ?? []).map(m => m.mode),
    sourceModes: (filterOptions?.sources ?? []).map(s => s.mode),
    pulseBuilt: pulseProbe?.built ?? null,
    pulseDetail: pulseProbe?.detail,
    hasClusterResult: clusterResult !== null,
    hasDrillResult: drillTrajectories.length > 0,
    hasODFlows: odFlows.length > 0,
    hasDensity: densityPoints.length > 0,
    hasLinkDensity: linkDensity.length > 0,
    hasFollowedAgents: selectedAgents.length > 0,
    hasPois: poi.categories.length > 0,
  }), [
    stats, filterOptions, pulseProbe, clusterResult, drillTrajectories,
    odFlows, densityPoints, linkDensity, selectedAgents, poi.categories,
  ]);

  return (
    <div ref={mapContainerRef} style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <MapView
        trajectories={trajectories}
        trips={trips}
        currentTime={animation.currentTime}
        trailLength={animation.trailLength}
        odFlows={odFlows}
        densityPoints={densityPoints}
        clusterResult={clusterResult}
        cityCenter={cityCenter}
        fitToBBox={initialFitBBox}
        linkDensityPoints={linkDensity}
        drillTrajectories={drillTrajectories}
        drillPoint={drillPoint}
        zoneBBox={zoneBBox}
        scenarioBBox={filter.scenario?.bbox ?? null}
        layerVisibility={layerVisibility}
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
        poiSourceLabels={poiSourceLabels}
        onMapClick={handleMapClick}
        onTrajectoryClick={handleTrajectoryClick}
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

      {/* Phase 2B — surfaced when the pulse aggregate isn't built (HTTP 409) */}
      {layerVisibility.pulse && pulse.error && (
        <div style={{
          position: 'absolute', bottom: 96, right: 12, maxWidth: 320,
          background: 'rgba(60,20,20,0.9)', border: '1px solid #a55',
          borderRadius: 6, padding: '8px 10px', fontSize: 11, color: '#f0c0c0',
          zIndex: 5,
        }}>
          Pulse layer unavailable: {pulse.error}
        </div>
      )}

      {/* Footfall — honest labels for degraded states (pulse-409 pattern) */}
      {layerVisibility.footfall && (footfall.error || footfall.fallback) && (
        <div style={{
          position: 'absolute', bottom: footfall.error ? 96 : 148, right: 12, maxWidth: 320,
          background: footfall.error ? 'rgba(60,20,20,0.9)' : 'rgba(60,45,15,0.9)',
          border: footfall.error ? '1px solid #a55' : '1px solid #a85',
          borderRadius: 6, padding: '8px 10px', fontSize: 11,
          color: footfall.error ? '#f0c0c0' : '#f0d8b0',
          zIndex: 5,
        }}>
          {footfall.error
            ? `Footfall layer unavailable: ${footfall.error}`
            : 'Footfall: no walk waypoints in this dataset — showing walk-trip OD density instead.'}
        </div>
      )}

      <FilterPanel
        filter={filter}
        stats={stats}
        loading={loading}
        error={error}
        trajectoryCount={trajectories.length}
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
        onLayerToggle={(key) => setLayerVisibility(prev => ({ ...prev, [key]: !prev[key] }))}
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
        onODFlows={handleODFlows}
        onDensity={handleDensity}
        onClusters={handleClusters}
        onLinkDensity={handleLinkDensity}
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
