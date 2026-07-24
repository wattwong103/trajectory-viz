/**
 * CompareTab — A⇄B fleet comparison (fleet-comparison change), rendered as
 * the "⇄" tab inside AnalysisPanel.
 *
 * Data: GET /api/analysis/compare rides the shared TripFilters — the
 * city/day/goods/hour/transport-mode/scenario props drilled from App apply
 * SYMMETRICALLY to both fleets (vehicle_type is overridden server-side by
 * source_a/source_b, so the panel's own source filter is ignored here).
 *
 * Follow-pair: matched persons share an integer vehicle_id across both
 * sources, so their vehicle_keys are "{source_a}:{id}" / "{source_b}:{id}"
 * — exactly the format AgentTab, the ag= hash, and fetchTrajectoriesByVehicle
 * use. The button simply calls App's onAddAgent twice; there is deliberately
 * no parallel follow path.
 *
 * Divergence-first design (GUFM reference: median distance 0.0, hour-23
 * spike): every fleet metric carries a signed B−A chip, the hourly overlay
 * is two raw-count lines (spikes stay visible), and the largest mode-share
 * divergences get explicit pp labels under the chart.
 */

import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { fetchComparison } from '../api';
import { friendlyFetchError } from '../friendlyError';
import { transportModeLabel, transportModeColor } from '../transportModes';
import type { CompareResponse, FilterState, SourceStyle } from '../types';

// ─── Formatting helpers (exported for tests) ────────────

/** Signed B−A delta chip text: "+4,300", "−3,530", "0", null when either side is null. */
export function formatDelta(
  a: number | null,
  b: number | null,
  digits: number = 0,
  unit: string = '',
): string | null {
  if (a === null || b === null) return null;
  const d = b - a;
  const mag = Math.abs(d).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `${sign}${mag}${unit}`;
}

/** Seconds-of-day → "HH:MM" (no modulo: hour 24+ shown as-is). */
export function fmtClock(sec: number): string {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  return `${h}:${m}`;
}

function fmtVal(v: number | null, digits: number, unit: string): string {
  if (v === null) return '—';
  return `${v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${unit}`;
}

const cssColor = (c: [number, number, number] | null, fallback: string): string =>
  c ? `rgb(${c[0]},${c[1]},${c[2]})` : fallback;

// ─── Component ──────────────────────────────────────────

interface CompareTabProps {
  /** filter-options sources (label + source_id + color). */
  sources: SourceStyle[];
  city?: string;
  simulationDay?: number;
  goodsType?: string;
  minHour?: number;
  maxHour?: number;
  transportModes?: number[];
  scenario?: FilterState['scenario'];
  /** App's existing agent-follow handler (vehicle_key). Follow-pair = 2 calls. */
  onAddAgent?: (key: string) => void;
}

export const CompareTab: React.FC<CompareTabProps> = ({
  sources,
  city, simulationDay, goodsType, minHour, maxHour, transportModes, scenario,
  onAddAgent,
}) => {
  const [sel, setSel] = useState<{ a: string; b: string } | null>(null);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default = first two sources; keep the user's picks across sources reloads.
  useEffect(() => {
    if (sources.length < 2) return;
    const ids = sources.map(s => s.source_id);
    setSel(prev =>
      prev && ids.includes(prev.a) && ids.includes(prev.b)
        ? prev
        : { a: ids[0], b: ids[1] },
    );
  }, [sources]);

  // Flatten filter deps (array/object identity changes per filter change,
  // which is exactly when we want to refetch anyway).
  const tmKey = (transportModes ?? []).join(',');
  const scenarioKey = scenario
    ? `${scenario.type}:${scenario.bbox.w},${scenario.bbox.s},${scenario.bbox.e},${scenario.bbox.n}`
    : '';

  useEffect(() => {
    if (!sel || sel.a === sel.b) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchComparison(sel.a, sel.b,
      { city, simulationDay, goodsType, minHour, maxHour, transportModes, scenario }, 10)
      .then(res => { if (!cancelled) setData(res); })
      .catch(e => {
        if (!cancelled) {
          setData(null);
          setError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // tmKey/scenarioKey stand in for the raw values intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.a, sel?.b, city, simulationDay, goodsType, minHour, maxHour, tmKey, scenarioKey]);

  if (sources.length < 2) {
    return (
      <div style={st.muted}>
        Fleet comparison needs at least two sources in this database.
      </div>
    );
  }

  const sourceById = Object.fromEntries(sources.map(s => [s.source_id, s]));
  const metaA = sel ? sourceById[sel.a] : undefined;
  const metaB = sel ? sourceById[sel.b] : undefined;
  const labelA = metaA?.label ?? sel?.a ?? '';
  const labelB = metaB?.label ?? sel?.b ?? '';
  const colorA = cssColor(metaA?.color ?? null, '#4fc3f7');
  const colorB = cssColor(metaB?.color ?? null, '#fd805d');
  const sameSource = !!sel && sel.a === sel.b;

  const followPair = (vehicleId: number) => {
    if (!onAddAgent || !data) return;
    onAddAgent(`${data.source_a}:${vehicleId}`);
    onAddAgent(`${data.source_b}:${vehicleId}`);
  };

  const METRIC_ROWS: Array<{
    label: string;
    a: number | null;
    b: number | null;
    digits: number;
    unit: string;
  }> = data ? [
    { label: 'Trips',    a: data.fleet_a.trips,             b: data.fleet_b.trips,             digits: 0, unit: '' },
    { label: 'Vehicles', a: data.fleet_a.vehicles,          b: data.fleet_b.vehicles,          digits: 0, unit: '' },
    { label: 'VKT',      a: data.fleet_a.vkt_km,            b: data.fleet_b.vkt_km,            digits: 1, unit: ' km' },
    { label: 'Avg dist', a: data.fleet_a.avg_distance_km,   b: data.fleet_b.avg_distance_km,   digits: 2, unit: ' km' },
    { label: 'Med dist', a: data.fleet_a.median_distance_km, b: data.fleet_b.median_distance_km, digits: 2, unit: ' km' },
    { label: 'Max dist', a: data.fleet_a.max_distance_km,   b: data.fleet_b.max_distance_km,   digits: 1, unit: ' km' },
  ] : [];

  const divergences = data
    ? [...data.mode_shares]
        .filter(r => Math.abs(r.delta_pp) >= 0.5)
        .sort((x, y) => Math.abs(y.delta_pp) - Math.abs(x.delta_pp))
        .slice(0, 4)
    : [];

  const oorTotal = data ? data.out_of_range.a + data.out_of_range.b : 0;

  return (
    <div>
      {/* ── Source pickers ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        <select
          value={sel?.a ?? ''}
          onChange={e => sel && setSel({ a: e.target.value, b: sel.b })}
          style={{ ...st.select, borderLeft: `3px solid ${colorA}` }}
          title="Fleet A"
        >
          {sources.map(s => (
            <option key={s.source_id} value={s.source_id}>{s.label}</option>
          ))}
        </select>
        <button
          onClick={() => sel && setSel({ a: sel.b, b: sel.a })}
          style={st.swapBtn}
          title="Swap A and B"
          aria-label="Swap A and B"
        >
          ⇄
        </button>
        <select
          value={sel?.b ?? ''}
          onChange={e => sel && setSel({ a: sel.a, b: e.target.value })}
          style={{ ...st.select, borderLeft: `3px solid ${colorB}` }}
          title="Fleet B"
        >
          {sources.map(s => (
            <option key={s.source_id} value={s.source_id}>{s.label}</option>
          ))}
        </select>
      </div>

      {sameSource && (
        <div style={st.hint}>
          Pick two different sources — comparing a fleet to itself is meaningless.
        </div>
      )}

      {loading && <div style={st.muted}>Comparing fleets…</div>}
      {error && <div style={st.errorBox}>{error}</div>}

      {data && !sameSource && (
        <>
          {/* ── Fleet summary cards ── */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {([
              { label: labelA, color: colorA, side: 'a' as const },
              { label: labelB, color: colorB, side: 'b' as const },
            ]).map(({ label, color, side }) => (
              <div key={side} style={{ ...st.fleetCard, borderTop: `2px solid ${color}` }}>
                <div style={{ ...st.fleetTitle, color }}>{label}</div>
                {METRIC_ROWS.map(r => {
                  const chip = formatDelta(r.a, r.b, r.digits, r.unit);
                  return (
                    <div key={r.label} style={st.metricRow}>
                      <span style={st.metricLabel}>{r.label}</span>
                      <span style={st.metricValue}>
                        {fmtVal(side === 'a' ? r.a : r.b, r.digits, r.unit)}
                      </span>
                      {side === 'b' && chip !== null && (
                        <span style={st.deltaChip} title="B − A">{chip}</span>
                      )}
                    </div>
                  );
                })}
                {/* Active window — a range, not a scalar: no delta chip. */}
                <div style={st.metricRow}>
                  <span style={st.metricLabel}>Active</span>
                  <span style={st.metricValue}>
                    {(side === 'a' ? data.fleet_a : data.fleet_b).min_starttime !== null &&
                     (side === 'a' ? data.fleet_a : data.fleet_b).max_starttime !== null
                      ? `${fmtClock((side === 'a' ? data.fleet_a : data.fleet_b).min_starttime!)}–${fmtClock((side === 'a' ? data.fleet_a : data.fleet_b).max_starttime!)}`
                      : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Hourly departures overlay ── */}
          <div style={st.sectionTitle}>
            Hourly departures
            <span style={st.legend}>
              <span style={{ ...st.legendDot, background: colorA }} />{labelA}
              <span style={{ ...st.legendDot, background: colorB, marginLeft: 8 }} />{labelB}
            </span>
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={data.hourly} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#888' }} interval={2} />
              <YAxis tick={{ fontSize: 9, fill: '#888' }} />
              <Tooltip
                contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                labelFormatter={h => `${String(h).padStart(2, '0')}:00`}
                formatter={(v: number) => v.toLocaleString()}
              />
              <Line type="monotone" dataKey="a" name={labelA} stroke={colorA} strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="b" name={labelB} stroke={colorB} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          {oorTotal > 0 && (
            <div style={st.footnote}>
              {[
                data.out_of_range.a > 0 ? `${data.out_of_range.a} ${labelA}` : null,
                data.out_of_range.b > 0 ? `${data.out_of_range.b} ${labelB}` : null,
              ].filter(Boolean).join(' + ')}{' '}
              {oorTotal === 1 ? 'trip' : 'trips'} outside 0–23h excluded.
            </div>
          )}

          {/* ── Mode shares ── */}
          {data.mode_shares.length > 0 && (
            <>
              <div style={{ ...st.sectionTitle, marginTop: 10 }}>Mode shares</div>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart
                  data={data.mode_shares.map(r => ({
                    mode: transportModeLabel(r.mode),
                    modeId: r.mode,
                    a: Math.round(r.a_share * 1000) / 10,
                    b: Math.round(r.b_share * 1000) / 10,
                  }))}
                  margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                >
                  <XAxis dataKey="mode" tick={{ fontSize: 9, fill: '#888' }} />
                  <YAxis tick={{ fontSize: 9, fill: '#888' }} tickFormatter={v => `${v}%`} />
                  <Tooltip
                    contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                    formatter={(v: number) => `${v}%`}
                  />
                  <Bar dataKey="a" name={labelA}>
                    {data.mode_shares.map((r, i) => {
                      const c = transportModeColor(r.mode);
                      return <Cell key={i} fill={`rgb(${c[0]},${c[1]},${c[2]})`} />;
                    })}
                  </Bar>
                  <Bar dataKey="b" name={labelB}>
                    {data.mode_shares.map((r, i) => {
                      const c = transportModeColor(r.mode);
                      return <Cell key={i} fill={`rgba(${c[0]},${c[1]},${c[2]},0.45)`} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {divergences.length > 0 && (
                <div style={st.divergenceList}>
                  {divergences.map(r => (
                    <div key={r.mode} style={st.divergenceRow}>
                      <span style={{ flex: 1 }}>{transportModeLabel(r.mode)}</span>
                      <span style={{ color: r.delta_pp > 0 ? colorB : colorA, fontWeight: 600 }}>
                        {r.delta_pp > 0 ? '+' : ''}{r.delta_pp.toFixed(1)} pp
                      </span>
                      <span style={st.divergenceShares}>
                        {(r.a_share * 100).toFixed(1)}% → {(r.b_share * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Distance histogram overlay ── */}
          <div style={{ ...st.sectionTitle, marginTop: 10 }}>Distance distribution (km)</div>
          {data.distance_hist.length > 0 ? (
            <ResponsiveContainer width="100%" height={100}>
              <LineChart
                data={data.distance_hist.map(bk => ({
                  hi: bk.bucket_hi, a: bk.a, b: bk.b,
                }))}
                margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
              >
                <XAxis dataKey="hi" tick={{ fontSize: 9, fill: '#888' }} tickFormatter={v => `${v}km`} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: '#888' }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                  labelFormatter={v => `≤ ${v} km`}
                  formatter={(v: number) => v.toLocaleString()}
                />
                <Line type="monotone" dataKey="a" name={labelA} stroke={colorA} strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="b" name={labelB} stroke={colorB} strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div style={st.footnote}>No distance data under these filters.</div>
          )}

          {/* ── Matched persons (GUFM-vs-PFLOW ground-truth workflow) ── */}
          {data.matched !== null ? (
            <>
              <div style={{ ...st.sectionTitle, marginTop: 10 }}>Matched persons</div>
              <div style={st.matchedHeader}>
                {data.matched.matched_persons.toLocaleString()} persons present in both fleets
              </div>
              <div style={st.matchedStats}>
                <span>
                  trips/person: <b style={{ color: colorA }}>{data.matched.trips_per_person_a ?? '—'}</b>
                  {' vs '}
                  <b style={{ color: colorB }}>{data.matched.trips_per_person_b ?? '—'}</b>
                </span>
                <span>
                  Δ mean {data.matched.delta.mean ?? '—'} · median {data.matched.delta.median ?? '—'}
                  {' · p90 |Δ| '}{data.matched.delta.p90_abs ?? '—'} · max |Δ| {data.matched.delta.max_abs ?? '—'}
                </span>
              </div>
              <div style={st.matchedTable}>
                <div style={{ ...st.matchedRow, ...st.matchedHead }}>
                  <span style={{ flex: 1 }}>person</span>
                  <span style={st.numCol}>{labelA}</span>
                  <span style={st.numCol}>{labelB}</span>
                  <span style={st.numCol}>Δ</span>
                  <span style={{ width: 64 }} />
                </div>
                {data.matched.top.map(p => (
                  <div key={p.vehicle_id} style={st.matchedRow}>
                    <span style={{ flex: 1, fontFamily: 'monospace' }}>{p.vehicle_id}</span>
                    <span style={st.numCol}>{p.trips_a}</span>
                    <span style={st.numCol}>{p.trips_b}</span>
                    <span style={{ ...st.numCol, color: p.delta > 0 ? colorB : p.delta < 0 ? colorA : '#888' }}>
                      {p.delta > 0 ? '+' : ''}{p.delta}
                    </span>
                    <button
                      onClick={() => followPair(p.vehicle_id)}
                      disabled={!onAddAgent}
                      style={st.followBtn}
                      title={`Follow ${data.source_a}:${p.vehicle_id} + ${data.source_b}:${p.vehicle_id}`}
                    >
                      ⚑ Follow pair
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ ...st.footnote, marginTop: 10 }}>
              No shared vehicle ids between these fleets.
            </div>
          )}

          {/* ── Color-by hint (map unchanged when this tab activates) ── */}
          <div style={{ ...st.footnote, marginTop: 10 }}>
            Tip: set Color by = Source in the filter panel to see both fleets on the map.
          </div>
        </>
      )}
    </div>
  );
};

const st: Record<string, React.CSSProperties> = {
  muted: { fontSize: 11, color: '#778', padding: '8px 0' },
  hint: {
    fontSize: 11, color: '#e8c96d',
    background: 'rgba(232,201,109,0.08)', border: '1px solid rgba(232,201,109,0.25)',
    borderRadius: 4, padding: '4px 8px', marginBottom: 8,
  },
  errorBox: {
    fontSize: 11, color: '#ff9a9a',
    background: 'rgba(231,76,60,0.10)', border: '1px solid rgba(231,76,60,0.35)',
    borderRadius: 4, padding: '4px 8px', marginBottom: 8, lineHeight: 1.4,
  },
  select: {
    flex: 1, minWidth: 0,
    background: 'rgba(255,255,255,0.06)', color: '#ddd',
    border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
    padding: '4px 6px', fontSize: 11,
  },
  swapBtn: {
    background: 'rgba(79,195,247,0.12)', color: '#4fc3f7',
    border: '1px solid rgba(79,195,247,0.35)', borderRadius: 4,
    padding: '3px 7px', cursor: 'pointer', fontSize: 12, flexShrink: 0,
  },
  fleetCard: {
    flex: 1, minWidth: 0,
    background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '6px 8px',
  },
  fleetTitle: {
    fontSize: 11, fontWeight: 700, marginBottom: 4,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  metricRow: {
    display: 'flex', alignItems: 'baseline', gap: 4,
    fontSize: 10, padding: '1px 0',
  },
  metricLabel: { color: '#888', width: 52, flexShrink: 0 },
  metricValue: { color: '#ddd', fontWeight: 600 },
  deltaChip: {
    marginLeft: 'auto',
    fontSize: 9, color: '#9fb6c9',
    background: 'rgba(79,195,247,0.08)',
    border: '1px solid rgba(79,195,247,0.25)',
    borderRadius: 8, padding: '0 5px', whiteSpace: 'nowrap',
  },
  sectionTitle: {
    fontSize: 12, fontWeight: 600, color: '#ccc', marginBottom: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  legend: { fontSize: 10, color: '#888', fontWeight: 400, display: 'flex', alignItems: 'center' },
  legendDot: { width: 8, height: 8, borderRadius: 4, display: 'inline-block', marginRight: 4 },
  footnote: { fontSize: 10, color: '#667', marginTop: 2, lineHeight: 1.4 },
  divergenceList: { marginTop: 4 },
  divergenceRow: {
    display: 'flex', alignItems: 'baseline', gap: 6,
    fontSize: 10, padding: '1px 0',
  },
  divergenceShares: { color: '#667', fontSize: 9 },
  matchedHeader: { fontSize: 11, color: '#ddd', marginBottom: 2 },
  matchedStats: {
    fontSize: 10, color: '#9aa', display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6,
  },
  matchedTable: { fontSize: 10 },
  matchedHead: { color: '#667', borderBottom: '1px solid #333', paddingBottom: 2 },
  matchedRow: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  numCol: { width: 34, textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  followBtn: {
    width: 64, flexShrink: 0,
    background: 'rgba(255,230,100,0.12)', color: '#ffe664',
    border: '1px solid rgba(255,230,100,0.4)', borderRadius: 4,
    padding: '2px 4px', fontSize: 9, cursor: 'pointer', whiteSpace: 'nowrap',
  },
};
