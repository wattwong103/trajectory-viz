import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeBasemap, decodeBasemap, resolveInitialBasemap,
  isPlausibleStyleUrl, BASEMAP_STORAGE_KEY, DEFAULT_BASEMAP_ID,
} from '../basemap';

describe('basemap hash + storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('omits default dark from hash', () => {
    expect(encodeBasemap({ kind: 'preset', id: DEFAULT_BASEMAP_ID })).toBe('');
    expect(encodeBasemap({ kind: 'preset', id: 'light' })).toBe('bm=light');
  });

  it('round-trips presets and custom URLs', () => {
    expect(decodeBasemap('#bm=voyager')).toEqual({ kind: 'preset', id: 'voyager' });
    const custom = {
      kind: 'custom' as const,
      url: 'https://example.com/style.json',
    };
    const enc = encodeBasemap(custom);
    expect(decodeBasemap('#' + enc)).toEqual(custom);
  });

  it('rejects implausible style URLs', () => {
    expect(isPlausibleStyleUrl('not-a-url')).toBe(false);
    expect(isPlausibleStyleUrl('ftp://x/style.json')).toBe(false);
    expect(isPlausibleStyleUrl('https://tiles.example/style.json')).toBe(true);
  });

  it('prefers hash over localStorage', () => {
    localStorage.setItem(
      BASEMAP_STORAGE_KEY,
      JSON.stringify({ kind: 'preset', id: 'voyager' }),
    );
    expect(resolveInitialBasemap('#bm=light')).toEqual({ kind: 'preset', id: 'light' });
    expect(resolveInitialBasemap('#')).toEqual({ kind: 'preset', id: 'voyager' });
  });
});
