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
import { CompareTab, compareInsight, formatDelta, fmtClock } from '../components/CompareTab';
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
    { mode: 4, a_trips: 4260, a_share: 0.968, b_trips: 6, b_share: 0.007, delta_pp: -96.13, p_value: 0.0 },
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
    significance: { statistic: 12.0, p_value: 0.000001, n_pairs: 400 },
    alignment: {
      persons: 400,
      pairs: 2200,
      mean: 0.412,
      median: 0.398,
      histogram: [
        { lo: 0, hi: 0.1, count: 12 }, { lo: 0.1, hi: 0.2, count: 30 },
        { lo: 0.9, hi: 1, count: 88 },
      ],
    },
    top: [{ vehicle_id: 240903, trips_a: 11, trips_b: 1, delta: -10 }],
  },
};

// Three-fleet rollup (compare-multi): dynamic per-source keys.
const RESP_MULTI = {
  sources: ['gufm', 'pflow', 'bus'],
  fleets: [
    { source_id: 'gufm', trips: 4400, vehicles: 400, vkt_km: 2676.9, avg_distance_km: 0.608, median_distance_km: 0.0, max_distance_km: 53.9, min_starttime: 19800, max_starttime: 82800 },
    { source_id: 'pflow', trips: 870, vehicles: 400, vkt_km: 5432.1, avg_distance_km: 6.244, median_distance_km: 5.1, max_distance_km: 61.2, min_starttime: 21600, max_starttime: 79200 },
    { source_id: 'bus', trips: 120, vehicles: 12, vkt_km: 900.0, avg_distance_km: 7.5, median_distance_km: 7.0, max_distance_km: 20.0, min_starttime: 18000, max_starttime: 80000 },
  ],
  hourly: Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    gufm: h === 23 ? 1705 : 10,
    pflow: h === 7 ? 300 : 5,
    bus: h === 8 ? 40 : 2,
  })),
  out_of_range: { gufm: 0, pflow: 1, bus: 0 },
  mode_shares: [
    {
      mode: 4,
      gufm: { trips: 4260, share: 0.968 },
      pflow: { trips: 6, share: 0.007 },
      bus: { trips: 0, share: 0.0 },
    },
    {
      mode: 3,
      gufm: { trips: 140, share: 0.032 },
      pflow: { trips: 864, share: 0.993 },
      bus: { trips: 120, share: 1.0 },
    },
  ],
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
  describe('compareInsight', () => {
    it('leads with the matched-person gap when present and material', () => {
      const text = compareInsight(RESP_MATCHED, 'GUFM', 'PFLOW');
      expect(text).toContain('400 shared persons');
      expect(text).toContain('fewer trips/person (11 vs 2.175)');
    });

    it('falls back to the largest mode-share swing ≥ 1 pp', () => {
      const text = compareInsight(RESP, 'GUFM', 'PFLOW');
      expect(text).toMatch(/Train share differs by 96\.1 pp — GUFM heavier/);
    });

    it('falls back to peak-hour mismatch when modes are quiet', () => {
      const noModes: CompareResponse = { ...RESP, mode_shares: [] };
      const text = compareInsight(noModes, 'GUFM', 'PFLOW');
      expect(text).toContain('diverge most at 23:00');
      expect(text).toContain('GUFM runs 1,705 more');
    });

    it('returns null when fleets are near-identical', () => {
      const flat: CompareResponse = {
        ...RESP,
        mode_shares: [{ mode: 4, a_trips: 100, a_share: 0.5, b_trips: 100, b_share: 0.5, delta_pp: 0, p_value: 1 }],
        hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, a: 10, b: 10 })),
        matched: null,
      };
      expect(compareInsight(flat, 'A', 'B')).toBeNull();
    });
  });

  it('surfaces significance markers and the Wilcoxon line', async () => {
    renderTab();
    await screen.findByText('4,400');
    // Mode-share star (p < 0.05) with tooltip.
    expect(screen.getByTitle(/Two-proportion z-test/)).toBeInTheDocument();
  });

  it('matched block shows the Wilcoxon verdict when present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => RESP_MATCHED,
    } as Response)));
    renderTab();
    await screen.findByText(/present in both fleets/);
    expect(screen.getByText(/Wilcoxon p = /)).toBeInTheDocument();
    expect(screen.getByText(/systematic per-person gap/)).toBeInTheDocument();
    // Alignment line + histogram render from the matched block.
    expect(screen.getByText(/Alignment: mean 0\.412 · median 0\.398 over 2,200 paired trips/)).toBeInTheDocument();
  });

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

  it('F1 ranges ride along symmetrically when set', async () => {
    renderTab({
      minSpeed: 5, maxSpeed: 60, maxDwellMinutes: 30,
      minDetourRatio: 1.2, maxDetourRatio: 3.5,
    });
    await screen.findByText('4,400');
    const url = fetchCalls()[0];
    expect(url).toContain('min_speed=5');
    expect(url).toContain('max_speed=60');
    expect(url).toContain('max_dwell_minutes=30');
    expect(url).toContain('min_detour_ratio=1.2');
    expect(url).toContain('max_detour_ratio=3.5');
  });

  it('chips toggle a third fleet into the multi view', async () => {
    renderTab();
    await screen.findByText('4,400');
    // Re-stub for the multi response — this also resets the call log.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => RESP_MULTI,
    } as Response)));
    fireEvent.click(screen.getByRole('button', { name: /City Buses/ }));
    await screen.findByRole('columnheader', { name: 'City Buses' });
    const url = fetchCalls()[0];
    expect(url).toContain('/api/analysis/compare-multi?');
    expect(url).toContain('sources=gufm%2Cpflow%2Cbus');
  });

  it('removing below two fleets is blocked', async () => {
    renderTab();
    await screen.findByText('4,400');
    fireEvent.click(screen.getByRole('button', { name: /^GUFM/ }));
    // Min-two guard: no refetch, pairwise view (delta chip) still rendered.
    expect(fetchCalls()).toHaveLength(1);
    expect(screen.getByText('−3,530')).toBeInTheDocument();
  });

  it('grid-diff toggle fetches the grid and clears when switched off', async () => {
    const onCompareGrid = vi.fn();
    renderTab({ onCompareGrid });
    await screen.findByText('4,400');
    // Multi-fetch stub: first call (grid) returns a tiny cell set.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => url.includes('/compare/grid')
          ? { cell_deg: 0.005, cells: [{ lon: 139.0, lat: 35.0, count_a: 8, count_b: 6, delta: -2 }] }
          : RESP,
      } as Response;
    }));
    fireEvent.click(screen.getByRole('button', { name: /Diff on map/i }));
    await waitFor(() => expect(onCompareGrid).toHaveBeenCalledWith(
      expect.objectContaining({ cell_deg: 0.005 }),
    ));
    fireEvent.click(screen.getByRole('button', { name: /Diff on map/i }));
    await waitFor(() => expect(onCompareGrid).toHaveBeenLastCalledWith(null));
  });

  it('grid-diff resolution selector refetches at the chosen cell size', async () => {
    const onCompareGrid = vi.fn();
    renderTab({ onCompareGrid });
    await screen.findByText('4,400');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => url.includes('/compare/grid')
          ? { cell_deg: 0.01, cells: [] }
          : RESP,
      } as Response;
    }));
    fireEvent.click(screen.getByRole('button', { name: /Diff on map/i }));
    await screen.findByLabelText('Grid-diff cell size');
    fireEvent.change(screen.getByLabelText('Grid-diff cell size'), { target: { value: '0.01' } });
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('cell_deg=0.01'))).toBe(true);
    });
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
