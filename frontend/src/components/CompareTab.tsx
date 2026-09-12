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
import { fetchComparison, fetchMultiComparison, fetchCompareGrid } from '../api';
import { friendlyFetchError } from '../friendlyError';
import { transportModeLabel, transportModeColor } from '../transportModes';
import type {
  CompareResponse, MultiCompareResponse, CompareGridResponse,
  FilterState, SourceStyle,
} from '../types';

/** Fleet-comparison supports 2–4 sources (deep view at exactly two). */
const COMPARE_MAX_SOURCES = 4;

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

/**
 * One-line auto-insight for the tab header — the single most decision-
 * relevant divergence in the response, ranked: matched-person behavior gap
 * (the ground-truth workflow) > biggest mode-share swing ≥1 pp > peak-hour
 * mismatch. Returns null when there is nothing worth surfacing (empty or
 * near-identical fleets) so the line can stay hidden instead of padding.
 */
export function compareInsight(
  data: CompareResponse,
  labelA: string,
  labelB: string,
): string | null {
  // Matched persons: relative trips/person gap is the headline number.
  if (data.matched && data.matched.trips_per_person_a && data.matched.trips_per_person_b) {
    const tppA = data.matched.trips_per_person_a;
    const tppB = data.matched.trips_per_person_b;
    if (tppA > 0 && Math.abs(tppB - tppA) / tppA >= 0.05) {
      const pct = Math.round(Math.abs(tppB - tppA) / tppA * 100);
      return `${data.matched.matched_persons.toLocaleString()} shared persons: ${labelB} makes ${pct}% ${tppB > tppA ? 'more' : 'fewer'} trips/person (${tppA} vs ${tppB}).`;
    }
  }
  // Mode shares: largest absolute swing ≥ 1 pp.
  const modeSwing = [...data.mode_shares]
    .filter(r => Math.abs(r.delta_pp) >= 1)
    .sort((x, y) => Math.abs(y.delta_pp) - Math.abs(x.delta_pp))[0];
  if (modeSwing) {
    const dir = modeSwing.delta_pp > 0 ? labelB : labelA;
    const mag = Math.abs(modeSwing.delta_pp).toFixed(1);
    return `${transportModeLabel(modeSwing.mode)} share differs by ${mag} pp — ${dir} heavier (${(modeSwing.a_share * 100).toFixed(0)}% → ${(modeSwing.b_share * 100).toFixed(0)}%).`;
  }
  // Hourly profile: biggest single-hour count gap.
  let peakGap = 0, peakHour = -1;
  for (const h of data.hourly) {
    const gap = Math.abs(h.b - h.a);
    if (gap > peakGap) { peakGap = gap; peakHour = h.hour; }
  }
  if (peakHour >= 0 && peakGap >= 10) {
    const hi = data.hourly[peakHour];
    const leader = hi.b > hi.a ? labelB : labelA;
    return `Departures diverge most at ${String(peakHour).padStart(2, '0')}:00 — ${leader} runs ${peakGap.toLocaleString()} more.`;
  }
  return null;
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
  /** F1 derived-metric ranges (applied symmetrically to both fleets). */
  minSpeed?: number;
  maxSpeed?: number;
  maxDwellMinutes?: number;
  minDetourRatio?: number;
  maxDetourRatio?: number;
  transportModes?: number[];
  scenario?: FilterState['scenario'];
  /** App's existing agent-follow handler (vehicle_key). Follow-pair = 2 calls. */
  onAddAgent?: (key: string) => void;
  /** Grid-diff overlay control — null clears the map layer. */
  onCompareGrid?: (grid: CompareGridResponse | null) => void;
}

export const CompareTab: React.FC<CompareTabProps> = ({
  sources,
  city, simulationDay, goodsType, minHour, maxHour,
  minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
  transportModes, scenario,
  onAddAgent,
  onCompareGrid,
}) => {
  const [picked, setPicked] = useState<string[]>([]);
  const [data, setData] = useState<
    | { kind: 'pair'; res: CompareResponse }
    | { kind: 'multi'; res: MultiCompareResponse }
    | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gridOn, setGridOn] = useState(false);
  /** Grid-diff cell size in degrees (≈ ×111 km). Backend range 0.0005–1.0. */
  const [gridCell, setGridCell] = useState(0.005);

  // Default = first two sources; keep the user's picks across sources reloads.
  useEffect(() => {
    if (sources.length < 2) return;
    const ids = sources.map(s => s.source_id);
    setPicked(prev => {
      const kept = prev.filter(id => ids.includes(id));
      return kept.length >= 2 ? kept : [ids[0], ids[1]];
    });
  }, [sources]);

  /** Toggle a fleet in/out of the comparison set (min 2, max 4). */
  const toggleSource = (id: string) => {
    setPicked(prev => {
      if (prev.includes(id)) {
        return prev.length <= 2 ? prev : prev.filter(x => x !== id);
      }
      if (prev.length >= COMPARE_MAX_SOURCES) return prev;
      return [...prev, id];
    });
  };

  const pairMode = picked.length === 2;
  const pickedKey = picked.join('|');

  // Flatten filter deps (array/object identity changes per filter change,
  // which is exactly when we want to refetch anyway).
  const tmKey = (transportModes ?? []).join(',');
  const scenarioKey = scenario
    ? `${scenario.type}:${scenario.bbox.w},${scenario.bbox.s},${scenario.bbox.e},${scenario.bbox.n}`
    : '';

  const filters = {
    city, simulationDay, goodsType, minHour, maxHour,
    minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
    transportModes, scenario,
  };

  useEffect(() => {
    if (!pairMode && picked.length < 3) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const req: Promise<CompareResponse | MultiCompareResponse> = pairMode
      ? fetchComparison(picked[0], picked[1], filters, 10)
      : fetchMultiComparison(picked, filters);
    req
      .then(res => {
        if (cancelled) return;
        setData(
          pairMode
            ? { kind: 'pair', res: res as CompareResponse }
            : { kind: 'multi', res: res as MultiCompareResponse },
        );
      })
      .catch(e => {
        if (!cancelled) {
          setData(null);
          setError(friendlyFetchError(String((e as Error)?.message ?? e)).text);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // pickedKey/scenarioKey stand in for the raw values intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey, pairMode, city, simulationDay, goodsType, minHour, maxHour,
      minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio, maxDetourRatio,
      tmKey, scenarioKey]);

  // Grid-diff overlay lifecycle: on = fetch for the current pair+filters,
  // off / multi-mode = clear. Filter changes clear via App's overlay reset.
  useEffect(() => {
    if (!onCompareGrid) return;
    if (!gridOn || !pairMode) {
      onCompareGrid(null);
      return;
    }
    let cancelled = false;
    fetchCompareGrid(picked[0], picked[1], filters, gridCell)
      .then(res => { if (!cancelled) onCompareGrid(res); })
      .catch(() => { if (!cancelled) onCompareGrid(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOn, pairMode, pickedKey, gridCell, city, simulationDay, goodsType, minHour,
      maxHour, minSpeed, maxSpeed, maxDwellMinutes, minDetourRatio,
      maxDetourRatio, tmKey, scenarioKey]);

  if (sources.length < 2) {
    return (
      <div style={st.muted}>
        Fleet comparison needs at least two sources in this database.
      </div>
    );
  }

  const sourceById = Object.fromEntries(sources.map(s => [s.source_id, s]));
  const labelOf = (id: string) => sourceById[id]?.label ?? id;
  const colorOf = (id: string) => cssColor(sourceById[id]?.color ?? null, '#4fc3f7');
  const labelA = pairMode ? labelOf(picked[0]) : '';
  const labelB = pairMode ? labelOf(picked[1]) : '';
  const colorA = pairMode ? colorOf(picked[0]) : '#4fc3f7';
  const colorB = pairMode ? colorOf(picked[1]) : '#fd805d';
  const pairData = data?.kind === 'pair' ? data.res : null;
  const multiData = data?.kind === 'multi' ? data.res : null;

  const followPair = (vehicleId: number) => {
    if (!onAddAgent || !pairData) return;
    onAddAgent(`${pairData.source_a}:${vehicleId}`);
    onAddAgent(`${pairData.source_b}:${vehicleId}`);
  };

  const METRIC_ROWS: Array<{
    label: string;
    a: number | null;
    b: number | null;
    digits: number;
    unit: string;
  }> = pairData ? [
    { label: 'Trips',    a: pairData.fleet_a.trips,             b: pairData.fleet_b.trips,             digits: 0, unit: '' },
    { label: 'Vehicles', a: pairData.fleet_a.vehicles,          b: pairData.fleet_b.vehicles,          digits: 0, unit: '' },
    { label: 'VKT',      a: pairData.fleet_a.vkt_km,            b: pairData.fleet_b.vkt_km,            digits: 1, unit: ' km' },
    { label: 'Avg dist', a: pairData.fleet_a.avg_distance_km,   b: pairData.fleet_b.avg_distance_km,   digits: 2, unit: ' km' },
    { label: 'Med dist', a: pairData.fleet_a.median_distance_km, b: pairData.fleet_b.median_distance_km, digits: 2, unit: ' km' },
    { label: 'Max dist', a: pairData.fleet_a.max_distance_km,   b: pairData.fleet_b.max_distance_km,   digits: 1, unit: ' km' },
  ] : [];

  const divergences = pairData
    ? [...pairData.mode_shares]
        .filter(r => Math.abs(r.delta_pp) >= 0.5)
        .sort((x, y) => Math.abs(y.delta_pp) - Math.abs(x.delta_pp))
        .slice(0, 4)
    : [];

  const oorTotal = pairData ? pairData.out_of_range.a + pairData.out_of_range.b : 0;
  const insight = pairData ? compareInsight(pairData, labelA, labelB) : null;

  return (
    <div>
      {/* ── Source chips (toggle fleets in/out; order = pick order) ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        {sources.map(s => {
          const active = picked.includes(s.source_id);
          const c = cssColor(s.color ?? null, '#4fc3f7');
          const order = picked.indexOf(s.source_id);
          return (
            <button
              key={s.source_id}
              onClick={() => toggleSource(s.source_id)}
              style={{
                ...st.chip,
                ...(active ? { ...st.chipOn, borderColor: c } : {}),
              }}
              title={
                active
                  ? picked.length <= 2
                    ? 'A comparison needs at least two fleets'
                    : `Remove ${s.label} from the comparison`
                  : `Add ${s.label} to the comparison`
              }
            >
              <span style={{ ...st.legendDot, background: c }} />
              {s.label}
              {active && <span style={st.chipOrder}>{order + 1}</span>}
            </button>
          );
        })}
        {pairMode && (
          <button
            onClick={() => setPicked(p => [p[1], p[0], ...p.slice(2)])}
            style={st.swapBtn}
            title="Swap A and B"
            aria-label="Swap A and B"
          >
            ⇄
          </button>
        )}
        {pairMode && onCompareGrid && (
          <button
            onClick={() => setGridOn(v => !v)}
            style={{
              ...st.chip,
              ...(gridOn ? { ...st.chipOn, borderColor: '#e8c96d' } : {}),
              marginLeft: 'auto',
            }}
            title="Overlay per-cell A/B trip-count differences on the map"
            aria-pressed={gridOn}
          >
            ⬚ Diff on map
          </button>
        )}
        {pairMode && gridOn && (
          <select
            value={gridCell}
            onChange={e => setGridCell(Number(e.target.value))}
            style={{ ...st.select, maxWidth: 86 }}
            title="Grid-diff cell size"
            aria-label="Grid-diff cell size"
          >
            {([0.002, 0.005, 0.01, 0.02] as const).map(v => (
              <option key={v} value={v}>
                {(v * 111).toFixed(v < 0.01 ? 2 : 1)} km
              </option>
            ))}
          </select>
        )}
      </div>

      {picked.length >= COMPARE_MAX_SOURCES && (
        <div style={st.hint}>
          Up to {COMPARE_MAX_SOURCES} fleets per comparison.
        </div>
      )}

      {loading && <div style={st.muted}>Comparing fleets…</div>}
      {error && <div style={st.errorBox}>{error}</div>}

      {/* ── Pairwise deep view (exactly two fleets) ── */}
      {pairData && insight && (
        <div style={st.insightLine} title="Auto-generated summary of the largest divergence">
          <span style={st.insightTag}>insight</span> {insight}
        </div>
      )}

      {multiData && multiData.fleets.some(fl => fl.trips > 0) && (() => {
        const ids = multiData.sources;
        const labels = Object.fromEntries(ids.map(id => [id, labelOf(id)]));
        const colors = Object.fromEntries(ids.map(id => [id, colorOf(id)]));
        const maxTrips = Math.max(...multiData.fleets.map(fl => fl.trips));
        return (
          <>
            {/* ── Fleet cards grid ── */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {multiData.fleets.map(fl => (
                <div
                  key={fl.source_id}
                  style={{
                    ...st.fleetCard, minWidth: 96,
                    borderTop: `2px solid ${colors[fl.source_id]}`,
                    ...(fl.trips === maxTrips && maxTrips > 0 ? {} : { opacity: 0.75 }),
                  }}
                >
                  <div style={{ ...st.fleetTitle, color: colors[fl.source_id] }}>
                    {labels[fl.source_id]}
                  </div>
                  <div style={st.metricRow}><span style={st.metricLabel}>Trips</span><span style={st.metricValue}>{fl.trips.toLocaleString()}</span></div>
                  <div style={st.metricRow}><span style={st.metricLabel}>Vehicles</span><span style={st.metricValue}>{fl.vehicles.toLocaleString()}</span></div>
                  <div style={st.metricRow}><span style={st.metricLabel}>VKT</span><span style={st.metricValue}>{fmtVal(fl.vkt_km, 1, ' km')}</span></div>
                  <div style={st.metricRow}><span style={st.metricLabel}>Avg dist</span><span style={st.metricValue}>{fmtVal(fl.avg_distance_km, 2, ' km')}</span></div>
                </div>
              ))}
            </div>

            {/* ── Hourly departures, one line per fleet ── */}
            <div style={st.sectionTitle}>
              Hourly departures
              <span style={st.legend}>
                {ids.map((id, i) => (
                  <span key={id}>
                    {i > 0 && <span style={{ marginLeft: 8 }} />}
                    <span style={{ ...st.legendDot, background: colors[id] }} />{labels[id]}
                  </span>
                ))}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={multiData.hourly} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#888' }} interval={2} />
                <YAxis tick={{ fontSize: 9, fill: '#888' }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                  labelFormatter={h => `${String(h).padStart(2, '0')}:00`}
                  formatter={(v: number) => v.toLocaleString()}
                />
                {ids.map(id => (
                  <Line key={id} type="monotone" dataKey={id} name={labels[id]}
                        stroke={colors[id]} strokeWidth={1.5} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>

            {/* ── Mode-share table (share of each fleet's non-null-mode trips) ── */}
            {multiData.mode_shares.length > 0 && (
              <>
                <div style={{ ...st.sectionTitle, marginTop: 10 }}>Mode shares</div>
                <table style={st.multiTable}>
                  <thead>
                    <tr>
                      <th style={st.multiTh}>mode</th>
                      {ids.map(id => (
                        <th key={id} style={{ ...st.multiTh, color: colors[id] }}>{labels[id]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {multiData.mode_shares.map(r => {
                      const best = Math.max(...ids.map(id => r[id]?.share ?? 0));
                      return (
                        <tr key={r.mode}>
                          <td style={st.multiTd}>{transportModeLabel(r.mode)}</td>
                          {ids.map(id => {
                            const cell = r[id];
                            const isBest = best > 0 && cell?.share === best;
                            return (
                              <td
                                key={id}
                                style={{
                                  ...st.multiTd,
                                  fontWeight: isBest ? 700 : 400,
                                  color: isBest ? colors[id] : '#99a',
                                }}
                              >
                                {cell ? `${(cell.share * 100).toFixed(1)}%` : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}

            <div style={{ ...st.footnote, marginTop: 8 }}>
              Deep-dive (matched persons, significance tests): pick exactly two fleets.
            </div>
          </>
        );
      })()}

      {pairData && (
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
                    {(side === 'a' ? pairData.fleet_a : pairData.fleet_b).min_starttime !== null &&
                     (side === 'a' ? pairData.fleet_a : pairData.fleet_b).max_starttime !== null
                      ? `${fmtClock((side === 'a' ? pairData.fleet_a : pairData.fleet_b).min_starttime!)}–${fmtClock((side === 'a' ? pairData.fleet_a : pairData.fleet_b).max_starttime!)}`
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
            <LineChart data={pairData.hourly} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
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
                pairData.out_of_range.a > 0 ? `${pairData.out_of_range.a} ${labelA}` : null,
                pairData.out_of_range.b > 0 ? `${pairData.out_of_range.b} ${labelB}` : null,
              ].filter(Boolean).join(' + ')}{' '}
              {oorTotal === 1 ? 'trip' : 'trips'} outside 0–23h excluded.
            </div>
          )}

          {/* ── Mode shares ── */}
          {pairData.mode_shares.length > 0 && (
            <>
              <div style={{ ...st.sectionTitle, marginTop: 10 }}>Mode shares</div>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart
                  data={pairData.mode_shares.map(r => ({
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
                    {pairData.mode_shares.map((r, i) => {
                      const c = transportModeColor(r.mode);
                      return <Cell key={i} fill={`rgb(${c[0]},${c[1]},${c[2]})`} />;
                    })}
                  </Bar>
                  <Bar dataKey="b" name={labelB}>
                    {pairData.mode_shares.map((r, i) => {
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
                      <span style={{ flex: 1 }}>
                        {transportModeLabel(r.mode)}
                        {r.p_value !== null && r.p_value < 0.05 && (
                          <span
                            style={st.sigStar}
                            title={`Two-proportion z-test p = ${r.p_value} — shift unlikely to be sampling noise`}
                          >
                            *
                          </span>
                        )}
                      </span>
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
          {pairData.distance_hist.length > 0 ? (
            <ResponsiveContainer width="100%" height={100}>
              <LineChart
                data={pairData.distance_hist.map(bk => ({
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
          {pairData.matched !== null ? (
            <>
              <div style={{ ...st.sectionTitle, marginTop: 10 }}>Matched persons</div>
              <div style={st.matchedHeader}>
                {pairData.matched.matched_persons.toLocaleString()} persons present in both fleets
              </div>
              <div style={st.matchedStats}>
                <span>
                  trips/person: <b style={{ color: colorA }}>{pairData.matched.trips_per_person_a ?? '—'}</b>
                  {' vs '}
                  <b style={{ color: colorB }}>{pairData.matched.trips_per_person_b ?? '—'}</b>
                </span>
                <span>
                  Δ mean {pairData.matched.delta.mean ?? '—'} · median {pairData.matched.delta.median ?? '—'}
                  {' · p90 |Δ| '}{pairData.matched.delta.p90_abs ?? '—'} · max |Δ| {pairData.matched.delta.max_abs ?? '—'}
                </span>
                {pairData.matched.significance && (
                  <span
                    title="Wilcoxon signed-rank over per-person trip counts (B vs A)"
                  >
                    Wilcoxon p = {pairData.matched.significance.p_value}
                    {pairData.matched.significance.p_value < 0.05 ? (
                      <b style={{ color: '#e8c96d' }}> — systematic per-person gap</b>
                    ) : ' — no consistent direction'}
                  </span>
                )}
                {pairData.matched.alignment.mean !== null && (
                  <span
                    title="Rank-paired trips (k-th earliest departure each side) scored on departure-time + distance similarity; 1 = identical"
                  >
                    Alignment: mean {pairData.matched.alignment.mean} · median{' '}
                    {pairData.matched.alignment.median} over{' '}
                    {pairData.matched.alignment.pairs.toLocaleString()} paired trips
                  </span>
                )}
              </div>
              {pairData.matched.alignment.histogram.some(b => b.count > 0) && (
                <ResponsiveContainer width="100%" height={54}>
                  <BarChart
                    data={pairData.matched.alignment.histogram.map(b => ({
                      band: `${b.lo.toFixed(1)}`, count: b.count,
                    }))}
                    margin={{ top: 2, right: 4, left: -30, bottom: 0 }}
                  >
                    <XAxis dataKey="band" tick={{ fontSize: 8, fill: '#777' }} interval={1} />
                    <YAxis tick={{ fontSize: 8, fill: '#777' }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }}
                      formatter={(v: number) => [`${v}`, 'persons']}
                    />
                    <Bar dataKey="count" fill="#4fc3f7" fillOpacity={0.55} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              <div style={st.matchedTable}>
                <div style={{ ...st.matchedRow, ...st.matchedHead }}>
                  <span style={{ flex: 1 }}>person</span>
                  <span style={st.numCol}>{labelA}</span>
                  <span style={st.numCol}>{labelB}</span>
                  <span style={st.numCol}>Δ</span>
                  <span style={{ width: 64 }} />
                </div>
                {pairData.matched.top.map(p => (
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
                      title={`Follow ${pairData.source_a}:${p.vehicle_id} + ${pairData.source_b}:${p.vehicle_id}`}
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
          {gridOn && (
            <div style={{ ...st.footnote, marginTop: 4 }}>
              Diff grid on map:{' '}
              <span style={{ color: '#68aaff' }}>■</span> B-heavier ·{' '}
              <span style={{ color: '#fd805d' }}>■</span> A-heavier ·
              opacity = |Δ| (trip starts, ≈{(gridCell * 111).toFixed(gridCell < 0.01 ? 2 : 1)} km cells)
            </div>
          )}
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
  insightLine: {
    fontSize: 11, color: '#d8e6f3',
    background: 'rgba(79,195,247,0.08)', borderLeft: '3px solid #4fc3f7',
    borderRadius: 3, padding: '5px 8px', marginBottom: 8, lineHeight: 1.45,
  },
  insightTag: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
    color: '#4fc3f7', marginRight: 4,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: 'rgba(255,255,255,0.05)', color: '#99a',
    border: '1px solid rgba(255,255,255,0.15)', borderRadius: 12,
    padding: '3px 9px', fontSize: 10, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  chipOn: {
    background: 'rgba(79,195,247,0.12)', color: '#ddd',
    borderWidth: 1, borderStyle: 'solid',
  },
  chipOrder: { fontSize: 8, color: '#888', marginLeft: 2 },
  select: {
    background: 'rgba(255,255,255,0.06)', color: '#ddd',
    border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
    padding: '3px 4px', fontSize: 10,
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
  multiTable: { width: '100%', borderCollapse: 'collapse', fontSize: 10 },
  multiTh: {
    textAlign: 'right', padding: '2px 4px', color: '#889',
    fontWeight: 600, borderBottom: '1px solid #333', fontSize: 9,
  },
  multiTd: {
    textAlign: 'right', padding: '2px 4px', color: '#99a',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  sigStar: { color: '#e8c96d', marginLeft: 3, fontWeight: 700 },
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
