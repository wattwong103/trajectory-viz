/**
 * AnalysisPanel — Insights summary + analysis charts and controls.
 *
 * Tabs:
 * 0. Summary — key metric cards, distance sparkline, auto-generated text insights
 * 1. Temporal — hourly departure histogram (Recharts BarChart)
 * 2. OD Flows — toggle ArcLayer on the map
 * 3. Density — toggle HeatmapLayer on the map
 * 4. Clusters — run clustering and show results
 * 5. Chains — trip chain length distribution
 *
 * Presentational tab bodies live under ./analysis/; this file keeps props,
 * state, loaders, and the tab bar shell.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { InsightsResponse, MetricsDistribution, Trajectory, TripPoint, FilterState, SourceStyle } from '../types';
import {
  fetchHourlyDepartures, fetchODFlows, fetchSpatialDensity,
  runClustering, fetchChainLengths,
  fetchTemporalPeaks, fetchDurationDistribution,
  fetchSpatialHotspots, fetchWaypointDensity,
  fetchDwellTimes, fetchRoundTrips, fetchCommodityPatterns,
  fetchLinkDensity,
  fetchMetricsDistribution,
  fetchTripsThroughZoneBBox,
  fetchMultiStopChains,
  runRouteSimilarity,
  type HourlyData, type ODFlow, type DensityPoint, type ClusterResult,
  type LinkDensityItem, type MultiStopVehicle,
  type RouteSimilarityResponse,
} from '../api';
import type { CompareGridResponse } from '../types';
import { friendlyFetchError } from '../friendlyError';
import { hasCarMode, hasLabAttr } from '../layerCatalog';
import { AgentTab } from './AgentTab';
import { CompareTab } from './CompareTab';
import { useNarrowViewport } from '../hooks/useNarrowViewport';
import {
  styles,
  SummaryTab,
  TemporalTab,
  MetricsTab,
  OdFlowsTab,
  DensityTab,
  ClustersTab,
  ChainsTab,
  LinksTab,
  ZoneTab,
  DetailTab,
  type ClusterAlgo,
} from './analysis';

type Tab = 'summary' | 'temporal' | 'metrics' | 'od' | 'density' | 'clusters' | 'chains' | 'links' | 'detail' | 'zone' | 'agents' | 'compare';

/** Short labels — symbol-only tabs were hard to decode on first run. */
const TAB_LABELS: Record<Tab, string> = {
  summary: 'Sum',
  temporal: 'Time',
  metrics: 'F1',
  od: 'OD',
  density: 'Dens',
  clusters: 'Clust',
  chains: 'Chain',
  links: 'Link',
  detail: 'Trip',
  zone: 'Zone',
  agents: 'Agent',
  compare: 'A⇄B',
};

const TAB_TITLES: Record<Tab, string> = {
  summary: 'Summary insights',
  temporal: 'Temporal patterns',
  metrics: 'Speed / dwell / detour metrics',
  od: 'Origin–destination flows',
  density: 'Spatial density & hotspots',
  clusters: 'Clustering & route similarity',
  chains: 'Trip chains & multi-stop',
  links: 'Link / network density',
  detail: 'Selected trajectory detail',
  zone: 'Through-zone query',
  agents: 'Follow agents',
  compare: 'Fleet A⇄B comparison',
};

interface AnalysisPanelProps {
  vehicleType: string;
  city?: string;
  simulationDay?: number;
  goodsType?: string;
  minHour?: number;
  maxHour?: number;
  hasData: boolean;
  insights: InsightsResponse | null;
  insightsLoading: boolean;
  insightsError?: string | null;
  onODFlows: (flows: ODFlow[]) => void;
  onDensity: (points: DensityPoint[]) => void;
  onClusters: (result: ClusterResult | null) => void;
  onLinkDensity: (links: LinkDensityItem[]) => void;
  /** Fleet-comparison grid-diff toggle (⇄ tab) — null clears the overlay. */
  onCompareGrid?: (grid: CompareGridResponse | null) => void;
  /** Live map-overlay counts so tabs can show “on map” status (App owns state). */
  odFlowCount?: number;
  densityCount?: number;
  linkCount?: number;
  mapHasClusters?: boolean;
  // Sprint A1a — Trajectory Details
  selectedTrajectory?: Trajectory | null;
  onClearSelectedTrajectory?: () => void;
  // Sprint A1b — Through-zone bbox
  zoneBBox?: { w: number; s: number; e: number; n: number } | null;
  zoneTrips?: TripPoint[];
  onZoneResult?: (bbox: { w: number; s: number; e: number; n: number }, trips: TripPoint[]) => void;
  onClearZone?: () => void;
  // Phase 4 — pedestrianize scenario controls (Zone tab)
  scenarioActive?: boolean;
  onPedestrianize?: (bbox: { w: number; s: number; e: number; n: number }) => void;
  onClearScenario?: () => void;
  // Phase 2A — agent selection & playback
  selectedAgents?: string[];
  agentLoading?: boolean;
  onAddAgent?: (key: string) => void;
  onRemoveAgent?: (key: string) => void;
  onClearAgents?: () => void;
  // fleet-comparison — sources list + shared filters the ⇄ tab applies
  // symmetrically to both fleets (vehicle_type is overridden server-side).
  sources?: SourceStyle[];
  transportModes?: number[];
  scenario?: FilterState['scenario'];
  // F1 ranges forwarded to the ⇄ tab (symmetric across both fleets).
  minSpeed?: number;
  maxSpeed?: number;
  maxDwellMinutes?: number;
  minDetourRatio?: number;
  maxDetourRatio?: number;
  // Phase B — capability gating for lab plugins (goods / pedestrianize).
  attrKeys?: string[];
  modeLabels?: string[];
  /** Mode ids present in the dataset (not the active filter selection). */
  datasetTransportModes?: number[];
  colorBy?: 'source' | 'transportMode' | string;
  /** Increment to force a link-density fetch (Network preset). */
  linkLoadNonce?: number;
}

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
  vehicleType, city, simulationDay, goodsType, minHour, maxHour,
  hasData, insights, insightsLoading, insightsError = null,
  onODFlows, onDensity, onClusters, onLinkDensity, onCompareGrid,
  odFlowCount = 0, densityCount = 0, linkCount = 0, mapHasClusters = false,
  selectedTrajectory, onClearSelectedTrajectory,
  zoneBBox, zoneTrips, onZoneResult, onClearZone,
  scenarioActive = false, onPedestrianize, onClearScenario,
  selectedAgents = [], agentLoading = false,
  onAddAgent, onRemoveAgent, onClearAgents,
  sources = [], transportModes, scenario,
  minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
  attrKeys = [], modeLabels = [], datasetTransportModes = [],
  colorBy = 'source',
  linkLoadNonce = 0,
}) => {
  const showCommodityPatterns = hasLabAttr({ attrKeys }, 'goods_type');
  const showPedestrianize = hasCarMode({
    transportModes: datasetTransportModes,
    modeLabels,
  });
  const [tab, setTab] = useState<Tab>('summary');
  // Shared failure line for all button-triggered loaders (rendered once
  // above the tab content); each loader clears it on start.
  const narrow = useNarrowViewport();
  // Collapse Analysis on narrow viewports so Filter + map stay usable;
  // user can still expand. Wide screens keep the panel open.
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 900 : false,
  );
  const wasNarrow = React.useRef(narrow);
  useEffect(() => {
    // Collapse only when crossing into narrow — don't fight a user who
    // already expanded on a small screen.
    if (narrow && !wasNarrow.current) setCollapsed(true);
    wasNarrow.current = narrow;
  }, [narrow]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hourlyData, setHourlyData] = useState<HourlyData[]>([]);
  // Shared failure line for the temporal tab's three parallel fetches —
  // without it a backend error leaves three empty charts and no explanation.
  const [temporalError, setTemporalError] = useState<string | null>(null);
  const [temporalLoading, setTemporalLoading] = useState(false);
  const [chainData, setChainData] = useState<Array<{ chain_length: number; vehicle_count: number }>>([]);
  const [clusterResult, setClusterResult] = useState<ClusterResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Temporal extensions
  const [peaksData, setPeaksData] = useState<{ peaks: Array<{ hour: number; count: number }>; mean: number; std: number; threshold: number } | null>(null);
  const [durationData, setDurationData] = useState<Array<{ distance_km: number; count: number; vehicle_type: string }>>([]);

  // Density extensions
  const [densitySource, setDensitySource] = useState<'od' | 'waypoint'>('od');
  const [hotspotsData, setHotspotsData] = useState<Array<{ lon: number; lat: number; volume: number; unique_vehicles: number; rank: number }>>([]);
  const [hotspotsLoading, setHotspotsLoading] = useState(false);

  // Chains extensions
  const [dwellData, setDwellData] = useState<Array<{ dwell_bin: string; count: number }>>([]);
  const [dwellLoading, setDwellLoading] = useState(false);
  const [roundTripData, setRoundTripData] = useState<Array<{ trip_type: 'round_trip' | 'one_way'; vehicle_count: number; avg_trips_per_vehicle: number }>>([]);
  const [roundTripLoading, setRoundTripLoading] = useState(false);
  const [commodityData, setCommodityData] = useState<Array<{ sequence: string; vehicle_count: number; chain_length: number }>>([]);
  const [commodityLoading, setCommodityLoading] = useState(false);

  // Links tab
  const [linkData, setLinkData] = useState<{ links: LinkDensityItem[]; count: number; total_links: number } | null>(null);
  const linkLoadedRef = useRef(false);
  const [linkLoading, setLinkLoading] = useState(false);

  // Metrics tab (Phase 2 Step 2.2e) — three F1 distributions
  const [metricsSpeed,  setMetricsSpeed]  = useState<MetricsDistribution | null>(null);
  const [metricsDwell,  setMetricsDwell]  = useState<MetricsDistribution | null>(null);
  const [metricsDetour, setMetricsDetour] = useState<MetricsDistribution | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  // Multi-stop sub-section (Sprint A1c) — within Chains tab
  const [multiStopMinStops, setMultiStopMinStops] = useState(3);
  const [multiStopVehicles, setMultiStopVehicles] = useState<MultiStopVehicle[]>([]);
  const [multiStopLoading, setMultiStopLoading] = useState(false);
  const [multiStopExpanded, setMultiStopExpanded] = useState<string | null>(null);

  // Route-similarity (Sprint A1d) — alternative algorithm in Clusters tab
  const [clusterAlgo, setClusterAlgo] = useState<ClusterAlgo>('od_distance');
  const [routeSimEps, setRouteSimEps] = useState(0.3);
  const [routeSimMinSamples, setRouteSimMinSamples] = useState(3);
  const [routeSimSampleSize, setRouteSimSampleSize] = useState(200);
  const [routeSimResult, setRouteSimResult] = useState<RouteSimilarityResponse | null>(null);
  const [routeSimLoading, setRouteSimLoading] = useState(false);

  // Zone tab — Sprint A1b — through-zone bbox form state.
  // Default to a Tokyo Station bbox (~1.5 km). User edits then hits Search.
  const [zoneFormW, setZoneFormW] = useState('139.760');
  const [zoneFormS, setZoneFormS] = useState('35.675');
  const [zoneFormE, setZoneFormE] = useState('139.780');
  const [zoneFormN, setZoneFormN] = useState('35.690');
  const [zoneLoading, setZoneLoading] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);

  // Auto-load temporal data when panel opens
  useEffect(() => {
    if (!hasData || tab !== 'temporal') return;
    let cancelled = false;
    setTemporalError(null);
    setTemporalLoading(true);
    const onFail = (e: unknown) => {
      if (!cancelled) {
        setTemporalError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
      }
    };
    Promise.all([
      fetchHourlyDepartures(vehicleType, city, simulationDay, goodsType, minHour, maxHour)
        .then(d => { if (!cancelled) setHourlyData(d); })
        .catch(onFail),
      fetchTemporalPeaks(vehicleType, city, simulationDay, goodsType, minHour, maxHour)
        .then(d => { if (!cancelled) setPeaksData(d); })
        .catch(onFail),
      fetchDurationDistribution(vehicleType, city, simulationDay, 10, goodsType, minHour, maxHour)
        .then(d => { if (!cancelled) setDurationData(d); })
        .catch(onFail),
    ]).finally(() => {
      if (!cancelled) setTemporalLoading(false);
    });
    return () => { cancelled = true; };
  }, [hasData, vehicleType, city, simulationDay, goodsType, minHour, maxHour, tab]);

  // Map click → Detail: expand the panel if collapsed (narrow) and open Trip.
  useEffect(() => {
    if (!selectedTrajectory) return;
    setTab('detail');
    setCollapsed(false);
  }, [selectedTrajectory]);

  // Keep local overlay mirrors in sync when App clears via StatusBanner /
  // filter change (App is source of truth for what’s on the map).
  useEffect(() => {
    if (!mapHasClusters) setClusterResult(null);
  }, [mapHasClusters]);
  useEffect(() => {
    if (linkCount === 0) {
      setLinkData(null);
      linkLoadedRef.current = false;
    }
  }, [linkCount]);

  // Auto-load F1 metric distributions when the Metrics tab is opened.
  // Three histograms fire in parallel (each is one DuckDB query).
  useEffect(() => {
    if (!hasData || tab !== 'metrics') return;
    setMetricsLoading(true);
    setMetricsError(null);
    const args = [vehicleType, city, simulationDay, 20, goodsType, minHour, maxHour] as const;
    Promise.all([
      fetchMetricsDistribution('speed_avg_kmh', ...args),
      fetchMetricsDistribution('dwell_minutes', ...args),
      fetchMetricsDistribution('detour_ratio',  ...args),
    ])
      .then(([s, d, dr]) => {
        setMetricsSpeed(s);
        setMetricsDwell(d);
        setMetricsDetour(dr);
      })
      .catch(e => setMetricsError(friendlyFetchError(String((e as Error)?.message ?? e)).text))
      .finally(() => setMetricsLoading(false));
  }, [hasData, vehicleType, city, simulationDay, goodsType, minHour, maxHour, tab]);

  const loadODFlows = useCallback(async () => {
    setActionError(null);
    setLoading(true);
    try {
      const res = await fetchODFlows(vehicleType, 80, city, simulationDay, goodsType, minHour, maxHour);
      onODFlows(res.flows);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour, onODFlows]);

  const loadDensity = useCallback(async (source: 'od' | 'waypoint') => {
    setActionError(null);
    setLoading(true);
    try {
      if (source === 'waypoint') {
        const res = await fetchWaypointDensity(
          vehicleType, city, simulationDay, 0.005, 5000, transportModes,
          goodsType, minHour, maxHour,
          minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
          scenario,
        );
        onDensity(res.points);
      } else {
        const res = await fetchSpatialDensity(vehicleType, 'both', 0.01, city, simulationDay, goodsType, minHour, maxHour);
        onDensity(res.points);
      }
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour,
      transportModes, scenario, minSpeed, maxSpeed, maxDwellMinutes,
      minDetourRatio, maxDetourRatio, onDensity]);

  const loadHotspots = useCallback(async () => {
    setActionError(null);
    setHotspotsLoading(true);
    try {
      const data = await fetchSpatialHotspots(
        vehicleType, city, simulationDay, 20, 'origin', goodsType, minHour, maxHour,
      );
      setHotspotsData(data);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setHotspotsLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour]);

  const loadDwellTimes = useCallback(async () => {
    setActionError(null);
    setDwellLoading(true);
    try {
      const data = await fetchDwellTimes(vehicleType, city, simulationDay, 1000, goodsType, minHour, maxHour);
      setDwellData(data);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setDwellLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour]);

  const loadRoundTrips = useCallback(async () => {
    setActionError(null);
    setRoundTripLoading(true);
    try {
      const data = await fetchRoundTrips(vehicleType, city, simulationDay, 2.0, goodsType, minHour, maxHour);
      setRoundTripData(data);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setRoundTripLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour]);

  const loadCommodityPatterns = useCallback(async () => {
    setActionError(null);
    setCommodityLoading(true);
    try {
      const data = await fetchCommodityPatterns(city, simulationDay, 20, goodsType, minHour, maxHour);
      setCommodityData(data);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setCommodityLoading(false);
  }, [city, simulationDay, goodsType, minHour, maxHour]);

  // Sprint A1d — fire the route-similarity clustering query
  const loadRouteSimilarity = useCallback(async () => {
    setActionError(null);
    setRouteSimLoading(true);
    try {
      const res = await runRouteSimilarity(
        vehicleType, city, simulationDay,
        routeSimSampleSize, routeSimEps, routeSimMinSamples,
      );
      setRouteSimResult(res);
    } catch (e) {
      console.error('[route-similarity]', e);
      setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
      setRouteSimResult(null);
    } finally {
      setRouteSimLoading(false);
    }
  }, [vehicleType, city, simulationDay, routeSimEps, routeSimMinSamples, routeSimSampleSize]);

  // Sprint A1c — fire the multi-stop chains query
  const loadMultiStop = useCallback(async () => {
    setActionError(null);
    setMultiStopLoading(true);
    try {
      const res = await fetchMultiStopChains(
        multiStopMinStops, vehicleType, city, simulationDay, goodsType, 50,
      );
      setMultiStopVehicles(res.vehicles);
    } catch (e) {
      console.error('[multi-stop]', e);
      setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
      setMultiStopVehicles([]);
    } finally {
      setMultiStopLoading(false);
    }
  }, [multiStopMinStops, vehicleType, city, simulationDay, goodsType]);

  // Sprint A1b — fire the through-zone-bbox query
  const runZoneQuery = useCallback(async () => {
    setZoneError(null);
    const w = Number(zoneFormW);
    const s = Number(zoneFormS);
    const e = Number(zoneFormE);
    const n = Number(zoneFormN);
    if (![w, s, e, n].every(Number.isFinite)) {
      setZoneError('All four coordinates must be numbers.');
      return;
    }
    if (w >= e || s >= n) {
      setZoneError('Require w < e and s < n (W/S min, E/N max).');
      return;
    }
    setZoneLoading(true);
    try {
      const res = await fetchTripsThroughZoneBBox(
        w, s, e, n, vehicleType, city, simulationDay, 500,
      );
      onZoneResult?.({ w, s, e, n }, res.trips as TripPoint[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      setZoneError(msg);
    } finally {
      setZoneLoading(false);
    }
  }, [zoneFormW, zoneFormS, zoneFormE, zoneFormN, vehicleType, city, simulationDay, onZoneResult]);

  const loadLinkDensity = useCallback(async () => {
    setActionError(null);
    setLinkLoading(true);
    try {
      const groupBy = colorBy === 'transportMode' ? 'transport_mode' : 'source_id';
      const res = await fetchLinkDensity(
        vehicleType, city, simulationDay, 500, 10, goodsType,
        minHour, maxHour, transportModes, scenario, groupBy,
        minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
      );
      setLinkData(res);
      onLinkDensity(res.links);
      linkLoadedRef.current = true;
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setLinkLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour,
      transportModes, scenario, colorBy, minSpeed, maxSpeed, maxDwellMinutes,
      minDetourRatio, maxDetourRatio, onLinkDensity]);

  useEffect(() => {
    if (!linkLoadedRef.current) return;
    void loadLinkDensity();
  }, [loadLinkDensity]);

  useEffect(() => {
    if (!linkLoadNonce) return;
    void loadLinkDensity();
  }, [linkLoadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadClusters = useCallback(async () => {
    setActionError(null);
    setLoading(true);
    try {
      const res = await runClustering(vehicleType, 5000, city, simulationDay, goodsType, minHour, maxHour);
      setClusterResult(res);
      onClusters(res);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour, onClusters]);

  const loadChains = useCallback(async () => {
    setActionError(null);
    setLoading(true);
    try {
      const data = await fetchChainLengths(vehicleType, city, simulationDay, goodsType, minHour, maxHour);
      setChainData(data);
    } catch (e) { setActionError(friendlyFetchError(String((e as Error)?.message ?? e)).text); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour]);

  if (!hasData) return null;

  if (collapsed) {
    return (
      <button onClick={() => setCollapsed(false)} style={styles.expandBtn}>
        Analysis
      </button>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Analysis</span>
        <button onClick={() => setCollapsed(true)} style={styles.closeBtn}>&times;</button>
      </div>

      {/* Tabs — cyan dot = that tab currently has a live map overlay */}
      <div style={styles.tabs}>
        {(Object.keys(TAB_LABELS) as Tab[])
          // 'detail' tab only shown when a trajectory is selected (Sprint A1a)
          .filter(t => t !== 'detail' || selectedTrajectory)
          .map(t => {
          const mapLive =
            (t === 'od' && odFlowCount > 0) ||
            (t === 'density' && densityCount > 0) ||
            (t === 'clusters' && (mapHasClusters || !!clusterResult)) ||
            (t === 'links' && linkCount > 0);
          return (
          <button
            key={t}
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
            onClick={() => { setTab(t); setActionError(null); }}
            title={mapLive ? `${TAB_TITLES[t]} (on map)` : TAB_TITLES[t]}
            aria-label={mapLive ? `${TAB_TITLES[t]} (on map)` : TAB_TITLES[t]}
          >
            {TAB_LABELS[t]}
            {mapLive && <span style={styles.tabDot} aria-hidden />}
          </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={styles.content}>
        {/* Shared failure line for the button-triggered loaders below
            (OD/density/chains/clusters/...): without it a backend error
            after clicking "Load" leaves an empty tab and no explanation. */}
        {actionError !== null && (
          <div style={styles.errorBox}>{actionError}</div>
        )}

        {tab === 'summary' && (
          <SummaryTab
            insights={insights}
            insightsLoading={insightsLoading}
            insightsError={insightsError}
          />
        )}

        {tab === 'temporal' && (
          <TemporalTab
            temporalError={temporalError}
            temporalLoading={temporalLoading}
            peaksData={peaksData}
            hourlyData={hourlyData}
            durationData={durationData}
          />
        )}

        {tab === 'metrics' && (
          <MetricsTab
            metricsLoading={metricsLoading}
            metricsError={metricsError}
            metricsSpeed={metricsSpeed}
            metricsDwell={metricsDwell}
            metricsDetour={metricsDetour}
          />
        )}

        {tab === 'od' && (
          <OdFlowsTab
            loading={loading}
            onLoad={loadODFlows}
            onClear={() => onODFlows([])}
            activeCount={odFlowCount}
          />
        )}

        {tab === 'density' && (
          <DensityTab
            densitySource={densitySource}
            setDensitySource={setDensitySource}
            loading={loading}
            loadDensity={loadDensity}
            onClearDensity={() => onDensity([])}
            activeCount={densityCount}
            hotspotsLoading={hotspotsLoading}
            loadHotspots={loadHotspots}
            hotspotsData={hotspotsData}
          />
        )}

        {tab === 'clusters' && (
          <ClustersTab
            clusterAlgo={clusterAlgo}
            setClusterAlgo={setClusterAlgo}
            loading={loading}
            loadClusters={loadClusters}
            clusterResult={clusterResult}
            onClearClusters={() => {
              setClusterResult(null);
              onClusters(null);
            }}
            routeSimSampleSize={routeSimSampleSize}
            setRouteSimSampleSize={setRouteSimSampleSize}
            routeSimEps={routeSimEps}
            setRouteSimEps={setRouteSimEps}
            routeSimMinSamples={routeSimMinSamples}
            setRouteSimMinSamples={setRouteSimMinSamples}
            routeSimLoading={routeSimLoading}
            loadRouteSimilarity={loadRouteSimilarity}
            routeSimResult={routeSimResult}
          />
        )}

        {tab === 'chains' && (
          <ChainsTab
            loading={loading}
            loadChains={loadChains}
            chainData={chainData}
            multiStopMinStops={multiStopMinStops}
            setMultiStopMinStops={setMultiStopMinStops}
            multiStopLoading={multiStopLoading}
            loadMultiStop={loadMultiStop}
            multiStopVehicles={multiStopVehicles}
            multiStopExpanded={multiStopExpanded}
            setMultiStopExpanded={setMultiStopExpanded}
            dwellLoading={dwellLoading}
            loadDwellTimes={loadDwellTimes}
            dwellData={dwellData}
            roundTripLoading={roundTripLoading}
            loadRoundTrips={loadRoundTrips}
            roundTripData={roundTripData}
            showCommodityPatterns={showCommodityPatterns}
            commodityLoading={commodityLoading}
            loadCommodityPatterns={loadCommodityPatterns}
            commodityData={commodityData}
          />
        )}

        {tab === 'links' && (
          <LinksTab
            vehicleType={vehicleType}
            linkLoading={linkLoading}
            loadLinkDensity={loadLinkDensity}
            onClear={() => { onLinkDensity([]); setLinkData(null); linkLoadedRef.current = false; }}
            linkData={linkData}
            colorBy={colorBy}
          />
        )}

        {tab === 'detail' && selectedTrajectory && (
          <DetailTab
            selectedTrajectory={selectedTrajectory}
            onClearSelectedTrajectory={onClearSelectedTrajectory}
            onAddAgent={onAddAgent}
            selectedAgents={selectedAgents}
            onFollowAgent={() => {
              onAddAgent!(selectedTrajectory.metadata.vehicle_key);
              setTab('agents');
            }}
          />
        )}

        {tab === 'agents' && onAddAgent && onRemoveAgent && onClearAgents && (
          <AgentTab
            vehicleType={vehicleType}
            city={city}
            simulationDay={simulationDay}
            selectedAgents={selectedAgents}
            agentLoading={agentLoading}
            onAddAgent={onAddAgent}
            onRemoveAgent={onRemoveAgent}
            onClearAgents={onClearAgents}
            colorBy={colorBy}
          />
        )}

        {tab === 'compare' && (
          <CompareTab
            sources={sources}
            city={city}
            simulationDay={simulationDay}
            goodsType={goodsType}
            minHour={minHour}
            maxHour={maxHour}
            minSpeed={minSpeed}
            maxSpeed={maxSpeed}
            maxDwellMinutes={maxDwellMinutes}
            minDetourRatio={minDetourRatio}
            maxDetourRatio={maxDetourRatio}
            transportModes={transportModes}
            scenario={scenario}
            onAddAgent={onAddAgent}
            onCompareGrid={onCompareGrid}
          />
        )}

        {tab === 'zone' && (
          <ZoneTab
            zoneFormW={zoneFormW}
            setZoneFormW={setZoneFormW}
            zoneFormS={zoneFormS}
            setZoneFormS={setZoneFormS}
            zoneFormE={zoneFormE}
            setZoneFormE={setZoneFormE}
            zoneFormN={zoneFormN}
            setZoneFormN={setZoneFormN}
            zoneLoading={zoneLoading}
            runZoneQuery={runZoneQuery}
            zoneBBox={zoneBBox}
            zoneTrips={zoneTrips}
            onClearZone={onClearZone}
            zoneError={zoneError}
            showPedestrianize={showPedestrianize}
            scenarioActive={scenarioActive}
            onPedestrianize={onPedestrianize}
            onClearScenario={onClearScenario}
          />
        )}
      </div>
    </div>
  );
};
