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

import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import type { InsightsResponse } from '../types';
import {
  fetchHourlyDepartures, fetchODFlows, fetchSpatialDensity,
  runClustering, fetchChainLengths,
  fetchTemporalPeaks, fetchDurationDistribution,
  fetchSpatialHotspots, fetchWaypointDensity,
  fetchDwellTimes, fetchRoundTrips, fetchCommodityPatterns,
  fetchLinkDensity,
  type HourlyData, type ODFlow, type DensityPoint, type ClusterResult,
  type LinkDensityItem,
} from '../api';

type Tab = 'summary' | 'temporal' | 'od' | 'density' | 'clusters' | 'chains' | 'links';

const TAB_LABELS: Record<Tab, string> = {
  summary: '\u03A3',
  temporal: '\u23F0',
  od: '\u2197',
  density: '\u2588',
  clusters: '\u25CE',
  chains: '\u26D3',
  links: '\u22A5',
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
  onODFlows: (flows: ODFlow[]) => void;
  onDensity: (points: DensityPoint[]) => void;
  onClusters: (result: ClusterResult | null) => void;
  onLinkDensity: (links: LinkDensityItem[]) => void;
}

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
  hasData, insights, insightsLoading,
  onODFlows, onDensity, onClusters, onLinkDensity,
}) => {
  const [tab, setTab] = useState<Tab>('summary');
  const [collapsed, setCollapsed] = useState(false);
  const [hourlyData, setHourlyData] = useState<HourlyData[]>([]);
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
  const [linkLoading, setLinkLoading] = useState(false);

  // Auto-load temporal data when panel opens
  useEffect(() => {
    if (hasData && tab === 'temporal') {
      fetchHourlyDepartures(vehicleType, city, simulationDay, goodsType, minHour, maxHour).then(setHourlyData).catch(console.error);
      fetchTemporalPeaks(vehicleType, city, simulationDay, goodsType, minHour, maxHour).then(setPeaksData).catch(console.error);
      fetchDurationDistribution(vehicleType, city, simulationDay, 10, goodsType, minHour, maxHour).then(setDurationData).catch(console.error);
    }
  }, [hasData, vehicleType, city, simulationDay, goodsType, minHour, maxHour, tab]);

  const loadODFlows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchODFlows(vehicleType, 80, city, simulationDay, goodsType, minHour, maxHour);
      onODFlows(res.flows);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour, onODFlows]);

  const loadDensity = useCallback(async (source: 'od' | 'waypoint') => {
    setLoading(true);
    try {
      if (source === 'waypoint') {
        const res = await fetchWaypointDensity(vehicleType, city, simulationDay, 0.005, 5000);
        onDensity(res.points);
      } else {
        const res = await fetchSpatialDensity(vehicleType, 'both', 0.01, city, simulationDay, goodsType, minHour, maxHour);
        onDensity(res.points);
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour, onDensity]);

  const loadHotspots = useCallback(async () => {
    setHotspotsLoading(true);
    try {
      const data = await fetchSpatialHotspots(vehicleType, city, simulationDay, 20, 'origin', goodsType);
      setHotspotsData(data);
    } catch (e) { console.error(e); }
    setHotspotsLoading(false);
  }, [vehicleType, city, simulationDay, goodsType]);

  const loadDwellTimes = useCallback(async () => {
    setDwellLoading(true);
    try {
      const data = await fetchDwellTimes(vehicleType, city, simulationDay, 1000, goodsType, minHour, maxHour);
      setDwellData(data);
    } catch (e) { console.error(e); }
    setDwellLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour]);

  const loadRoundTrips = useCallback(async () => {
    setRoundTripLoading(true);
    try {
      const data = await fetchRoundTrips(vehicleType, city, simulationDay, 2.0, goodsType, minHour, maxHour);
      setRoundTripData(data);
    } catch (e) { console.error(e); }
    setRoundTripLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour]);

  const loadCommodityPatterns = useCallback(async () => {
    setCommodityLoading(true);
    try {
      const data = await fetchCommodityPatterns(city, simulationDay, 20, goodsType, minHour, maxHour);
      setCommodityData(data);
    } catch (e) { console.error(e); }
    setCommodityLoading(false);
  }, [city, simulationDay, goodsType, minHour, maxHour]);

  const loadLinkDensity = useCallback(async () => {
    setLinkLoading(true);
    try {
      const res = await fetchLinkDensity(vehicleType, city, simulationDay, 500, 50, goodsType);
      setLinkData(res);
      onLinkDensity(res.links);
    } catch (e) { console.error(e); }
    setLinkLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, onLinkDensity]);

  const loadClusters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await runClustering(vehicleType, 5000, city, simulationDay, goodsType, minHour, maxHour);
      setClusterResult(res);
      onClusters(res);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [vehicleType, city, simulationDay, goodsType, minHour, maxHour, onClusters]);

  const loadChains = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchChainLengths(vehicleType, city, simulationDay, goodsType, minHour, maxHour);
      setChainData(data);
    } catch (e) { console.error(e); }
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
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button
            key={t}
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
            onClick={() => setTab(t)}
            title={t.charAt(0).toUpperCase() + t.slice(1)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={styles.content}>

        {/* ── Summary Tab ── */}
        {tab === 'summary' && (
          <div>
            {insightsLoading && <SkeletonLines />}
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
              Top DRM road links by waypoint count — where trajectories actually travel.
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
              onClick={() => { onLinkDensity([]); setLinkData(null); }}
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
                  return (
                    <div key={link.link_id} style={styles.clusterRow}>
                      <span style={{ ...styles.clusterDot, background: dotColor }} />
                      <span style={{ minWidth: 18, color: '#888' }}>#{i + 1}</span>
                      <span style={{ flex: 1, color: '#bbb', fontSize: 9 }}>
                        {link.link_id}
                      </span>
                      <span style={{ color: '#4fc3f7' }}>{formatCompact(link.waypoint_count)}</span>
                      <span style={{ color: '#888', marginLeft: 4 }}>{formatCompact(link.unique_vehicles)}v</span>
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
