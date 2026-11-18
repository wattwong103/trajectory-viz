import React from 'react';
import {
  BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import type { MultiStopVehicle } from '../../api';
import { formatCompact } from './shared';
import { styles } from './styles';

export interface ChainsTabProps {
  loading: boolean;
  loadChains: () => void;
  chainData: Array<{ chain_length: number; vehicle_count: number }>;
  multiStopMinStops: number;
  setMultiStopMinStops: (n: number) => void;
  multiStopLoading: boolean;
  loadMultiStop: () => void;
  multiStopVehicles: MultiStopVehicle[];
  multiStopExpanded: string | null;
  setMultiStopExpanded: (key: string | null) => void;
  dwellLoading: boolean;
  loadDwellTimes: () => void;
  dwellData: Array<{ dwell_bin: string; count: number }>;
  roundTripLoading: boolean;
  loadRoundTrips: () => void;
  roundTripData: Array<{ trip_type: 'round_trip' | 'one_way'; vehicle_count: number; avg_trips_per_vehicle: number }>;
  showCommodityPatterns: boolean;
  commodityLoading: boolean;
  loadCommodityPatterns: () => void;
  commodityData: Array<{ sequence: string; vehicle_count: number; chain_length: number }>;
}

export const ChainsTab: React.FC<ChainsTabProps> = ({
  loading, loadChains, chainData,
  multiStopMinStops, setMultiStopMinStops, multiStopLoading, loadMultiStop,
  multiStopVehicles, multiStopExpanded, setMultiStopExpanded,
  dwellLoading, loadDwellTimes, dwellData,
  roundTripLoading, loadRoundTrips, roundTripData,
  showCommodityPatterns, commodityLoading, loadCommodityPatterns, commodityData,
}) => (
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

            {/* Commodity patterns — lab plugin; needs goods_type attr */}
            {showCommodityPatterns && (
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
);
