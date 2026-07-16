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

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { MapView } from './components/MapView';
import { FilterPanel } from './components/FilterPanel';
import { TimeSlider } from './components/TimeSlider';
import { AnalysisPanel } from './components/AnalysisPanel';
import { SourceLegend } from './components/SourceLegend';
import { PLATEAU_ATTRIBUTION } from './buildings';
import { useTrajectories } from './hooks/useTrajectories';
import { useAnimation } from './hooks/useAnimation';
import { useInsights } from './hooks/useInsights';
import { useHourlyDensity } from './hooks/useHourlyDensity';
import { useFootfall } from './hooks/useFootfall';
import { fetchFilterOptions, queryTrajectoriesPoint, fetchTrajectoriesByVehicle } from './api';
import { exportCompositePng } from './utils/exportPng';
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
  return parts.join('&');
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

  // Through-zone bbox state (Sprint A1b — F2 endpoint UI).
  // Once a query fires, App holds the bbox (rendered as yellow PolygonLayer
  // on the map) and the returned trip list (displayed in the Zone tab).
  const [zoneBBox, setZoneBBox] = useState<{ w: number; s: number; e: number; n: number } | null>(null);
  const [zoneTrips, setZoneTrips] = useState<TripPoint[]>([]);

  useEffect(() => {
    fetchFilterOptions().then(setFilterOptions).catch(console.error);
  }, []);

  // Sync filter + agent-selection + hidden-source changes to URL hash
  useEffect(() => {
    const encoded = [encodeHash(filter), encodeAgents(selectedAgents), encodeHiddenSources(hiddenSources)]
      .filter(Boolean)
      .join('&');
    const newHash = encoded ? '#' + encoded : ' ';
    window.history.replaceState(null, '', newHash || window.location.pathname);
  }, [filter, selectedAgents, hiddenSources]);

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

  const animation = useAnimation();

  const hasData = (stats?.trips?.row_count ?? 0) > 0;
  const { insights, loading: insightsLoading } = useInsights(
    filter.vehicleType, filter.city, filter.simulationDay, hasData,
    filter.goodsType, filter.minHour, filter.maxHour,
    filter.transportModes,
  );

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
        linkDensityPoints={linkDensity}
        drillTrajectories={drillTrajectories}
        drillPoint={drillPoint}
        zoneBBox={zoneBBox}
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
        buildingExaggeration={buildingExaggeration}
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
        selectedAgents={selectedAgents}
        agentLoading={agentLoading}
        onAddAgent={addAgent}
        onRemoveAgent={removeAgent}
        onClearAgents={clearAgents}
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
    </div>
  );
}
