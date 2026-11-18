import React from 'react';
import {
  AreaChart, Area,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import type { InsightsResponse } from '../../types';
import { friendlyFetchError } from '../../friendlyError';
import { formatCompact, MetricCard, SkeletonLines } from './shared';
import { styles } from './styles';

export interface SummaryTabProps {
  insights: InsightsResponse | null;
  insightsLoading: boolean;
  insightsError: string | null;
}

export const SummaryTab: React.FC<SummaryTabProps> = ({
  insights, insightsLoading, insightsError,
}) => (
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
);
