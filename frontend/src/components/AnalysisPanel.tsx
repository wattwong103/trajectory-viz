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
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
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
import { sourceFallbackColor } from '../sourceColors';
import { transportModeColor } from '../transportModes';
import { AgentTab } from './AgentTab';
import { CompareTab } from './CompareTab';

type Tab = 'summary' | 'temporal' | 'metrics' | 'od' | 'density' | 'clusters' | 'chains' | 'links' | 'detail' | 'zone' | 'agents' | 'compare';

const TAB_LABELS: Record<Tab, string> = {
  summary: '\u03A3',
  temporal: '\u23F0',
  metrics: '\u0192',     // \u0192 for F1 derived metrics
  od: '\u2197',
  density: '\u2588',
  clusters: '\u25CE',
  chains: '\u26D3',
  links: '\u22A5',
  detail: '\uD83D\uDCCD',     // Sprint A1a \u2014 Trajectory Details (visible only when one selected)
  zone: '\u25AD',        // Sprint A1b \u2014 Through-zone bbox query
  agents: '\u2691',      // Phase 2A \u2014 agent search & follow
  compare: '⇄',      // fleet-comparison — A⇄B fleet comparison
};

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

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
  colorBy?: 'source' | 'transportMode';
  /** Increment to force a link-density fetch (Network preset). */
  linkLoadNonce?: number;
}

// Sprint A1a — Per-trajectory detail view rendered in the Detail tab.
// Bins the trajectory's segment.speed_kmh into a small histogram and lists
// the longest dwells + most-used links. Uses the segments[] data that
// useTrajectories already fetches via include_segments=true.
const TrajectoryDetail: React.FC<{
  trajectory: Trajectory;
  onClear?: () => void;
}> = ({ trajectory, onClear }) => {
  const segments = trajectory.segments ?? [];

  // Speed histogram (10 bins from 0 to max of segments)
  const speeds = segments
    .map(s => s.speed_kmh)
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  const speedHist: Array<{ bin: string; count: number }> = (() => {
    if (speeds.length === 0) return [];
    const maxKmh = Math.max(...speeds, 10);
    const top = Math.ceil(maxKmh / 10) * 10;       // round up to nearest 10
    const bins = 10;
    const width = top / bins;
    const counts = new Array(bins).fill(0);
    for (const s of speeds) {
      const idx = Math.min(Math.floor(s / width), bins - 1);
      counts[idx]++;
    }
    return counts.map((c, i) => ({
      bin: `${(i * width).toFixed(0)}`,
      count: c,
    }));
  })();

  // Dwell stats
  const dwells = segments
    .map(s => s.dwell_sec)
    .filter((v): v is number => v !== null && v !== undefined && v > 0);
  const totalDwellMin = dwells.reduce((sum, d) => sum + d, 0) / 60;
  const longestDwellSec = dwells.length > 0 ? Math.max(...dwells) : 0;
  const longestDwellIdx = segments.findIndex(s => s.dwell_sec === longestDwellSec);

  // Speed extremes
  const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;
  const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

  // Link usage (top 5 most-frequent)
  const linkCounts: Record<string, number> = {};
  for (const seg of segments) {
    if (seg.link_id) {
      linkCounts[seg.link_id] = (linkCounts[seg.link_id] || 0) + 1;
    }
  }
  const uniqueLinks = Object.keys(linkCounts).length;
  const topLinks = Object.entries(linkCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const meta = trajectory.metadata;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#4fc3f7' }}>
          {meta.vehicle_type} · {meta.vehicle_key}
        </div>
        {onClear && (
          <button
            onClick={onClear}
            style={{
              background: 'none', border: 'none', color: '#888',
              cursor: 'pointer', fontSize: 14, padding: 2,
            }}
            title="Clear selection"
          >
            ×
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
        trip {meta.trip_id} · {trajectory.path.length} waypoints · {segments.length} segments
        {meta.goods_type && <> · {meta.goods_type}</>}
        {meta.fare_yen !== null && meta.fare_yen !== undefined && <> · ¥{meta.fare_yen}</>}
      </div>

      {segments.length === 0 ? (
        <div style={{ fontSize: 11, color: '#666', padding: '12px 0' }}>
          No segment data. Set <code>include_segments=true</code> on the trajectory fetch (already on by default in useTrajectories).
        </div>
      ) : (
        <>
          {/* Stats cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: 6, borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Avg speed</div>
              <div style={{ fontSize: 14 }}>{avgSpeed.toFixed(1)} km/h</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: 6, borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Max speed</div>
              <div style={{ fontSize: 14 }}>{maxSpeed.toFixed(1)} km/h</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: 6, borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Total dwell</div>
              <div style={{ fontSize: 14 }}>{totalDwellMin.toFixed(1)} min</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: 6, borderRadius: 4 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Longest stop</div>
              <div style={{ fontSize: 14 }}>
                {(longestDwellSec / 60).toFixed(1)} min
                {longestDwellIdx >= 0 && <span style={{ fontSize: 10, color: '#888' }}> @ seg {longestDwellIdx}</span>}
              </div>
            </div>
          </div>

          {/* Speed histogram */}
          {speedHist.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#bbb', marginBottom: 2 }}>
                Speed distribution (km/h)
              </div>
              <ResponsiveContainer width="100%" height={70}>
                <BarChart data={speedHist} margin={{ top: 2, right: 6, bottom: 2, left: 0 }}>
                  <XAxis dataKey="bin" tick={{ fontSize: 9, fill: '#888' }} interval="preserveStartEnd" />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={{ background: 'rgba(20,20,30,0.95)', border: '1px solid #444', fontSize: 11 }}
                    labelStyle={{ color: '#aaa' }}
                  />
                  <Bar dataKey="count" fill="#4fc3f7" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Link usage */}
          {topLinks.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>
                Top links ({uniqueLinks} unique)
              </div>
              <div style={{ fontSize: 10, fontFamily: 'monospace' }}>
                {topLinks.map(([linkId, count]) => (
                  <div key={linkId} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
                    <span>{linkId}</span>
                    <span style={{ color: '#888' }}>{count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/** Recharts BarChart of one F1 metric's histogram. Used in the Metrics tab. */
const MetricHistogram: React.FC<{
  title: string;
  dist: MetricsDistribution | null;
  precision: number;
}> = ({ title, dist, precision }) => {
  if (!dist || dist.histogram.length === 0 || dist.total_rows === 0) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: '#bbb', marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 11, color: '#666', padding: '8px 0' }}>
          No data — the metric is NULL for all matching trips.
          {title.startsWith('Speed') && ' (Speed needs trajectory data.)'}
        </div>
      </div>
    );
  }
  // Use bin_lower as the x-axis label, rounded for display
  const data = dist.histogram.map(b => ({
    bin: b.bin_lower.toFixed(precision),
    count: b.count,
  }));
  const range = `${dist.min!.toFixed(precision)} – ${dist.max!.toFixed(precision)} ${dist.unit}`;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: '#bbb', marginBottom: 2 }}>
        {title}
        <span style={{ color: '#666', float: 'right', fontSize: 10 }}>
          {dist.total_rows.toLocaleString()} trips, {range}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={70}>
        <BarChart data={data} margin={{ top: 2, right: 6, bottom: 2, left: 0 }}>
          <XAxis dataKey="bin" tick={{ fontSize: 9, fill: '#888' }} interval="preserveStartEnd" />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: 'rgba(20,20,30,0.95)', border: '1px solid #444', fontSize: 11 }}
            labelStyle={{ color: '#aaa' }}
          />
          <Bar dataKey="count" fill="#4fc3f7" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

/** Three-line skeleton shown while a tab's content is loading */
const SkeletonLines: React.FC = () => (
  <div style={{ padding: '10px 0' }}>
    <style>{`
      @keyframes pflow-pulse {
        0%   { opacity: 0.4; }
        50%  { opacity: 0.8; }
        100% { opacity: 0.4; }
      }
    `}</style>
    {[90, 75, 60].map((w, i) => (
      <div
        key={i}
        style={{
          height: 10,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.12)',
          animation: 'pflow-pulse 1.4s ease-in-out infinite',
          animationDelay: `${i * 0.15}s`,
          width: `${w}%`,
          marginBottom: 8,
        }}
      />
    ))}
  </div>
);

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
  vehicleType, city, simulationDay, goodsType, minHour, maxHour,
  hasData, insights, insightsLoading, insightsError = null,
  onODFlows, onDensity, onClusters, onLinkDensity, onCompareGrid,
  selectedTrajectory, onClearSelectedTrajectory,
  zoneBBox, zoneTrips, onZoneResult, onClearZone,
  scenarioActive = false, onPedestrianize, onClearScenario,
  selectedAgents = [], agentLoading = false,
  onAddAgent, onRemoveAgent, onClearAgents,
  sources = [], transportModes, scenario,
  minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
  colorBy = 'source',
  linkLoadNonce = 0,
}) => {
  const [tab, setTab] = useState<Tab>('summary');
  const [collapsed, setCollapsed] = useState(false);
  // Shared failure line for all button-triggered loaders (rendered once
  // above the tab content); each loader clears it on start.
  const [actionError, setActionError] = useState<string | null>(null);
  const [hourlyData, setHourlyData] = useState<HourlyData[]>([]);
  // Shared failure line for the temporal tab's three parallel fetches —
  // without it a backend error leaves three empty charts and no explanation.
  const [temporalError, setTemporalError] = useState<string | null>(null);
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
  type ClusterAlgo = 'od_distance' | 'route_similarity';
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
    if (hasData && tab === 'temporal') {
      setTemporalError(null);
      const onFail = (e: unknown) =>
        setTemporalError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
      fetchHourlyDepartures(vehicleType, city, simulationDay, goodsType, minHour, maxHour).then(setHourlyData).catch(onFail);
      fetchTemporalPeaks(vehicleType, city, simulationDay, goodsType, minHour, maxHour).then(setPeaksData).catch(onFail);
      fetchDurationDistribution(vehicleType, city, simulationDay, 10, goodsType, minHour, maxHour).then(setDurationData).catch(onFail);
    }
  }, [hasData, vehicleType, city, simulationDay, goodsType, minHour, maxHour, tab]);

  // Auto-switch to Detail tab when a trajectory is clicked on the map.
  useEffect(() => {
    if (selectedTrajectory) setTab('detail');
  }, [selectedTrajectory]);

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

      {/* Tabs */}
      <div style={styles.tabs}>
        {(Object.keys(TAB_LABELS) as Tab[])
          // 'detail' tab only shown when a trajectory is selected (Sprint A1a)
          .filter(t => t !== 'detail' || selectedTrajectory)
          .map(t => (
          <button
            key={t}
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
            onClick={() => { setTab(t); setActionError(null); }}
            title={t.charAt(0).toUpperCase() + t.slice(1)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={styles.content}>
        {/* Shared failure line for the button-triggered loaders below
            (OD/density/chains/clusters/...): without it a backend error
            after clicking "Load" leaves an empty tab and no explanation. */}
        {actionError !== null && (
          <div style={styles.errorBox}>{actionError}</div>
        )}

        {/* ── Summary Tab ── */}
        {tab === 'summary' && (
          <div>
            {insightsLoading && <SkeletonLines />}
            {insightsError !== null && !insightsLoading && (
              <div style={styles.errorBox}>
                {friendlyFetchError(insightsError).text}
              </div>
            )}
            {insights && (
              <>
                {/* Metric cards — row 1 */}
                <div style={styles.cardGrid}>
                  <MetricCard label="Trips" value={formatCompact(insights.core.total_trips)} />
                  <MetricCard label="Avg Dist" value={`${insights.core.avg_distance_km} km`} />
                  <MetricCard
                    label="Peak Hour"
                    value={insights.peak.peak_hour !== null
                      ? `${String(insights.peak.peak_hour).padStart(2, '0')}:00`
                      : '--'}
                  />
                  <MetricCard label="Total VKT" value={`${formatCompact(insights.core.total_vkt_km)} km`} />
                </div>

                {/* Metric cards — row 2 (fare/fleet) */}
                <div style={styles.cardGrid}>
                  {insights.fare ? (
                    <>
                      <MetricCard label="Avg Fare" value={`\u00A5${insights.fare.avg_fare_yen.toLocaleString()}`} />
                      <MetricCard label="Night %" value={`${insights.fare.night_trip_pct}%`} />
                    </>
                  ) : (
                    <>
                      <MetricCard label="Vehicles" value={formatCompact(insights.core.unique_vehicles)} />
                      <MetricCard label="Trips/Veh" value={`${insights.fleet.avg_trips_per_vehicle}`} />
                    </>
                  )}
                  <MetricCard label="Pk/Off" value={`${insights.peak.peak_to_offpeak_ratio}x`} />
                  <MetricCard
                    label="Med Dist"
                    value={`${insights.core.median_distance_km} km`}
                  />
                </div>

                {/* Distance distribution sparkline */}
                {insights.distance_distribution.length > 0 && (
                  <div style={{ marginTop: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>
                      Distance distribution (km)
                    </div>
                    <ResponsiveContainer width="100%" height={55}>
                      <AreaChart data={insights.distance_distribution} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
                        <defs>
                          <linearGradient id="distGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#4fc3f7" stopOpacity={0.3} />
                            <stop offset="100%" stopColor="#4fc3f7" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke="#4fc3f7"
                          strokeWidth={1.5}
                          fill="url(#distGrad)"
                        />
                        <Tooltip
                          contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 10 }}
                          labelFormatter={v => `${v} km`}
                          formatter={(v: number) => [v.toLocaleString(), 'trips']}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Text insights */}
                {insights.text_insights.length > 0 && (
                  <div style={styles.insightsList}>
                    {insights.text_insights.map((txt, i) => (
                      <div key={i} style={styles.insightItem}>{txt}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Temporal Tab ── */}
        {tab === 'temporal' && (
          <div>
            <div style={styles.subtitle}>Hourly Departures</div>
            {temporalError !== null && (
              <div style={styles.errorBox}>{temporalError}</div>
            )}
            {peaksData && (
              <div style={styles.peakRibbon}>
                <span style={{ color: '#fd805d' }}>&#9650;</span>{' '}
                Peaks at {peaksData.peaks.map(p => `${String(p.hour).padStart(2, '0')}:00`).join(', ')}{' '}
                <span style={{ color: '#888' }}>(threshold: {peaksData.threshold.toLocaleString(undefined, { maximumFractionDigits: 0 })})</span>
              </div>
            )}
            {hourlyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={hourlyData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#888' }} interval={2} />
                  <YAxis tick={{ fontSize: 9, fill: '#888' }} />
                  <Tooltip
                    contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                    labelFormatter={h => `${String(h).padStart(2, '0')}:00`}
                  />
                  <Bar dataKey="truck" stackId="a" name="Truck">
                    {hourlyData.map((d, i) => {
                      const isPeak = peaksData?.peaks.some(p => p.hour === d.hour) ?? false;
                      return <Cell key={i} fill={isPeak ? '#ff6b35' : '#fd805d'} />;
                    })}
                  </Bar>
                  <Bar dataKey="taxi" stackId="a" name="Taxi">
                    {hourlyData.map((d, i) => {
                      const isPeak = peaksData?.peaks.some(p => p.hour === d.hour) ?? false;
                      return <Cell key={i} fill={isPeak ? '#00d4dd' : '#17b8be'} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <SkeletonLines />
            )}
            {durationData.length > 0 && (
              <>
                <div style={{ ...styles.subtitle, marginTop: 10 }}>Distance Distribution</div>
                <ResponsiveContainer width="100%" height={110}>
                  <BarChart data={durationData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="distance_km" tick={{ fontSize: 9, fill: '#888' }} tickFormatter={v => `${v}km`} />
                    <YAxis tick={{ fontSize: 9, fill: '#888' }} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} />
                    <Tooltip
                      contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                      labelFormatter={v => `${v} km`}
                      formatter={(v: number) => [v.toLocaleString(), 'trips']}
                    />
                    <Bar dataKey="count" fill="#4fc3f7" name="Count">
                      {durationData.map((d, i) => (
                        <Cell key={i} fill={d.vehicle_type === 'truck' ? '#fd805d' : '#17b8be'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
        )}

        {/* ── Metrics Tab (F1 derived: speed / dwell / detour) ── */}
        {tab === 'metrics' && (
          <div>
            <div style={styles.subtitle}>F1 Derived Metrics</div>
            <p style={styles.desc}>
              Per-trip metrics computed at ingest: average speed (needs trajectory data),
              dwell time before next trip, and route detour vs straight-line.
            </p>
            {metricsLoading && <SkeletonLines />}
            {metricsError !== null && !metricsLoading && (
              <div style={styles.errorBox}>{metricsError}</div>
            )}
            {!metricsLoading && (
              <>
                <MetricHistogram title="Speed (km/h)"      dist={metricsSpeed}  precision={0} />
                <MetricHistogram title="Dwell (min)"        dist={metricsDwell}  precision={0} />
                <MetricHistogram title="Detour ratio"       dist={metricsDetour} precision={2} />
              </>
            )}
          </div>
        )}

        {/* ── OD Flows Tab ── */}
        {tab === 'od' && (
          <div>
            <div style={styles.subtitle}>OD Flow Arcs</div>
            <p style={styles.desc}>Shows top origin-destination flow pairs as arcs on the map.</p>
            <button onClick={loadODFlows} style={styles.actionBtn} disabled={loading}>
              {loading ? 'Loading...' : 'Load OD Flows'}
            </button>
            <button onClick={() => onODFlows([])} style={styles.clearBtn}>Clear</button>
          </div>
        )}

        {/* ── Density Tab ── */}
        {tab === 'density' && (
          <div>
            <div style={styles.subtitle}>Spatial Density</div>
            <div style={styles.radioGroup}>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="densitySource"
                  value="od"
                  checked={densitySource === 'od'}
                  onChange={() => setDensitySource('od')}
                  style={{ marginRight: 4 }}
                />
                Trip OD density
              </label>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="densitySource"
                  value="waypoint"
                  checked={densitySource === 'waypoint'}
                  onChange={() => setDensitySource('waypoint')}
                  style={{ marginRight: 4 }}
                />
                Waypoint density
              </label>
            </div>
            <p style={styles.desc}>
              {densitySource === 'od'
                ? 'Heatmap of trip origins and destinations (~1km grid).'
                : 'Heatmap of trajectory waypoints (~500m grid).'}
            </p>
            <button onClick={() => loadDensity(densitySource)} style={styles.actionBtn} disabled={loading}>
              {loading ? 'Loading...' : 'Load Heatmap'}
            </button>
            <button onClick={() => onDensity([])} style={styles.clearBtn}>Clear</button>

            <div style={{ marginTop: 10 }}>
              <div style={styles.subtitle}>Top Hotspots</div>
              <button onClick={loadHotspots} style={styles.actionBtn} disabled={hotspotsLoading}>
                {hotspotsLoading ? 'Loading...' : 'Load Hotspots'}
              </button>
              {hotspotsData.length > 0 && (
                <div style={styles.results}>
                  {hotspotsData.map(h => (
                    <div key={h.rank} style={styles.clusterRow}>
                      <span style={{ ...styles.clusterDot, background: CLUSTER_COLORS[(h.rank - 1) % CLUSTER_COLORS.length] }} />
                      <span style={{ minWidth: 16, color: '#888' }}>#{h.rank}</span>
                      <span style={{ flex: 1 }}>{h.lat.toFixed(3)}, {h.lon.toFixed(3)}</span>
                      <span style={{ color: '#4fc3f7' }}>{formatCompact(h.volume)}</span>
                      <span style={{ color: '#888', marginLeft: 4 }}>{formatCompact(h.unique_vehicles)}v</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Clusters Tab ── */}
        {tab === 'clusters' && (
          <div>
            <div style={styles.subtitle}>Trip Clustering</div>
            {/* Algorithm toggle (Sprint A1d) */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 6, fontSize: 11 }}>
              <label style={{ flex: 1, padding: 4, background: clusterAlgo === 'od_distance' ? 'rgba(79,195,247,0.2)' : 'transparent', border: '1px solid #333', borderRadius: 3, cursor: 'pointer' }}>
                <input
                  type="radio" name="cluster-algo" value="od_distance"
                  checked={clusterAlgo === 'od_distance'}
                  onChange={() => setClusterAlgo('od_distance')}
                  style={{ marginRight: 4 }}
                />
                OD + distance
              </label>
              <label style={{ flex: 1, padding: 4, background: clusterAlgo === 'route_similarity' ? 'rgba(79,195,247,0.2)' : 'transparent', border: '1px solid #333', borderRadius: 3, cursor: 'pointer' }}>
                <input
                  type="radio" name="cluster-algo" value="route_similarity"
                  checked={clusterAlgo === 'route_similarity'}
                  onChange={() => setClusterAlgo('route_similarity')}
                  style={{ marginRight: 4 }}
                />
                Route similarity (F3)
              </label>
            </div>

            {clusterAlgo === 'od_distance' && (
              <>
                <p style={styles.desc}>Groups similar trips by OD pattern, distance, and time.</p>
                <button onClick={loadClusters} style={styles.actionBtn} disabled={loading}>
                  {loading ? 'Clustering...' : 'Run Clustering'}
                </button>
                {clusterResult && (
                  <div style={styles.results}>
                    <div>{clusterResult.algorithm}: {clusterResult.num_clusters} clusters</div>
                    <div>{clusterResult.total_trips} trips, {clusterResult.noise_count} noise</div>
                    <div style={{ marginTop: 6 }}>
                      {clusterResult.clusters.slice(0, 8).map(c => (
                        <div key={c.cluster_id} style={styles.clusterRow}>
                          <span style={{ ...styles.clusterDot, background: CLUSTER_COLORS[c.cluster_id % CLUSTER_COLORS.length] }} />
                          C{c.cluster_id}: {c.size} trips, ~{c.centroid.avg_distance_km}km, {Math.round(c.centroid.avg_dep_hour)}h
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {clusterAlgo === 'route_similarity' && (
              <>
                <p style={styles.desc}>
                  Jaccard distance over each trajectory's DRM link_id set. Groups trips
                  that share infrastructure. Requires trajectory data (waypoints).
                </p>
                <div style={{ marginBottom: 4 }}>
                  <label style={{ fontSize: 10, color: '#aaa' }}>
                    Sample size: {routeSimSampleSize}
                  </label>
                  <input
                    type="range" min={20} max={2000} step={20}
                    value={routeSimSampleSize}
                    onChange={e => setRouteSimSampleSize(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4fc3f7' }}
                  />
                </div>
                <div style={{ marginBottom: 4 }}>
                  <label style={{ fontSize: 10, color: '#aaa' }}>
                    eps (Jaccard dist): {routeSimEps.toFixed(2)}
                  </label>
                  <input
                    type="range" min={0.01} max={0.95} step={0.01}
                    value={routeSimEps}
                    onChange={e => setRouteSimEps(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4fc3f7' }}
                  />
                </div>
                <div style={{ marginBottom: 6 }}>
                  <label style={{ fontSize: 10, color: '#aaa' }}>
                    min_samples: {routeSimMinSamples}
                  </label>
                  <input
                    type="range" min={2} max={50} value={routeSimMinSamples}
                    onChange={e => setRouteSimMinSamples(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4fc3f7' }}
                  />
                </div>
                <button onClick={loadRouteSimilarity} style={styles.actionBtn} disabled={routeSimLoading}>
                  {routeSimLoading ? 'Clustering…' : 'Run Route Similarity'}
                </button>
                {routeSimResult && (
                  <div style={styles.results}>
                    {routeSimResult.error ? (
                      <div style={{ color: '#ff7676' }}>Error: {routeSimResult.error}</div>
                    ) : (
                      <>
                        <div>{routeSimResult.algorithm}: {routeSimResult.num_clusters} clusters</div>
                        <div>{routeSimResult.total_trips} trips, {routeSimResult.noise_count} noise</div>
                        {routeSimResult.note && (
                          <div style={{ color: '#aaa', fontSize: 10, marginTop: 4 }}>{routeSimResult.note}</div>
                        )}
                        <div style={{ marginTop: 6 }}>
                          {routeSimResult.clusters.slice(0, 8).map(c => (
                            <div key={c.cluster_id} style={styles.clusterRow}>
                              <span style={{ ...styles.clusterDot, background: CLUSTER_COLORS[c.cluster_id % CLUSTER_COLORS.length] }} />
                              C{c.cluster_id}: {c.size} trips · {c.representative.link_count} links
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Chains Tab ── */}
        {tab === 'chains' && (
          <div>
            <div style={styles.subtitle}>Trip Chains</div>
            <p style={styles.desc}>Trips per vehicle distribution.</p>
            <button onClick={loadChains} style={styles.actionBtn} disabled={loading}>
              {loading ? 'Loading...' : 'Load Chain Data'}
            </button>
            {chainData.length > 0 && (
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chainData.slice(0, 15)} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="chain_length" tick={{ fontSize: 9, fill: '#888' }} />
                  <YAxis tick={{ fontSize: 9, fill: '#888' }} />
                  <Tooltip
                    contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                    labelFormatter={l => `${l} trips/vehicle`}
                  />
                  <Bar dataKey="vehicle_count" fill="#4fc3f7" name="Vehicles">
                    {chainData.slice(0, 15).map((_, i) => (
                      <Cell key={i} fill={i < 3 ? '#4fc3f7' : '#2a6b8a'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}

            {/* Multi-stop chains (Sprint A1c — F2 endpoint UI) */}
            <div style={{ marginTop: 10 }}>
              <div style={styles.subtitle}>Multi-stop Chains</div>
              <p style={styles.desc}>
                Vehicles with ≥ {multiStopMinStops} trips, sorted by chain length.
                Click a card to expand its trip sequence.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <label style={{ fontSize: 10, color: '#aaa' }}>
                  min_stops: {multiStopMinStops}
                </label>
                <input
                  type="range" min={2} max={20} value={multiStopMinStops}
                  onChange={e => setMultiStopMinStops(Number(e.target.value))}
                  style={{ flex: 1, accentColor: '#4fc3f7' }}
                />
              </div>
              <button onClick={loadMultiStop} style={styles.actionBtn} disabled={multiStopLoading}>
                {multiStopLoading ? 'Loading…' : 'Load Multi-stop'}
              </button>
              {multiStopVehicles.length > 0 && (
                <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                  {multiStopVehicles.length} vehicle(s) returned
                </div>
              )}
              <div style={{ marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
                {multiStopVehicles.slice(0, 10).map(v => {
                  const isOpen = multiStopExpanded === v.vehicle_key;
                  return (
                    <div key={v.vehicle_key}
                         style={{
                           background: 'rgba(255,255,255,0.04)',
                           borderRadius: 4,
                           padding: 5,
                           marginBottom: 4,
                           cursor: 'pointer',
                           fontSize: 11,
                         }}
                         onClick={() => setMultiStopExpanded(isOpen ? null : v.vehicle_key)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontFamily: 'monospace' }}>{v.vehicle_key}</span>
                        <span style={{ color: '#888' }}>{v.chain_length} trips {isOpen ? '▾' : '▸'}</span>
                      </div>
                      {isOpen && (
                        <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'monospace' }}>
                          {v.trips.map(t => {
                            const hh = Math.floor(t.starttime / 3600).toString().padStart(2, '0');
                            const mm = Math.floor((t.starttime % 3600) / 60).toString().padStart(2, '0');
                            return (
                              <div key={t.trip_id} style={{ padding: '1px 0', borderBottom: '1px solid #222' }}>
                                #{t.seq} · {hh}:{mm} · trip {t.trip_id}
                                {t.distance_km !== null && (
                                  <span style={{ color: '#888' }}> · {t.distance_km.toFixed(1)} km</span>
                                )}
                                {t.goods_type && (
                                  <span style={{ color: '#888' }}> · {t.goods_type}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {multiStopVehicles.length > 10 && (
                  <div style={{ color: '#666', padding: '2px 0', fontSize: 10 }}>
                    … {multiStopVehicles.length - 10} more (showing top 10)
                  </div>
                )}
              </div>
            </div>

            {/* Dwell times */}
            <div style={{ marginTop: 10 }}>
              <div style={styles.subtitle}>Dwell Times</div>
              <button onClick={loadDwellTimes} style={styles.actionBtn} disabled={dwellLoading}>
                {dwellLoading ? 'Loading...' : 'Load Dwell Times'}
              </button>
              {dwellData.length > 0 && (
                <ResponsiveContainer width="100%" height={90}>
                  <BarChart data={dwellData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="dwell_bin" tick={{ fontSize: 8, fill: '#888' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#888' }} />
                    <Tooltip
                      contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                    />
                    <Bar dataKey="count" fill="#9b59b6" name="Vehicles" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Round trips */}
            <div style={{ marginTop: 10 }}>
              <div style={styles.subtitle}>Round Trips vs One-Way</div>
              <button onClick={loadRoundTrips} style={styles.actionBtn} disabled={roundTripLoading}>
                {roundTripLoading ? 'Loading...' : 'Load Round Trips'}
              </button>
              {roundTripData.length > 0 && (() => {
                const total = roundTripData.reduce((s, r) => s + r.vehicle_count, 0);
                const roundTrip = roundTripData.find(r => r.trip_type === 'round_trip');
                const oneWay = roundTripData.find(r => r.trip_type === 'one_way');
                return (
                  <div style={styles.roundTripCards}>
                    {roundTrip && (
                      <div style={styles.roundTripCard}>
                        <div style={{ ...styles.cardValue, color: '#17b8be' }}>
                          {total > 0 ? Math.round((roundTrip.vehicle_count / total) * 100) : 0}%
                        </div>
                        <div style={styles.cardLabel}>Round-trip</div>
                        <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>
                          {formatCompact(roundTrip.vehicle_count)} veh
                        </div>
                        <div style={{ fontSize: 9, color: '#666' }}>
                          avg {roundTrip.avg_trips_per_vehicle} trips
                        </div>
                      </div>
                    )}
                    {oneWay && (
                      <div style={styles.roundTripCard}>
                        <div style={{ ...styles.cardValue, color: '#fd805d' }}>
                          {total > 0 ? Math.round((oneWay.vehicle_count / total) * 100) : 0}%
                        </div>
                        <div style={styles.cardLabel}>One-way</div>
                        <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>
                          {formatCompact(oneWay.vehicle_count)} veh
                        </div>
                        <div style={{ fontSize: 9, color: '#666' }}>
                          avg {oneWay.avg_trips_per_vehicle} trips
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Commodity patterns — truck/all only */}
            {(vehicleType === 'truck' || vehicleType === 'all') && (
              <div style={{ marginTop: 10 }}>
                <div style={styles.subtitle}>Commodity Patterns</div>
                <button onClick={loadCommodityPatterns} style={styles.actionBtn} disabled={commodityLoading}>
                  {commodityLoading ? 'Loading...' : 'Load Commodity Patterns'}
                </button>
                {commodityData.length > 0 && (
                  <div style={styles.results}>
                    <div style={{ ...styles.clusterRow, color: '#666', marginBottom: 4 }}>
                      <span style={{ flex: 1 }}>Sequence</span>
                      <span>Vehicles</span>
                    </div>
                    {commodityData.map((row, i) => (
                      <div key={i} style={styles.clusterRow}>
                        <span style={{ flex: 1, fontSize: 9, color: '#bbb', wordBreak: 'break-all' as const }}>
                          {row.sequence}
                        </span>
                        <span style={{ color: '#4fc3f7', minWidth: 40, textAlign: 'right' as const }}>
                          {formatCompact(row.vehicle_count)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Links Tab ── */}
        {tab === 'links' && (
          <div>
            <div style={styles.subtitle}>Link-Level Road Density</div>
            <p style={styles.desc}>
              Top DRM road links by waypoint count — polylines when trajectories
              exist, colored by source or transport mode. Origin/destination-only
              sources have no links; keep Origins / Destinations / O-D arcs on.
            </p>
            {(vehicleType === 'truck' || vehicleType === 'all') && (
              <div style={styles.warnRibbon}>
                Truck queries take ~25s — please wait after clicking.
              </div>
            )}
            <button onClick={loadLinkDensity} style={styles.actionBtn} disabled={linkLoading}>
              {linkLoading ? 'Loading...' : 'Load Top 500 Links'}
            </button>
            <button
              onClick={() => { onLinkDensity([]); setLinkData(null); linkLoadedRef.current = false; }}
              style={styles.clearBtn}
            >
              Clear
            </button>
            {linkData && (
              <div style={styles.results}>
                <div style={{ marginBottom: 6, color: '#888' }}>
                  Showing top {linkData.count} of {linkData.total_links.toLocaleString()} total links
                </div>
                {linkData.links.slice(0, 20).map((link, i) => {
                  const intensity = Math.max(0, 1 - i / 20);
                  const dotColor = `rgba(${Math.round(68 + intensity * (253 - 68))}, ${Math.round(1 + intensity * (231 - 1))}, ${Math.round(84 + intensity * (37 - 84))}, 0.9)`;
                  const groups = link.by_group ?? [];
                  return (
                    <div key={link.link_id} style={{ ...styles.clusterRow, flexWrap: 'wrap' as const }}>
                      <span style={{ ...styles.clusterDot, background: dotColor }} />
                      <span style={{ minWidth: 18, color: '#888' }}>#{i + 1}</span>
                      <span style={{ flex: 1, color: '#bbb', fontSize: 9 }}>
                        {link.link_id}
                      </span>
                      <span style={{ color: '#4fc3f7' }}>{formatCompact(link.waypoint_count)}</span>
                      <span style={{ color: '#888', marginLeft: 4 }}>{formatCompact(link.unique_vehicles)}v</span>
                      {groups.length > 0 && (
                        <div style={{ flexBasis: '100%', display: 'flex', height: 4, margin: '3px 0 0 22px', borderRadius: 2, overflow: 'hidden' }}>
                          {groups.map(g => {
                            const rgb = colorBy === 'transportMode'
                              ? transportModeColor(Number(g.key))
                              : sourceFallbackColor(g.key);
                            return (
                              <div
                                key={g.key}
                                title={`${g.key}: ${g.waypoint_count}`}
                                style={{ flex: g.waypoint_count, background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {linkData.links.length > 20 && (
                  <div style={{ color: '#555', fontSize: 10, marginTop: 4, paddingLeft: 14 }}>
                    + {linkData.links.length - 20} more
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Detail Tab (Trajectory Details — Sprint A1a) ── */}
        {tab === 'detail' && selectedTrajectory && (
          <>
            <TrajectoryDetail
              trajectory={selectedTrajectory}
              onClear={onClearSelectedTrajectory}
            />
            {/* Phase 2A — jump from one sampled trip to the agent's full day */}
            {onAddAgent && !selectedAgents.includes(selectedTrajectory.metadata.vehicle_key) && (
              <button
                onClick={() => {
                  onAddAgent(selectedTrajectory.metadata.vehicle_key);
                  setTab('agents');
                }}
                style={{
                  marginTop: 8, width: '100%',
                  background: 'rgba(255,230,100,0.12)', color: '#ffe664',
                  border: '1px solid rgba(255,230,100,0.4)', borderRadius: 4,
                  padding: '5px 8px', fontSize: 11, cursor: 'pointer',
                }}
              >
                ★ Follow this agent (full day)
              </button>
            )}
          </>
        )}

        {/* ── Agents Tab (Phase 2A — search & follow) ── */}
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

        {/* ── Compare Tab (fleet-comparison — A⇄B fleets) ── */}
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

        {/* ── Zone Tab (Through-zone bbox — Sprint A1b) ── */}
        {tab === 'zone' && (
          <div>
            <div style={styles.subtitle}>Trips Through Zone</div>
            <p style={styles.desc}>
              Find trips whose trajectories pass through an axis-aligned
              bounding box. Backend: <code>/api/analysis/trip-chains/through-zone-bbox</code>.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                W (lon min)
                <input
                  type="number" step="0.001" value={zoneFormW}
                  onChange={e => setZoneFormW(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                S (lat min)
                <input
                  type="number" step="0.001" value={zoneFormS}
                  onChange={e => setZoneFormS(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                E (lon max)
                <input
                  type="number" step="0.001" value={zoneFormE}
                  onChange={e => setZoneFormE(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                N (lat max)
                <input
                  type="number" step="0.001" value={zoneFormN}
                  onChange={e => setZoneFormN(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button
                onClick={runZoneQuery}
                disabled={zoneLoading}
                style={styles.actionBtn}
              >
                {zoneLoading ? 'Searching…' : 'Search'}
              </button>
              {(zoneBBox || zoneTrips?.length) && (
                <button onClick={onClearZone} style={styles.clearBtn}>
                  Clear
                </button>
              )}
            </div>
            {zoneError && (
              <div style={{ fontSize: 11, color: '#ff7676', marginBottom: 6 }}>
                {zoneError}
              </div>
            )}
            {/* Phase 4 — promote the queried zone into a pedestrianize scenario.
                Query-time: excludes car trips entering this bbox everywhere. */}
            {zoneBBox && onPedestrianize && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {!scenarioActive ? (
                  <button
                    onClick={() => onPedestrianize(zoneBBox)}
                    style={{
                      ...styles.actionBtn,
                      background: 'rgba(231,76,60,0.15)',
                      borderColor: 'rgba(231,76,60,0.5)',
                      color: '#ff8a80',
                    }}
                    title="Exclude car trips whose trajectories enter this zone (query-time; toggle off any time)"
                  >
                    🚫🚗 Pedestrianize this zone
                  </button>
                ) : (
                  <button onClick={onClearScenario} style={styles.clearBtn}>
                    Clear pedestrianize scenario
                  </button>
                )}
              </div>
            )}
            {zoneTrips && zoneTrips.length > 0 && (
              <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>
                {zoneTrips.length} trip(s) found in bbox
                {zoneTrips.length === 500 && ' (capped at limit=500)'}
              </div>
            )}
            {zoneTrips && zoneTrips.length > 0 && (
              <div style={{ fontSize: 10, fontFamily: 'monospace', maxHeight: 200, overflowY: 'auto' }}>
                {zoneTrips.slice(0, 50).map((t, i) => (
                  <div key={`${t.vehicle_id}-${t.trip_id}-${i}`}
                       style={{ padding: '1px 0', borderBottom: '1px solid #222' }}>
                    {t.vehicle_type} #{t.vehicle_id} trip {t.trip_id}
                    {t.distance_km !== undefined && t.distance_km !== null && (
                      <span style={{ color: '#888' }}> · {t.distance_km.toFixed(1)} km</span>
                    )}
                  </div>
                ))}
                {zoneTrips.length > 50 && (
                  <div style={{ color: '#666', padding: '2px 0' }}>
                    … {zoneTrips.length - 50} more (showing first 50)
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Small metric card for the summary grid */
const MetricCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={styles.card}>
    <div style={styles.cardValue}>{value}</div>
    <div style={styles.cardLabel}>{label}</div>
  </div>
);

const CLUSTER_COLORS = [
  '#fd805d', '#17b8be', '#2bc850', '#d4a017', '#9b59b6',
  '#e74c3c', '#3498db', '#1abc9c', '#f39c12', '#e91e63',
];

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    top: 16,
    right: 16,
    background: 'rgba(15, 15, 25, 0.92)',
    borderRadius: 12,
    padding: 12,
    color: '#e0e0e0',
    backdropFilter: 'blur(8px)',
    width: 280,
    maxHeight: 'calc(100vh - 80px)',
    zIndex: 10,
    fontSize: 12,
    display: 'flex',
    flexDirection: 'column',
  },
  expandBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    background: 'rgba(15, 15, 25, 0.85)',
    border: '1px solid #444',
    borderRadius: 8,
    padding: '6px 14px',
    color: '#4fc3f7',
    cursor: 'pointer',
    fontSize: 12,
    zIndex: 10,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: '#4fc3f7',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: 18,
    cursor: 'pointer',
  },
  tabs: {
    display: 'flex',
    gap: 2,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    padding: '4px 0',
    border: '1px solid #333',
    borderRadius: 4,
    background: 'transparent',
    color: '#888',
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  tabActive: {
    background: '#1a3a5c',
    borderColor: '#4fc3f7',
    color: '#fff',
  },
  content: {
    minHeight: 100,
    overflowY: 'auto' as const,
    flex: 1,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#ccc',
    marginBottom: 4,
  },
  desc: {
    fontSize: 11,
    color: '#888',
    marginBottom: 8,
    lineHeight: 1.4,
  },
  empty: {
    color: '#666',
    textAlign: 'center' as const,
    padding: 20,
  },
  errorBox: {
    fontSize: 11, color: '#ff9a9a',
    background: 'rgba(231,76,60,0.10)', border: '1px solid rgba(231,76,60,0.35)',
    borderRadius: 4, padding: '4px 8px', marginBottom: 8, lineHeight: 1.4,
  },
  actionBtn: {
    width: '100%',
    padding: '6px 0',
    border: '1px solid #4fc3f7',
    borderRadius: 6,
    background: 'rgba(79, 195, 247, 0.1)',
    color: '#4fc3f7',
    cursor: 'pointer',
    fontSize: 12,
    marginBottom: 4,
  },
  clearBtn: {
    width: '100%',
    padding: '4px 0',
    border: '1px solid #444',
    borderRadius: 6,
    background: 'transparent',
    color: '#888',
    cursor: 'pointer',
    fontSize: 11,
  },
  results: {
    marginTop: 8,
    fontSize: 11,
    color: '#aaa',
    lineHeight: 1.5,
  },
  clusterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    marginBottom: 2,
  },
  clusterDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
  },

  // Summary tab styles
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr 1fr',
    gap: 4,
    marginBottom: 4,
  },
  card: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
    padding: '5px 4px',
    textAlign: 'center' as const,
  },
  cardValue: {
    fontSize: 14,
    fontWeight: 700,
    color: '#4fc3f7',
    lineHeight: 1.2,
  },
  cardLabel: {
    fontSize: 9,
    color: '#888',
    marginTop: 2,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.3,
  },
  insightsList: {
    borderLeft: '2px solid #333',
    paddingLeft: 8,
    marginTop: 6,
  },
  insightItem: {
    fontSize: 11,
    color: '#aaa',
    lineHeight: 1.5,
    marginBottom: 4,
  },
  peakRibbon: {
    fontSize: 10,
    color: '#ccc',
    background: 'rgba(253, 128, 93, 0.08)',
    border: '1px solid rgba(253, 128, 93, 0.25)',
    borderRadius: 4,
    padding: '3px 6px',
    marginBottom: 6,
    lineHeight: 1.4,
  },
  radioGroup: {
    display: 'flex',
    gap: 10,
    marginBottom: 6,
    fontSize: 11,
  },
  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    color: '#bbb',
    cursor: 'pointer',
  },
  roundTripCards: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 4,
    marginTop: 6,
  },
  roundTripCard: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
    padding: '6px 4px',
    textAlign: 'center' as const,
  },
  warnRibbon: {
    fontSize: 10,
    color: '#e8c96d',
    background: 'rgba(232, 201, 109, 0.08)',
    border: '1px solid rgba(232, 201, 109, 0.25)',
    borderRadius: 4,
    padding: '3px 6px',
    marginBottom: 6,
    lineHeight: 1.4,
  },
};
