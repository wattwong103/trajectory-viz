import React from 'react';
import {
  BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { Trajectory } from '../../types';

// Sprint A1a — Per-trajectory detail view rendered in the Detail tab.
// Bins the trajectory's segment.speed_kmh into a small histogram and lists
// the longest dwells + most-used links. Uses the segments[] data that
// useTrajectories already fetches via include_segments=true.
export const TrajectoryDetail: React.FC<{
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

