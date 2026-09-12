/**
 * Tests for the zones data path (zones feature): API URL formation and the
 * useZones hook's initial fetch (zones + styles in one round).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fetchZones, fetchZoneStyles } from '../api';
import { useZones } from '../hooks/useZones';

describe('zones api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    } as Response)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchZones hits /api/zones', async () => {
    await fetchZones();
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/zones');
  });

  it('fetchZoneStyles hits /api/zones/styles', async () => {
    await fetchZoneStyles();
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/zones/styles');
  });
});

describe('useZones', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).endsWith('/api/zones')
        ? { zones: [{ zone_id: 0, source_key: 'w', name: 'Ward A', category: null, bbox: null, geometry: { type: 'Polygon', coordinates: [] }, props: null }], count: 1, truncated: false }
        : { styles: { w: { label: 'Wards', color: [1, 2, 3] } } },
    } as Response)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads zones and styles on mount', async () => {
    const { result } = renderHook(() => useZones());
    await waitFor(() => expect(result.current.zones).toHaveLength(1));
    expect(result.current.zones[0].name).toBe('Ward A');
    expect(result.current.styles.w.color).toEqual([1, 2, 3]);
    expect(result.current.loading).toBe(false);
  });
});
