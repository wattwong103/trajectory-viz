import React from 'react';
import {
  BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { MetricsDistribution } from '../../types';
import { styles } from './styles';

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Recharts BarChart of one F1 metric's histogram. Used in the Metrics tab. */
export const MetricHistogram: React.FC<{
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
export const SkeletonLines: React.FC = () => (
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

/** Small metric card for the summary grid */
export const MetricCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={styles.card}>
    <div style={styles.cardValue}>{value}</div>
    <div style={styles.cardLabel}>{label}</div>
  </div>
);

