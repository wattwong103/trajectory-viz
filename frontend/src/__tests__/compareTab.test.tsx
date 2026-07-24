/**
 * Tests for CompareTab (fleet-comparison).
 *
 * global.fetch is stubbed per the existing test setups; the mock captures
 * request URLs so source_a/source_b (and filter pass-through) can be
 * asserted. Recharts' ResponsiveContainer renders zero-size in jsdom — the
 * assertions target DOM text/controls, not chart internals.
 *
 * Fixture mirrors the backend contract (backend/analysis/compare.py) with
 * GUFM-like numbers: median distance 0.0 on fleet A and a large B−A trips
 * delta so the signed delta chips are exercisable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompareTab, formatDelta, fmtClock } from '../components/CompareTab';
import type { CompareResponse, SourceStyle } from '../types';

// jsdom lacks ResizeObserver, which recharts' ResponsiveContainer requires.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const SOURCES: SourceStyle[] = [
  { source_key: 'k-gufm', source_id: 'gufm', label: 'GUFM', mode: 'trails', color: [255, 160, 40], has_waypoints: true },
  { source_key: 'k-pflow', source_id: 'pflow', label: 'PFLOW', mode: 'trails', color: [23, 184, 190], has_waypoints: true },
  { source_key: 'k-bus', source_id: 'bus', label: 'City Buses', mode: 'trails', color: [59, 130, 246], has_waypoints: true },
];

const RESP: CompareResponse = {
  source_a: 'gufm',
  source_b: 'pflow',
  fleet_a: { trips: 4400, vehicles: 400, vkt_km: 2676.9, avg_distance_km: 0.608, median_distance_km: 0.0, max_distance_km: 53.879, min_starttime: 19800, max_starttime: 82800 },
  fleet_b: { trips: 870, vehicles: 400, vkt_km: 5432.1, avg_distance_km: 6.244, median_distance_km: 5.1, max_distance_km: 61.2, min_starttime: 21600, max_starttime: 79200 },
  mode_shares: [
    { mode: 4, a_trips: 4260, a_share: 0.968, b_trips: 6, b_share: 0.007, delta_pp: -96.13 },
  ],
  hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, a: h === 23 ? 1705 : 0, b: h === 7 ? 300 : 0 })),
  out_of_range: { a: 0, b: 1 },
  distance_hist: [{ bucket_lo: 0.0, bucket_hi: 2.827, a: 4218, b: 529 }],
  matched: null,
};

const RESP_MATCHED: CompareResponse = {
  ...RESP,
  matched: {
    matched_persons: 400,
    trips_per_person_a: 11.0,
    trips_per_person_b: 2.175,
    delta: { mean: -8.825, median: -9.0, p90_abs: 10.0, max_abs: 10 },
    top: [{ vehicle_id: 240903, trips_a: 11, trips_b: 1, delta: -10 }],
  },
};

function fetchCalls(): string[] {
  return vi.mocked(fetch).mock.calls.map(c => String(c[0]));
}

function renderTab(overrides: Partial<React.ComponentProps<typeof CompareTab>> = {}) {
  const onAddAgent = overrides.onAddAgent ?? vi.fn();
  render(
    <CompareTab
      sources={SOURCES}
      minHour={0}
      maxHour={23}
      transportModes={[3, 4]}
      onAddAgent={onAddAgent}
      {...overrides}
    />,
  );
  return { onAddAgent };
}

describe('CompareTab', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => RESP,
    } as Response)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the first two sources and fires the comparison', async () => {
    renderTab();
    await screen.findByText('4,400');   // fleet A trips rendered
    expect(fetchCalls()).toHaveLength(1);
    const url = fetchCalls()[0];
    expect(url).toContain('/api/analysis/compare?');
    expect(url).toContain('source_a=gufm');
    expect(url).toContain('source_b=pflow');
    // Shared filters ride along symmetrically (vehicle_type never sent).
    expect(url).toContain('min_hour=0');
    expect(url).toContain('max_hour=23');
    expect(url).toContain('transport_modes=3%2C4');
    expect(url).not.toContain('vehicle_type');
    // Both fleet labels (option + card title + legend) and the B−A trips chip.
    expect(screen.getAllByText('GUFM').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PFLOW').length).toBeGreaterThan(0);
    expect(screen.getByText('−3,530')).toBeInTheDocument();
    // Active window HH:MM–HH:MM from starttime seconds.
    expect(screen.getByText('05:30–23:00')).toBeInTheDocument();
    // Out-of-range footnote surfaces when > 0.
    expect(screen.getByText(/outside 0–23h excluded/)).toBeInTheDocument();
    // Matched-persons section is hidden when matched is null.
    expect(screen.queryByText(/present in both fleets/)).toBeNull();
    expect(screen.getByText(/No shared vehicle ids/)).toBeInTheDocument();
  });

  it('swap button exchanges A and B and refetches', async () => {
    renderTab();
    await screen.findByText('4,400');
    fireEvent.click(screen.getByRole('button', { name: /swap/i }));
    await waitFor(() => expect(fetchCalls()).toHaveLength(2));
    const url = fetchCalls()[1];
    expect(url).toContain('source_a=pflow');
    expect(url).toContain('source_b=gufm');
  });

  it('same-source selection shows the hint instead of firing a 422', async () => {
    renderTab();
    await screen.findByText('4,400');
    const [, selectB] = screen.getAllByRole('combobox');
    fireEvent.change(selectB, { target: { value: 'gufm' } });
    expect(screen.getByText(/Pick two different sources/)).toBeInTheDocument();
    // No second request — the guard preempts the backend's 422.
    expect(fetchCalls()).toHaveLength(1);
  });

  it('needs at least two sources', () => {
    renderTab({ sources: [SOURCES[0]] });
    expect(screen.getByText(/needs at least two sources/)).toBeInTheDocument();
    expect(fetchCalls()).toHaveLength(0);
  });

  it('matched-persons section renders with delta stats when present', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => RESP_MATCHED,
    } as Response));
    renderTab();
    await screen.findByText(/400 persons present in both fleets/);
    // Raw backend values render with ASCII minus (only the fleet-card chips
    // go through formatDelta's typographic minus).
    expect(screen.getByText(/Δ mean -8\.825 · median -9/)).toBeInTheDocument();
    // Top-table row: person id, trips A/B, signed delta.
    expect(screen.getByText('240903')).toBeInTheDocument();
    expect(screen.getByText('-10')).toBeInTheDocument();
  });

  it('Follow pair follows BOTH vehicle_keys via the shared handler', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => RESP_MATCHED,
    } as Response));
    const { onAddAgent } = renderTab();
    await screen.findByText(/400 persons present in both fleets/);
    fireEvent.click(screen.getByRole('button', { name: /Follow pair/i }));
    expect(onAddAgent).toHaveBeenCalledTimes(2);
    expect(onAddAgent).toHaveBeenNthCalledWith(1, 'gufm:240903');
    expect(onAddAgent).toHaveBeenNthCalledWith(2, 'pflow:240903');
  });

  it('shows a friendly error instead of crashing on API failure', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ detail: 'source_a and source_b must differ' }),
    } as Response));
    renderTab();
    await screen.findByText(/Backend error 422/);
  });
});

describe('formatDelta / fmtClock', () => {
  it('signs and formats B−A deltas', () => {
    expect(formatDelta(4400, 8700)).toBe('+4,300');
    expect(formatDelta(4400, 870)).toBe('−3,530');
    expect(formatDelta(400, 400)).toBe('0');
    expect(formatDelta(2676.9, 5432.1, 1, ' km')).toBe('+2,755.2 km');
    expect(formatDelta(null, 5)).toBeNull();
  });

  it('formats seconds-of-day as HH:MM', () => {
    expect(fmtClock(19800)).toBe('05:30');
    expect(fmtClock(82800)).toBe('23:00');
  });
});
