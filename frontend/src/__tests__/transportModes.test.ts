import { describe, it, expect } from 'vitest';
import { resolveModeOptions, transportModeLabel } from '../transportModes';

describe('resolveModeOptions', () => {
  it('prefers labeled modes[] from filter-options', () => {
    const modes = [
      { id: 0, label: 'Pedestrian', count: 10 },
      { id: 3, label: 'Drive', count: 5 },
    ];
    expect(resolveModeOptions(modes, [{ mode: 0, count: 99 }])).toEqual(modes);
  });

  it('falls back to transport_modes + default PFLOW labels', () => {
    expect(resolveModeOptions(undefined, [{ mode: 0, count: 3 }, { mode: 8, count: 1 }]))
      .toEqual([
        { id: 0, label: 'Walk', count: 3 },
        { id: 8, label: 'Taxi', count: 1 },
      ]);
  });

  it('returns empty when neither list is present', () => {
    expect(resolveModeOptions(null, null)).toEqual([]);
    expect(resolveModeOptions([], [])).toEqual([]);
  });
});

describe('transportModeLabel', () => {
  it('uses PFLOW defaults for known ints', () => {
    expect(transportModeLabel(0)).toBe('Walk');
    expect(transportModeLabel(99)).toBe('mode 99');
    expect(transportModeLabel(null)).toBe('unknown mode');
  });
});
