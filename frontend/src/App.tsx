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

import React, { useState, useCallback, useEffect } from 'react';
import { MapView } from './components/MapView';
import { FilterPanel } from './components/FilterPanel';
import { TimeSlider } from './components/TimeSlider';
import { AnalysisPanel } from './components/AnalysisPanel';
import { useTrajectories } from './hooks/useTrajectories';
import { useAnimation } from './hooks/useAnimation';
import { useInsights } from './hooks/useInsights';
import { fetchFilterOptions, queryTrajectoriesPoint } from './api';
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
  return parts.join('&');
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
  };
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

  // Through-zone bbox state (Sprint A1b — F2 endpoint UI).
  // Once a query fires, App holds the bbox (rendered as yellow PolygonLayer
  // on the map) and the returned trip list (displayed in the Zone tab).
  const [zoneBBox, setZoneBBox] = useState<{ w: number; s: number; e: number; n: number } | null>(null);
  const [zoneTrips, setZoneTrips] = useState<TripPoint[]>([]);

  useEffect(() => {
    fetchFilterOptions().then(setFilterOptions).catch(console.error);
  }, []);

  // Sync filter changes to URL hash
  useEffect(() => {
    const encoded = encodeHash(filter);
    const newHash = encoded ? '#' + encoded : ' ';
    window.history.replaceState(null, '', newHash || window.location.pathname);
  }, [filter]);

  const {
    trajectories, trips, stats,
    loading, error, refetch,
  } = useTrajectories(filter);

  const animation = useAnimation();

  const hasData = (stats?.trips?.row_count ?? 0) > 0;
  const { insights, loading: insightsLoading } = useInsights(
    filter.vehicleType, filter.city, filter.simulationDay, hasData,
    filter.goodsType, filter.minHour, filter.maxHour,
  );

  const cityCenter: [number, number] | null =
    (filter.city && filterOptions?.city_centers[filter.city]) || null;

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
  }, [filter.vehicleType, filter.city, filter.simulationDay, filter.goodsType]);

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

  // Screenshot handler
  const handleScreenshot = useCallback(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pflow-viz-${timestamp}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
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
        onMapClick={handleMapClick}
        onTrajectoryClick={handleTrajectoryClick}
      />

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
        onChange={setFilter}
        onRefetch={refetch}
        onClearDrill={clearDrill}
        onLayerToggle={(key) => setLayerVisibility(prev => ({ ...prev, [key]: !prev[key] }))}
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
