import React from 'react';
import {
  BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import type { HourlyData } from '../../api';
import { SkeletonLines } from './shared';
import { styles } from './styles';

export interface TemporalTabProps {
  temporalError: string | null;
  peaksData: { peaks: Array<{ hour: number; count: number }>; mean: number; std: number; threshold: number } | null;
  hourlyData: HourlyData[];
  durationData: Array<{ distance_km: number; count: number; vehicle_type: string }>;
}

export const TemporalTab: React.FC<TemporalTabProps> = ({
  temporalError, peaksData, hourlyData, durationData,
}) => (
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
);
